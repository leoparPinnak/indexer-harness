/**
 * The vendor loader's group update (`vendor/loader/src/config/group.ts`): a
 * transient entry failure is retried on a bounded jittered backoff before the
 * transaction is reported, and a failure a wait cannot clear is reported at
 * once. It lives in this package's suite because vendor/ ships no test lane
 * (the include glob only picks up `packages` test directories) and the
 * standing mount is the group update's consumer on this side of the boundary.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { updateBackoffWaitMs } from '@deepseek-ai/cordis-plugin-loader/src/config/group.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
// A file URL, the form the loader's import seam receives once a composition
// has been resolved; a bare Windows path reaches Node's ESM loader as `c:`.
const IDLE_ROW = pathToFileURL(join(FIXTURES, 'plugins', 'idle.js')).href

/** One empty group under the smallest host that can run one: a bare Loader. */
async function groupCtx(): Promise<{ ctx: Context; group: EntryGroup }> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  const groupId = await ctx.loader.create({ name: 'cordis:group', group: true, config: [] })
  return { ctx, group: ctx.loader.resolveGroup(groupId) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the group update backoff', () => {
  it('retries a transient entry failure on the bounded schedule and applies the update', async () => {
    const { ctx, group } = await groupCtx()
    const internal = ctx.loader.internal!
    const original = internal.import.bind(internal)
    const busy = Object.assign(new Error('module busy'), { code: 'EBUSY' })
    const imported = vi.spyOn(internal, 'import')
      .mockImplementationOnce(() => Promise.reject(busy))
      .mockImplementationOnce(() => Promise.reject(busy))
      .mockImplementation(original)

    await group.update([{ id: 'row', name: IDLE_ROW }])

    // Two refused imports, then the real one: the retry is what landed it.
    expect(imported).toHaveBeenCalledTimes(3)
    expect(ctx.loader.resolve('row').options.name).toBe(IDLE_ROW)
  })

  it('stops at the attempt bound and reports the failure it could not clear', async () => {
    const { ctx, group } = await groupCtx()
    const busy = Object.assign(new Error('module busy'), { code: 'EBUSY' })
    const imported = vi.spyOn(ctx.loader.internal!, 'import').mockRejectedValue(busy)

    await expect(group.update([{ id: 'row', name: IDLE_ROW }])).rejects.toThrow(/module busy/)

    // Three attempts, no fourth: the bound is what keeps a contended loader
    // re-applying the same update forever.
    expect(imported).toHaveBeenCalledTimes(3)
    expect(() => ctx.loader.resolve('row')).toThrow(/cannot resolve entry/)
  })

  it('reports a failure a wait cannot clear on the first attempt', async () => {
    const { ctx, group } = await groupCtx()
    const imported = vi.spyOn(ctx.loader.internal!, 'import')
      .mockRejectedValue(new Error('composition will not parse'))

    await expect(group.update([{ id: 'row', name: IDLE_ROW }])).rejects.toThrow(/will not parse/)

    expect(imported).toHaveBeenCalledTimes(1)
  })

  it('rolls back to the entries it had before the transaction reports', async () => {
    const { ctx, group } = await groupCtx()
    await group.update([{ id: 'before', name: IDLE_ROW }])
    vi.spyOn(ctx.loader.internal!, 'import').mockRejectedValue(new Error('never resolves'))

    await expect(group.update([{ id: 'after', name: IDLE_ROW }])).rejects.toThrow(/never resolves/)

    // The compensating transaction ran before the rejection: the addition is
    // gone and the previous generation is back in place, so a follow-up
    // update reconciles against the OLD config, not a half-applied one.
    expect(group.data.map(row => row.id)).toEqual(['before'])
    expect(() => ctx.loader.resolve('after')).toThrow(/cannot resolve entry/)
    expect(ctx.loader.resolve('before').options.name).toBe(IDLE_ROW)
  })

  it('jitters each wait into the upper half of a doubling, capped ceiling', () => {
    expect(updateBackoffWaitMs(0, () => 0)).toBe(25)
    expect(updateBackoffWaitMs(0, () => 0.999)).toBe(50)
    expect(updateBackoffWaitMs(1, () => 0)).toBe(50)
    expect(updateBackoffWaitMs(1, () => 0.999)).toBe(100)
    expect(updateBackoffWaitMs(2, () => 0.999)).toBe(200)
    // The ceiling caps the wait however many attempts a deployment allows.
    expect(updateBackoffWaitMs(9, () => 0)).toBe(500)
    expect(updateBackoffWaitMs(9, () => 0.999)).toBe(1_000)
  })
})
