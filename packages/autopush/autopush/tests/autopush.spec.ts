/**
 * Auto-push behavior: the logged toggle and push history the dashboard reads,
 * the git decisions the tool makes, and the config validation that fails loud.
 *
 * The git runner is injected, so the tool's decisions are pinned without a
 * repository: what happens on a clean tree, on a dirty one, and when a push is
 * refused after its commit already exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AutoPushController, { pushWorkspace, resolveConfig } from '../src/index.ts'
import { internals } from '../src/git.ts'
import type { GitResult, GitRunner } from '../src/git.ts'

const CONFIG = { remote: 'origin', branch: 'master' }

/** An absolute workspace for the bench session; git is faked, so nothing here is written. */
const WORKSPACE = join(tmpdir(), 'dsh-autopush-bench')

/** One scripted git invocation result. */
function result(code: number, stdout = '', stderr = ''): GitResult {
  return { code, stdout, stderr }
}

/**
 * A git runner answering from a script keyed by the command's first argument.
 * @param answers - one reply per subcommand, most recent call first.
 * @returns the runner and the calls it recorded.
 */
function fakeGit(answers: Record<string, GitResult | GitResult[]>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  const git: GitRunner = async (args) => {
    calls.push([...args])
    const entry = answers[args[0] ?? '']
    if (entry === undefined) return result(0)
    return Array.isArray(entry) ? entry.shift() ?? result(0) : entry
  }
  return { git, calls }
}

async function bench(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AutoPushController, CONFIG)
  const session = ctx.sessions.create(undefined, { meta: { cwd: WORKSPACE } })
  return { ctx, session }
}

const view = (ctx: Context, session: Session) => (ctx.sessionProjections.snapshot(session).values as Record<string, unknown>).autopush

afterEach(() => {
  internals.git = internals.git
  vi.restoreAllMocks()
  rmSync(WORKSPACE, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(WORKSPACE, { recursive: true, force: true })
})

describe('autopush config', () => {
  it('needs a remote and a branch and rejects unknown keys', () => {
    expect(resolveConfig(CONFIG)).toEqual(CONFIG)
    expect(() => resolveConfig({ remote: '', branch: 'master' })).toThrow(/remote/u)
    expect(() => resolveConfig({ remote: 'origin', branch: ' ' })).toThrow(/branch/u)
    expect(() => resolveConfig({ ...CONFIG, extra: 1 } as never)).toThrow(/unknown key/u)
  })
})

describe('autopush projection', () => {
  it('starts off with no history and folds the logged toggle', async () => {
    const { ctx, session } = await bench()
    expect(view(ctx, session)).toEqual({ enabled: false, count: 0, lastAt: null, history: [], projectHistory: [] })

    expect(ctx.autoPush.set(session, true)).toBe('committed')
    expect(ctx.autoPush.set(session, true)).toBe('noop')
    expect(view(ctx, session)).toEqual({ enabled: true, count: 0, lastAt: null, history: [], projectHistory: [] })
    expect(ctx.autoPush.enabled(session)).toBe(true)

    ctx.autoPush.set(session, false)
    expect(ctx.autoPush.enabled(session)).toBe(false)
  })

  it('counts pushes newest first and keeps the newest fifty on the wire', async () => {
    const { ctx, session } = await bench()
    for (let index = 0; index < 55; index++) {
      session.append('autopush/push', {
        at: 1000 + index, message: `iş ${String(index)}`, sha: `s${String(index)}`, files: 1, ...CONFIG,
      })
    }
    const projected = view(ctx, session) as { count: number; lastAt: number; history: unknown[] }
    expect(projected.count).toBe(55)
    expect(projected.lastAt).toBe(1054)
    expect(projected.history).toHaveLength(50)
    expect((projected.history[0] as { message: string }).message).toBe('iş 54')
  })
})

describe('push decisions', () => {
  it('commits and pushes a dirty workspace', async () => {
    const { git, calls } = fakeGit({
      status: result(0, ' M a.ts\n?? b.ts\n'),
      'rev-parse': result(0, 'abc1234\n'),
    })
    const outcome = await pushWorkspace(git, 'C:/work', 'buton eklendi', CONFIG)
    expect(outcome).toEqual({
      pushed: true, sha: 'abc1234', files: 2, pending: 0,
      detail: '2 dosya commit\'lendi ve origin/master dalına gönderildi.',
    })
    expect(calls.map(call => call[0])).toEqual(['status', 'add', 'commit', 'push', 'rev-parse'])
    expect(calls[2]).toEqual(['commit', '-m', 'buton eklendi'])
  })

  it('pushes only what is already committed when the tree is clean', async () => {
    const { git, calls } = fakeGit({
      status: result(0, ''),
      'rev-list': result(0, '3\n'),
      'rev-parse': result(0, 'def5678\n'),
    })
    const outcome = await pushWorkspace(git, 'C:/work', 'yok', CONFIG)
    expect(outcome.pushed).toBe(true)
    expect(outcome.files).toBe(0)
    expect(outcome.pending).toBe(3)
    expect(calls.map(call => call[0])).toEqual(['status', 'rev-list', 'push', 'rev-parse'])
  })

  it('does nothing when the tree is clean and the branch is in sync', async () => {
    const { git, calls } = fakeGit({ status: result(0, ''), 'rev-list': result(0, '0\n') })
    const outcome = await pushWorkspace(git, 'C:/work', 'yok', CONFIG)
    expect(outcome.pushed).toBe(false)
    expect(outcome.detail).toBe('Pushlanacak değişiklik yok.')
    expect(calls.map(call => call[0])).toEqual(['status', 'rev-list'])
  })

  it('fails loud when git refuses a step', async () => {
    const status = fakeGit({ status: result(128, '', 'not a git repository') })
    await expect(pushWorkspace(status.git, 'C:/work', 'x', CONFIG)).rejects.toThrow(/git status failed/u)

    const commit = fakeGit({ status: result(0, ' M a.ts\n'), commit: result(1, '', 'hook reddetti') })
    await expect(pushWorkspace(commit.git, 'C:/work', 'x', CONFIG)).rejects.toThrow(/git commit failed: hook reddetti/u)

    // The commit stays; the message says so, because only publication failed.
    const push = fakeGit({ status: result(0, ' M a.ts\n'), push: result(1, '', 'kimlik yok'), 'rev-parse': result(0, 'abc\n') })
    await expect(pushWorkspace(push.git, 'C:/work', 'x', CONFIG)).rejects.toThrow(/commit oluştu ama push başarısız/u)
  })
})

describe('the push tool through the service', () => {
  it('refuses while the toggle is off', async () => {
    const { ctx, session } = await bench()
    await expect(ctx.autoPush.push(session, 'deneme')).rejects.toThrow(/auto-push is off/u)
  })

  it('records one push in the session log, and records nothing when there was nothing to push', async () => {
    const { ctx, session } = await bench()
    ctx.autoPush.set(session, true)

    internals.git = fakeGit({ status: result(0, ' M a.ts\n'), 'rev-parse': result(0, 'abc1234\n') }).git
    const pushed = await ctx.autoPush.push(session, '  düzenleyici kaydetme  ')
    expect(pushed.pushed).toBe(true)
    const afterFirst = view(ctx, session) as { count: number; lastAt: number; history: { message: string; files: number }[] }
    expect(afterFirst.count).toBe(1)
    expect(afterFirst.lastAt).toBeGreaterThan(0)
    expect(afterFirst.history[0]).toEqual(expect.objectContaining({ message: 'düzenleyici kaydetme', files: 1 }))

    internals.git = fakeGit({ status: result(0, ''), 'rev-list': result(0, '0\n') }).git
    const idle = await ctx.autoPush.push(session, 'boş')
    expect(idle.pushed).toBe(false)
    expect((view(ctx, session) as { count: number }).count).toBe(1)
  })

  it('refuses an empty description', async () => {
    const { ctx, session } = await bench()
    ctx.autoPush.set(session, true)
    await expect(ctx.autoPush.push(session, '   ')).rejects.toThrow(/non-empty Turkish description/u)
  })

  it('publishes pending commits on retry and records the original commit message from git log', async () => {
    const { ctx, session } = await bench()
    ctx.autoPush.set(session, true)

    internals.git = fakeGit({
      status: result(0, ''),
      'rev-list': result(0, '1\n'),
      'rev-parse': result(0, 'fedcba9\n'),
      log: result(0, 'Kritik Düzeltme: Bekleyen commit mesajı\n'),
    }).git

    const pushed = await ctx.autoPush.push(session, 'yeniden deneme')
    expect(pushed.pushed).toBe(true)
    expect(pushed.pending).toBe(1)

    const projected = view(ctx, session) as { count: number; history: { message: string; sha: string }[] }
    expect(projected.count).toBe(1)
    expect(projected.history[0]).toEqual(expect.objectContaining({
      message: 'Kritik Düzeltme: Bekleyen commit mesajı',
      sha: 'fedcba9',
    }))
  })
})
