/**
 * Import-time approval posture freeze (mirror of hermes `tools/approval.py`
 * `_YOLO_MODE_FROZEN`): the environment is read exactly once at module import,
 * so a mutation after import can move neither the frozen posture nor the
 * config default derived from it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const ENV_KEY = 'DSH_PERMISSION_MODE'
const original = process.env[ENV_KEY]

/** Re-import the module under test with a clean registry (fresh module scope). */
async function importFresh(): Promise<typeof import('../src/index.ts')> {
  vi.resetModules()
  return import('../src/index.ts')
}

afterEach(() => {
  vi.resetModules()
  if (original === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = original
})

describe('import-time approval posture freeze', () => {
  it("freezes danger-full-access to 'never' at import; a later env change cannot move it", async () => {
    process.env[ENV_KEY] = 'danger-full-access'
    const fresh = await importFresh()
    expect(fresh.APPROVAL_POSTURE_FROZEN).toBe('never')

    process.env[ENV_KEY] = 'workspace-write'
    expect(fresh.APPROVAL_POSTURE_FROZEN).toBe('never')
  })

  it("freezes the default to 'ask' when the environment carries no restrictive posture", async () => {
    delete process.env[ENV_KEY]
    const fresh = await importFresh()
    expect(fresh.APPROVAL_POSTURE_FROZEN).toBe('ask')

    process.env[ENV_KEY] = 'danger-full-access'
    expect(fresh.APPROVAL_POSTURE_FROZEN).toBe('ask')
  })

  it('defaults an omitted policy to the frozen posture, and stays put across a re-parse', async () => {
    process.env[ENV_KEY] = 'danger-full-access'
    const fresh = await importFresh()
    // The same standard-schema entry the loader's resolveConfig applies.
    expect(fresh.ApprovalService.Config['~standard'].validate({})).toEqual({ value: { policy: 'never' } })

    // A config re-parse after a post-import environment mutation must not move.
    process.env[ENV_KEY] = 'workspace-write'
    expect(fresh.ApprovalService.Config['~standard'].validate({})).toEqual({ value: { policy: 'never' } })
  })

  it("an explicit config still wins over the frozen default ('ask' stays 'ask')", async () => {
    process.env[ENV_KEY] = 'danger-full-access'
    const fresh = await importFresh()
    expect(fresh.ApprovalService.Config['~standard'].validate({ policy: 'ask' }))
      .toEqual({ value: { policy: 'ask' } })
  })
})
