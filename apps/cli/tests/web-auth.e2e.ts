/** Real `dsh web` request admission against a temporary Harness home. */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DSH_SOURCE_BIN = join(REPO_ROOT, 'apps/cli/src/bin.ts')
const TSX_LOADER = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href

interface RunningWeb {
  readonly child: ChildProcess
  readonly launchUrl: string
  readonly output: () => string
}

interface HttpResult {
  readonly status: number
  readonly body: string
}

/** Reserve one concrete loopback port, then release it for the CLI process. */
async function freePort(): Promise<number> {
  const server = createServer()
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const port = (server.address() as AddressInfo).port
  const closing = Promise.withResolvers<void>()
  server.close((error) => {
    if (error === undefined) closing.resolve()
    else closing.reject(error)
  })
  await closing.promise
  return port
}

function cleanEnvironment(root: string, dshHome: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
  return {
    ...env,
    DSH_AGENTS_HOME: join(root, '.agents'),
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
    SSH_CONNECTION: '',
    SSH_TTY: '',
    TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
  }
}

/** Start the public source CLI and wait for its readiness URL. */
async function startWeb(root: string, dshHome: string, port: number): Promise<RunningWeb> {
  const child = spawn(process.execPath, [
    '--import', TSX_LOADER,
    DSH_SOURCE_BIN,
    'web',
    '--no-open',
    '--port', String(port),
  ], {
    cwd: root,
    env: cleanEnvironment(root, dshHome),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const ready = Promise.withResolvers<string>()
  let settled = false
  const fail = (error: Error): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    ready.reject(error)
  }
  const timer = setTimeout(() => {
    fail(new Error(`dsh web did not become ready:\n${output}`))
  }, 90_000)
  const append = (chunk: Buffer | string): void => {
    output = `${output}${String(chunk)}`.slice(-100_000)
    const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
    if (settled || match?.[1] === undefined) return
    settled = true
    clearTimeout(timer)
    ready.resolve(match[1])
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.once('error', (error) => {
    fail(error)
  })
  child.once('exit', (code) => {
    fail(new Error(`dsh web exited before readiness (${String(code)}):\n${output}`))
  })
  const launchUrl = await ready.promise
  return { child, launchUrl, output: () => output }
}

async function stopWeb(running: RunningWeb): Promise<void> {
  if (running.child.exitCode !== null) return
  const exited = Promise.withResolvers<void>()
  running.child.once('exit', () => { exited.resolve() })
  running.child.kill('SIGTERM')
  const forced = setTimeout(() => { running.child.kill('SIGKILL') }, 10_000)
  forced.unref()
  await exited.promise
  clearTimeout(forced)
}

/** POST one real Remote envelope while controlling the wire Host header. */
function describeSettings(port: number, host: string): Promise<HttpResult> {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'web-auth-real-cli',
    method: 'settings/describe',
    payload: { args: {} },
  })
  const capture = Promise.withResolvers<HttpResult>()
  const req = httpRequest({
    hostname: '127.0.0.1',
    port,
    path: '/api/settings/describe',
    method: 'POST',
    headers: {
      host,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  }, (res) => {
    const chunks: Uint8Array[] = []
    res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    res.on('end', () => {
      capture.resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
    })
  })
  req.once('error', capture.reject)
  req.end(body)
  return capture.promise
}

describe('dsh web admission through the real CLI', () => {
  it('admits trusted requests without a token and refuses an untrusted Host across restart', { timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-auth-real-cli-'))
    const dshHome = join(root, '.dsh')
    const port = await freePort()
    let first: RunningWeb | undefined
    let second: RunningWeb | undefined
    try {
      first = await startWeb(root, dshHome, port)
      const firstUrl = new URL(first.launchUrl)
      expect(firstUrl.origin).toBe(`http://127.0.0.1:${String(port)}`)
      expect(firstUrl.pathname).toBe('/')
      // The printed URL is clean: no launch token, no credentials of any kind.
      expect(firstUrl.search).toBe('')

      // Loopback and localhost authorities are admitted without a cookie.
      const admitted = await describeSettings(port, firstUrl.host)
      expect(admitted.status).toBe(200)
      expect(JSON.parse(admitted.body) as unknown).toMatchObject({
        type: 'server-response',
        rpcId: 'web-auth-real-cli',
        result: { ok: true, value: { namespaces: expect.any(Array) as unknown } },
      })
      expect((await describeSettings(port, `localhost:${String(port)}`)).status).toBe(200)

      // The Host/Origin fence is unchanged: an authority the deployment never
      // declared is refused before admission is consulted.
      const refused = await describeSettings(port, `forged.example:${String(port)}`)
      expect(refused).toEqual({ status: 403, body: 'forbidden' })

      // The clean root URL opens with no token exchange.
      const entry = await fetch(first.launchUrl, { redirect: 'manual' })
      expect(entry.status).toBe(200)

      await stopWeb(first)
      first = undefined
      second = await startWeb(root, dshHome, port)
      const secondUrl = new URL(second.launchUrl)
      expect(secondUrl.origin).toBe(`http://127.0.0.1:${String(port)}`)
      expect(secondUrl.search).toBe('')
      expect((await describeSettings(port, secondUrl.host)).status).toBe(200)
    } catch (error) {
      const evidence = [first?.output(), second?.output()].filter(value => value !== undefined).join('\n')
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${evidence}`, { cause: error })
    } finally {
      if (second !== undefined) await stopWeb(second)
      if (first !== undefined) await stopWeb(first)
      await rm(root, { recursive: true, force: true })
    }
  })
})
