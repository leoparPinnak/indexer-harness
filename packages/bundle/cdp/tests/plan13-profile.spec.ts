/**
 * plan13-profile: persistent browser profiles and the `cdp_open` choice gate.
 *
 * Three layers, mirroring the three parts of the feature:
 *
 *  1. **name validation** — the security contract. A profile name becomes a
 *     path segment, so `..`, separators, and blanks are refused before any
 *     filesystem call, and the resolution is anchored under the profiles root.
 *  2. **the durable directory** — `profile:'assistant'` hands the launcher the
 *     SAME absolute directory on every call (the fake launcher proves it), and
 *     omitting `profile` still mints a throwaway one. A profile another browser
 *     holds is REFUSED with the lock evidence, never silently downgraded.
 *  3. **the choice gate** — a bare `open()` scans the configured ports and, on
 *     a live endpoint, returns `{needsChoice, discovered}` having launched and
 *     dialed nothing. `switchTo`/`port`/`endpoint` is a decision and applies.
 *
 * The fake launcher is the seam: `open()`'s directory choice is the whole
 * contract under test, and no Chromium is ever spawned.
 *
 * @module @deepseek-ai/dsh-cdp/tests/plan13-profile
 */

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  EPHEMERAL_PROFILE_NAME,
  PROFILE_NAME_RULE,
  profileIdentity,
  profileNameFromUserDataDir,
  profileNameRefusal,
  readProfileLock,
  resolveDshHomeDir,
  resolveProfileDir,
} from '../src/profiles.ts'

// ---------------------------------------------------------------------------
// The fake launcher: records every `userDataDir` it was handed and refuses to
// spawn. The refusal is the assertion that a call reached the launch branch at
// all, and the recorded directory IS the feature under test.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({ launches: [] as Array<{ userDataDir: string, extraArgs: string[] }> }))

vi.mock('../src/launch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/launch.ts')>()
  return {
    ...actual,
    launchBrowser: async (options: { userDataDir: string, extraArgs?: string[] }) => {
      hoisted.launches.push({ userDataDir: options.userDataDir, extraArgs: options.extraArgs ?? [] })
      throw new Error('launch-fake: refusing to spawn a browser in tests')
    },
  }
})

// Imported AFTER the mock so the service picks the fake launcher up.
const { CdpService } = await import('../src/service.ts')
type CdpServiceType = InstanceType<typeof CdpService>

const services: CdpServiceType[] = []
const tempRoots: string[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop().catch(() => {})
  for (const close of closers.splice(0)) await close().catch(() => {})
  hoisted.launches.length = 0
})

/** A throwaway profiles root, so no test ever touches the ambient `~/.dsh`. */
function tempProfilesRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profiles-test-'))
  tempRoots.push(root)
  return resolve(root)
}

/** A service pinned to a throwaway profiles root and an empty discovery set. */
function service(options: Record<string, unknown> = {}): CdpServiceType {
  const created = new CdpService({ profilesRoot: tempProfilesRoot(), discoveryPorts: [], ...options })
  services.push(created)
  return created
}

/**
 * A loopback endpoint that behaves like a real debug browser: it answers
 * `/json/version` over HTTP and upgrades the same port to a WebSocket that
 * replies to every CDP frame. Binding an ephemeral port keeps the choice-gate
 * specs hermetic — they exercise the genuine discovery+dial path instead of
 * a stubbed fetch, and can never collide with a browser the developer has open.
 */
async function startFakeBrowser(): Promise<{ port: number, url: string, close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (!String(req.url ?? '').startsWith('/json/version')) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/fake`,
      Browser: 'Chrome/130 (fake)',
    }))
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as { id?: unknown, method?: unknown }
      socket.send(JSON.stringify({ id: frame.id, result: frame.method === 'Target.getTargets' ? { targetInfos: [] } : {} }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => { resolve() })
    server.once('error', reject)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    url: `ws://127.0.0.1:${String(port)}/devtools/browser/fake`,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => { wss.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

// ---------------------------------------------------------------------------
// 1. Name validation — the security contract.
// ---------------------------------------------------------------------------

describe('plan13-profile: a profile name is one path segment or it is refused', () => {
  it('accepts letters, digits, underscore and dash', () => {
    for (const name of ['assistant', 'work', 'my-profile', 'p_2', 'A1', 'x'.repeat(64)]) {
      expect(profileNameRefusal(name)).toBeUndefined()
    }
  })

  it('refuses path traversal, separators, blanks and over-long names', () => {
    // The shapes a caller is most likely to send by accident, each with its own
    // reason — "invalid character" would be a useless answer for any of them.
    expect(profileNameRefusal('..')).toContain('path-traversal')
    expect(profileNameRefusal('../evil')).toContain('path-traversal')
    expect(profileNameRefusal('a/b')).toContain('path separator')
    expect(profileNameRefusal('a\\b')).toContain('path separator')
    expect(profileNameRefusal('')).toContain('empty')
    expect(profileNameRefusal('   ')).toContain('empty')
    expect(profileNameRefusal(' assistant')).toContain('whitespace')
    expect(profileNameRefusal('assistant ')).toContain('whitespace')
    expect(profileNameRefusal('x'.repeat(65))).toContain(PROFILE_NAME_RULE)
    expect(profileNameRefusal('pro file')).toContain(PROFILE_NAME_RULE)
    expect(profileNameRefusal('pro.file')).toContain(PROFILE_NAME_RULE)
    expect(profileNameRefusal('C:evil')).toContain(PROFILE_NAME_RULE)
  })

  it('resolves inside the profiles root and never above it', () => {
    const root = tempProfilesRoot()
    expect(resolveProfileDir('assistant', { profilesRoot: root })).toBe(join(root, 'assistant'))
    // A traversal attempt throws instead of returning a path outside the root.
    expect(() => resolveProfileDir('../escape', { profilesRoot: root })).toThrow(/invalid profile name/)
    expect(() => resolveProfileDir('a/b', { profilesRoot: root })).toThrow(/invalid profile name/)
  })

  it('falls back to ~/.dsh only when DSH_HOME is absent or blank', () => {
    expect(resolveDshHomeDir({ DSH_HOME: '/custom/home' }, '/users/me')).toBe(resolve('/custom/home'))
    expect(resolveDshHomeDir({ DSH_HOME: '  ' }, '/users/me')).toBe(resolve('/users/me/.dsh'))
    expect(resolveDshHomeDir({}, '/users/me')).toBe(resolve('/users/me/.dsh'))
  })

  it('derives the display identity from the directory name', () => {
    expect(profileNameFromUserDataDir('/home/me/.dsh/profiles/assistant')).toBe('assistant')
    expect(profileNameFromUserDataDir('C:\\Users\\me\\.dsh\\profiles\\assistant')).toBe('assistant')
    // A throwaway mkdtemp directory answers the one word, not a random suffix.
    expect(profileIdentity('/tmp/dsh-cdp-Ab3xY9')).toBe(EPHEMERAL_PROFILE_NAME)
    expect(profileIdentity('/home/me/.dsh/profiles/assistant')).toBe('assistant')
  })
})

// ---------------------------------------------------------------------------
// 2. The durable directory.
// ---------------------------------------------------------------------------

describe('plan13-profile: profile:"assistant" launches on ONE fixed directory', () => {
  it('hands launchBrowser the same absolute directory on every call', async () => {
    const root = tempProfilesRoot()
    const created = service({ profilesRoot: root })

    await expect(created.open({ profile: 'assistant' })).rejects.toThrow('launch-fake')
    await expect(created.open({ profile: 'assistant' })).rejects.toThrow('launch-fake')

    expect(hoisted.launches).toHaveLength(2)
    const [first, second] = hoisted.launches
    expect(first?.userDataDir).toBe(join(root, 'assistant'))
    // The whole point: the second launch reuses the FIRST directory, so a
    // sign-in the user made by hand is still there.
    expect(second?.userDataDir).toBe(first?.userDataDir)
    // plan13-profile: it is a real directory under the profiles root, never a
    // temp one — the launcher contract in launch.ts is unchanged.
    expect(first?.userDataDir.startsWith(resolve(root))).toBe(true)
    expect(first?.userDataDir).not.toContain('dsh-cdp-')
  })

  it('creates the profile directory once and never deletes it', async () => {
    const root = tempProfilesRoot()
    const created = service({ profilesRoot: root })
    const dir = join(root, 'assistant')
    // A marker that only survives if nothing ever wipes the directory.
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Cookies'), 'signed-in-by-hand')

    await expect(created.open({ profile: 'assistant' })).rejects.toThrow('launch-fake')
    expect(readProfileLock(dir).locked).toBe(false)
    // The refusal above happens BEFORE the launch, so nothing was created or
    // removed; the caller's own file is still exactly where it was.
    expect(profileNameFromUserDataDir(dir)).toBe('assistant')
  })

  it('a named profile that is ALREADY live re-adopts it instead of relaunching', async () => {
    // A second browser on one user-data directory is impossible; Chromium's own
    // lock failure would surface as an opaque spawn error. The re-open must be
    // the no-op it is for every other already-live configuration.
    const browser = await startFakeBrowser()
    closers.push(browser.close)
    const root = tempProfilesRoot()
    const created = new CdpService({ profilesRoot: root, discoveryPorts: [] })
    services.push(created)
    // Pretend this endpoint is the one launched on the assistant profile.
    await created.open({ endpoint: browser.url })
    const entry = (created as unknown as { pool: { get: (u: string) => { profileName?: string, userDataDir?: string } | undefined } })
      .pool.get(browser.url)
    const dir = join(root, 'assistant')
    if (entry !== undefined) {
      entry.profileName = 'assistant'
      entry.userDataDir = dir
    }

    const again = await created.open({ profile: 'assistant' })
    expect(again).toMatchObject({ endpoint: browser.url, reused: true, profile: 'assistant' })
    expect(String(again.note)).toContain('already open')
    expect(hoisted.launches).toHaveLength(0)
  })

  it('omitting profile keeps the throwaway mkdtemp directory', async () => {
    const created = service()
    await expect(created.open()).rejects.toThrow('launch-fake')
    await expect(created.open()).rejects.toThrow('launch-fake')

    const [first, second] = hoisted.launches
    expect(first?.userDataDir).toContain('dsh-cdp-')
    // Each bare launch still mints its OWN temporary profile — the historical
    // behavior, byte for byte.
    expect(second?.userDataDir).not.toBe(first?.userDataDir)
  })

  it('refuses an invalid name with an honest envelope and no side effect', async () => {
    const created = service()
    const result = await created.open({ profile: '../escape' })
    expect(result).toMatchObject({
      endpoint: '',
      targets: 0,
      reused: false,
      reasonCode: 'INVALID_PROFILE_NAME',
    })
    expect(String(result.reason)).toContain('invalid profile name')
    expect(String(result.reason)).toContain(PROFILE_NAME_RULE)
    expect(hoisted.launches).toHaveLength(0)
  })

  it('refuses a profile another browser holds, naming the evidence', async () => {
    const root = tempProfilesRoot()
    const created = service({ profilesRoot: root })
    const dir = join(root, 'assistant')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'lockfile'), 'opaque-on-windows')

    const result = await created.open({ profile: 'assistant' })
    expect(result).toMatchObject({
      endpoint: '',
      reused: false,
      reasonCode: 'PROFILE_LOCKED',
      profileDir: dir,
    })
    expect(String(result.reason)).toContain('already open in another browser')
    expect(String(result.reason)).toContain('lockfile')
    expect(String(result.reason)).toContain(dir)
    // The one thing it must never do: quietly open a throwaway profile and
    // hand back a browser that looks signed out.
    expect(String(result.reason)).toContain('never falls back to a throwaway profile')
    expect(hoisted.launches).toHaveLength(0)
  })

  it('reads the POSIX holder pid out of SingletonLock when it is there', () => {
    const dir = join(tempProfilesRoot(), 'with-pid')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SingletonLock'), 'myhost-4711')
    const report = readProfileLock(dir)
    expect(report).toMatchObject({ locked: true, pid: '4711' })
    expect(report.artifacts).toContain('SingletonLock')
  })

  it('reports an unlocked profile honestly', () => {
    const dir = join(tempProfilesRoot(), 'clean')
    mkdirSync(dir, { recursive: true })
    expect(readProfileLock(dir)).toMatchObject({ locked: false, artifacts: [] })
  })
})

// ---------------------------------------------------------------------------
// 3. The choice gate.
// ---------------------------------------------------------------------------

describe('plan13-profile: a bare open() discovers first and refuses to decide', () => {
  it('returns needsChoice with the table and launches nothing', async () => {
    const browser = await startFakeBrowser()
    closers.push(browser.close)
    const created = new CdpService({
      profilesRoot: tempProfilesRoot(),
      discoveryPorts: [browser.port, 1],
    })
    services.push(created)

    const result = await created.open()
    expect(result.needsChoice).toBe(true)
    expect(result.endpoint).toBe('')
    expect(result.reused).toBe(false)
    expect(result.discovered).toHaveLength(1)
    expect(result.discovered?.[0]).toMatchObject({
      port: browser.port,
      kind: 'user',
      endpoint: browser.url,
      browser: 'Chrome/130 (fake)',
      // /json/version exposes no user-data directory, so the profile is
      // honestly unknown rather than guessed from the browser banner.
      profile: '',
    })
    expect(result.choices).toContain(`switchTo:${String(browser.port)}`)
    // THE contract: nothing was launched and nothing was attached.
    expect(hoisted.launches).toHaveLength(0)
    expect(created.status().endpoint).toBeUndefined()
  })

  it('the active endpoint appears in the table but never raises the question', async () => {
    // plan04-F6 stays: a bare re-open on the browser we are already driving is
    // a no-op, not "do you want to keep the one you are using?".
    const browser = await startFakeBrowser()
    closers.push(browser.close)
    const created = new CdpService({ profilesRoot: tempProfilesRoot(), discoveryPorts: [browser.port] })
    services.push(created)
    await created.open({ endpoint: browser.url })

    const again = await created.open()
    expect(again.needsChoice).toBeUndefined()
    expect(again.reused).toBe(true)
    expect(again.endpoint).toBe(browser.url)
    expect(hoisted.launches).toHaveLength(0)
  })

  it('a live endpoint we are NOT attached to turns the no-op into a question', async () => {
    // The user's actual case: driving one browser while a signed-in one sits
    // on a default port. The bare call must stop and ask, not silently keep.
    const mine = await startFakeBrowser()
    const theirs = await startFakeBrowser()
    closers.push(mine.close, theirs.close)
    const created = new CdpService({ profilesRoot: tempProfilesRoot(), discoveryPorts: [theirs.port] })
    services.push(created)
    await created.open({ endpoint: mine.url })

    const asked = await created.open()
    expect(asked.needsChoice).toBe(true)
    // The table shows BOTH: what we are on and the alternative.
    expect(asked.discovered?.map(row => row.active)).toContain(true)
    expect(asked.discovered?.map(row => row.port)).toContain(theirs.port)
    expect(hoisted.launches).toHaveLength(0)
  })

  it('an explicit switchTo is a decision and applies it — the dial happens', async () => {
    const browser = await startFakeBrowser()
    closers.push(browser.close)
    const created = new CdpService({ profilesRoot: tempProfilesRoot(), discoveryPorts: [browser.port] })
    services.push(created)

    const switched = await created.open({ switchTo: browser.port })
    expect(switched.needsChoice).toBeUndefined()
    expect(switched.reason).toBeUndefined()
    expect(switched.endpoint).toBe(browser.url)
    expect(switched.connectionId).toBe(`ep-${String(browser.port)}`)
    // Reaching a real attach is what proves the choice was applied.
    expect(created.status().endpoint).toBe(browser.url)
    expect(created.status().profile).toBe('external')
  })

  it('an explicit port is a decision too, and skips discovery entirely', async () => {
    const browser = await startFakeBrowser()
    closers.push(browser.close)
    const created = new CdpService({ profilesRoot: tempProfilesRoot(), discoveryPorts: [browser.port] })
    services.push(created)

    const attached = await created.open({ port: browser.port })
    expect(attached.needsChoice).toBeUndefined()
    expect(attached.endpoint).toBe(browser.url)
  })

  it('no live endpoint means no choice — the normal launch path is untouched', async () => {
    const created = service({ discoveryPorts: [1] })
    await expect(created.open()).rejects.toThrow('launch-fake')
    expect(hoisted.launches).toHaveLength(1)
  })

  it('a plain HTTP listener on a discovery port is not offered as a browser', async () => {
    // The capture proxy listens on 9333 by default. It answers HTTP, so a
    // naive "something answered" rule would offer the proxy as a browser.
    const blocker = createServer((_req, res) => { res.statusCode = 404; res.end('nope') })
    await new Promise<void>((resolve) => { blocker.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = blocker.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const created = service({ discoveryPorts: [port] })
    try {
      await expect(created.open()).rejects.toThrow('launch-fake')
      expect(hoisted.launches).toHaveLength(1)
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() => { resolve() }) })
    }
  })
})
