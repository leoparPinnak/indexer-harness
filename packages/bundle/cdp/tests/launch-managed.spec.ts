import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { CdpBrowserNotFoundError, launchBrowser, managedCandidates } from '../src/launch.ts'

/** Seam kit that resolves nothing and must never spawn: proves the STRICT miss. */
function inertInternals(): Parameters<typeof launchBrowser>[1] {
  return {
    platform: 'win32',
    env: { PATH: 'C:\\sys' },
    exists: () => false,
    readFile: async () => { throw new Error('no port file') },
    spawn: () => { throw new Error('spawn must not be reached on a strict miss') },
    killTree: () => {},
    now: () => 0,
    sleep: async () => {},
  }
}

describe('managed browser channel (plan16-managed)', () => {
  it('candidates follow the platform executable names', () => {
    expect(managedCandidates('C:\\h\\browser', 'win32'))
      .toEqual([join('C:\\h\\browser', 'chrome.exe'), join('C:\\h\\browser', 'chromium.exe'), join('C:\\h\\browser', 'msedge.exe')])
    const linux = managedCandidates('/h/browser', 'linux')
    expect(linux).toEqual([join('/h/browser', 'chrome'), join('/h/browser', 'chromium'), join('/h/browser', 'google-chrome')])
  })

  it('a strict miss names ONLY the managed candidates — no system fall-back leaks in', async () => {
    const seen: string[] = []
    const internals = { ...inertInternals(), exists: (p: string) => { seen.push(p); return false } }
    await expect(launchBrowser({ userDataDir: 'C:\\udd', managedDir: 'C:\\h\\browser', discoveryTimeoutMs: 10 }, internals))
      .rejects.toBeInstanceOf(CdpBrowserNotFoundError)
    // The attempted set is exactly the three managed names — the point of a pin.
    expect(seen).toEqual(managedCandidates('C:\\h\\browser', 'win32'))
    expect(seen.some(p => p.toLowerCase().includes('google'))).toBe(false)
  })

  it('an explicit executablePath WINS over the managed dir (checked first, alone)', async () => {
    const seen: string[] = []
    const internals = {
      ...inertInternals(),
      exists: (p: string) => { seen.push(p); return p === 'C:\\pin\\chrome.exe' },
    }
    await expect(launchBrowser({
      userDataDir: 'C:\\udd',
      executablePath: 'C:\\pin\\chrome.exe',
      managedDir: 'C:\\h\\browser',
      discoveryTimeoutMs: 10,
    }, internals)).rejects.toThrow() // port discovery cannot proceed with inert seams
    // Only the configured path was consulted — the managed dir never entered it.
    expect(seen).toEqual(['C:\\pin\\chrome.exe'])
  })
})