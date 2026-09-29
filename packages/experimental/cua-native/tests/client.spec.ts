/** Spawn lifecycle against the scripted helper stub: routing, errors, approval resend, timeout, exit, close. */

import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import {
  CuaApprovalRequiredError,
  CuaHelperClient,
  CuaHelperExitError,
  CuaHelperProtocolError,
  CuaHelperRequestError,
  CuaHelperTimeoutError,
} from '../src/client.ts'

const STUB = fileURLToPath(new URL('./fixtures/helper-stub.mjs', import.meta.url))

const open: CuaHelperClient[] = []

function stubClient(options: Partial<ConstructorParameters<typeof CuaHelperClient>[0]> = {}): CuaHelperClient {
  const client = new CuaHelperClient({ helperPath: process.execPath, helperArgs: [STUB], ...options })
  open.push(client)
  return client
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(client => client.close().catch(() => {})))
})

describe('request routing', () => {
  it('resolves the result that matches the request id and ignores unsolicited ids', async () => {
    const client = stubClient()
    const result = await client.request<{ served: string }>('ready')
    expect(result).toEqual({ served: 'stub' })
  })

  it('rejects with the helper error text as a typed error', async () => {
    const client = stubClient()
    await expect(client.request('fails')).rejects.toBeInstanceOf(CuaHelperRequestError)
    await expect(client.request('fails')).rejects.toThrow('stub refuses')
  })

  it('rejects unknown methods with the helper message', async () => {
    const client = stubClient()
    await expect(client.request('not-a-method')).rejects.toThrow('unknown method: not-a-method')
  })
})

describe('approval flow', () => {
  it('rejects an approval pause with the full payload when no handler is installed', async () => {
    const client = stubClient()
    const failure = await client.request('approve', { app: 'stub-app' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CuaApprovalRequiredError)
    const approval = failure as CuaApprovalRequiredError
    expect(approval.approval).toEqual({ app: 'stub-app', displayName: 'Stub App', riskLevel: 'low' })
    expect(approval.method).toBe('approve')
    expect(approval.message).toContain('Stub App')
  })

  it('resends with x-oai-cua-approved-app once the handler allows it', async () => {
    const seen: string[] = []
    const client = stubClient({
      approvalHandler: (approval) => {
        seen.push(approval.app)
        return approval.riskLevel === 'low'
      },
    })
    const result = await client.request<{ launched: string }>('approve', { app: 'stub-app' })
    expect(result).toEqual({ launched: 'stub-app' })
    expect(seen).toEqual(['stub-app'])
  })

  it('rejects the original request when the handler refuses', async () => {
    const client = stubClient({ approvalHandler: () => false })
    await expect(client.request('approve', { app: 'stub-app' })).rejects.toBeInstanceOf(CuaApprovalRequiredError)
  })
})

describe('failure modes', () => {
  it('times out, rejects with the Codex timeout text, and kills the helper', async () => {
    const client = stubClient()
    await expect(client.request('hang', {}, { timeoutMs: 250 })).rejects.toBeInstanceOf(CuaHelperTimeoutError)
    await expect(client.request('hang', {}, { timeoutMs: 250 })).rejects.toThrow(
      'computer-use request timed out: hang',
    )
    await client.exited
    expect(client.pid).toBeTypeOf('number')
  })

  it('flags an invalid JSON line and keeps the helper usable', async () => {
    const client = stubClient()
    await expect(client.request('garbage')).rejects.toBeInstanceOf(CuaHelperProtocolError)
    await expect(client.request('garbage')).rejects.toThrow('computer-use helper emitted invalid JSON')
    const recovered = await client.request<{ served: string }>('ready')
    expect(recovered).toEqual({ served: 'stub' })
  })

  it('surfaces a premature helper exit with its code and stderr tail', async () => {
    const client = stubClient()
    const failure = await client.request('die').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CuaHelperExitError)
    const exit = failure as CuaHelperExitError
    expect(exit.exitCode).toBe(7)
    expect(exit.message).toContain('exit code 7')
    expect(exit.message).toContain('stub crashing now')
  })
})

describe('lifecycle', () => {
  it('close() performs the protocol close and the helper exits', async () => {
    const client = stubClient()
    const pid = client.pid
    expect(pid).toBeTypeOf('number')
    await client.close()
    await client.exited
    await expect(client.request('ready')).rejects.toThrow(/closed/u)
  })

  it('close() is idempotent', async () => {
    const client = stubClient()
    await client.close()
    await client.close()
    await client.exited
  })

  it('fails loud when the helper binary cannot be spawned', async () => {
    const client = new CuaHelperClient({
      helperPath: process.execPath,
      helperArgs: [fileURLToPath(new URL('./fixtures/does-not-exist.mjs', import.meta.url))],
    })
    open.push(client)
    await client.exited
    await expect(client.request('ready')).rejects.toThrow(/MODULE_NOT_FOUND/u)
  })
})
