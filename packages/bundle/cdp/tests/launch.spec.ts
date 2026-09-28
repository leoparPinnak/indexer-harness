/**
 * The CDP browser launcher. Every case injects the spawn function, the
 * executable/port reads, and the clock, so no browser is started, no port is
 * bound, and nothing waits on wall-clock time. Temporary user-data directories
 * are created per case and removed in teardown.
 */

import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CdpBrowserNotFoundError,
  CdpBrowserPortTimeoutError,
  CdpBrowserSpawnError,
  DEVTOOLS_ACTIVE_PORT_FILE,
  launchBrowser,
} from '../src/launch.ts'
import type { BrowserLauncherInternals, BrowserSpawn, BrowserSpawnOptions } from '../src/launch.ts'

const directories: string[] = []

/** Create one unique temporary user-data directory owned by the calling case. */
async function tempUserDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cdp-launch-'))
  directories.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** One fake browser child plus the state the owning case mutates. */
interface FakeChild {
  /** The `ChildProcess` stand-in handed to the launcher. */
  process: ChildProcess
  /** Exit state the launcher polls through `exitCode` and `signalCode`. */
  state: { exitCode: number | null; signalCode: NodeJS.Signals | null }
  /** Signals delivered through `kill`. */
  signals: NodeJS.Signals[]
  /** Deliver one `error` event to the listener the launcher registered. */
  emitError(error: Error): void
}

/**
 * Build a fake child whose exit state the case owns.
 * @param pid - process id the launcher reports.
 * @param exitCode - initial exit code; non-null marks the child already gone.
 * @returns the fake child and its inspectable state.
 */
function makeChild(pid: number | undefined = 4242, exitCode: number | null = null): FakeChild {
  const state: FakeChild['state'] = { exitCode, signalCode: null }
  const signals: NodeJS.Signals[] = []
  let errorListener: ((error: Error) => void) | undefined
  const holder: { process?: ChildProcess } = {}
  const child = {
    pid,
    get exitCode(): number | null { return state.exitCode },
    get signalCode(): NodeJS.Signals | null { return state.signalCode },
    kill: (signal?: NodeJS.Signals): boolean => {
      signals.push(signal ?? 'SIGTERM')
      state.signalCode = signal ?? 'SIGTERM'
      return true
    },
    once: (event: string, listener: (error: Error) => void): ChildProcess => {
      if (event === 'error') errorListener = listener
      return holder.process as ChildProcess
    },
  } as unknown as ChildProcess
  holder.process = child
  return {
    process: child,
    state,
    signals,
    emitError: (error: Error): void => { errorListener?.(error) },
  }
}

/** One recorded spawn call. */
interface SpawnCall {
  command: string
  args: readonly string[]
  options: BrowserSpawnOptions
}

/**
 * Build a spawn seam that records its call and returns one fake child.
 * @param child - the process the seam returns.
 * @param calls - the list the seam appends the call to.
 * @returns the spawn function.
 */
function recordingSpawn(child: ChildProcess, calls: SpawnCall[]): BrowserSpawn {
  return (command, args, options) => {
    calls.push({ command, args, options })
    return child
  }
}

/** A clock whose only advance comes from `sleep`, so discovery never waits on real time. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let current = 0
  return {
    now: () => current,
    sleep: (ms: number) => {
      current += ms
      return Promise.resolve()
    },
  }
}

/** One settled launch: either its value or its rejection. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

/**
 * Await one launch and return its rejection as a value.
 * @param promise - the launch under test.
 * @returns the value, or the thrown error.
 */
async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise }
  } catch (error: unknown) {
    return { ok: false, error }
  }
}

/**
 * Write one port file into the case's user-data directory and resolve a launch
 * against it, so discovery succeeds on its first read.
 * @param options - launch options naming the user-data directory.
 * @param portFileText - exact text of the user-data directory's `DevToolsActivePort`.
 * @param internals - the environment seams to inject over the defaults.
 * @returns the launched browser and the recorded spawn calls.
 */
async function launchWithPortFile(
  options: { userDataDir: string; executablePath?: string | undefined; extraArgs?: readonly string[] | undefined },
  portFileText: string,
  internals: Partial<BrowserLauncherInternals> = {},
): Promise<{ browser: Awaited<ReturnType<typeof launchBrowser>>; calls: SpawnCall[]; child: FakeChild }> {
  await writeFile(join(options.userDataDir, DEVTOOLS_ACTIVE_PORT_FILE), portFileText)
  const child = makeChild()
  const calls: SpawnCall[] = []
  const browser = await launchBrowser(options, {
    platform: 'linux',
    exists: () => true,
    spawn: recordingSpawn(child.process, calls),
    ...internals,
  })
  return { browser, calls, child }
}

describe('cdp browser argument list', () => {
  it('builds every documented flag and appends the caller arguments last', async () => {
    const dir = await tempUserDataDir()
    const { calls, browser } = await launchWithPortFile(
      { userDataDir: dir, executablePath: '/usr/bin/chromium', extraArgs: ['--headless=new'] },
      '51000\n/devtools/browser/abc-123\n',
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('/usr/bin/chromium')
    expect(calls[0]?.args).toEqual([
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
    ])
    expect(calls[0]?.options).toEqual({ detached: true, stdio: 'ignore', windowsHide: true })
    expect(browser.port).toBe(51000)
    expect(browser.websocketUrl).toBe('ws://127.0.0.1:51000/devtools/browser/abc-123')
    expect(browser.userDataDir).toBe(dir)
    expect(browser.executablePath).toBe('/usr/bin/chromium')
  })

  it('does not detach the browser on Windows', async () => {
    const dir = await tempUserDataDir()
    const { calls } = await launchWithPortFile(
      { userDataDir: dir, executablePath: 'C:\\chrome\\chrome.exe' },
      '51008\n/devtools/browser/abc\n',
      { platform: 'win32' },
    )
    expect(calls[0]?.options.detached).toBe(false)
  })
})

describe('cdp port-file parsing', () => {
  it('trims trailing whitespace from both lines', async () => {
    const dir = await tempUserDataDir()
    const { browser } = await launchWithPortFile(
      { userDataDir: dir, executablePath: '/usr/bin/chromium' },
      '51000 \n/devtools/browser/abc-123 \n',
    )
    expect(browser.port).toBe(51000)
    expect(browser.websocketUrl).toBe('ws://127.0.0.1:51000/devtools/browser/abc-123')
  })

  it('reports the loopback origin when the second line is blank', async () => {
    const dir = await tempUserDataDir()
    const { browser } = await launchWithPortFile({ userDataDir: dir, executablePath: '/usr/bin/chromium' }, '51001\n\n')
    expect(browser.port).toBe(51001)
    expect(browser.websocketUrl).toBe('ws://127.0.0.1:51001')
  })

  it('accepts a path without a leading slash and CRLF line endings', async () => {
    const dir = await tempUserDataDir()
    const { browser } = await launchWithPortFile(
      { userDataDir: dir, executablePath: '/usr/bin/chromium' },
      '51002\r\nbrowser/abc\r\n',
    )
    expect(browser.websocketUrl).toBe('ws://127.0.0.1:51002/browser/abc')
  })
})

describe('cdp port discovery', () => {
  it('retries at a fixed interval until the port file appears', async () => {
    const dir = await tempUserDataDir()
    const child = makeChild()
    const clock = fakeClock()
    let reads = 0
    const browser = await launchBrowser({ userDataDir: dir, executablePath: '/usr/bin/chromium' }, {
      platform: 'linux',
      exists: () => true,
      now: clock.now,
      sleep: clock.sleep,
      spawn: recordingSpawn(child.process, []),
      readFile: () => {
        reads += 1
        if (reads < 3) return Promise.reject(new Error('ENOENT'))
        return Promise.resolve('51003\n/devtools/browser/abc\n')
      },
    })
    expect(reads).toBe(3)
    expect(browser.websocketUrl).toBe('ws://127.0.0.1:51003/devtools/browser/abc')
  })

  it('fails with a typed timeout error naming the port file and the directory', async () => {
    const dir = await tempUserDataDir()
    const child = makeChild()
    const clock = fakeClock()
    const portFile = join(dir, DEVTOOLS_ACTIVE_PORT_FILE)
    const result = await settle(launchBrowser(
      { userDataDir: dir, executablePath: '/usr/bin/chromium', discoveryTimeoutMs: 100 },
      {
        platform: 'linux',
        exists: () => true,
        now: clock.now,
        sleep: clock.sleep,
        spawn: recordingSpawn(child.process, []),
        readFile: () => Promise.reject(new Error('ENOENT')),
      },
    ))
    if (result.ok) throw new Error('expected the launch to time out')
    expect(result.error).toBeInstanceOf(CdpBrowserPortTimeoutError)
    const error = result.error as CdpBrowserPortTimeoutError
    expect(error.portFile).toBe(portFile)
    expect(error.userDataDir).toBe(dir)
    expect(error.timeoutMs).toBe(100)
    expect(error.message).toContain(portFile)
    expect(error.message).toContain(dir)
  })
})

describe('cdp executable discovery', () => {
  it('refuses a configured executable that does not exist instead of searching', async () => {
    const dir = await tempUserDataDir()
    const searched: string[] = []
    const result = await settle(launchBrowser({ userDataDir: dir, executablePath: 'C:\\nope\\chrome.exe' }, {
      platform: 'win32',
      exists: (path) => {
        searched.push(path)
        return false
      },
    }))
    if (result.ok) throw new Error('expected the launch to fail')
    expect(result.error).toBeInstanceOf(CdpBrowserNotFoundError)
    const error = result.error as CdpBrowserNotFoundError
    expect(error.searched).toEqual(['C:\\nope\\chrome.exe'])
    expect(error.message).toContain('C:\\nope\\chrome.exe')
    expect(searched).toEqual(['C:\\nope\\chrome.exe'])
  })

  it('names every location tried when discovery finds no browser', async () => {
    const dir = await tempUserDataDir()
    const result = await settle(launchBrowser({ userDataDir: dir }, {
      platform: 'linux',
      env: { PATH: '/opt/tools' },
      exists: () => false,
    }))
    if (result.ok) throw new Error('expected the launch to fail')
    expect(result.error).toBeInstanceOf(CdpBrowserNotFoundError)
    const error = result.error as CdpBrowserNotFoundError
    expect(error.searched).toContain('/usr/bin/google-chrome')
    expect(error.searched).toContain(join('/opt/tools', 'chromium'))
    expect(error.message).toContain('/usr/bin/chromium')
    expect(error.message).toContain(join('/opt/tools', 'chromium'))
  })

  it('finds the browser in the documented Linux install locations', async () => {
    const dir = await tempUserDataDir()
    await writeFile(join(dir, DEVTOOLS_ACTIVE_PORT_FILE), '51004\n/devtools/browser/abc\n')
    const child = makeChild()
    const calls: SpawnCall[] = []
    const browser = await launchBrowser({ userDataDir: dir }, {
      platform: 'linux',
      env: { PATH: '/opt/tools' },
      exists: path => path === '/usr/bin/chromium',
      spawn: recordingSpawn(child.process, calls),
    })
    expect(calls[0]?.command).toBe('/usr/bin/chromium')
    expect(browser.executablePath).toBe('/usr/bin/chromium')
  })

  it('searches the documented Windows install locations', async () => {
    const dir = await tempUserDataDir()
    await writeFile(join(dir, DEVTOOLS_ACTIVE_PORT_FILE), '51005\n/devtools/browser/abc\n')
    const programFiles = 'C:\\Program Files'
    const expected = join(programFiles, 'Google\\Chrome\\Application\\chrome.exe')
    const child = makeChild()
    const calls: SpawnCall[] = []
    const browser = await launchBrowser({ userDataDir: dir }, {
      platform: 'win32',
      env: { ProgramFiles: programFiles, PATH: 'C:\\tools' },
      exists: path => path === expected,
      spawn: recordingSpawn(child.process, calls),
    })
    expect(calls[0]?.command).toBe(expected)
    expect(browser.executablePath).toBe(expected)
  })

  it('searches the documented macOS application bundles', async () => {
    const dir = await tempUserDataDir()
    await writeFile(join(dir, DEVTOOLS_ACTIVE_PORT_FILE), '51006\n/devtools/browser/abc\n')
    const expected = join('/Applications', 'Google Chrome.app/Contents/MacOS/Google Chrome')
    const child = makeChild()
    const calls: SpawnCall[] = []
    const browser = await launchBrowser({ userDataDir: dir }, {
      platform: 'darwin',
      env: { HOME: '/Users/tester' },
      exists: path => path === expected,
      spawn: recordingSpawn(child.process, calls),
    })
    expect(calls[0]?.command).toBe(expected)
    expect(browser.executablePath).toBe(expected)
  })
})

describe('cdp launch failures', () => {
  it('surfaces a synchronous spawn failure as a typed error', async () => {
    const dir = await tempUserDataDir()
    const result = await settle(launchBrowser({ userDataDir: dir, executablePath: '/usr/bin/chromium' }, {
      platform: 'linux',
      exists: () => true,
      spawn: () => { throw new Error('EACCES: permission denied') },
    }))
    if (result.ok) throw new Error('expected the launch to fail')
    expect(result.error).toBeInstanceOf(CdpBrowserSpawnError)
    const error = result.error as CdpBrowserSpawnError
    expect(error.executablePath).toBe('/usr/bin/chromium')
    expect(error.message).toContain('EACCES')
  })

  it('surfaces a browser that exits before publishing its port as a typed error', async () => {
    const dir = await tempUserDataDir()
    const child = makeChild(4242, 1)
    const result = await settle(launchBrowser({ userDataDir: dir, executablePath: '/usr/bin/chromium' }, {
      platform: 'linux',
      exists: () => true,
      spawn: recordingSpawn(child.process, []),
      readFile: () => Promise.reject(new Error('ENOENT')),
    }))
    if (result.ok) throw new Error('expected the launch to fail')
    expect(result.error).toBeInstanceOf(CdpBrowserSpawnError)
    expect((result.error as CdpBrowserSpawnError).message).toContain('exited before')
  })

  it('surfaces an asynchronous spawn error recorded while waiting for the port', async () => {
    const dir = await tempUserDataDir()
    const child = makeChild()
    const clock = fakeClock()
    const failure = new Error('spawn ENOENT')
    const result = await settle(launchBrowser({ userDataDir: dir, executablePath: '/usr/bin/chromium' }, {
      platform: 'linux',
      exists: () => true,
      now: clock.now,
      spawn: recordingSpawn(child.process, []),
      readFile: () => Promise.reject(new Error('ENOENT')),
      sleep: async (ms) => {
        await clock.sleep(ms)
        child.emitError(failure)
      },
    }))
    if (result.ok) throw new Error('expected the launch to fail')
    expect(result.error).toBeInstanceOf(CdpBrowserSpawnError)
    expect((result.error as CdpBrowserSpawnError).message).toContain('spawn ENOENT')
  })

  it('refuses an empty userDataDir before spawning', async () => {
    const result = await settle(launchBrowser({ userDataDir: '' }, {
      spawn: () => { throw new Error('must not spawn') },
    }))
    if (result.ok) throw new Error('expected the launch to fail')
    expect((result.error as Error).message).toContain('userDataDir')
  })

  it('refuses a non-positive discovery timeout before spawning', async () => {
    const dir = await tempUserDataDir()
    const result = await settle(launchBrowser({ userDataDir: dir, discoveryTimeoutMs: 0 }, {
      spawn: () => { throw new Error('must not spawn') },
    }))
    if (result.ok) throw new Error('expected the launch to fail')
    expect((result.error as Error).message).toContain('discoveryTimeoutMs')
  })
})

describe('cdp close', () => {
  it('terminates the browser tree and is idempotent', async () => {
    const dir = await tempUserDataDir()
    const portFile = join(dir, DEVTOOLS_ACTIVE_PORT_FILE)
    const portFileText = '51007\n/devtools/browser/abc\n'
    await writeFile(portFile, portFileText)
    const child = makeChild()
    const killed: number[] = []
    const browser = await launchBrowser({ userDataDir: dir, executablePath: '/usr/bin/chromium' }, {
      platform: 'linux',
      exists: () => true,
      spawn: recordingSpawn(child.process, []),
      killTree: (pid) => {
        killed.push(pid)
        child.state.exitCode = 0
      },
    })

    await browser.close()
    await browser.close()

    expect(killed).toEqual([4242])
    // close() removes nothing it did not create: the caller's directory and the
    // browser's port file survive exactly as the browser left them.
    expect(await readFile(portFile, 'utf8')).toBe(portFileText)
  })
})
