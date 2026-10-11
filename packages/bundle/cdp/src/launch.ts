/**
 * @deepseek-ai/dsh-cdp — the browser launcher. It starts one Chromium-based
 * browser with remote debugging bound to loopback, reads the endpoint the
 * browser actually chose from the `DevToolsActivePort` file it writes into a
 * caller-owned user-data directory, and reports it as a `ws` URL. The launcher
 * owns the browser process: [`LaunchedBrowser.close`] terminates the whole
 * process tree and removes nothing from the caller's directory.
 *
 * Every environment dependency is an injectable parameter with a production
 * default — the spawn function, the existence and read operations used by
 * executable discovery and port reading, and the clock/sleep pair — so a spec
 * exercises the launcher without starting a browser, binding a port, or
 * waiting on wall-clock time.
 * @module @deepseek-ai/dsh-cdp/launch
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/** Name of the file the browser writes its chosen port and WebSocket path into. */
export const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort'

/** Total time port discovery waits for the port file before failing, in milliseconds. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000

/** Fixed interval between two `DevToolsActivePort` reads, in milliseconds. */
const DISCOVERY_POLL_INTERVAL_MS = 25

/** Fixed interval between two liveness checks while closing, in milliseconds. */
const CLOSE_POLL_INTERVAL_MS = 25

/** Grace a terminated browser tree gets to report its exit, in milliseconds. */
const CLOSE_GRACE_MS = 5_000

/** Executable names looked up on `PATH` on Windows. */
const WINDOWS_PATH_NAMES: readonly string[] = ['chrome.exe', 'msedge.exe', 'chromium.exe']

/** Executable names looked up on `PATH` on macOS and other POSIX platforms. */
const POSIX_PATH_NAMES: readonly string[] = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
]

/** Absolute install locations tried on Linux, in order. */
const LINUX_INSTALL_LOCATIONS: readonly string[] = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/usr/bin/brave-browser',
  '/snap/bin/chromium',
]

/** Bundle-relative executable paths tried inside each macOS applications directory, in order. */
const MAC_BUNDLE_PATHS: readonly string[] = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Chromium.app/Contents/MacOS/Chromium',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Brave Browser.app/Contents/MacOS/Brave Browser',
]

/** Windows install-location roots, tried under each documented browser subdirectory. */
const WINDOWS_INSTALL_DIRS: readonly string[] = [
  'Google\\Chrome\\Application\\chrome.exe',
  'Microsoft\\Edge\\Application\\msedge.exe',
  'Chromium\\Application\\chrome.exe',
]

/**
 * Request to start one browser with remote debugging enabled.
 * The user-data directory is caller-owned: the launcher neither creates nor
 * removes it, and the browser writes its port file into it.
 */
export interface BrowserLaunchOptions {
  /** Temporary user-data directory the caller owns and has already created. */
  readonly userDataDir: string
  /**
   * Explicit browser executable. When set, discovery is skipped entirely and a
   * path that does not exist fails with {@link CdpBrowserNotFoundError} instead
   * of falling back to the platform search.
   */
  readonly executablePath?: string | undefined
  /**
   * plan16-managed: the DSH-owned pinned browser directory (`$DSH_HOME/browser`).
   * When set the search is STRICT — only managed candidates are tried and a miss
   * throws naming them; there is no silent fall-back to the system browsers,
   * because a pin that can silently change is not a pin (same doctrine as the
   * profile lock). An explicit `executablePath` still wins outright.
   */
  readonly managedDir?: string | undefined
  /** Extra command-line arguments appended after the built-in flags. */
  readonly extraArgs?: readonly string[] | undefined
  /**
   * Total time port discovery waits for the browser's port file.
   * @default DEFAULT_DISCOVERY_TIMEOUT_MS
   */
  readonly discoveryTimeoutMs?: number | undefined
}

/** One started browser with remote debugging enabled. */
export interface LaunchedBrowser {
  /** TCP port the browser bound, as written in its port file. */
  readonly port: number
  /**
   * Browser-level WebSocket endpoint the port file states, for example
   * `ws://127.0.0.1:51000/devtools/browser/<id>`. When the file states no
   * WebSocket path, only the loopback origin is reported.
   */
  readonly websocketUrl: string
  /** Executable path the launcher started. */
  readonly executablePath: string
  /** User-data directory the browser was started with; never removed by `close`. */
  readonly userDataDir: string
  /**
   * plan18-flags: the complete argument list this launch actually spawned with,
   * in order. Rendered into the model prompt by `cdp_open` (`flagBlock`), so the
   * flags a browser runs under are never folklore — they are stated.
   */
  readonly launchArgs: readonly string[]
  /**
   * Terminate the browser's whole process tree and await its exit. Idempotent:
   * repeated or concurrent calls share one termination and one result. The
   * caller's user-data directory is left exactly as the browser left it.
   * @returns a promise that settles once the tree has exited or the close grace elapsed.
   */
  close(): Promise<void>
}

/**
 * Error thrown when no browser executable is found. `searched` names every
 * location tried, in order.
 */
export class CdpBrowserNotFoundError extends Error {
  /** Every executable location the search tried, in the order it tried them. */
  readonly searched: readonly string[]

  /**
   * @param searched - executable locations tried, in order.
   */
  constructor(searched: readonly string[]) {
    super(`CDP: no Chromium-based browser found; searched ${searched.join(', ')}`)
    this.name = 'CdpBrowserNotFoundError'
    this.searched = [...searched]
  }
}

/** Error thrown when the browser process could not be started or died before publishing its port. */
export class CdpBrowserSpawnError extends Error {
  /** Executable path the launcher tried to start. */
  readonly executablePath: string

  /**
   * @param executablePath - executable path the launcher tried to start.
   * @param reason - the spawn failure's own message.
   */
  constructor(executablePath: string, reason: string) {
    super(`CDP: could not start ${executablePath}: ${reason}`)
    this.name = 'CdpBrowserSpawnError'
    this.executablePath = executablePath
  }
}

/** Error thrown when the browser never wrote its `DevToolsActivePort` file. */
export class CdpBrowserPortTimeoutError extends Error {
  /** Port file that never appeared. */
  readonly portFile: string
  /** User-data directory the port file was expected in. */
  readonly userDataDir: string
  /** Total time discovery waited, in milliseconds. */
  readonly timeoutMs: number

  /**
   * @param portFile - the `DevToolsActivePort` path that never appeared.
   * @param userDataDir - directory the port file was expected in.
   * @param timeoutMs - total time discovery waited, in milliseconds.
   */
  constructor(portFile: string, userDataDir: string, timeoutMs: number) {
    super(`CDP: timed out after ${String(timeoutMs)}ms waiting for ${portFile} in user-data directory ${userDataDir}`)
    this.name = 'CdpBrowserPortTimeoutError'
    this.portFile = portFile
    this.userDataDir = userDataDir
    this.timeoutMs = timeoutMs
  }
}

/** Options one browser `spawn` call carries. */
export interface BrowserSpawnOptions {
  /** True off Windows, so the browser leads its own process group and a group signal reaches its helpers. */
  detached: boolean
  /** The browser's own output is not read; an unread pipe would fill and stall it. */
  stdio: 'ignore'
  /** No console window is created for the child on Windows. */
  windowsHide: boolean
}

/**
 * Start one browser process.
 * @param command - executable path to run.
 * @param args - complete argument list.
 * @param options - the spawn options the launcher fixes.
 * @returns the started child process.
 */
export type BrowserSpawn = (command: string, args: readonly string[], options: BrowserSpawnOptions) => ChildProcess

/** Injectable environment seams. Every field defaults to its production value. */
export interface BrowserLauncherInternals {
  /** Platform whose install locations and termination semantics are used. */
  platform: NodeJS.Platform
  /** Environment supplying `PATH` and the Windows install roots. */
  env: NodeJS.ProcessEnv
  /** Existence check for one discovery candidate. */
  exists: (path: string) => boolean
  /** Read of the browser's port file. */
  readFile: (path: string) => Promise<string>
  /** Process starter. */
  spawn: BrowserSpawn
  /** Process-tree terminator used by `close`. */
  killTree: (pid: number, platform: NodeJS.Platform, child: ChildProcess) => void
  /** Monotonic-enough clock in milliseconds. */
  now: () => number
  /** Sleep for a fixed interval. */
  sleep: (ms: number) => Promise<void>
}

/** One parsed `DevToolsActivePort` file. */
interface ActivePort {
  /** Port the browser bound. */
  port: number
  /** Browser-level WebSocket path, empty when the file states none. */
  browserPath: string
}

/** The context one bounded port-discovery wait needs. */
interface PortDiscovery {
  /** `DevToolsActivePort` path being observed. */
  portFile: string
  /** User-data directory named in the timeout error. */
  userDataDir: string
  /** Executable path named in a spawn error. */
  executablePath: string
  /** Total wait budget in milliseconds. */
  timeoutMs: number
  /** The started child, checked for an early exit. */
  child: ChildProcess
  /** Spawn failure recorded by the child's `error` listener, when one arrives. */
  spawnState: { failure: Error | undefined }
}

/**
 * Terminate one Windows process tree with `taskkill /T /F`, or one POSIX
 * process group with `SIGKILL`.
 *
 * Windows: `taskkill /T` enumerates the child's descendants and `/F` forces
 * them, so no helper the browser spawned outlives `close`. `spawnSync` reports
 * an already-absent tree in its status instead of throwing, which keeps
 * repeated termination harmless. No console window is created for `taskkill`.
 *
 * POSIX: the launcher started the browser detached, so it leads its own process
 * group and a negative-pid `SIGKILL` reaches the whole tree. A group that is
 * already gone, or a process that never became a leader, falls back to a direct
 * child kill.
 *
 * @param pid - the browser's root process id.
 * @param platform - platform selecting the termination mechanism.
 * @param child - the browser child, used only by the POSIX fallback.
 */
function terminateBrowserTree(pid: number, platform: NodeJS.Platform, child: ChildProcess): void {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group is already gone (ESRCH) or the process never became a leader;
    // the direct child is the remaining owner, so fall back to a bare kill.
    try {
      child.kill('SIGKILL')
    } catch {
      // The child exited between the group signal and this fallback; teardown
      // stays idempotent, and no other failure can reach this catch.
    }
  }
}

/** Production seams: the real filesystem, clock, process starter, and terminator. */
const PRODUCTION_INTERNALS: BrowserLauncherInternals = {
  platform: process.platform,
  env: process.env,
  exists: existsSync,
  readFile: path => readFile(path, 'utf8'),
  spawn: (command, args, options) => spawn(command, [...args], options),
  killTree: terminateBrowserTree,
  now: () => Date.now(),
  sleep: ms => new Promise((resolve) => { setTimeout(resolve, ms) }),
}

/**
 * Merge caller-supplied seams over the production defaults.
 * @param overrides - the seams the caller replaces.
 * @returns a complete environment.
 */
function resolveInternals(overrides: Partial<BrowserLauncherInternals>): BrowserLauncherInternals {
  return {
    platform: overrides.platform ?? PRODUCTION_INTERNALS.platform,
    env: overrides.env ?? PRODUCTION_INTERNALS.env,
    exists: overrides.exists ?? PRODUCTION_INTERNALS.exists,
    readFile: overrides.readFile ?? PRODUCTION_INTERNALS.readFile,
    spawn: overrides.spawn ?? PRODUCTION_INTERNALS.spawn,
    killTree: overrides.killTree ?? PRODUCTION_INTERNALS.killTree,
    now: overrides.now ?? PRODUCTION_INTERNALS.now,
    sleep: overrides.sleep ?? PRODUCTION_INTERNALS.sleep,
  }
}

/**
 * Build the `PATH` candidates for one platform.
 * @param env - environment carrying `PATH` (Windows setups may set `Path`).
 * @param names - executable names to look for.
 * @returns each `PATH` directory joined with each name, in directory order.
 */
function pathCandidates(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  const raw = env.PATH ?? env.Path ?? ''
  return raw.split(delimiter)
    .filter(dir => dir !== '')
    .flatMap(dir => names.map(name => join(dir, name)))
}

/**
 * Build the documented Windows install locations.
 * @param env - environment carrying `ProgramFiles`, `ProgramFiles(x86)`, and `LOCALAPPDATA`.
 * @returns location candidates, browsers ordered Chrome, Edge, Chromium per root.
 */
function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
  const candidates: string[] = []
  for (const installDir of WINDOWS_INSTALL_DIRS) {
    for (const root of roots) {
      if (root === undefined || root === '') continue
      candidates.push(join(root, installDir))
    }
  }
  return candidates
}

/**
 * Build the documented macOS application-bundle locations.
 * @param env - environment carrying `HOME` for the per-user applications directory.
 * @returns location candidates, `/Applications` before the per-user directory.
 */
function macCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = ['/Applications']
  if (env.HOME !== undefined && env.HOME !== '') roots.push(join(env.HOME, 'Applications'))
  return roots.flatMap(root => MAC_BUNDLE_PATHS.map(bundle => join(root, bundle)))
}

/**
 * Build every executable location the platform search tries, in order.
 * @param platform - platform selecting the install-location list.
 * @param env - environment supplying the install roots and `PATH`.
 * @returns documented install locations first, then `PATH` candidates.
 */
function executableCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') return [...windowsCandidates(env), ...pathCandidates(env, WINDOWS_PATH_NAMES)]
  if (platform === 'darwin') return [...macCandidates(env), ...pathCandidates(env, POSIX_PATH_NAMES)]
  return [...LINUX_INSTALL_LOCATIONS, ...pathCandidates(env, POSIX_PATH_NAMES)]
}

/**
 * plan16-managed: the executable names one managed directory may carry.
 * @param managedDir - the DSH-owned browser directory.
 * @param platform - platform selecting the executable names.
 * @returns each managed candidate path, in name order.
 */
export function managedCandidates(managedDir: string, platform: NodeJS.Platform): string[] {
  const names = platform === 'win32' ? ['chrome.exe', 'chromium.exe', 'msedge.exe'] : ['chrome', 'chromium', 'google-chrome']
  return names.map(name => join(managedDir, name))
}

/**
 * Resolve the executable to start.
 *
 * A configured path is authoritative: it is checked and returned, and a path
 * that does not exist throws instead of silently falling back to the platform
 * search. A managed directory is STRICT likewise — only its own candidates are
 * tried. Otherwise every documented location is tried in order.
 *
 * @param options - the launch request, whose `executablePath` may be set.
 * @param internals - the resolved environment seams.
 * @returns the executable path to start.
 * @throws CdpBrowserNotFoundError naming every location tried.
 */
function resolveExecutable(options: BrowserLaunchOptions, internals: BrowserLauncherInternals): string {
  const configured = options.executablePath
  if (configured !== undefined) {
    if (!internals.exists(configured)) throw new CdpBrowserNotFoundError([configured])
    return configured
  }
  // plan16-managed: strict pinned channel — no system fall-back, ever.
  if (options.managedDir !== undefined) {
    const managed = managedCandidates(options.managedDir, internals.platform)
    for (const candidate of managed) {
      if (internals.exists(candidate)) return candidate
    }
    throw new CdpBrowserNotFoundError(managed)
  }
  const candidates = executableCandidates(internals.platform, internals.env)
  const found = candidates.find(candidate => internals.exists(candidate))
  if (found === undefined) throw new CdpBrowserNotFoundError(candidates)
  return found
}

/**
 * plan18-flags (operator directive, verbatim block): every launch runs this
 * block — the launcher's own plumbing flags are added underneath and duplicates
 * collapse to one occurrence. `--user-data-dir` and the remote-debugging port
 * stay launcher-owned (they must: the port is read back from the port file).
 *
 * ```
 * chrome.exe
 *   --user-data-dir=<profile>
 *   --no-first-run
 *   --no-default-browser-check
 *   --lang=tr
 *   --disable-blink-features=AutomationControlled   ← navigator.webdriver izini siler
 *   --start-maximized
 * ```
 */
export const OPERATOR_LAUNCH_ARGS: readonly string[] = [
  '--no-first-run',
  '--no-default-browser-check',
  '--lang=tr',
  '--disable-blink-features=AutomationControlled',
  '--start-maximized',
]

/**
 * plan18-stealth (operator request: "tamamen stealth, bot korumasına takılmasın"):
 * the anti-detection layers that BELONG on the command line, grouped by the
 * detector they disarm. They merge with {@link OPERATOR_LAUNCH_ARGS} on every
 * launch — `--disable-blink-features` VALUES UNION across the blocks (one flag
 * line accumulates every feature disabled, no block silently wins).
 *
 * Deliberately NOT here — each is a signature of its own:
 * - `--incognito` (contradicts the Zero-Profile Law of a persistent isolated dir),
 * - `--window-size` (fights the operator's `--start-maximized`; sizing belongs to
 *   `cdp_viewport`, which reports what actually applied),
 * - `--user-agent=…` (UA-CH never follows it — the story splits; `cdp_stealth`
 *   sets UA/UA-CH/headers coherently per session),
 * - `--enable-automation` / old `--headless` / `--use-gl=swiftshader` /
 *   `--disable-web-security` (every one of them IS the detection signature).
 */
export const STEALTH_LAUNCH_ARGS: readonly string[] = [
  // A — automation-surface killers: webdriver getter, topic/fledge cohorts,
  // extension and default-app inventory, phoning-home channels.
  '--disable-blink-features=AutomationControlled,InterestCohort,TopicsAPI,AttributionReporting',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-component-update',
  '--disable-background-networking',
  '--no-pings',
  '--metrics-recording-only',
  '--disable-session-crashed-bubble',
  // B — behaviour-timing signatures: an idle/covered window throttles timers and
  // rAF, and that throttling is measurable. A human window runs flat out.
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion',
  // C — fingerprint coherence: font metrics flattening and a real GL path
  // (SwiftShader in WEBGL_debug_renderer_info is the "headless server" tattoo).
  '--font-render-hinting=none',
  '--use-gl=desktop',
  // D — tunnel law backstops (no proxy configured today, but UDP/WebRTC must
  // never slip past a SOCKS stitch when one IS configured).
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
]

/**
 * plan18-stealth: the "Çift Dikiş Kanunu" flag family for tunneled launches —
 * merge through `extraArgs` when a SOCKS stitch is in front of the browser.
 *
 * `socks5://` (schemeless host) makes Chromium resolve DNS THROUGH the proxy —
 * the stitch carries TCP *and* name resolution. `socks4://` is refused by
 * doctrine: it resolves locally and leaks the very lookups the tunnel exists to
 * hide. `hardDnsKill` additionally null-routes the local resolver (`MAP *
 * ~NOTFOUND , EXCLUDE <loopback>`), the strongest kordon — use it when the
 * tunnel entrance is also the DNS authority.
 * @param socksPort - the local SOCKS5 entrance port.
 * @param hardDnsKill - also disable the local resolver entirely.
 * @returns the flag family to append via `extraArgs`.
 */
export function proxyTunnelArgs(socksPort: number, hardDnsKill = false): string[] {
  const base = [
    `--proxy-server=socks5://127.0.0.1:${String(socksPort)}`,
    '--proxy-bypass-list=<-loopback>',
  ]
  return hardDnsKill ? [...base, '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] : base
}

/**
 * Build the browser argument list (plan18-flags: exported so `cdp_open` can
 * report exactly what runs).
 *
 * Each flag exists for one reason: `--remote-debugging-port=0` lets the browser
 * bind a free port and publish it in the port file, so nothing here reserves a
 * fixed port; `--remote-debugging-address=127.0.0.1` keeps the debugging
 * endpoint off every non-loopback interface; `--user-data-dir` isolates the
 * profile from the user's real one and is where the browser writes its port
 * file; {@link OPERATOR_LAUNCH_ARGS} carries the operator's launch block
 * (first-run/default-browser suppression, locale, automation-surface mask,
 * maximized start). Caller-supplied arguments are appended after these.
 *
 * Duplicate flags collapse by name (everything before `=`), first occurrence
 * wins, so the operator block can never be doubled by built-ins or extras.
 *
 * @param options - the launch request supplying the user-data directory and extra arguments.
 * @returns the complete argument list, exactly as spawned.
 */
export function buildBrowserLaunchArgs(options: BrowserLaunchOptions): string[] {
  const merged = [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${options.userDataDir}`,
    ...OPERATOR_LAUNCH_ARGS,
    ...STEALTH_LAUNCH_ARGS,
    ...(options.extraArgs ?? []),
  ]
  // Duplicate flags collapse by name (everything before `=`), first occurrence
  // wins — EXCEPT `--disable-blink-features`, whose VALUES UNION across blocks
  // (operator + stealth each contribute feature names; neither may silence the
  // other). Extras still never undo an earlier explicit flag.
  const byName = new Map<string, string>()
  const mergedFeatures = new Set<string>()
  for (const flag of merged) {
    const eq = flag.indexOf('=')
    const name = eq === -1 ? flag : flag.slice(0, eq)
    const value = eq === -1 ? '' : flag.slice(eq + 1)
    if (name === '--disable-blink-features') {
      for (const feature of value.split(',').map(part => part.trim()).filter(part => part !== '')) {
        mergedFeatures.add(feature)
      }
      continue
    }
    if (!byName.has(name)) byName.set(name, flag)
  }
  const out = [...byName.values()]
  if (mergedFeatures.size > 0) {
    // Reinsert at the first contributor's slot position: appended after basics,
    // before extras — same deterministic order every build.
    out.splice(Math.min(out.findIndex(f => f.startsWith('--start-maximized')) + 1, out.length), 0,
      `--disable-blink-features=${[...mergedFeatures].join(',')}`)
  }
  return out
}

/**
 * plan18-flags: render the launch block the model is shown verbatim on every
 * `cdp_open` — the flags a browser runs under, one per line, no prose.
 * @param executablePath - the binary the launcher started.
 * @param args - the argument list {@link buildBrowserLaunchArgs} produced.
 * @returns the fenced flag block.
 */
export function renderLaunchFlagBlock(executablePath: string, args: readonly string[]): string {
  const lines = [executablePath, ...args.map(flag => `  ${flag}`)]
  return `LAUNCH FLAGS (prompt):\n${lines.join('\n')}`
}

/**
 * Parse one `DevToolsActivePort` file.
 *
 * The first line is the chosen port; the second is the browser-level WebSocket
 * path and may be blank. Lines may carry trailing whitespace and any line
 * ending. An unusable first line reports `undefined` so the caller retries.
 *
 * @param text - the file's text.
 * @returns the parsed port and WebSocket path, or undefined when no port could be read.
 */
function parseActivePort(text: string): ActivePort | undefined {
  const lines = text.split(/\r?\n/u)
  const port = Number((lines[0] ?? '').trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { port, browserPath: (lines[1] ?? '').trim() }
}

/**
 * Read the port file once.
 * @param portFile - the `DevToolsActivePort` path.
 * @param internals - the resolved environment seams.
 * @returns the parsed file, or undefined when the browser has not written a usable one yet.
 */
async function readActivePort(portFile: string, internals: BrowserLauncherInternals): Promise<ActivePort | undefined> {
  let text: string
  try {
    text = await internals.readFile(portFile)
  } catch {
    // The browser has not written the port file yet; the bounded loop retries.
    return undefined
  }
  return parseActivePort(text)
}

/**
 * Report whether the child has left the operating system.
 * @param child - the browser child process.
 * @returns true once the child published an exit code or signal.
 */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * Wait for the browser to publish its port.
 *
 * Reads the port file on a fixed interval until it parses, a recorded spawn
 * failure is observed, the child exits, or the total wait budget elapses.
 *
 * @param discovery - the wait's context: paths, budget, child, and spawn-failure slot.
 * @param internals - the resolved environment seams supplying read, clock, and sleep.
 * @returns the parsed port.
 * @throws CdpBrowserSpawnError when the browser could not start or exited before publishing a port.
 * @throws CdpBrowserPortTimeoutError when the budget elapses without a usable port file.
 */
async function waitForActivePort(
  discovery: PortDiscovery,
  internals: BrowserLauncherInternals,
): Promise<ActivePort> {
  const deadline = internals.now() + discovery.timeoutMs
  for (;;) {
    const failure = discovery.spawnState.failure
    if (failure !== undefined) throw new CdpBrowserSpawnError(discovery.executablePath, failure.message)
    const active = await readActivePort(discovery.portFile, internals)
    if (active !== undefined) return active
    if (hasExited(discovery.child)) {
      throw new CdpBrowserSpawnError(discovery.executablePath, 'the browser exited before it published its debugging port')
    }
    if (internals.now() >= deadline) {
      throw new CdpBrowserPortTimeoutError(discovery.portFile, discovery.userDataDir, discovery.timeoutMs)
    }
    await internals.sleep(DISCOVERY_POLL_INTERVAL_MS)
  }
}

/**
 * Terminate one browser and await its exit.
 * Windows goes through `taskkill /T /F`; POSIX signals the browser's own
 * process group. The bounded liveness poll also covers a tree that ignores the
 * first termination request.
 * @param child - the browser child process.
 * @param internals - the resolved environment seams supplying termination, clock, and sleep.
 * @returns a promise that settles once the child is gone or the grace elapsed.
 */
async function terminateBrowser(child: ChildProcess, internals: BrowserLauncherInternals): Promise<void> {
  if (!hasExited(child)) {
    const pid = child.pid
    if (pid === undefined) {
      child.kill('SIGKILL')
    } else {
      internals.killTree(pid, internals.platform, child)
    }
  }
  const deadline = internals.now() + CLOSE_GRACE_MS
  while (!hasExited(child) && internals.now() < deadline) {
    await internals.sleep(CLOSE_POLL_INTERVAL_MS)
  }
}

/**
 * Start a Chromium-based browser with remote debugging enabled on a loopback
 * ephemeral port and report the endpoint it chose.
 *
 * A configured executable that does not exist, or an empty user-data
 * directory, fails before anything is spawned. Discovery failures, spawn
 * failures, and port-discovery timeouts are typed errors.
 *
 * @param options - the launch request: user-data directory, optional executable and extras, timeout.
 * @param internals - optional environment seams; every omission keeps its production default.
 * @returns the started browser, its endpoint, and its teardown.
 */
export async function launchBrowser(
  options: BrowserLaunchOptions,
  internals: Partial<BrowserLauncherInternals> = {},
): Promise<LaunchedBrowser> {
  if (options.userDataDir === '') {
    throw new Error('cdp: userDataDir must be a non-empty path to a caller-created user-data directory')
  }
  const timeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('cdp: discoveryTimeoutMs must be a positive finite number of milliseconds')
  }
  const resolved = resolveInternals(internals)
  const executablePath = resolveExecutable(options, resolved)
  const portFile = join(options.userDataDir, DEVTOOLS_ACTIVE_PORT_FILE)
  const spawnState: { failure: Error | undefined } = { failure: undefined }
  const launchArgs = buildBrowserLaunchArgs(options)

  let child: ChildProcess
  try {
    child = resolved.spawn(executablePath, launchArgs, {
      detached: resolved.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (error: unknown) {
    throw new CdpBrowserSpawnError(executablePath, error instanceof Error ? error.message : String(error))
  }
  child.once('error', (error: Error) => { spawnState.failure = error })

  const active = await waitForActivePort(
    { portFile, userDataDir: options.userDataDir, executablePath, timeoutMs, child, spawnState },
    resolved,
  )

  let closePromise: Promise<void> | undefined
  return {
    port: active.port,
    websocketUrl: active.browserPath === ''
      ? `ws://127.0.0.1:${active.port}`
      : `ws://127.0.0.1:${active.port}${active.browserPath.startsWith('/') ? '' : '/'}${active.browserPath}`,
    executablePath,
    userDataDir: options.userDataDir,
    launchArgs,
    close: (): Promise<void> => {
      closePromise ??= terminateBrowser(child, resolved)
      return closePromise
    },
  }
}
