/**
 * @deepseek-ai/dsh-cdp/service — CdpService lifecycle coordinator.
 * Manages browser launching, raw CDP over WebSocket connections,
 * target registry bookkeeping, page sessions, snapshot weaving,
 * human-like input, and resource disposal.
 *
 * @module @deepseek-ai/dsh-cdp/service
 */

import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises' /* plan10 */
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { CdpConnection, type CdpConnectionOptions } from './connection.ts'
// plan10: PDF extraction, print round-trip, downloads, and the file policy.
import { DownloadManager, type ArmOutcome, type DownloadRecord } from './download.ts'
import { chooseWriteName } from './files.ts'
import { ensureDownloadsDir, resolveDownloadsRoot, resolveInsideRoot } from './downloads-dir.ts'
import {
  DEFAULT_MAX_PDF_BYTES,
  extractFromViewer,
  extractPdfText,
  isPdf,
  parsePrintToPdfReply,
  type ExtractPdfResult,
  type ViewerContext,
  type ViewerExtractOutcome,
} from './pdf.ts'
import { TargetRegistry, type TargetInfo } from './targets.ts'
import { PageSession, type PageEvaluation, type NavigationOutcome } from './page.ts'
import {
  weaveSnapshot,
  type CdpSnapshot,
  type CdpSnapshotInput,
  type CdpSnapshotLimits,
  type CdpDomNode,
  type CdpViewport,
} from './snapshot.ts'
import { launchBrowser, type LaunchedBrowser, type BrowserLaunchOptions } from './launch.ts'
/* plan13-profile: named, durable user-data directories (`$DSH_HOME/profiles/<name>`)
   plus the honest lock report a second browser on the same profile must get. */
import {
  EXTERNAL_PROFILE_NAME,
  listProfileDirs,
  profileIdentity,
  profileLockedMessage,
  readProfileLock,
  resolveProfileDir,
  resolveProfilesRoot,
  CdpProfileError,
} from './profiles.ts'
import { HumanInput, type Point, type ClickOptions, type TextEntryOutcome } from './input.ts'
import { stealthScript, type StealthOptions } from './stealth.ts'
/* plan07: one profile drives JS patches, Sec-CH-UA/Accept-Language headers,
   and launch flags so no layer can tell a different story (G9/G3/G4/G26). */
import {
  DEFAULT_STEALTH_PROFILE,
  deriveAcceptLanguage,
  deriveLaunchArgs,
  deriveStealthOptions,
  resolveStealthProfile,
  STEALTH_PROFILES,
  type StealthProfile,
} from './stealth-profiles.ts'
import { classifyWhyBlocked, type WhyBlockedReason } from './why-blocked.ts'
import { CaptureStore } from './net/capture.ts'
import { CertificateAuthority } from './net/ca.ts'
import { CdpProxy } from './net/proxy.ts'
import type { CdpConnectionBrief, CdpConnectionState, CdpResolutionVia, CdpStatusDetail, CdpStatusResponse, CdpTabBrief } from './types.ts'
// plan04: endpoint pool, loopback discovery, and the automatic reattach driver.
import {
  ConnectionPool,
  DEFAULT_DISCOVERY_PORTS,
  discoverEndpoints,
  type CdpEndpointRow,
  type PooledEndpoint,
} from './connection-pool.ts'
// plan05: dialog records/policy/guard error + the upload path policy and DOM binding.
import {
  CdpDialogOpenError,
  briefDialog,
  dialogDenialReason,
  type DialogBrief,
  type DialogPolicy,
  type DialogRecord,
} from './dialog.ts'
import {
  DEFAULT_MAX_UPLOAD_FILES,
  bindFileInput,
  bindFilePickerFiles,
  validateUploadPath,
  type UploadBindOutcome,
  type UploadFileBrief,
  type UploadInputInfo,
  type UploadPolicy,
  type UploadSender,
} from './upload.ts'
import {
  buildEvalFailureOutcome,
  buildEvalOutcome,
  buildExecOutcome,
  clampTimeout,
  classifyCdpError,
  DEFAULT_EXEC_TIMEOUT_MS, /* plan10-fix */
  isInfrastructureError,
  postConditionExpression,
  hiddenEnvelopeValue, /* plan15-hidden */
  PAGE_ACTIVITY_EXPRESSION, /* plan15-hidden */
  readPageActivity, /* plan15-hidden */
  UNVERIFIED_ACTIVITY, /* plan15-hidden */
  type EvalOutcome,
  type ExecOptions,
  type ExecOutcome,
  type PageActivityProbe,
} from './exec.ts'
// plan06: capture core, live viewport probing, and the shared write helper.
import {
  CdpViewportError,
  ScreenshotCapture,
  UNAVAILABLE_VIEWPORT,
  VIEWPORT_CACHE_MS,
  parseResizeProbeAnswer, /* plan15-viewport */
  probeViewport,
  RESIZE_PROBE_ARM_EXPRESSION, /* plan15-viewport */
  RESIZE_PROBE_READ_EXPRESSION, /* plan15-viewport */
  resizeNotDeliveredReason, /* plan15-viewport */
  type CaptureContext,
  type ScreenshotRequest,
  type ScreenshotResult,
  type ViewportApplyArgs,
  type ViewportApplyOutcome,
  type ViewportMetrics,
  type ViewportObservation,
  type ViewportResizeProbe,
} from './capture.ts'
// plan02 wave 1: the locator resolver, its verdicts, and the evidence builders.
import {
  LOCATOR_EVAL_TIMEOUT_MS,
  LOCATOR_POLL_MS,
  buildFocusExpression,
  buildFocusArmExpression,
  buildFocusCheckExpression,
  buildLocatorExpression,
  buildPointExpression,
  clampMaxChars,
  clampWaitTimeout,
  evaluateExpect,
  evaluateText,
  parseEvidenceReply,
  parseFocusCheckReply,
  parseLocatorReply,
  sleep,
  validateLocatorSpec,
  type ExpectOptions,
  type ExpectOutcome,
  type FocusEvidence,
  type LocatorRun,
  type LocatorSpec,
  type PointEvidence,
  type ReadTextOptions,
  type TextOutcome,
  type ActionResolution,
  type TypeFocusCheck,
} from './locator.ts'
// plan02 wave 2: framework-safe fill (§4.4) and the wait strategies (§4.7).
import {
  FILL_DEFAULT_TIMEOUT_MS,
  FILL_EVAL_TIMEOUT_MS,
  FILL_POLL_MS,
  buildFillExpression,
  buildFillReadExpression,
  fillFallbackOutcome,
  fillOutcomeFromReply,
  isFillFatal,
  parseFillReply,
  parseFillRead,
  type FillOptions,
  type FillOutcome,
} from './fill.ts'
import { waitForNetworkIdle, type WaitNetworkReply } from './waits.ts'
// plan08 wave: the ref path — fresh element resolution at action time.
import {
  REF_STALE_PREFIX,
  RefStaleError,
  buildRefIndex,
  clearRefOrigins,
  isStaleRefReason,
  lookupRefOrigin,
  recordRefOrigins,
  refFailureRun,
  refLocatorRun,
  resolveRefOn,
  type RefEvidence,
  type RefExpectOutcome,
  type RefIndexEntry,
  type RefRect,
  type RefTextOutcome,
} from './refs.ts'
// plan08 wave: find/extract — the pure query + projection engines.
import {
  displayNormalize,
  hasFindQuery,
  matchFindCandidates,
  querySummary,
  type FindMatch,
  type FindQuery,
} from './find.ts'
/* plan14: the "what is AT this point?" probe — the query the visual loop
   (screenshot → model names a point → click) was missing. The engine is pure:
   this file only runs it and shapes the honest envelope. */
import {
  LOCATE_EVAL_TIMEOUT_MS,
  buildLocateExpression,
  parseLocateReply,
  type LocateNearest,
  type LocateNode,
} from './locate.ts'
import {
  PAGE_FIELDS_EXPRESSION,
  extractFieldPairs,
  matchExtractCandidates,
  parseExtractSpec,
  projectExtract,
  type ExtractRow,
  type ExtractSpec,
  type LosslessJsonValue,
  type ResolvedCandidate,
} from './extract.ts'
/* plan11: the cdp_captcha pure engine (Katman A scan + Katman B drag geometry
   + solution signals) and the real-CDP press-move-release dispatcher. Nothing
   here is pasted from an existing module: the locator DSL, resolveForAction,
   the ref path, and HumanInput's adapter are IMPORTED, never forked. */
import {
  CAPTCHA_PROVIDER_HOSTS,
  CAPTCHA_SCAN_BUDGET_REASON,
  CAPTCHA_SCAN_EXPRESSION,
  CAPTCHA_VERIFY_EXPRESSION,
  buildDragMeasureExpression,
  buildDragPlan,
  classifyCandidates,
  classifyHoneypots,
  classifyOverlays,
  clampDragSteps,
  clampTargetPct,
  collectSolutionSignals,
  declaredTargetPct,
  judgeDrag,
  parseDragMeasureReply,
  parseScanReply,
  parseVerifyReply,
  releaseXFor,
  seededSource,
  sliderInset,
  stateDifferences,
  thirdPartyVerdict,
  thumbPercent,
  DRAG_DEFAULT_SEED,
  type CaptchaAction,
  type CaptchaDragOutcome,
  type CaptchaScanOutcome,
  type CaptchaVerifyOutcome,
  type SliderGeometry,
} from './captcha.ts'
import { dispatchDrag, dispatchedSpanPx, DRAG_COLLAPSE_MAX_PX } from './drag.ts'

const { version: CDP_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

/**
 * Adapter bridging {@link CdpConnection} to {@link TargetRegistry}'s connection interface.
 * @param connection - the raw CDP connection to wrap.
 * @returns a `send`/`on` pair that forwards commands and subscriptions to the
 *   connection without its target bookkeeping.
 */
export function createTargetConnectionAdapter(connection: CdpConnection): {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  on: (event: string, listener: (params: unknown) => void) => () => void
} {
  return {
    send: (method: string, params?: Record<string, unknown>) => connection.send(method, params),
    on: (event: string, listener: (params: unknown) => void) => connection.on(event, (cdpEvent) => {
      listener(cdpEvent.params)
    }),
  }
}

/**
 * Adapter bridging {@link CdpConnection} to {@link PageSession}'s connection interface.
 * @param connection - the raw CDP connection to wrap.
 * @returns a `send`/`on` pair that passes the session id through, so commands
 *   and session-scoped events reach the page session they belong to.
 */
export function createPageConnectionAdapter(connection: CdpConnection): {
  send: (method: string, params: Record<string, unknown>, sessionId?: string, timeoutMs?: number) => Promise<unknown>
  on: (event: string, listener: (params: unknown, sessionId: string | undefined) => void) => () => void
} {
  return {
    send: (method: string, params: Record<string, unknown>, sessionId?: string, timeoutMs?: number) =>
      connection.send(method, params, sessionId, timeoutMs),
    on: (event: string, listener: (params: unknown, sessionId: string | undefined) => void) => connection.on(event, (cdpEvent) => {
      listener(cdpEvent.params, cdpEvent.sessionId)
    }),
  }
}

/**
 * Adapter bridging {@link CdpConnection} to {@link HumanInput}'s connection interface.
 * @param connection - the raw CDP connection to wrap.
 * @returns a `send`-only handle that routes input commands to the session
 *   id they name; input never subscribes to events.
 */
export function createInputConnectionAdapter(connection: CdpConnection): {
  send: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>
} {
  return {
    send: (method: string, params: Record<string, unknown>, sessionId?: string) => connection.send(method, params, sessionId),
  }
}

/**
 * plan10: construction options for {@link CdpService}. The no-arg default
 * keeps every existing call site (`new CdpService()`) valid.
 */
export interface CdpServiceOptions {
  /** Configured downloads root; empty/absent → `<cwd>/.dsh/cdp-downloads`. */
  readonly downloadsDir?: string | undefined
  /** Hard byte cap for `cdp_readpdf` inputs; default 64 MiB. */
  readonly maxPdfBytes?: number | undefined
  /** Fetch implementation for the pdftotext network strategy (tests inject). */
  readonly fetch?: typeof globalThis.fetch | undefined
  /** plan04: loopback debug ports `endpointInventory()` probes by default. */
  readonly discoveryPorts?: readonly number[] | undefined
  /** plan04-FAZ7: loopback port the capture proxy binds (Config `proxyListenPort`); absent → 9333. */
  readonly proxyListenPort?: number | undefined
  /**
   * plan13-profile: root under which named profiles live. Absent → resolved
   * per call to `$DSH_HOME/profiles` (falling back to `~/.dsh/profiles`), so
   * repointing `DSH_HOME` is honored. Tests point this at a temp directory.
   */
  readonly profilesRoot?: string | undefined
}

/** plan10: arguments for the `Page.printToPDF` round-trip. */
export interface PrintToPdfOptions {
  /** Paper format; omitted → the CDP default. */
  readonly format?: 'A4' | 'Letter' | 'Legal' | 'Tabloid' | undefined
  readonly landscape?: boolean | undefined
  /** Scale 0.1..2.0 (CDP's own bounds). */
  readonly scale?: number | undefined
  readonly printBackground?: boolean | undefined
  /** Margins in inches. */
  readonly marginIn?: { top?: number | undefined; bottom?: number | undefined; left?: number | undefined; right?: number | undefined } | undefined
  /** e.g. `'1-3,5'`. */
  readonly pageRanges?: string | undefined
  readonly targetId?: string | undefined
  /** Explicit destination (root-relative); hard-errors when occupied. */
  readonly saveTo?: string | undefined
}

/** plan10: a saved print-round-trip PDF. */
export interface PrintToPdfResult {
  /** Root-relative saved path. */
  path: string
  bytes: number
  pageCount: number
  /** The decoded bytes (callers projecting JSON must drop this field). */
  data: Buffer
}

/** plan10: arguments for `cdp_readpdf`. */
export interface ReadPdfOptions {
  /** Root-relative PDF path. */
  path: string
  page?: number | undefined
  pageFrom?: number | undefined
  pages?: string | undefined
  maxChars?: number | undefined
  includeMeta?: boolean | undefined
}

/** plan10: arguments for `cdp_pdftotext`. */
export interface ViewerReadOptions {
  strategy?: string | undefined
  maxChars?: number | undefined
  page?: number | undefined
  pageFrom?: number | undefined
  timeoutMs?: number | undefined
  targetId?: string | undefined
}

/**
 * Options for opening or attaching a browser session in {@link CdpService}.
 */
export interface CdpOpenOptions {
  /** Explicit WebSocket debugger URL to connect to. */
  readonly endpoint?: string | undefined
  /** Remote debugging port to query loopback discovery for. */
  readonly port?: number | undefined
  /** Path to Chromium executable if launching. */
  readonly executablePath?: string | undefined
  /**
   * plan16-managed: launch on the DSH-owned pinned browser (`$DSH_HOME/browser`)
   * — strict channel, no system fall-back (see launch.ts). Ignored when
   * `executablePath` pins one directly.
   */
  readonly managed?: boolean | undefined
  /** Whether to run headlessly if launching. */
  readonly headless?: boolean | undefined
  /** Additional command-line flags if launching. */
  readonly extraArgs?: readonly string[] | undefined
  /** Fetch implementation for discovery; defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined
  /**
   * plan13-profile: named persistent user-data directory to launch on, resolved
   * to `$DSH_HOME/profiles/<name>`. Omitted → the historical throwaway
   * `mkdtemp` profile, byte-for-byte unchanged. A named profile is an EXPLICIT
   * decision: it launches (or re-adopts) that profile even while another
   * endpoint is live, and it is idempotent for its own already-open session.
   */
  readonly profile?: string | undefined
  /**
   * plan13-profile: the "or a new port?" half of the choice. Same meaning as
   * {@link port}, named separately so the answer to a `needsChoice` envelope
   * can be given without re-typing the generic port parameter.
   */
  readonly switchTo?: number | undefined
}

/**
 * plan13-profile: one row of the discovery table `cdp_open` returns when it
 * refuses to decide for the caller. The fields map 1:1 to the `discovered`
 * items in the tool's output schema.
 */
export interface CdpDiscoveredEndpoint {
  /** Loopback port the row reports. */
  readonly port: number
  /**
   * Browser profile identity: the user-data directory's last segment
   * (`assistant`, `dsh-cdp-XXXXXX`), `external` for a browser DSH attached to
   * but did not launch, and `''` when `/json/version` exposes no profile.
   */
  readonly profile: string
  /** `dsh` when DSH launched this browser, `user` when it is somebody else's. */
  readonly kind: 'user' | 'dsh'
  /** Live tracked target count; `0` when unknown or unattached. */
  readonly targets: number
  /** Whether this endpoint is pooled with a live socket. */
  readonly attached: boolean
  /** Whether it is the service's ACTIVE connection. */
  readonly active: boolean
  /** WebSocket debugger URL; `''` when unreachable. */
  readonly endpoint: string
  /** `/json/version` `Browser` value; `''` when unknown. */
  readonly browser: string
}

/**
 * plan13-profile: what {@link CdpService.open} reports. The four original
 * fields keep their meaning (an empty `endpoint` + a `reason` is a refusal);
 * every plan13 field is optional and only rides along when it applies, so the
 * pre-plan13 payload still validates.
 */
export interface CdpOpenResult {
  /** Attached debugger URL; `''` when the call made no decision. */
  endpoint: string
  /** Live target count; `0` when nothing is attached. */
  targets: number
  /** Pool connection id; `''` when nothing is attached. */
  connectionId: string
  /** True when an already-pooled endpoint was adopted instead of dialed. */
  reused: boolean
  /**
   * plan16-managed: the executable the launched browser runs, present exactly
   * when THIS call launched one (a bare attach knows no executable and claims none).
   */
  executablePath?: string
  /**
   * plan16-managed: how the executable was chosen — `explicit` (caller-pinned),
   * `managed` (the strict $DSH_HOME/browser pin), or `system` (documented
   * locations + PATH). Absent together with {@link executablePath}.
   */
  browserKind?: string
  /** Why the live session was kept instead of the requested port. */
  note?: string
  /**
   * plan13-profile: the ACTIVE profile identity — the named profile, the
   * literal `ephemeral` for a throwaway one, or `external` for a browser DSH
   * attached to. Absent only when the call made no decision.
   */
  profile?: string
  /**
   * plan13-profile: true when discovery found live endpoints and the call
   * deliberately made NO decision. While this is true the call had zero side
   * effects — nothing was launched, closed, dialed, or switched.
   */
  needsChoice?: boolean
  /** plan13-profile: the discovery table, present exactly when {@link needsChoice} is true. */
  discovered?: readonly CdpDiscoveredEndpoint[]
  /** plan13-profile: the decisions the caller may make to resolve the choice. */
  choices?: readonly string[]
  /**
   * plan13-profile: honest refusal text (invalid profile name, profile held by
   * another browser). Present means the call did nothing at all.
   */
  reason?: string
  /** plan13-profile: refusal reason code, stable for programmatic callers. */
  reasonCode?: 'INVALID_PROFILE_NAME' | 'PROFILE_LOCKED'
  /** plan13-profile: the absolute profile directory involved in the refusal. */
  profileDir?: string
}

/* plan07: result envelopes — every field maps 1:1 to the cdp_stealth /
   cdp_fingerprint tool output schemas (additionalProperties:false safe). */

/** plan07: one row of the cdp_stealth profile listing. */
export interface StealthProfileRow {
  readonly name: string
  readonly locale: string
  /** UA-CH platform ('Windows' | 'macOS' | 'Linux'). */
  readonly platform: string
  readonly userAgent: string
}

/** plan07: cross-layer coherence verdict (G9/G3/G1). */
export interface StealthCoherence {
  /** Stealth script registered for the active page session. */
  readonly js: boolean
  /** UA/UA-CH/Accept-Language overrides applied without warnings. */
  readonly headers: boolean
  /** Browser was launched (not merely attached) with the profile flags. */
  readonly launch: boolean
}

/** plan07: cdp_stealth status envelope. */
export interface StealthStatusResult {
  readonly profile: string
  readonly profiles: readonly StealthProfileRow[]
  readonly applied: boolean
  readonly coherence: StealthCoherence
  readonly warnings: readonly string[]
}

/** plan07: one fingerprint coherence check. */
export interface FingerprintCheck {
  readonly id: string
  readonly ok: boolean
  readonly expected: string
  readonly actual: string
}

/** plan07: cdp_fingerprint envelope (A11 why-blocked list included). */
export interface FingerprintResult {
  readonly profile: string
  readonly coherent: boolean
  readonly checks: readonly FingerprintCheck[]
  readonly whyBlocked: readonly WhyBlockedReason[]
}

/**
 * plan07: one-page probe for cdp_fingerprint. Returns a plain object; every
 * read is individually guarded so a missing API yields null, never a throw.
 */
const FINGERPRINT_PROBE = `(() => {
  const out = {}
  const read = (key, fn) => { try { out[key] = fn() } catch { out[key] = null } }
  read('webdriver', () => navigator.webdriver === true)
  read('userAgent', () => navigator.userAgent)
  read('platform', () => navigator.platform)
  read('languages', () => Array.from(navigator.languages || []))
  read('uaChPlatform', () => (navigator.userAgentData ? navigator.userAgentData.platform : null))
  read('pluginsLength', () => (navigator.plugins ? navigator.plugins.length : null))
  read('hardwareConcurrency', () => navigator.hardwareConcurrency)
  read('deviceMemory', () => navigator.deviceMemory)
  read('hasChrome', () => typeof window.chrome === 'object' && window.chrome !== null)
  read('hasChromeCsi', () => Boolean(window.chrome && typeof window.chrome.csi === 'function'))
  read('hasChromeLoadTimes', () => Boolean(window.chrome && typeof window.chrome.loadTimes === 'function'))
  read('chromeHasRuntime', () => Boolean(window.chrome && window.chrome.runtime))
  read('fontsStatus', () => (document.fonts ? document.fonts.status : null))
  read('connection', () => (navigator.connection ? {
    effectiveType: navigator.connection.effectiveType,
    rtt: navigator.connection.rtt,
    downlink: navigator.connection.downlink,
  } : null))
  read('screen', () => ({ width: screen.width, height: screen.height, colorDepth: screen.colorDepth }))
  read('viewport', () => ({
    width: window.innerWidth, height: window.innerHeight,
    outerWidth: window.outerWidth, outerHeight: window.outerHeight,
    dpr: window.devicePixelRatio,
  }))
  read('automationKeys', () => {
    const keys = []
    const scan = obj => {
      try {
        for (const key of Object.getOwnPropertyNames(obj)) {
          if (/^\\$?cdc_|webdriver|__nightmare|_Selenium_IDE_Recorder|__driver_|__selenium_|__fxdriver_/.test(key)) keys.push(key)
        }
      } catch {}
    }
    scan(document)
    scan(window)
    return keys.slice(0, 12)
  })
  // plan07-fix (T1 §4): real-vs-forged structure probes.
  const probeNavKeys = ['webdriver', 'plugins', 'mimeTypes', 'language', 'languages', 'platform', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'fonts', 'connection']
  read('navigatorOwnKeys', () => Object.getOwnPropertyNames(navigator).filter(key => probeNavKeys.includes(key)))
  read('protoInstanceMismatches', () => {
    const found = []
    try {
      const proto = Object.getPrototypeOf(navigator)
      if (proto !== null && proto !== undefined) {
        for (const key of probeNavKeys) {
          try {
            const desc = Object.getOwnPropertyDescriptor(proto, key)
            if (desc === undefined || typeof desc.get !== 'function') continue
            if (JSON.stringify(desc.get.call(navigator)) !== JSON.stringify(navigator[key])) found.push(key)
          } catch { found.push(key) }
        }
      }
    } catch {}
    return found
  })
  read('uaChBrandMajor', () => {
    const data = navigator.userAgentData
    if (!data || !data.brands) return null
    const chrome = data.brands.find(brand => brand.brand === 'Google Chrome' || brand.brand === 'Chromium')
    return chrome ? chrome.version : null
  })
  read('languagesWithQ', () => Array.from(navigator.languages || []).filter(tag => typeof tag === 'string' && tag.indexOf(';q=') !== -1))
  read('pluginInstanceof', () => {
    if (typeof Plugin === 'undefined' || !navigator.plugins || navigator.plugins.length === 0) return null
    return navigator.plugins[0] instanceof Plugin
  })
  return out
})()`

/**
 * Core CDP management service for DeepSeek Harness.
 */
/** F1: click-dispatch evidence — did a click event provably reach the page? */
export interface ClickDelivery {
  /** False when the post-dispatch probe saw no click event (hidden/background target). */
  readonly delivered?: boolean
}

/**
 * plan15-viewport: project one observation onto the metrics block a viewport
 * answer carries. Used for the acted-on and the verified numbers alike, so
 * the two the caller compares are shaped identically.
 * @param observation - the live observation to project.
 * @returns the CSS-pixel metrics block.
 */
function toViewportMetrics(observation: ViewportObservation): ViewportMetrics {
  return {
    width: observation.width,
    height: observation.height,
    deviceScaleFactor: observation.deviceScaleFactor,
    mobile: observation.mobile,
  }
}

/**
 * The session coordinator every `cdp_*` tool runs through: owns the browser
 * launch, the raw CDP WebSocket connection, target-registry bookkeeping and
 * per-target page sessions, and layers the tool operations — snapshot
 * weaving, human-like input, eval/exec envelopes, waits, downloads, PDF,
 * dialogs, and context lifecycle — on top of them.
 */
export class CdpService {
  private connection: CdpConnection | undefined
  private registry: TargetRegistry | undefined
  private launched: LaunchedBrowser | undefined
  private readonly sessions = new Map<string, PageSession>()
  private readonly store = new CaptureStore({
    limits: {
      maxBodyBytesPerMessage: 65_536,
      maxTotalBodyBytes: 1_048_576,
      maxExchanges: 500,
      maxHeadersPerMessage: 64,
    },
  })
  private readonly ca = new CertificateAuthority()
  private proxy: CdpProxy | undefined
  private explicitProxyActive: boolean | undefined
  // plan04-FAZ7: bumped by stop() so a proxy start racing teardown detects the
  // epoch change and closes itself instead of leaking a listener.
  private proxyEpoch = 0
  // plan06: newest live viewport observation. status() reads it synchronously;
  // snapshot/screenshot refresh it through probeViewport (never 1280x800).
  private lastViewport: ViewportObservation | undefined
  private lastViewportAt = 0
  // plan06: set only by an explicit cdp_viewport call; probe source 'override' hinges on it.
  private viewportOverride: { width: number, height: number, deviceScaleFactor: number, mobile: boolean } | undefined
  private capture: ScreenshotCapture | undefined
  // plan06: captures serialize on one queue so two concurrent clips never overlap (plan 7.9).
  private captureQueue: Promise<unknown> = Promise.resolve()
  // plan10: immutable options (downloads root, PDF byte cap, fetch override).
  private readonly serviceOptions: CdpServiceOptions
  // plan10: created lazily — the manager needs a live connection to subscribe.
  private downloadManagerInstance: DownloadManager | undefined
  // plan03: how the most recent page-session resolution was proven; status()
  // reports it as `resolvedBy` so a wrong-tab run is visible after the fact.
  private lastResolutionVia: CdpResolutionVia | undefined
  // plan03: disposer for the Target.targetActivated subscription connect() arms.
  private targetActivatedOff: (() => void) | undefined
  // plan04: every attached endpoint stays pooled; the fields above mirror only
  // the ACTIVE entry — parkActive()/activateEntry() swap them across switches.
  private readonly pool: ConnectionPool
  // plan07: the single browser story (G9/G3/G4/G26) — JS patches, Sec-CH-UA*
  // and Accept-Language headers, and launch flags all project from this profile.
  private stealthProfile: StealthProfile = DEFAULT_STEALTH_PROFILE
  private stealthOverrides: Partial<StealthOptions> = {}
  private stealthWarnings: string[] = []
  private stealthApplied = false
  // plan07: true only when open() launched THIS browser with the profile flags.
  private stealthLaunchApplied = false
  // plan07: identifiers registered per session — a profile switch replaces the
  // old registration instead of stacking two scripts (the idempotency marker
  // would let only the first one win on each document).
  private readonly stealthScriptIds = new Map<string, string>()
  // plan13-profile: the user-data directories THIS service launched on. A lock
  // inside one of these is our own browser, not a conflict — the lock report
  // only ever describes somebody else's window.
  private readonly ownedProfileDirs = new Set<string>()

  /**
   * @param serviceOptions - plan10 downloads/PDF options; defaults apply.
   */
  constructor(serviceOptions: CdpServiceOptions = {}) {
    this.serviceOptions = serviceOptions
    // plan04: the pool's reconnect driver rebuilds state through this service.
    this.pool = new ConnectionPool({ hooks: { onReconnected: async (entry) => { await this.handleReconnected(entry) } } })
  }

  /**
   * Current status of the CDP extension.
   * @returns standard status payload matching {@link CdpStatusResponse}.
   */
  status(): CdpStatusResponse {
    const connection = this.connection
    const active = this.registry?.active()
    return {
      ok: true,
      version: CDP_VERSION,
      targets: this.registry?.targets().length ?? 0,
      proxy: { active: this.proxyActive },
      // plan01: cached state fields — the socket's own state, the tab
      // inventory, and the resolution evidence. `endpoint`/`activeTargetId`
      // appear only while a connection/registry exists, so an untouched
      // disconnected payload keeps its stable shape.
      connectionState: this.readConnectionState(),
      openTabs: this.readOpenTabs(),
      ...(connection !== undefined ? { endpoint: connection.endpoint } : {}),
      ...(active !== undefined ? { activeTargetId: active.targetId } : {}),
      // plan03: page-tab count rides only while a connection exists, and the
      // resolution evidence only after the first getPageSession resolution —
      // an untouched payload keeps the stable shape status.spec pins.
      ...(connection !== undefined ? { pages: this.pageCount() } : {}),
      // plan13-profile: which profile the ACTIVE browser runs on. Additive and
      // conditional exactly like `endpoint`: a never-connected payload keeps the
      // shape status.spec pins, and a connected one always answers the question
      // "which Google profile is that?" — `ephemeral` when the session is a
      // throwaway, `external` for a browser DSH attached to but did not launch.
      ...(this.activeProfileName() === '' ? {} : { profile: this.activeProfileName() }),
      ...(this.lastResolutionVia !== undefined ? { resolvedBy: this.lastResolutionVia } : {}),
      // plan06: report the cached live viewport only once one has been probed,
      // so an untouched status payload stays byte-identical to the static read.
      ...(this.lastViewport !== undefined
        ? {
            viewport: {
              width: this.lastViewport.width,
              height: this.lastViewport.height,
              deviceScaleFactor: this.lastViewport.deviceScaleFactor,
              source: this.lastViewport.source,
            },
          }
        : {}),
    }
  }

  /**
   * plan01: the asynchronous status surface both `GET /api/server/cdp/status`
   * and the `cdp_status` tool answer with. It refreshes the live viewport
   * observation through plan06's cache-bounded probe — but only when a page
   * target exists, so a status read never creates a tab (rule R1/E18) — and
   * then returns the enriched {@link CdpStatusResponse}. Never throws: a
   * failing probe leaves the cached payload intact.
   * @param options - optional probe tuning; reserved for later probes.
   * @returns the freshest status payload available.
   */
  async statusLive(options?: { probeTimeoutMs?: number }): Promise<CdpStatusDetail> {
    void options
    const hasPageTarget = (this.registry?.targets() ?? []).some(target => target.type === 'page')
    if (hasPageTarget) {
      await this.refreshViewport().catch(() => undefined)
    }
    return this.status()
  }

  /**
   * @returns the connection's own state, mapped to the status vocabulary.
   */
  private readConnectionState(): CdpConnectionState {
    const connection = this.connection
    if (connection === undefined) return 'disconnected'
    switch (connection.state) {
      case 'open': return 'connected'
      case 'connecting': return 'connecting'
      case 'closed': return 'closed'
      default: return 'disconnected'
    }
  }

  /**
   * @returns brief rows of every `page` target: the cached tab inventory `openTabs` reports.
   */
  private readOpenTabs(): CdpTabBrief[] {
    return (this.registry?.targets() ?? [])
      .filter(target => target.type === 'page')
      .map(target => ({ targetId: target.targetId, title: target.title, url: target.url }))
  }

  /** Captured network traffic store. */
  get captureStore(): CaptureStore {
    return this.store
  }

  /** Certificate Authority instance. */
  get certificateAuthority(): CertificateAuthority {
    return this.ca
  }

  /** Whether the proxy is currently listening. */
  get proxyActive(): boolean {
    return this.explicitProxyActive ?? (this.proxy?.isListening ?? false)
  }

  /**
   * Start the local HTTP/HTTPS intercepting proxy.
   * @param port - port to bind on loopback.
   * @returns actual listening port.
   */
  async startProxy(port = 9333): Promise<number> {
    if (this.proxy !== undefined && this.proxy.isListening) return this.proxy.port
    const p = new CdpProxy({ port, store: this.store, ca: this.ca })
    await p.start()
    this.proxy = p
    return p.port
  }

  /**
   * Stop the intercepting proxy.
   */
  async stopProxy(): Promise<void> {
    if (this.proxy !== undefined) {
      await this.proxy.stop()
      this.proxy = undefined
    }
  }

  /** Whether a browser connection is currently active. */
  get isConnected(): boolean {
    return this.connection?.connected ?? false
  }

  /** Active targets discovered in the browser. */
  get targets(): readonly TargetInfo[] {
    return this.registry?.targets() ?? []
  }

  /**
   * Set proxy active state for status reporting.
   * @param active - whether proxy listener is currently active.
   */
  setProxyActive(active: boolean): void {
    this.explicitProxyActive = active
  }

  /**
   * Connect to an existing browser over a WebSocket URL.
   * @param endpoint - browser debugger WebSocket URL.
   * @param options - connection timeout options.
   */
  async connect(endpoint: string, options?: CdpConnectionOptions): Promise<void> {
    // plan04: pool-aware idempotent attach. A live endpoint is ADOPTED (no
    // re-dial, no sibling dropped); a stale entry for the same URL is detached
    // and re-dialed below; the current active endpoint is PARKED — its socket,
    // registry, sessions, and browser process stay alive in the pool — where
    // the old `await this.disconnect()` silently killed them.
    const existing = this.pool.get(endpoint)
    if (existing !== undefined) {
      if (existing.connection.connected) {
        if (this.connection === existing.connection) return
        this.parkActive()
        this.activateEntry(existing)
        return
      }
      await this.pool.detach(existing)
    }
    if (this.connection !== undefined) this.parkActive()
    const conn = new CdpConnection(endpoint, options)
    await conn.connect()
    this.connection = conn

    const targetAdapter = createTargetConnectionAdapter(conn)
    const reg = new TargetRegistry(targetAdapter)
    await reg.list()
    this.registry = reg
    // plan03 Adım 2: without discovery the registry only hears lifecycle
    // events it can never receive (Target.targetCreated/destroyed/infoChanged
    // are emitted only after setDiscoverTargets), so the tracked tab list
    // went stale until the next explicit list(). Best-effort: a browser that
    // refuses the command still connects — refreshTargets() stays the
    // authoritative path.
    await conn.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined)
    // plan03: the browser is the source of truth for focus — a human clicking
    // a tab (or a popup taking focus) moves our active pointer too, instead of
    // leaving cdp_tabs and the resolver disagreeing with the window.
    this.targetActivatedOff?.()
    this.targetActivatedOff = conn.on('Target.targetActivated', (cdpEvent) => {
      const targetId = (cdpEvent.params as { targetId?: unknown } | undefined)?.targetId
      if (typeof targetId !== 'string' || targetId === '') return
      if (reg.targets().some(target => target.targetId === targetId)) {
        try {
          reg.setActive(targetId)
        } catch {
          // The registry was disposed between the event and this handler.
        }
      }
    })
    // plan06: a new connection starts with no viewport observation or override.
    this.lastViewport = undefined
    this.lastViewportAt = 0
    this.viewportOverride = undefined
    // plan03: the previous connection's resolution evidence does not carry over.
    this.lastResolutionVia = undefined
    // plan04: register the connection in the pool and arm the reattach driver.
    // The listeners attach AFTER the first CDP_CONNECTED_EVENT, so every
    // lifecycle event they see from here on is a genuine reconnect/drop.
    const pooled = this.pool.adopt(endpoint, conn)
    pooled.registry = reg
    pooled.targetActivatedOff = this.targetActivatedOff
  }

  /**
   * Query the loopback discovery endpoint (`/json/version`) on the given port.
   * @param port - loopback remote debugging port.
   * @param fetchImpl - fetch function to use.
   * @returns webSocketDebuggerUrl if found.
   */
  async discoverEndpoint(port: number, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<string> {
    const url = `http://127.0.0.1:${String(port)}/json/version`
    const res = await fetchImpl(url)
    if (!res.ok) {
      throw new Error(`cdp discovery failed: ${url} returned HTTP ${String(res.status)}`)
    }
    const data = await res.json() as { webSocketDebuggerUrl?: string }
    if (typeof data.webSocketDebuggerUrl !== 'string' || data.webSocketDebuggerUrl.length === 0) {
      throw new Error(`cdp discovery failed: ${url} did not provide webSocketDebuggerUrl`)
    }
    return data.webSocketDebuggerUrl
  }

  /**
   * Open or attach to a browser according to the supplied options.
   * plan04: idempotent — resolving to an already-pooled endpoint adopts it
   * instead of dialing, so a second call never drops the existing connection.
   * plan13-profile: a call that names NO endpoint/port/switchTo first DISCOVERS
   * the configured loopback ports and, when a live browser turns up, returns
   * `{needsChoice:true, discovered:[…]}` without touching anything — the caller
   * (the model, asking the user) picks. A named `profile` is itself a decision.
   * @param options - open options.
   * @returns endpoint URL, live target count, pool id, and the reuse verdict.
   */
  async open(options: CdpOpenOptions = {}): Promise<CdpOpenResult> {
    // plan13-profile: `switchTo` is the named answer to a `needsChoice`
    // envelope; it means exactly what `port` means, so it is folded in here and
    // every branch below keeps reading one field.
    const requested: CdpOpenOptions = options.switchTo !== undefined && options.port === undefined
      ? { ...options, port: options.switchTo }
      : options
    // A decision was supplied → apply it. Everything else goes through discovery.
    const decided = requested.endpoint !== undefined || requested.port !== undefined

    // plan13-profile: resolve and validate the profile BEFORE any probe or
    // spawn, so an invalid name can never reach the filesystem and a locked
    // profile is reported before anything is disturbed.
    let profileDir: string | undefined
    if (requested.profile !== undefined) {
      let resolved: string
      try {
        resolved = resolveProfileDir(requested.profile, { profilesRoot: this.serviceOptions.profilesRoot })
      } catch (error) {
        const message = error instanceof CdpProfileError
          ? error.message
          : `cdp: invalid profile name "${requested.profile}"`
        return {
          endpoint: '',
          targets: 0,
          connectionId: '',
          reused: false,
          reason: message,
          reasonCode: 'INVALID_PROFILE_NAME',
        }
      }
      profileDir = resolved
      // The same profile already open in THIS service is not a conflict: the
      // re-open below simply re-adopts it.
      if (!this.ownsProfileDir(resolved)) {
        const lock = readProfileLock(resolved)
        if (lock.locked) {
          return {
            endpoint: '',
            targets: 0,
            connectionId: '',
            reused: false,
            reason: profileLockedMessage(requested.profile!, resolved, lock),
            reasonCode: 'PROFILE_LOCKED',
            profileDir: resolved,
          }
        }
      }
    }

    // plan13-profile: no decision → discover first and hand the choice back.
    if (!decided) {
      const choice = await this.endpointChoice()
      if (choice !== undefined) return choice
    }

    // plan13-profile: a named profile that is ALREADY the live session is a
    // no-op, exactly like a bare re-open (plan04-F6). Without this, the launch
    // branch below would start a SECOND browser on the same directory, and
    // Chromium's own lock failure would surface as an opaque spawn error.
    if (profileDir !== undefined) {
      const live = this.connection
      const liveDir = live === undefined ? undefined : this.pool.get(live.endpoint)?.userDataDir
      if (live !== undefined && live.connected && liveDir === profileDir) {
        return {
          endpoint: live.endpoint,
          targets: this.targets.length,
          connectionId: this.pool.get(live.endpoint)?.connectionId ?? '',
          reused: true,
          profile: this.activeProfileName(),
          note: `reused the live session: profile "${requested.profile}" is already open at ${live.endpoint}`,
        }
      }
    }

    // plan04-F6: one service = one ACTIVE session. Parallel agents sharing the
    // harness (T1/T3/T6 saw the socket handed off five times in one test) must
    // never have cdp_open yank it: with a live endpoint, a bare re-open or a
    // port that resolves elsewhere KEEPS the current session instead of
    // relaunching/switching — same config is a pure no-op. Only an explicit
    // `endpoint` (below) still switches, and the pool parks the previous one.
    // plan13-profile: naming a profile is an explicit decision too, so that
    // block is skipped for it — `cdp_open({profile:'assistant'})` must reach
    // the launch branch even while an unrelated browser is live.
    const current = this.connection
    if (current !== undefined && current.connected && requested.endpoint === undefined && requested.profile === undefined) {
      if (requested.port !== undefined) {
        let found: string | undefined
        try {
          found = await this.discoverEndpoint(requested.port, requested.fetch)
        } catch {
          found = undefined
        }
        if (found !== undefined && found !== current.endpoint) {
          return {
            endpoint: current.endpoint,
            targets: this.targets.length,
            connectionId: this.pool.get(current.endpoint)?.connectionId ?? '',
            reused: true,
            note: `kept the live session: port ${String(requested.port)} resolves to ${found}, `
              + `but the active endpoint ${current.endpoint} stays (pass endpoint or switchTo to switch explicitly)`,
          }
        }
        if (found === undefined) {
          return {
            endpoint: current.endpoint,
            targets: this.targets.length,
            connectionId: this.pool.get(current.endpoint)?.connectionId ?? '',
            reused: true,
            note: `kept the live session: port ${String(requested.port)} did not answer discovery `
              + '(pass endpoint or switchTo to switch explicitly)',
          }
        }
      }
      return {
        endpoint: current.endpoint,
        targets: this.targets.length,
        connectionId: this.pool.get(current.endpoint)?.connectionId ?? '',
        reused: true,
        profile: this.activeProfileName(),
      }
    }

    let endpoint = requested.endpoint

    if (endpoint === undefined && requested.port !== undefined) {
      try {
        endpoint = await this.discoverEndpoint(requested.port, requested.fetch)
      } catch {
        // Fall back to launching below if port discovery failed and launching is permitted.
      }
    }

    let launched: LaunchedBrowser | undefined
    let launchedProfile = profileDir
    if (endpoint === undefined) {
      // plan04-proxy: a fresh browser must RIDE the capture proxy or nothing
      // is ever recorded (live: net_capture saw 0 exchanges — the listener
      // was up but the browser went direct). Re-fire the bind (it may have
      // failed at load), then add the routing flags ONLY while the listener
      // is actually up: an unreachable bind keeps the old launch behavior.
      await this.ensureProxy()
      const proxyArgs = this.proxy?.isListening === true
        ? [
            // MITM needs the flags: the proxy signs leaf certs with the
            // local CA (net/ca.ts), which a fresh profile does not trust.
            // plan07: only while the proxy is open. Loopback (CDP itself,
            // local fixtures) keeps Chromium's implicit proxy bypass.
            `--proxy-server=http://127.0.0.1:${String(this.proxy.port)}`,
            '--ignore-certificate-errors',
          ]
        : []
      // plan07: launch flags join the same profile story (G1/G26). The Set
      // dedupes identical flags; distinct caller flags stay and come last, so
      // a caller can still override by passing its own value.
      const extraArgs = [...new Set([
        ...(requested.headless !== false ? ['--headless=new'] : []),
        ...deriveLaunchArgs(this.stealthProfile),
        ...proxyArgs, // plan04-proxy
        ...(requested.extraArgs ?? []),
      ])]
      // plan13-profile: a named profile is a FIXED directory, created once and
      // never deleted — that is what keeps the user's own sign-in alive across
      // runs. Omitting `profile` keeps the historical throwaway directory.
      if (profileDir !== undefined) {
        await mkdir(profileDir, { recursive: true })
      }
      const userDataDir = profileDir ?? mkdtempSync(join(tmpdir(), 'dsh-cdp-'))
      if (profileDir === undefined) launchedProfile = userDataDir
      const launchOpts: BrowserLaunchOptions = {
        userDataDir,
        ...(requested.executablePath !== undefined ? { executablePath: requested.executablePath } : {}),
        // plan16-managed: strict pinned channel beside the profiles root.
        ...(requested.managed === true && requested.executablePath === undefined
          ? { managedDir: join(resolveProfilesRoot({ profilesRoot: this.serviceOptions.profilesRoot }), '..', 'browser') }
          : {}),
        extraArgs,
      }
      launched = await launchBrowser(launchOpts)
      // plan07: this browser carries the profile's launch flags (G1/G26).
      this.stealthLaunchApplied = true
      endpoint = launched.websocketUrl
    }

    // plan04: verdict computed BEFORE the dial — connect() adopts a live
    // endpoint instead of re-opening it.
    const reused = this.connection?.endpoint === endpoint && this.connection.connected
    await this.connect(endpoint)
    // plan04: bind the fresh browser process to the NEW active entry only after
    // connect() has parked the previous active (and its own launched tree).
    if (launched !== undefined) this.launched = launched
    // plan13-profile: stamp the endpoint's profile identity onto its pool entry
    // so `cdp_endpoints`/`cdp_status` can answer "which profile is that?"
    // without re-deriving anything. A DSH-launched browser knows its own
    // directory; an attached foreign one is honestly `external`.
    this.stampProfile(endpoint, launchedProfile, launched !== undefined)
    return {
      endpoint,
      targets: this.targets.length,
      // plan04: stable pool id of the endpoint this call attached to.
      connectionId: this.pool.get(endpoint)?.connectionId ?? '',
      reused,
      profile: this.activeProfileName(),
      // plan16-managed: report what actually ran — only when this call launched.
      ...(launched !== undefined
        ? {
          executablePath: launched.executablePath,
          browserKind: requested.executablePath !== undefined
            ? 'explicit'
            : (requested.managed === true ? 'managed' : 'system'),
        }
        : {}),
    }
  }

  /**
   * plan16-profile-list: the named-profile inventory behind `cdp_profiles`.
   * Rows come from the disk (name-validated subdirectories, honest lock
   * reports); `active` is this session's profile identity.
   * @returns the inventory the model sees: root, active identity, one row per named profile.
   */
  profileInventory(): {
    root: string
    active: string
    profiles: { name: string; dir: string; locked: boolean; artifacts: string[]; pid: string }[]
  } {
    const root = resolveProfilesRoot({ profilesRoot: this.serviceOptions.profilesRoot })
    return {
      root,
      active: this.activeProfileName(),
      profiles: listProfileDirs(root).map(row => ({
        name: row.name,
        dir: row.dir,
        locked: row.lock.locked,
        artifacts: [...row.lock.artifacts],
        pid: row.lock.pid,
      })),
    }
  }

  /**
   * plan16-profile-list: true only when THIS service owns the live browser
   * process (a `cdp_open` launch, not a mere attachment) — the honest basis
   * for saying "stop terminated the process" vs "only the connection closed".
   * @returns whether the active browser was launched by this service.
   */
  launchedBrowserOwned(): boolean {
    return this.launched !== undefined
  }

  /**
   * plan13-profile: the ACTIVE profile identity for status and open results.
   * @returns the named profile, `ephemeral` for a throwaway one, `external`
   * for a browser DSH attached to but did not launch, or `''` when no browser
   * is attached at all.
   */
  activeProfileName(): string {
    const connection = this.connection
    // A stand-in service surface may carry a connection without an endpoint;
    // an unaddressable connection has no profile to report.
    if (connection === undefined || typeof connection.endpoint !== 'string') return ''
    return this.pool.get(connection.endpoint)?.profileName ?? EXTERNAL_PROFILE_NAME
  }

  /**
   * plan13-profile: record one endpoint's profile identity on its pool entry.
   * Called after every connect so a parked entry keeps its identity across a
   * switch, and re-attaching to the same URL re-adopts the existing record.
   * @param endpoint - the debugger URL just connected.
   * @param userDataDir - the directory the browser runs on, when this call launched it.
   * @param launchedByService - true only when THIS call spawned the browser.
   */
  private stampProfile(endpoint: string, userDataDir: string | undefined, launchedByService: boolean): void {
    const entry = this.pool.get(endpoint)
    if (entry === undefined) return
    if (userDataDir !== undefined) {
      entry.profileName = profileIdentity(userDataDir)
      entry.userDataDir = userDataDir
      if (launchedByService) this.ownedProfileDirs.add(userDataDir)
    } else if (entry.profileName === undefined) {
      entry.profileName = EXTERNAL_PROFILE_NAME
    }
    if (launchedByService) entry.launchedByService = true
  }

  /**
   * plan13-profile: true when THIS service already launched on that user-data
   * directory. Chromium's lock files are then our own, and a second open on
   * the same profile must re-adopt the live browser rather than refuse.
   * @param dir - the profile directory to test.
   * @returns whether the directory is one this service owns.
   */
  private ownsProfileDir(dir: string): boolean {
    return this.ownedProfileDirs.has(dir)
  }

  /**
   * plan13-profile: the discovery table behind a `needsChoice` answer.
   *
   * Runs the SAME loopback scan `cdp_endpoints` runs (the configured
   * `discoveryPorts`) and keeps only rows that are genuinely a browser — a
   * plain HTTP listener on a probe port (the capture proxy lives on 9333) is
   * not a candidate and must not be offered as one.
   *
   * The ACTIVE endpoint appears in the table (the user should see what they are
   * currently on) but never TRIGGERS the question: plan04-F6 already decided
   * that a bare re-open with a live session is a no-op, and re-asking "should I
   * keep the browser I am already driving?" is noise. The question is raised
   * exactly when there is a live endpoint the service is NOT attached to —
   * which is the user's case: "there is a signed-in browser on 9222, do you
   * want that one, or a new port?"
   *
   * @returns the choice envelope when a live alternative exists, otherwise
   * `undefined` so `open()` proceeds with its normal behavior.
   */
  private async endpointChoice(): Promise<CdpOpenResult | undefined> {
    const rows = await this.endpointInventory()
    const live = rows
      .filter(row => row.endpoint !== '' && (row.reachable || row.attached))
      .map((row): CdpDiscoveredEndpoint => ({
        port: row.port,
        profile: row.profile,
        kind: row.kind,
        targets: row.targets,
        attached: row.attached,
        active: row.active,
        endpoint: row.endpoint,
        browser: row.browser,
      }))
    if (!live.some(row => !row.active)) return undefined
    const choices = live.flatMap(row => [
      `switchTo:${String(row.port)}`,
      `endpoint:${row.endpoint}`,
    ])
    choices.push('profile:<name>')
    return {
      endpoint: '',
      targets: 0,
      connectionId: '',
      reused: false,
      needsChoice: true,
      discovered: live,
      choices,
      // No `reason`: a choice request is not a failure. It carries no
      // `reasonCode` either, so `ok` stays true while `needsChoice` tells the
      // caller that nothing was attached and that the decision is theirs.
    }
  }

  /**
   * Get or create a {@link PageSession} for the specified target.
   * If targetId is omitted, attaches to the active page target or creates one.
   * @param targetId - optional target id.
   * @param options - plan07-fix: `activate:false` seeds a session WITHOUT
   * stealing the active tab (used while opening background/context tabs).
   * @returns active page session.
   */
  async getPageSession(targetId?: string, options: { activate?: boolean } = {}): Promise<PageSession> {
    if (this.connection === undefined || this.registry === undefined) {
      throw new Error('cdp: no active browser connection')
    }

    // plan03 Adım 4: resolution carries evidence. An explicit targetId must be
    // tracked (one Target.getTargets refresh proves a stale list); an omitted
    // one must be provable — the active page, or the only page. Otherwise the
    // call is refused with its candidates instead of silently picking the
    // first tab or spawning about:blank (the 1↔2 target-count flap of the
    // wrong-tab incident). The verdict lands in lastResolutionVia, which
    // status() reports as `resolvedBy`.
    let resolvedTargetId: string | undefined
    let resolvedVia: CdpResolutionVia
    if (targetId !== undefined) {
      let explicit = this.registry.targets().find(t => t.targetId === targetId)
      if (explicit === undefined) {
        await this.registry.list().catch(() => undefined)
        explicit = this.registry.targets().find(t => t.targetId === targetId)
      }
      if (explicit === undefined) {
        // plan04-F6: may have stayed on a parked endpoint — name its successor.
        throw new Error(this.notTrackedMessage(targetId))
      }
      resolvedTargetId = targetId
      resolvedVia = 'explicit'
    } else {
      const active = this.registry.active()
      const pages = this.registry.targets().filter(t => t.type === 'page')
      if (active !== undefined && active.type === 'page') {
        resolvedTargetId = active.targetId
        resolvedVia = 'active'
      } else if (pages.length === 1) {
        resolvedTargetId = pages[0]?.targetId
        resolvedVia = 'single-page'
      } else if (pages.length === 0) {
        throw new Error('cdp: no page target exists; call cdp_tab_new to open one')
      } else {
        throw new Error(
          `cdp: cannot prove which of ${String(pages.length)} tabs to use (none active); pass targetId `
          + `or call cdp_tab_focus first (candidates: ${this.candidateSummary()})`,
        )
      }
    }

    if (resolvedTargetId === undefined) {
      throw new Error('cdp: could not resolve target')
    }
    this.lastResolutionVia = resolvedVia

    let sessionId = this.registry.attachedSession(resolvedTargetId)
    if (sessionId === undefined) {
      sessionId = await this.registry.attach(resolvedTargetId)
    }

    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      const pageAdapter = createPageConnectionAdapter(this.connection)
      session = new PageSession(pageAdapter, sessionId)
      this.sessions.set(sessionId, session)

      // plan07: register the profile's stealth script and mirror the same
      // story into network headers for this page session; every layer failure
      // is recorded as a warning instead of silently diverging (G9).
      await this.applyStealthToSession(sessionId)
    }

    if (options.activate !== false) this.registry.setActive(resolvedTargetId)
    return session
  }

  /**
   * plan07: register the active profile's stealth script on one page session
   * and mirror the SAME story into network headers (G9/G3/G4/G26). Each layer
   * is attempted independently; a failure becomes a warning string so the
   * status view can show exactly which layer diverges instead of hiding it.
   * @param sessionId - attached page session to register on.
   */
  private async applyStealthToSession(sessionId: string): Promise<void> {
    const profile = this.stealthProfile
    const warnings: string[] = []
    const previousId = this.stealthScriptIds.get(sessionId)
    if (previousId !== undefined) {
      try {
        await this.connection?.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: previousId }, sessionId)
      } catch {
        warnings.push('previous stealth registration could not be removed; an old profile may persist on open documents')
      }
      this.stealthScriptIds.delete(sessionId)
    }
    try {
      await this.connection?.send('Page.enable', {}, sessionId)
    } catch {
      warnings.push('Page.enable failed; the stealth script is not registered for this page')
    }
    try {
      const added = await this.connection?.send('Page.addScriptToEvaluateOnNewDocument', {
        source: stealthScript(deriveStealthOptions(profile, this.stealthOverrides)),
      }, sessionId) as { identifier?: string } | undefined
      if (added !== undefined && added.identifier !== undefined) {
        this.stealthScriptIds.set(sessionId, added.identifier)
      }
    } catch {
      warnings.push('Page.addScriptToEvaluateOnNewDocument failed; page scripts see the raw automation surface')
    }
    // plan07-fix: Accept-Language travels through EXACTLY ONE channel —
    // setExtraHTTPHeaders (replace semantics, verified per request type).
    // Passing the same string as Network override's `acceptLanguage` made
    // Chrome re-serialize it with a doubled q (`en-US,en;q=0.9;q=0.9`) on
    // main-frame navigations AND reflect the raw split into
    // navigator.languages (`["en-US","en;q=0.9"]`).
    const acceptLanguage = deriveAcceptLanguage(profile.languageValues)
    try {
      await this.connection?.send('Network.enable', {}, sessionId)
    } catch {
      warnings.push('Network.enable failed; the header story is not applied')
    }
    // plan07-fix: BOTH override surfaces carry UA + UA-CH metadata so the
    // wire story and the JS story come from the same profile object (G9);
    // neither carries acceptLanguage (see above).
    const userAgentMetadata = {
      brands: profile.uaCh.brands.map(brand => ({ brand: brand.brand, version: brand.version })),
      fullVersion: profile.chromeVersion,
      fullVersionList: profile.uaCh.fullVersionList.map(brand => ({ brand: brand.brand, version: brand.version })),
      platform: profile.uaCh.platform,
      platformVersion: profile.uaCh.platformVersion,
      architecture: profile.uaCh.architecture,
      bitness: profile.uaCh.bitness,
      model: profile.uaCh.model,
      mobile: profile.uaCh.mobile,
      wow64: profile.uaCh.wow64,
    }
    try {
      await this.connection?.send('Emulation.setUserAgentOverride', {
        userAgent: profile.userAgent,
        platform: profile.platformValue,
        userAgentMetadata,
      }, sessionId)
    } catch {
      warnings.push('Emulation.setUserAgentOverride failed; navigator may report the raw automation UA (G9)')
    }
    try {
      await this.connection?.send('Network.setUserAgentOverride', {
        userAgent: profile.userAgent,
        userAgentMetadata,
      }, sessionId)
    } catch {
      warnings.push('Network.setUserAgentOverride failed; JS and Sec-CH-UA headers may diverge (G9)')
    }
    try {
      await this.connection?.send('Network.setExtraHTTPHeaders', {
        headers: { 'Accept-Language': acceptLanguage },
      }, sessionId)
    } catch {
      warnings.push('Network.setExtraHTTPHeaders failed; the wire Accept-Language may diverge (G3)')
    }
    this.stealthWarnings = warnings
    this.stealthApplied = true
  }

  /**
   * plan07 `cdp_stealth` (read-only): the active profile, every built-in
   * profile, the cross-layer coherence verdict, and any layer warnings.
   * @returns the status envelope.
   */
  stealthStatus(): StealthStatusResult {
    const warnings = [...this.stealthWarnings]
    const headerWarning = warnings.some(w => /header|Accept-Language|Sec-CH/i.test(w))
    return {
      profile: this.stealthProfile.name,
      profiles: STEALTH_PROFILES.map(profile => ({
        name: profile.name,
        locale: profile.locale,
        platform: profile.uaCh.platform,
        userAgent: profile.userAgent,
      })),
      applied: this.stealthApplied,
      coherence: {
        js: this.stealthApplied,
        headers: this.stealthApplied && !headerWarning,
        launch: this.stealthLaunchApplied,
      },
      warnings,
    }
  }

  /**
   * plan07 `cdp_stealth` (apply): activate a profile and re-register the whole
   * story on the page session (fresh documents get the new profile; the
   * idempotency marker keeps each document on exactly one registration).
   * @param profileName - profile id; empty string keeps the current profile.
   * @param targetId - page session to register on; defaults to the active page.
   * @returns the status envelope after application.
   * @throws Error naming every known profile when `profileName` is unknown.
   */
  async stealthApply(profileName: string, targetId?: string): Promise<StealthStatusResult> {
    if (profileName !== '') this.stealthProfile = resolveStealthProfile(profileName)
    const session = await this.getPageSession(targetId)
    await this.applyStealthToSession(session.sessionId)
    return this.stealthStatus()
  }

  /**
   * plan07 `cdp_fingerprint`: probe the page's reported surface with one
   * `Runtime.evaluate`, compare it against the active profile (G9 coherence),
   * and classify every divergence into ordered why-blocked reasons (A11).
   * @param targetId - page to probe; defaults to the active page.
   * @returns checks + why-blocked reasons.
   * @throws Error when the probe cannot run or its payload is unreadable.
   */
  async fingerprint(targetId?: string): Promise<FingerprintResult> {
    const evaluation = await this.evaluate(FINGERPRINT_PROBE, targetId)
    if (evaluation.exception !== undefined || !evaluation.hasValue) {
      throw new Error(`cdp: fingerprint probe failed: ${evaluation.exception ?? 'no value returned'}`)
    }
    if (evaluation.truncated) {
      throw new Error('cdp: fingerprint probe payload was truncated')
    }
    let raw: unknown
    try {
      raw = JSON.parse(evaluation.value)
    } catch {
      throw new Error('cdp: fingerprint probe returned unreadable data')
    }
    const probe = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const asBool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
    const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)
    const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
    const asStrings = (value: unknown): string[] | null =>
      (Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value as string[]] : null)
    const asRecord = (value: unknown): Record<string, unknown> | null =>
      (typeof value === 'object' && value !== null ? value as Record<string, unknown> : null)

    const profile = this.stealthProfile
    const userAgent = asString(probe.userAgent)
    const platform = asString(probe.platform)
    const uaChPlatform = asString(probe.uaChPlatform)
    const languages = asStrings(probe.languages) ?? []
    const pluginsLength = asNumber(probe.pluginsLength)
    const fontsStatus = asString(probe.fontsStatus)
    const automationKeys = asStrings(probe.automationKeys) ?? []
    const screen = asRecord(probe.screen)
    const viewport = asRecord(probe.viewport)
    const connection = asRecord(probe.connection)
    const connectionType = connection !== null ? asString(connection.effectiveType) : null
    const hasChrome = asBool(probe.hasChrome)
    const chromeExtras = asBool(probe.hasChromeCsi) === true && asBool(probe.hasChromeLoadTimes) === true
    const chromeHasRuntime = asBool(probe.chromeHasRuntime)

    const screenW = screen !== null ? asNumber(screen.width) : null
    const screenH = screen !== null ? asNumber(screen.height) : null
    const outerW = viewport !== null ? asNumber(viewport.outerWidth) : null
    const outerH = viewport !== null ? asNumber(viewport.outerHeight) : null
    const screenCovers = screenW !== null && screenH !== null && outerW !== null && outerH !== null
      ? screenW >= outerW && screenH >= outerH
      : null

    const uaMajor = userAgent !== null ? (/Chrome\/(\d+)/.exec(userAgent)?.[1] ?? null) : null
    const expectedMajor = profile.chromeVersion.split('.')[0] ?? ''
    const expectedLanguages = profile.languageValues.join(',')

    // plan07-fix (T1 §4): structure-level evidence — own-key traces,
    // prototype/instance contradictions, UA-CH major, AL tag pollution,
    // and fabricated plugin objects.
    const navigatorOwnKeys = asStrings(probe.navigatorOwnKeys) ?? []
    const protoInstanceMismatches = asStrings(probe.protoInstanceMismatches) ?? []
    const uaChBrandMajor = asString(probe.uaChBrandMajor)
    const languagesWithQ = asStrings(probe.languagesWithQ) ?? []
    const pluginInstanceof = asBool(probe.pluginInstanceof)

    const checks: FingerprintCheck[] = [
      { id: 'webdriver-hidden', ok: asBool(probe.webdriver) === false, expected: 'false', actual: String(probe.webdriver) },
      { id: 'user-agent-matches-profile', ok: userAgent === profile.userAgent, expected: profile.userAgent, actual: userAgent ?? 'unavailable' },
      { id: 'platform-matches-profile', ok: platform === profile.platformValue, expected: profile.platformValue, actual: platform ?? 'unavailable' },
      { id: 'languages-match-profile', ok: languages.join(',') === expectedLanguages, expected: expectedLanguages, actual: languages.join(',') },
      { id: 'ua-ch-platform-coherent', ok: uaChPlatform === profile.uaCh.platform, expected: profile.uaCh.platform, actual: uaChPlatform ?? 'unavailable' },
      { id: 'ua-ch-major-matches-ua', ok: uaMajor === expectedMajor, expected: expectedMajor, actual: uaMajor ?? 'missing' },
      { id: 'plugins-present', ok: pluginsLength !== null && pluginsLength > 0, expected: '> 0', actual: String(pluginsLength) },
      { id: 'screen-covers-window', ok: screenCovers === true, expected: 'screen >= window', actual: screenCovers === null ? 'unavailable' : String(screenCovers) },
      { id: 'chrome-extras-coherent', ok: hasChrome === true && chromeExtras && chromeHasRuntime === false, expected: 'csi+loadTimes, no runtime', actual: `chrome=${String(hasChrome)} extras=${String(chromeExtras)} runtime=${String(chromeHasRuntime)}` },
      { id: 'no-automation-variables', ok: automationKeys.length === 0, expected: 'none', actual: automationKeys.length > 0 ? automationKeys.join(', ') : 'none' },
      { id: 'fonts-loaded', ok: fontsStatus === 'loaded', expected: 'loaded', actual: fontsStatus ?? 'unavailable' },
      { id: 'connection-4g', ok: connectionType === '4g', expected: '4g', actual: connectionType ?? 'unavailable' },
      {
        id: 'device-numbers-match-profile',
        ok: asNumber(probe.hardwareConcurrency) === profile.device.hardwareConcurrency
          && asNumber(probe.deviceMemory) === profile.device.deviceMemoryGb,
        expected: `${String(profile.device.hardwareConcurrency)}c/${String(profile.device.deviceMemoryGb)}GB`,
        actual: `${String(probe.hardwareConcurrency)}c/${String(probe.deviceMemory)}GB`,
      },
      // plan07-fix (T1 §4): real-vs-forged structure checks.
      { id: 'no-navigator-own-props', ok: navigatorOwnKeys.length === 0, expected: 'none', actual: navigatorOwnKeys.length > 0 ? navigatorOwnKeys.join(', ') : 'none' },
      { id: 'proto-instance-agree', ok: protoInstanceMismatches.length === 0, expected: 'no mismatch', actual: protoInstanceMismatches.length > 0 ? protoInstanceMismatches.join(', ') : 'none' },
      { id: 'ua-ch-agrees-with-ua', ok: uaChBrandMajor === uaMajor, expected: uaMajor ?? 'unavailable', actual: uaChBrandMajor ?? 'unavailable' },
      { id: 'languages-clean-tags', ok: languagesWithQ.length === 0, expected: 'no ;q= tags', actual: languagesWithQ.length > 0 ? languagesWithQ.join(', ') : 'none' },
      { id: 'plugins-instance-of', ok: pluginInstanceof === true, expected: 'true', actual: String(pluginInstanceof) },
    ]
    const coherent = checks.every(check => check.ok)

    const whyBlocked = classifyWhyBlocked({
      webdriver: asBool(probe.webdriver),
      userAgent,
      platform,
      uaChPlatform,
      pluginsLength,
      hasChrome,
      chromeHasRuntime,
      chromeHasExtras: hasChrome === true ? chromeExtras : null,
      fontsStatus,
      connectionType,
      automationKeys,
      screenCoversWindow: screenCovers,
      navigatorOwnKeys,
      protoInstanceMismatches,
      uaChBrandMajor,
      languagesWithQ,
      pluginInstanceof,
    })

    return { profile: profile.name, coherent, checks, whyBlocked }
  }

  /**
   * Navigate a page target to a destination URL and optionally wait for load.
   * @param url - destination URL.
   * @param targetId - optional target id.
   * @param timeoutMs - optional load timeout.
   * @returns navigation outcome.
   */
  async navigate(url: string, targetId?: string, timeoutMs?: number): Promise<NavigationOutcome> {
    const session = await this.getPageSession(targetId)
    const outcome = await session.navigate(url)
    try {
      await session.waitForLoad(timeoutMs ?? 10_000)
    } catch {
      // Bounded wait can time out; navigation outcome is still valid.
    }
    return outcome
  }

  /**
   * Capture a woven DOM snapshot of the specified or active page target.
   * @param targetId - optional target id.
   * @param limits - snapshot size and node count limits.
   * @returns woven DOM snapshot.
   */
  async snapshot(targetId?: string, limits?: CdpSnapshotLimits): Promise<CdpSnapshot> {
    const session = await this.getPageSession(targetId)
    if (this.connection === undefined) {
      throw new Error('cdp: no active connection')
    }

    // Enable DOM and Accessibility domains
    await this.connection.send('DOM.enable', {}, session.sessionId).catch(() => {})

    const docRes = await this.connection.send('DOM.getDocument', { depth: -1, pierce: true }, session.sessionId) as { root?: CdpDomNode }
    const docNode = docRes.root ?? {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      localName: '',
      nodeValue: '',
    }

    const title = await session.title().catch(() => '')
    const url = await session.url().catch(() => '')

    // plan06 Step 1: probe the LIVE viewport instead of the old hardcoded
    // default constant; Page.getLayoutMetrics with a Runtime.evaluate fallback,
    // cached for status(), never inventing unavailable dimensions.
    const observation = await this.probeSessionViewport(session)
    const viewport: CdpViewport = { width: observation.width, height: observation.height }

    const input: CdpSnapshotInput = {
      document: docNode,
      viewport,
      title,
      url,
      ...(limits !== undefined ? { limits } : {}),
    }

    // plan08-fix-ref-rename: this is the only moment the publish-time document
    // is in hand, so remember the node behind every ref handed to the model.
    // Later, a ref that misses by NAME is re-matched by node id and delivered
    // to the same element instead of being refused as a stale ref.
    recordRefOrigins(
      this.registry?.active()?.targetId ?? targetId ?? '',
      buildRefIndex(docNode),
      url,
    )

    return weaveSnapshot(input)
  }

  /**
   * plan06: probe the live viewport for one session and cache the observation
   * so `status()` and later probes read the same single source of truth.
   * Never throws: an unreachable probe caches `UNAVAILABLE_VIEWPORT` instead of
   * the old hardcoded dimensions.
   * @param session - page session to probe.
   * @returns the fresh observation.
   */
  private async probeSessionViewport(session: PageSession): Promise<ViewportObservation> {
    let observation: ViewportObservation = UNAVAILABLE_VIEWPORT
    if (this.connection !== undefined) {
      observation = await probeViewport(this.connection, session.sessionId, {
        overrideActive: this.viewportOverride !== undefined,
      })
    }
    this.lastViewport = observation
    this.lastViewportAt = Date.now()
    return observation
  }

  /**
   * plan06: refresh the cached viewport observation for `cdp_status`.
   * Reuses a cache younger than {@link VIEWPORT_CACHE_MS}; when no browser is
   * reachable it returns the previous observation (or `undefined`), so the
   * status payload never loses a field it already had.
   * @returns the freshest observation available, or `undefined` when none exists.
   */
  async refreshViewport(): Promise<ViewportObservation | undefined> {
    if (this.lastViewport !== undefined && Date.now() - this.lastViewportAt < VIEWPORT_CACHE_MS) {
      return this.lastViewport
    }
    try {
      const session = await this.getPageSession()
      return await this.probeSessionViewport(session)
    } catch {
      return this.lastViewport
    }
  }

  /**
   * plan06: capture one screenshot. Captures serialize on a single queue
   * (plan 7.9: a second capture waits instead of overlapping), and every
   * result points at an on-disk file; the binary never crosses the tool channel.
   * @param request - normalized capture request.
   * @returns the on-disk result with header-parsed dimensions.
   */
  async screenshot(request: ScreenshotRequest): Promise<ScreenshotResult> {
    this.capture ??= new ScreenshotCapture(this.captureContext())
    const capture = this.capture
    const run = this.captureQueue.then(() => capture.capture(request))
    this.captureQueue = run.then(() => undefined, () => undefined)
    return await run
  }

  /**
   * plan06: opt-in viewport control (`cdp_viewport`).
   * No parameters → report only; `width`+`height` →
   * `Emulation.setDeviceMetricsOverride` verified by a live probe; `reset` →
   * `Emulation.clearDeviceMetricsOverride` and a live-window observation.
   * The other tools never call this: they read the viewport, never write it.
   *
   * plan15-viewport: a metrics read is no longer the whole verification. A
   * change the browser accepts but never tells the page about used to answer
   * `applied`, so the tool reported a success the page's own `resize` handler
   * never saw — and an agent told it had "freshly measured" a target was
   * handed a rect the page had not reflowed to. Every mutating call now
   * brackets the `Emulation.*` dispatch with a page-side counter read, and a
   * counter that stayed at zero is an honest `ok:false`.
   * @param args - viewport arguments.
   * @returns the applied/report-only outcome, or the honest not-delivered failure.
   */
  async applyViewport(args: ViewportApplyArgs): Promise<ViewportApplyOutcome> {
    const session = await this.getPageSession(args.targetId)
    const connection = this.requireConnection()

    if (args.deviceScaleFactor !== undefined
      && (!Number.isFinite(args.deviceScaleFactor) || args.deviceScaleFactor <= 0 || args.deviceScaleFactor > 10)) {
      throw new CdpViewportError('deviceScaleFactor must be a finite number greater than 0 and at most 10')
    }

    if (args.reset === true) {
      return await this.viewportMutation(session, connection, undefined)
    }

    const mutation = args.width !== undefined || args.height !== undefined
      || args.mobile !== undefined || args.deviceScaleFactor !== undefined
    if (!mutation) {
      // Report only: nothing was dispatched, so there is no acted-on viewport
      // to witness and no page-side resize to prove.
      const observed = await this.probeSessionViewport(session)
      return {
        ok: true,
        viewport: toViewportMetrics(observed),
        source: observed.source,
        applied: false,
      }
    }

    if (args.width === undefined || args.height === undefined) {
      throw new CdpViewportError('width and height must be provided together to set the viewport')
    }
    if (!Number.isInteger(args.width) || !Number.isInteger(args.height)
      || args.width < 16 || args.width > 10_000 || args.height < 16 || args.height > 10_000) {
      throw new CdpViewportError(`viewport width/height must be integers between 16 and 10000 (got ${String(args.width)}x${String(args.height)})`)
    }

    const deviceScaleFactor = args.deviceScaleFactor ?? this.lastViewport?.deviceScaleFactor ?? 1
    return await this.viewportMutation(session, connection, {
      width: args.width,
      height: args.height,
      deviceScaleFactor,
      mobile: args.mobile ?? false,
    })
  }

  /**
   * plan15-viewport: one viewport mutation, verified against the live page.
   *
   * The order is the whole point: arm the page's counter, measure the viewport
   * the page currently holds, dispatch, then read both the new metrics and the
   * counter back. The pre-dispatch measurement is reported as
   * `appliedViewport` because neither branch is atomic — another agent sharing
   * this window can resize it between the measurement and the dispatch, and an
   * answer that only reported the post-state would hide exactly that race.
   * @param session - the page session to mutate.
   * @param connection - the live connection carrying the `Emulation.*` call.
   * @param next - the override to set, or undefined to clear back to the live window.
   * @returns the verified outcome, or the honest not-delivered failure.
   */
  private async viewportMutation(
    session: PageSession,
    connection: CdpConnection,
    next: { readonly width: number, readonly height: number, readonly deviceScaleFactor: number, readonly mobile: boolean } | undefined,
  ): Promise<ViewportApplyOutcome> {
    // plan15-viewport: arm BEFORE the dispatch so the two counter reads bracket
    // the change; an arm that could not be installed is absence of evidence,
    // not a failure (a page with no window cannot be reflowed by one).
    const armed = await this.readResizeProbe(session, RESIZE_PROBE_ARM_EXPRESSION)
    // Measured with the CURRENT override state, so its source still describes
    // what was really in effect when this call went out.
    const before = await this.probeSessionViewport(session)
    const appliedViewport: ViewportMetrics = toViewportMetrics(before)

    if (next === undefined) {
      await connection.send('Emulation.clearDeviceMetricsOverride', {}, session.sessionId)
      this.viewportOverride = undefined
    } else {
      await connection.send('Emulation.setDeviceMetricsOverride', { ...next }, session.sessionId)
      this.viewportOverride = { ...next }
    }

    const after = await this.probeSessionViewport(session)
    const viewport = toViewportMetrics(after)
    const applied = next === undefined
      ? true
      : after.width === next.width && after.height === next.height

    if (armed?.ok !== true) {
      return { ok: true, viewport, source: after.source, applied, appliedViewport, resizeEvent: { delivered: 'unverified' } }
    }
    const reading = parseResizeProbeAnswer(await this.readResizeProbe(session, RESIZE_PROBE_READ_EXPRESSION))
    if (reading === undefined) {
      return { ok: true, viewport, source: after.source, applied, appliedViewport, resizeEvent: { delivered: 'unverified' } }
    }

    const resizeEvent: ViewportResizeProbe = {
      delivered: reading.events > 0 ? 'delivered' : 'not-delivered',
      events: reading.events,
      ...(reading.visibilityState !== undefined ? { visibilityState: reading.visibilityState } : {}),
      ...(reading.documentHidden !== undefined ? { documentHidden: reading.documentHidden } : {}),
    }
    if (reading.events <= 0) {
      return {
        ok: false,
        reason: resizeNotDeliveredReason(resizeEvent),
        viewport,
        appliedViewport,
        resizeEvent,
      }
    }
    return { ok: true, viewport, source: after.source, applied, appliedViewport, resizeEvent }
  }

  /**
   * plan15-viewport: run one page-side counter expression out-of-band.
   *
   * Travels the raw connection (not `session.evaluate`) so the run's own
   * evaluate call pattern — and the plan01 tests that count it — is untouched.
   * Best-effort throughout: a busy, closed, or answer-free target yields
   * undefined, which the caller reads as "could not measure", never as zero.
   * @param session - the page session carrying the counter.
   * @param expression - the arm or read expression to run.
   * @returns the parsed answer, or undefined when it could not be read.
   */
  private async readResizeProbe(session: PageSession, expression: string): Promise<Record<string, unknown> | undefined> {
    const connection = this.connection
    if (connection === undefined) return undefined
    try {
      const reply = await connection.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
      }, session.sessionId, 2000) as { result?: { value?: unknown } } | undefined
      const value = reply?.result?.value
      if (typeof value !== 'string' || value === '') return undefined
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      return parsed as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  /** plan06: connection guard for the capture context's send callback. */
  private requireConnection(): CdpConnection {
    if (this.connection === undefined) throw new Error('cdp: no active connection')
    return this.connection
  }

  /** plan06: the outward facts `ScreenshotCapture` needs; memoized per service. */
  private captureContext(): CaptureContext {
    return {
      send: (method, params, sessionId) => this.requireConnection().send(method, params, sessionId),
      getPageSession: targetId => this.getPageSession(targetId),
      isViewportOverrideActive: () => this.viewportOverride !== undefined,
      onViewportObserved: observation => {
        this.lastViewport = observation
        this.lastViewportAt = Date.now()
      },
      snapshot: targetId => this.snapshot(targetId),
    }
  }

  /**
   * Evaluate a JavaScript expression in the target page context.
   * @param expression - JS code to evaluate.
   * @param targetId - optional target id.
   * @returns bounded evaluation result.
   */
  async evaluate(expression: string, targetId?: string): Promise<PageEvaluation> {
    const session = await this.getPageSession(targetId)
    return await session.evaluate(expression)
  }

  /**
   * plan01: evaluate one expression and return it with the resolution
   * evidence a failure report needs — the target the session resolved to and
   * the page URL read before the expression ran, so a wrong-tab resolve is
   * visible in the outcome instead of silent. Infrastructure failures (no
   * connection, send timeout, dropped socket) propagate: the tool layer
   * classifies them into an envelope, the REST layer answers 500.
   * plan10-fix (T6 §3.3): a send timeout first cancels the page script
   * (`Runtime.terminateExecution`) and tags the thrown error with
   * `terminated`/`documentHidden`, which {@link buildEvalFailure} folds into
   * the failure envelope; the success meta carries `documentHidden` instead.
   * @param expression - JS code to evaluate.
   * @param targetId - optional preferred target id.
   * @returns the bounded evaluation plus its target/url evidence.
   */
  async evalWithMeta(expression: string, targetId?: string): Promise<{
    readonly targetId: string
    readonly url: string
    readonly evaluation: PageEvaluation
    readonly documentHidden?: boolean
  }> {
    const session = await this.getPageSession(targetId)
    const resolvedTargetId = this.registry?.active()?.targetId ?? targetId ?? ''
    const url = await session.url().catch(() => '')
    // plan15-hidden: the shared corroborated out-of-band probe (same helper
    // exec uses). A probe that proved nothing carries no value at all.
    const activity = await this.probePageActivity(session)
    const documentHidden = hiddenEnvelopeValue(activity)
    try {
      const evaluation = await session.evaluate(expression)
      return {
        targetId: resolvedTargetId,
        url,
        evaluation,
        ...(documentHidden !== undefined ? { documentHidden } : {}),
      }
    } catch (error) {
      if (isInfrastructureError(error) && classifyCdpError(error).kind === 'timeout') {
        // plan10-fix: cancel the zombie, then tag the error so the catch
        // site's buildEvalFailure reports it without a signature change.
        const terminated = await this.terminateExecution(session)
        // plan15-hidden: the pre-run reading may be stale by the time the
        // bound fired, so anything claimed on the envelope is re-read first.
        const hiddenNow = await this.freshPageActivity(session, documentHidden)
        if (typeof error === 'object' && error !== null) {
          Object.assign(error, {
            terminated,
            ...(hiddenNow !== undefined ? { documentHidden: hiddenNow } : {}),
          })
        }
      }
      throw error
    }
  }

  /**
   * plan01: run one `cdp_exec` expression. The script resolves its session,
   * reads the pre-run URL as evidence, evaluates with a clamped per-send
   * timeout, and — only when the script returned cleanly — evaluates the
   * requested `postCondition`. Every expected failure (protocol, timeout,
   * closed socket/session, resolution failure) is folded into the returned
   * envelope by {@link buildExecOutcome}; only unexpected errors propagate.
   * @param options - expression, target preference, and optional assertion.
   * @returns the complete outcome envelope.
   */
  async exec(options: ExecOptions): Promise<ExecOutcome> {
    const started = Date.now()
    let timeoutMs = clampTimeout(options.timeoutMs) /* plan10-fix: widened below for hidden tabs */
    const elapsed = (): number => Date.now() - started

    let session: PageSession
    try {
      session = await this.getPageSession(options.targetId)
    } catch (error) {
      if (isInfrastructureError(error)) {
        return buildExecOutcome({
          expression: options.expression,
          ...(options.targetId !== undefined ? { targetId: options.targetId } : {}),
          durationMs: elapsed(),
          failure: classifyCdpError(error),
          phase: 'script',
        })
      }
      throw error
    }

    const resolvedTargetId = this.registry?.active()?.targetId ?? options.targetId
    const url = await session.url().catch(() => '')
    const target = {
      ...(resolvedTargetId !== undefined ? { targetId: resolvedTargetId } : {}),
      ...(url !== '' ? { url } : {}),
    }
    let phase: 'script' | 'postCondition' = 'script'

    // plan10-fix (T6 §3.3): an out-of-band page-activity probe — hidden
    // tabs throttle timers (setTimeout(500) measured 901ms), so an implicit
    // timeout gets a ×2 safe margin and the answer rides the envelope to name
    // the cause when a timeout still fires. Raw connection only: the run's
    // own session.evaluate call pattern stays exactly as the plan01 tests
    // count it.
    // plan15-hidden: the verdict is CORROBORATED (document.hidden plus the
    // page's own visibilityState), and only a corroborated hidden tab buys a
    // margin or a throttling claim.
    const activity = await this.probePageActivity(session)
    const documentHidden = hiddenEnvelopeValue(activity)
    const hiddenMargin = documentHidden === true && options.timeoutMs === undefined
    if (hiddenMargin) {
      timeoutMs = clampTimeout(DEFAULT_EXEC_TIMEOUT_MS * 2) /* plan10-fix */
    }
    // plan15-hidden: an applied margin is reported, never silent.
    const margin = hiddenMargin ? { effectiveTimeoutMs: timeoutMs } : {}

    try {
      const evaluation = await session.evaluate(options.expression, {
        ...(options.awaitPromise === true ? { awaitPromise: true } : {}),
        timeoutMs,
      })
      if (evaluation.error !== undefined) {
        return buildExecOutcome({
          expression: options.expression,
          ...target,
          ...(documentHidden !== undefined ? { documentHidden } : {}),
          ...margin,
          durationMs: elapsed(),
          script: evaluation,
          ...(options.postCondition !== undefined ? { postCondition: options.postCondition } : {}),
        })
      }
      if (options.postCondition !== undefined) {
        phase = 'postCondition'
        const post = await session.evaluate(postConditionExpression(options.postCondition), { timeoutMs })
        return buildExecOutcome({
          expression: options.expression,
          ...target,
          ...(documentHidden !== undefined ? { documentHidden } : {}),
          ...margin,
          durationMs: elapsed(),
          script: evaluation,
          postCondition: options.postCondition,
          post,
        })
      }
      return buildExecOutcome({
        expression: options.expression,
        ...target,
        ...(documentHidden !== undefined ? { documentHidden } : {}),
        ...margin,
        durationMs: elapsed(),
        script: evaluation,
      })
    } catch (error) {
      if (isInfrastructureError(error)) {
        let failure = classifyCdpError(error)
        // plan10-fix (T6 §3.3): the send bound fired, but the page script may
        // still be running — a zombie run keeps polluting the page (T6 logged
        // repeated entries after the call already failed). Cancel it and say
        // so in the envelope. Covers awaitPromise and the postCondition phase
        // alike — anything this catch sees was timed out.
        // plan15-hidden: the throttling claim is re-read here, at the instant
        // the timeout is being reported, instead of replaying a reading taken
        // before the run. A tab that came back into view mid-run therefore
        // produces NO hint rather than a stale, contradicted claim.
        let terminated: boolean | undefined
        let hiddenNow = documentHidden
        if (failure.kind === 'timeout') {
          terminated = await this.terminateExecution(session)
          hiddenNow = await this.freshPageActivity(session, documentHidden)
          if (hiddenNow === true) {
            failure = {
              ...failure,
              message: `${failure.message} (document.hidden=true, visibilityState=hidden — timer throttling possible)`,
            }
          }
        }
        return buildExecOutcome({
          expression: options.expression,
          ...target,
          ...(hiddenNow !== undefined ? { documentHidden: hiddenNow } : {}),
          ...margin,
          ...(terminated !== undefined ? { terminated } : {}),
          durationMs: elapsed(),
          failure,
          phase,
          ...(options.postCondition !== undefined ? { postCondition: options.postCondition } : {}),
        })
      }
      throw error
    }
  }

  /**
   * plan15-hidden: re-read the page's activity signals at report time.
   *
   * The pre-run probe answers "was the tab hidden when the run started"; a
   * timeout is reported later, and the tab can have changed state in between.
   * A hidden tab re-reads as visible, the honest answer is "not hidden now"
   * and the throttling claim is dropped. A re-read that proves nothing falls
   * back to the pre-run verdict rather than to a guess.
   * @param session - the session this run resolved to.
   * @param preRun - the pre-run envelope value, kept when the re-read is silent.
   * @returns the freshest corroborated verdict.
   */
  private async freshPageActivity(session: PageSession, preRun: boolean | undefined): Promise<boolean | undefined> {
    const fresh = await this.probePageActivity(session)
    const value = hiddenEnvelopeValue(fresh)
    return value ?? preRun
  }

  /**
   * plan10-fix (T6 §3.3) / plan15-hidden: read the page's activity signals
   * out-of-band over the raw connection — deliberately NOT through
   * `session.evaluate`, which stays reserved for the script and its
   * post-condition so call patterns (and the plan01 tests counting them) do
   * not change. Reads `document.hidden`, `document.visibilityState` and
   * `document.hasFocus()` in one round trip and returns the CORROBORATED
   * verdict: a lone `document.hidden: true` is not believed, so a wrong or
   * stale reading can no longer produce a throttling claim. Best-effort: a
   * busy, closed, or non-answering target yields `unverified` and changes
   * nothing.
   * @param session - the session this run resolved to.
   * @returns the corroborated verdict, `unverified` when unreadable.
   */
  private async probePageActivity(session: PageSession): Promise<PageActivityProbe> {
    const connection = this.connection
    if (connection === undefined) return UNVERIFIED_ACTIVITY
    try {
      const reply = await connection.send('Runtime.evaluate', {
        expression: PAGE_ACTIVITY_EXPRESSION,
        returnByValue: true,
      }, session.sessionId, 500) as { result?: { value?: unknown } } | undefined
      return readPageActivity(reply?.result?.value)
    } catch {
      return UNVERIFIED_ACTIVITY
    }
  }

  /**
   * plan10-fix (T6 §3.3): cancel whatever the target is still executing after
   * an evaluate send timeout, so a timed-out script cannot keep running as a
   * zombie and pollute the page state the next call reads. Best-effort: when
   * the connection cannot carry the command, the envelope reports
   * `terminated: false` instead of pretending it worked.
   * @param session - the session whose target should stop executing.
   * @returns whether the termination request was acknowledged.
   */
  private async terminateExecution(session: PageSession): Promise<boolean> {
    const connection = this.connection
    if (connection === undefined) return false
    try {
      await connection.send('Runtime.terminateExecution', {}, session.sessionId, 3000)
      return true
    } catch {
      return false
    }
  }

  /**
   * plan01: the failure half of {@link CdpService.evalWithMeta}'s tool
   * contract — classify a caught infrastructure failure into an envelope so
   * the model reads a `kind` instead of a crash. Unknown errors reach this
   * call only through {@link classifyCdpError}'s rethrow.
   * @param error - the caught failure.
   * @param expression - the expression the run attempted.
   * @param targetId - the requested target, when one was given.
   * @returns the failure envelope.
   */
  buildEvalFailure(error: unknown, expression: string, targetId?: string): EvalOutcome {
    // plan10-fix: evalWithMeta tags a terminated timeout's error with
    // `terminated`/`documentHidden`; carry them into the envelope so cdp_eval
    // reports zombie cancellation exactly like cdp_exec does.
    const tagged = (typeof error === 'object' && error !== null ? error : {}) as {
      terminated?: unknown
      documentHidden?: unknown
    }
    const context = {
      ...(typeof tagged.terminated === 'boolean' ? { terminated: tagged.terminated } : {}),
      ...(typeof tagged.documentHidden === 'boolean' ? { documentHidden: tagged.documentHidden } : {}),
    }
    return buildEvalFailureOutcome(classifyCdpError(error), expression, targetId, context)
  }

  /**
   * plan01: build the `cdp_eval` envelope from a completed evaluation plus
   * its resolution evidence; shared by the tool and the REST handler so both
   * answer the same shape.
   * @param evaluation - the bounded evaluation result.
   * @param targetId - the resolved target.
   * @param url - the page URL read before the evaluation.
   * @param documentHidden - plan10-fix: the pre-run hidden probe answer, when known.
   * @returns the envelope.
   */
  buildEvalOutcome(evaluation: PageEvaluation, targetId: string, url: string, documentHidden?: boolean): EvalOutcome {
    return buildEvalOutcome(evaluation, targetId, url, documentHidden !== undefined ? { documentHidden } : undefined)
  }

  /**
   * Perform human-like click on an element or coordinates.
   *
   * F1 (T3/T6): a background or hidden target drops pointer input — the
   * coordinates arrive as (0,0) or the event never lands at all — while the
   * tool would still report success. Two guards run here: the target is
   * activated first (what a user does by switching to the tab), and a
   * page-side probe in `sessionStorage` (survives a click-triggered
   * navigation) proves AFTER the dispatch that a real click event reached
   * the document. An `ok:false` envelope is built by the tool from
   * `delivered === false`; when the probe could not run the field is absent
   * and the click stays best-effort.
   * @param point - coordinates to click.
   * @param targetId - optional target id.
   * @param options - click timing options.
   * @returns delivery evidence (`delivered:false` = no click event arrived).
   */
  async click(point: Point, targetId?: string, options?: ClickOptions): Promise<ClickDelivery> {
    const session = await this.getPageSession(targetId)
    if (this.connection === undefined) throw new Error('cdp: no active connection')
    const armExpr = String.raw`(() => {
  try {
    sessionStorage.setItem('__dshClickProbe', '0');
    if (!window.__dshClickProbeFn) {
      window.__dshClickProbeFn = function () {
        try {
          sessionStorage.setItem('__dshClickProbe', String(Number(sessionStorage.getItem('__dshClickProbe') || '0') + 1));
        } catch (e) { /* storage may go away mid-click */ }
      };
      window.addEventListener('click', window.__dshClickProbeFn, true);
    }
    return JSON.stringify({ ok: true });
  } catch (error) {
    return JSON.stringify({ ok: false });
  }
})()`
    const readExpr = String.raw`(() => {
  try {
    if (window.__dshClickProbeFn) {
      window.removeEventListener('click', window.__dshClickProbeFn, true);
      delete window.__dshClickProbeFn;
    }
    const raw = sessionStorage.getItem('__dshClickProbe');
    sessionStorage.removeItem('__dshClickProbe');
    return JSON.stringify({ n: raw === null ? -1 : Number(raw) });
  } catch (error) {
    return JSON.stringify({ n: -1 });
  }
})()`
    const probe = async (expr: string): Promise<Record<string, unknown> | undefined> => {
      try {
        const evaluation = await session.evaluate(expr, { awaitPromise: false, timeoutMs: 2_000 })
        if (evaluation.error !== undefined || !evaluation.hasValue || evaluation.value === '') return undefined
        const parsed: unknown = JSON.parse(evaluation.value)
        if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
      } catch {
        // Probe degradation must never break the click itself.
      }
      return undefined
    }
    if (targetId !== undefined) {
      // Best-effort: a stale id must not kill the click; the probe gates it.
      await this.connection.send('Target.activateTarget', { targetId }).catch(() => undefined)
    }
    const armed = await probe(armExpr)
    const inputAdapter = createInputConnectionAdapter(this.connection)
    const input = new HumanInput({
      connection: inputAdapter,
      sessionId: session.sessionId,
    })
    await input.click(point, options)
    if (armed?.ok !== true) return {}
    const seen = await probe(readExpr)
    const count = typeof seen?.n === 'number' ? seen.n : undefined
    if (count === undefined || count < 0) return {}
    return { delivered: count > 0 }
  }

  /**
   * F5: the target document's viewport size — page-side and therefore
   * authoritative (browser-window metrics can disagree with `innerWidth`).
   * @param targetId - optional target id.
   * @returns the CSS-pixel viewport, or undefined when it could not be read.
   */
  async readViewport(targetId?: string): Promise<{ width: number, height: number } | undefined> {
    const session = await this.getPageSession(targetId)
    try {
      const evaluation = await session.evaluate(
        'JSON.stringify({ width: window.innerWidth, height: window.innerHeight })',
        { awaitPromise: false, timeoutMs: 2_000 },
      )
      if (evaluation.error !== undefined || !evaluation.hasValue || evaluation.value === '') return undefined
      const parsed: unknown = JSON.parse(evaluation.value)
      if (parsed === null || typeof parsed !== 'object') return undefined
      const record = parsed as { width?: unknown, height?: unknown }
      if (typeof record.width === 'number' && typeof record.height === 'number') {
        return { width: record.width, height: record.height }
      }
    } catch {
      // Unreadable viewport stays undefined — callers fall back to finite/non-negative checks.
    }
    return undefined
  }

  /**
   * Perform human-like typing into the page.
   * @param text - text to type.
   * @param targetId - optional target id.
   * @returns typing outcome.
   */
  async type(text: string, targetId?: string): Promise<TextEntryOutcome> {
    const session = await this.getPageSession(targetId)
    if (this.connection === undefined) throw new Error('cdp: no active connection')
    const inputAdapter = createInputConnectionAdapter(this.connection)
    const input = new HumanInput({
      connection: inputAdapter,
      sessionId: session.sessionId,
    })
    return await input.typeText(text)
  }

  /**
   * Close a specific target or the active target tab.
   * @param targetId - target id to close.
   */
  async closeTarget(targetId?: string): Promise<void> {
    if (this.registry === undefined) return
    const id = targetId ?? this.registry.active()?.targetId
    if (id !== undefined) {
      // plan08-fix-ref-rename: a closed tab's remembered ref origins can never
      // match anything again — drop them instead of holding a cap slot.
      clearRefOrigins(id)
      await this.registry.close(id)
    }
  }

  // ------------------------------------------------------------------
  // plan03: tab lifecycle (refresh/create/close/focus) + scrolling.
  // Backs cdp_tabs(refresh), cdp_tab_new, cdp_tab_close, cdp_tab_focus,
  // and cdp_scroll. All guards fail with actionable `cdp:` messages.
  // ------------------------------------------------------------------

  /** plan03: how many `page` targets the registry currently tracks. */
  private pageCount(): number {
    return (this.registry?.targets() ?? []).filter(t => t.type === 'page').length
  }

  /** plan03: one-line candidates summary carried by a refused resolution. */
  private candidateSummary(): string {
    const rows = (this.registry?.targets() ?? []).slice(0, 10).map((t) =>
      `${t.type} "${t.title || '(no title)'}" ${t.url || 'about:blank'} [${t.targetId}]`)
    return rows.length > 0 ? rows.join(' | ') : 'no tracked targets'
  }

  /** plan03: the tracked row for an id, or undefined when the list is stale. */
  private trackedTarget(targetId: string): TargetInfo | undefined {
    return this.registry?.targets().find(t => t.targetId === targetId)
  }

  /** plan03: force a `Target.getTargets` round trip for `cdp_tabs(refresh)`. */
  async refreshTargets(): Promise<void> {
    if (this.registry === undefined) throw new Error('cdp: no active browser connection')
    await this.registry.list()
  }

  /**
   * plan03: the only sanctioned way to open a tab — `Target.createTarget`
   * followed by an explicit report (no silent about:blank anywhere else).
   * @param options - what to open: the landing URL and whether the tab takes
   *   focus (both defaulting when omitted).
   * @returns the new tab's id, reported URL and title, focus state, and the
   *   resulting tab/page counts.
   */
  async createTab(options: CdpTabCreateOptions = {}): Promise<CdpTabCreateResult> {
    if (this.connection === undefined || this.registry === undefined) {
      throw new Error('cdp: no active browser connection')
    }
    const registry = this.registry
    const pages = this.pageCount()
    if (pages >= PLAN03_MAX_PAGES) {
      throw new Error(
        `cdp: page cap reached (${String(pages)} pages, max ${String(PLAN03_MAX_PAGES)}); `
        + 'close tabs with cdp_tab_close',
      )
    }
    const requestedUrl = options.url ?? 'about:blank'
    const focus = options.focus ?? true
    // plan07-fix: a target created WITH the URL begins its first request
    // before any session-level UA/UA-CH override can exist — the wire then
    // carries HeadlessChrome/153 while JS reports Chrome/131 (T1 Wire A).
    // Create on about:blank, seed the page session (stealth script +
    // Emulation/Network overrides), THEN navigate: the first real document
    // already wears the profile story.
    const seedFirst = requestedUrl !== 'about:blank'
    const reply = await this.connection.send('Target.createTarget', {
      url: seedFirst ? 'about:blank' : requestedUrl,
      ...(focus ? {} : { background: true }),
    }) as { targetId?: unknown }
    if (typeof reply.targetId !== 'string' || reply.targetId === '') {
      throw new Error('cdp: Target.createTarget reply carried no targetId')
    }
    await registry.list()
    if (seedFirst) {
      let seeded = false
      try {
        const session = await this.getPageSession(reply.targetId, { activate: false })
        // Session exists ⇒ applyStealthToSession already ran inside
        // getPageSession; navigate only after every override round-trip.
        await this.connection.send('Page.navigate', { url: requestedUrl }, session.sessionId)
        seeded = true
      } catch {
        // Fall through to the direct navigation below; stealth warnings are
        // already recorded per layer by applyStealthToSession.
      }
      if (!seeded) {
        const sessionId = this.registry?.attachedSession(reply.targetId)
        await this.connection.send('Page.navigate', { url: requestedUrl }, sessionId).catch(() => undefined)
      }
    }
    if (focus) {
      // Best-effort browser focus; the local pointer is set either way.
      await this.connection.send('Target.activateTarget', { targetId: reply.targetId }).catch(() => undefined)
      if (this.trackedTarget(reply.targetId) !== undefined) registry.setActive(reply.targetId)
    }
    const info = this.trackedTarget(reply.targetId)
    const activeId = registry.active()?.targetId
    return {
      ok: true,
      targetId: reply.targetId,
      // plan07-fix: the seeded target's registry row may still read
      // about:blank while the navigation is in flight — the tab is OPEN AT
      // requestedUrl, so report that instead of the seeding document.
      url: seedFirst ? requestedUrl : (info?.url ?? requestedUrl),
      title: info?.title ?? '',
      focused: focus && activeId === reply.targetId,
      ...(activeId !== undefined ? { activeTargetId: activeId } : {}),
      tabCount: registry.targets().length,
      pages: this.pageCount(),
    }
  }

  /**
   * plan03: guarded close. Closing the active tab needs `confirmActive`, and
   * the last remaining page tab needs `force` — both refusals are actionable.
   * The legacy REST `POST /api/server/cdp/close` keeps its unguarded path.
   * @param options - which tab to close (defaults to the active one) plus the
   *   `confirmActive`/`force` overrides the two guards accept.
   * @returns the closed tab's id, whether it was active, the remaining page
   *   count, the new active target, and whether the browser reported the close.
   */
  async closeTab(options: CdpTabCloseOptions = {}): Promise<CdpTabCloseResult> {
    if (this.connection === undefined || this.registry === undefined) {
      throw new Error('cdp: no active browser connection')
    }
    const registry = this.registry
    const active = registry.active()
    const id = options.targetId ?? active?.targetId
    if (id === undefined) {
      throw new Error('cdp: cdp_tab_close needs a targetId (no active tab); call cdp_tabs to list tabs')
    }
    let info = this.trackedTarget(id)
    if (info === undefined) {
      await registry.list().catch(() => undefined)
      info = this.trackedTarget(id)
      if (info === undefined) {
        // plan04-F6: may have stayed on a parked endpoint — name its successor.
        throw new Error(this.notTrackedMessage(id))
      }
    }
    const wasActive = active?.targetId === id
    if (options.targetId === undefined && wasActive && options.confirmActive !== true) {
      throw new Error(
        `cdp: refusing to close the ACTIVE tab ${id} without an explicit targetId; `
        + 'pass targetId, or confirmActive:true to close the active tab',
      )
    }
    if (info.type === 'page' && this.pageCount() <= 1 && options.force !== true) {
      throw new Error(
        'cdp: refusing to close the last remaining page tab; pass force:true to close it '
        + '(the browser would be left with no pages)',
      )
    }
    const browserClosed = await registry.close(id)
    let activeTargetId: string | undefined
    if (wasActive && browserClosed) {
      const next = registry.targets().find(t => t.type === 'page')
      if (next !== undefined) {
        registry.setActive(next.targetId)
        activeTargetId = next.targetId
      }
    } else {
      activeTargetId = registry.active()?.targetId
    }
    return {
      ok: true,
      closedTargetId: id,
      wasActive,
      remainingPages: this.pageCount(),
      ...(activeTargetId !== undefined ? { activeTargetId } : {}),
      browserClosed,
    }
  }

  /**
   * plan03: make a tab the resolution base, and tell the real browser so the
   * window focus matches the model's belief (`Target.activateTarget`).
   * @param targetId - the tab to focus; must be a tracked target.
   * @param activateBrowser - whether the OS-level browser window is activated
   *   too (false only moves the registry's active target).
   * @returns the newly focused tab's identity and page, the previous active
   *   target when it changed, and whether the browser was activated.
   */
  async focusTab(targetId: string, activateBrowser = true): Promise<CdpTabFocusResult> {
    if (this.connection === undefined || this.registry === undefined) {
      throw new Error('cdp: no active browser connection')
    }
    const registry = this.registry
    let info = this.trackedTarget(targetId)
    if (info === undefined) {
      await registry.list().catch(() => undefined)
      info = this.trackedTarget(targetId)
      if (info === undefined) {
        // plan04-F6: may have stayed on a parked endpoint — name its successor.
        throw new Error(this.notTrackedMessage(targetId))
      }
    }
    const previousTargetId = registry.active()?.targetId
    let activated = false
    if (activateBrowser) {
      await this.connection.send('Target.activateTarget', { targetId })
      activated = true
    }
    registry.setActive(targetId)
    const fresh = this.trackedTarget(targetId) ?? info
    return {
      ok: true,
      targetId,
      ...(previousTargetId !== undefined && previousTargetId !== targetId ? { previousTargetId } : {}),
      url: fresh.url,
      title: fresh.title,
      activated,
      pageCount: this.pageCount(),
    }
  }

  /**
   * plan03: scroll a page — human-like wheel steps, keyboard paging, or
   * anchor/edge jumps — always reporting the verified post-scroll position.
   * @param request - what to do: strategy (`mode`), deltas or target
   *   (`selector`/`anchor`), repetitions, settle delay, and the target id.
   * @returns the executed strategy and the before/after position boxes read
   *   from the page.
   */
  async scroll(request: CdpScrollRequest = {}): Promise<CdpScrollReport> {
    const session = await this.getPageSession(request.targetId)
    if (this.connection === undefined || this.registry === undefined) {
      throw new Error('cdp: no active browser connection')
    }
    const mode: CdpScrollMode = request.mode ?? 'wheel'
    const resolvedTargetId = this.registry.active()?.targetId ?? request.targetId ?? ''
    const input = new HumanInput({
      connection: createInputConnectionAdapter(this.connection),
      sessionId: session.sessionId,
    })
    const before = await this.readScrollPosition(session)
    const repetitions = plan03Clamp(request.repetitions ?? 1, 1, 20)
    const settleMs = plan03Clamp(request.settleMs ?? 0, 0, 2000)
    const behavior = request.smooth === true ? 'smooth' : 'auto'
    let steps = 0
    let deltaX = 0
    let deltaY = 0
    let found: boolean | undefined

    if (mode === 'wheel') {
      const dx = request.deltaX ?? 0
      const dy = request.deltaY ?? 0
      if (dx === 0 && dy === 0) {
        throw new Error("cdp scroll: mode 'wheel' needs a non-zero deltaX/deltaY")
      }
      const to: Point = {
        x: request.x ?? Math.max(0, Math.floor(before.innerWidth / 2)),
        y: request.y ?? Math.max(0, Math.floor(before.innerHeight / 2)),
      }
      for (let index = 0; index < repetitions; index += 1) {
        const outcome = await input.scroll(to, { x: dx, y: dy })
        steps += outcome.steps
        deltaX += outcome.deltaX
        deltaY += outcome.deltaY
      }
    } else if (mode === 'pagedown' || mode === 'pageup') {
      const key = mode === 'pagedown' ? 'PageDown' : 'PageUp'
      for (let index = 0; index < repetitions; index += 1) {
        await input.pressKey(key)
        steps += 1
      }
    } else if (mode === 'top' || mode === 'bottom') {
      const expression = mode === 'top'
        ? `window.scrollTo({ top: 0, left: 0, behavior: ${JSON.stringify(behavior)} })`
        : `window.scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior: ${JSON.stringify(behavior)} })`
      const evaluation = await session.evaluate(expression)
      if (evaluation.exception !== undefined || evaluation.error !== undefined) {
        throw new Error(`cdp scroll: ${mode} failed: ${evaluation.exception ?? evaluation.error?.message ?? 'evaluation failed'}`)
      }
      steps = 1
    } else {
      const needle = mode === 'anchor' ? (request.anchor ?? '') : (request.selector ?? '')
      if (needle === '') {
        throw new Error(`cdp scroll: mode '${mode}' needs ${mode === 'anchor' ? 'anchor' : 'selector'}`)
      }
      const expression = mode === 'anchor'
        ? plan03AnchorExpression(needle, behavior)
        : plan03SelectorExpression(needle, behavior)
      const evaluation = await session.evaluate(expression)
      if (evaluation.exception !== undefined || evaluation.error !== undefined) {
        throw new Error(`cdp scroll: ${mode} failed: ${evaluation.exception ?? evaluation.error?.message ?? 'evaluation failed'}`)
      }
      found = plan03ParseFound(evaluation.value)
      if (found) steps = 1
    }

    if (settleMs > 0) await new Promise<void>((resolve) => { setTimeout(resolve, settleMs) })
    const after = await this.readScrollPosition(session)
    let note: string | undefined
    if (mode === 'wheel'
      && after.scrollY === before.scrollY
      && before.maxScrollY > 0
      && before.scrollY < before.maxScrollY) {
      note = 'window did not move; the wheel may have scrolled a nested container — '
        + 'pass x/y over the container or use mode:selector'
    }
    return {
      ok: true,
      mode,
      targetId: resolvedTargetId,
      url: after.href,
      steps,
      deltaX,
      deltaY,
      scrollX: after.scrollX,
      scrollY: after.scrollY,
      maxScrollX: after.maxScrollX,
      maxScrollY: after.maxScrollY,
      atTop: after.scrollY <= 0,
      atBottom: after.maxScrollY > 0 ? after.scrollY >= after.maxScrollY : true,
      resolvedBy: this.lastResolutionVia ?? 'active',
      ...(found !== undefined ? { found } : {}),
      ...(note !== undefined ? { note } : {}),
    }
  }

  /** plan03: read the live scroll box (`scrollX/Y`, extents, viewport, url). */
  private async readScrollPosition(session: PageSession): Promise<CdpScrollPosition> {
    const fallback: CdpScrollPosition =
      { scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0, innerWidth: 0, innerHeight: 0, href: '' }
    let value: string
    try {
      const evaluation = await session.evaluate(PLAN03_SCROLL_POSITION_EXPRESSION)
      if (evaluation.exception !== undefined || evaluation.error !== undefined) return fallback
      value = evaluation.value
    } catch {
      return fallback
    }
    if (value === '') return fallback
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      const num = (key: string): number => {
        const cell = parsed[key]
        return typeof cell === 'number' && Number.isFinite(cell) ? cell : 0
      }
      return {
        scrollX: num('sx'),
        scrollY: num('sy'),
        maxScrollX: num('mx'),
        maxScrollY: num('my'),
        innerWidth: num('iw'),
        innerHeight: num('ih'),
        href: typeof parsed.href === 'string' ? parsed.href : '',
      }
    } catch {
      return fallback
    }
  }

  /**
   * Disconnect from the browser and clean up session state.
   */
  async disconnect(): Promise<void> {
    // plan04: detach the ACTIVE endpoint only — every other pooled endpoint
    // stays attached. Forgetting the entry FIRST disarms its reattach driver,
    // so this intentional close never schedules a reconnect. Pooled siblings
    // survive; only this entry's socket dies below (unchanged plan03/plan10
    // teardown continues as before).
    const active = this.connection
    const pooled = active !== undefined ? this.pool.get(active.endpoint) : undefined
    if (pooled !== undefined) this.pool.forget(pooled)
    // plan03: drop the focus-sync subscription before the socket goes away.
    this.targetActivatedOff?.()
    this.targetActivatedOff = undefined
    // plan10: the manager listens on this connection — drop listeners first.
    if (this.downloadManagerInstance !== undefined) {
      await this.downloadManagerInstance.dispose().catch(() => {})
      this.downloadManagerInstance = undefined
    }
    for (const session of this.sessions.values()) {
      await session.close().catch(() => {})
    }
    this.sessions.clear()

    if (this.registry !== undefined) {
      this.registry.dispose()
      this.registry = undefined
    }

    if (this.connection !== undefined) {
      await this.connection.close().catch(() => {})
      this.connection = undefined
    }
  }

  /**
   * Full teardown: disconnect and terminate any browser process launched by this service.
   */
  async stop(): Promise<void> {
    // plan04-FAZ7: invalidate any proxy start still in flight (it closes itself).
    this.proxyEpoch += 1
    await this.stopProxy()
    await this.disconnect()
    // plan04: every parked endpoint — socket, backoff timer, listeners, and
    // any browser process it launched — dies with the plugin (ctx.effect teardown).
    await this.pool.closeAll()
    if (this.launched !== undefined) {
      await this.launched.close().catch(() => {})
      this.launched = undefined
    }
  }

  // ---------------------------------------------------------------------------
  // plan04: connection pool — park/activate, reattach, inventory, contexts
  // ---------------------------------------------------------------------------

  /**
   * plan04-FAZ7: make sure the capture proxy listener is running. This is the
   * reader Config `proxyListenPort` never had: `apply()` fires it at load and
   * `net_capture`/`net_export` re-fire it before reporting, so a transient
   * bind failure heals on first use. Never throws — an unreachable bind is an
   * honest `{active:false}` result the tools surface as `ok:false`, not a
   * silent `Captured 0 of 0`.
   * @returns whether the listener is up, its port, and the bind error if not.
   */
  async ensureProxy(): Promise<{ active: boolean, port?: number | undefined, error?: string | undefined }> {
    if (this.proxy?.isListening) return { active: true, port: this.proxy.port }
    const epoch = this.proxyEpoch
    // plan04-fix2: idle-port scan. The configured port can be permanently
    // occupied in a shared environment (another local service can sit on 9333),
    // so try it plus the next few loopback ports and take the first bind that
    // succeeds. Port 0 already means "any free port" — one attempt only.
    const configured = this.serviceOptions.proxyListenPort ?? 9333
    const tries = configured === 0
      ? [0]
      : Array.from({ length: 8 }, (_, i) => configured + i).filter(port => port <= 65535)
    let lastError: string | undefined
    for (const port of tries) {
      try {
        const bound = await this.startProxy(port)
        if (epoch !== this.proxyEpoch) {
          // stop() ran while the socket was binding — close the orphan we just made.
          await this.stopProxy()
          return { active: false, error: 'service stopped while the capture proxy was starting' }
        }
        return { active: true, port: bound }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Only EADDRINUSE justifies scanning on; anything else (EACCES, a
        // non-loopback address, ...) would fail identically on every port.
        if (!message.includes('EADDRINUSE')) return { active: false, error: message }
        lastError = message
      }
    }
    return { active: false, error: lastError ?? 'no candidate port bound' }
  }

  /**
   * plan04-F6: the single `not tracked` refusal. The base sentence is
   * plan03's, verbatim — plan03 tests pin it. The suffix is the re-map
   * envelope: when the id stayed behind on a PARKED endpoint (the active
   * endpoint changed under the caller), its URL is still readable from that
   * entry's registry, so the message names the same-URL successor on the
   * active endpoint instead of leaving the caller at a dead id.
   * @param targetId - the id the caller asked for.
   * @returns the refusal message.
   */
  private notTrackedMessage(targetId: string): string {
    const base = `cdp: target ${targetId} is not tracked; call cdp_tabs to list live tabs (candidates: ${this.candidateSummary()})`
    const parked = this.pool.parkedTarget(targetId)
    const registry = this.registry
    if (parked === undefined || registry === undefined) return base
    const successor = registry.targets().find(t =>
      t.targetId !== targetId && t.type === 'page' && t.url === parked.url)
    const where = `target ${targetId} stayed on parked endpoint ${parked.connectionId} (url ${parked.url})`
    if (successor === undefined) {
      return `${base}; ${where} — the active endpoint has no target with that url; call cdp_tabs`
    }
    return `${base}; ${where} — same-URL successor on the active endpoint: ${successor.targetId}`
  }

  /**
   * plan04: move the ACTIVE endpoint's live state (registry, sessions, focus
   * subscription, launched browser) into its pool entry, leaving the entry's
   * socket and its reattach driver running in the background.
   */
  private parkActive(): void {
    const conn = this.connection
    if (conn === undefined) return
    const entry = this.pool.get(conn.endpoint) ?? this.pool.adopt(conn.endpoint, conn)
    entry.registry = this.registry
    entry.sessions.clear()
    for (const [sessionId, session] of this.sessions) entry.sessions.set(sessionId, session)
    this.sessions.clear()
    entry.targetActivatedOff = this.targetActivatedOff
    this.targetActivatedOff = undefined
    entry.launched = this.launched
    this.launched = undefined
    try {
      entry.activeTargetId = this.registry?.active()?.targetId
    } catch {
      // Registry already disposed — keep whatever hint the entry had.
    }
    entry.state = conn.connected ? 'connected' : 'degraded'
    this.connection = undefined
    this.registry = undefined
  }

  /**
   * plan04: load a pooled entry's parked state into the service fields —
   * the reverse of {@link parkActive}. The previously active entry stays
   * pooled, socket open, reattach armed.
   * @param entry - endpoint to make active.
   */
  private activateEntry(entry: PooledEndpoint): void {
    this.connection = entry.connection
    this.registry = entry.registry
    this.sessions.clear()
    for (const [sessionId, session] of entry.sessions) this.sessions.set(sessionId, session)
    entry.sessions.clear()
    this.targetActivatedOff = entry.targetActivatedOff
    this.launched = entry.launched
    const wanted = entry.activeTargetId
    if (wanted !== undefined && entry.registry !== undefined) {
      const tracked = entry.registry.targets().some(target => target.targetId === wanted)
      if (tracked) {
        try {
          entry.registry.setActive(wanted)
        } catch {
          // Registry refused the restore; the resolver's evidence rules apply.
        }
      }
    }
    // plan06/plan03: switching endpoints resets viewport + resolution evidence,
    // mirroring what connect() does for a freshly dialed connection.
    this.lastViewport = undefined
    this.lastViewportAt = 0
    this.viewportOverride = undefined
    this.lastResolutionVia = undefined
  }

  /**
   * plan04: rebuild one endpoint's state after its socket re-opened — the
   * subscriber `connection.ts` promised and nothing had. Runs for ACTIVE and
   * PARKED entries alike: flattened session ids died with the old socket, the
   * registry tracked a dead world, and plan03's focus subscription still
   * pointed at the disposed registry. Failure is recorded on the entry by the
   * pool's driver, never thrown into the event loop.
   * @param entry - the reconnected endpoint.
   */
  private async handleReconnected(entry: PooledEndpoint): Promise<void> {
    const conn = entry.connection
    const previous = entry.registry
    let wanted = entry.activeTargetId
    if (previous !== undefined) {
      try {
        wanted = previous.active()?.targetId ?? wanted
      } catch {
        // Registry already disposed — keep the parked hint.
      }
    }
    const isActive = this.connection === conn
    const sessions = isActive ? this.sessions : entry.sessions
    for (const session of sessions.values()) {
      await session.close().catch(() => {})
    }
    sessions.clear()
    previous?.dispose()

    const targetAdapter = createTargetConnectionAdapter(conn)
    const reg = new TargetRegistry(targetAdapter)
    await reg.list()
    // plan03 Adım 2 re-issued: without discovery the NEW registry only hears
    // lifecycle events Chromium emits after setDiscoverTargets — re-arm it on
    // every socket generation.
    await conn.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined)
    // plan03 focus sync re-armed: the old closure referenced the disposed reg.
    entry.targetActivatedOff?.()
    entry.targetActivatedOff = undefined
    const off = conn.on('Target.targetActivated', (cdpEvent) => {
      const targetId = (cdpEvent.params as { targetId?: unknown } | undefined)?.targetId
      if (typeof targetId !== 'string' || targetId === '') return
      if (reg.targets().some(target => target.targetId === targetId)) {
        try {
          reg.setActive(targetId)
        } catch {
          // The registry was disposed between the event and this handler.
        }
      }
    })
    entry.targetActivatedOff = off
    entry.registry = reg
    if (isActive) {
      this.registry = reg
      this.targetActivatedOff = off
    }
    // Restore the previously active target — session state survives the drop.
    if (wanted !== undefined && reg.targets().some(target => target.targetId === wanted)) {
      try {
        reg.setActive(wanted)
      } catch {
        // Registry refused the restore; the resolver's evidence rules apply.
      }
    }
    entry.activeTargetId = wanted
  }

  /**
   * plan04: every pooled endpoint as its wire brief — the per-connection state
   * `GET /api/server/cdp/connections` renders.
   * @returns one row per pooled endpoint, active first is NOT guaranteed.
   */
  connections(): CdpConnectionBrief[] {
    return this.pool.list().map((entry): CdpConnectionBrief => {
      const active = entry.connection === this.connection
      const activeTargetId = active ? this.registry?.active()?.targetId : entry.activeTargetId
      return {
        connectionId: entry.connectionId,
        endpoint: entry.endpoint,
        port: entry.port ?? 0,
        state: entry.state,
        active,
        targets: active ? this.targets.length : (entry.registry?.targets().length ?? 0),
        sessions: active ? this.sessions.size : entry.sessions.size,
        reconnects: entry.reconnects,
        ...(activeTargetId !== undefined ? { activeTargetId } : {}),
        ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
      }
    })
  }

  /**
   * plan04: pool id of the active endpoint.
   * @returns `ep-<port>` or undefined when nothing is attached.
   */
  activeConnectionId(): string | undefined {
    const active = this.connection
    if (active === undefined) return undefined
    return this.pool.get(active.endpoint)?.connectionId
  }

  /**
   * plan04: multi-endpoint discovery — probe the configured loopback ports'
   * `/json/version` and merge the answer with the pool, so attached-but-unprobed
   * endpoints (an ephemeral launched port, a non-default port) still get a row.
   * @param options - ports/fetch/timeout overrides (tests inject fetch).
   * @returns one row per probed port plus every unprobed pool entry.
   */
  async endpointInventory(
    options: {
      ports?: readonly number[] | undefined
      fetch?: typeof globalThis.fetch | undefined
      timeoutMs?: number | undefined
    } = {},
  ): Promise<CdpEndpointRow[]> {
    const ports = options.ports ?? this.serviceOptions.discoveryPorts ?? DEFAULT_DISCOVERY_PORTS
    const fetchImpl = options.fetch ?? globalThis.fetch
    const probes = await discoverEndpoints(ports, fetchImpl, options.timeoutMs)
    const rows: CdpEndpointRow[] = []
    const matched = new Set<string>()
    for (const probe of probes) {
      const ws = probe.webSocketDebuggerUrl
      const entry = ws !== undefined ? this.pool.get(ws) : undefined
      if (entry !== undefined) matched.add(entry.endpoint)
      rows.push(this.endpointRow(
        probe.port,
        probe.reachable,
        entry,
        ws ?? '',
        probe.browser ?? '',
        probe.browserId ?? '',
        probe.error ?? '',
      ))
    }
    for (const entry of this.pool.list()) {
      if (matched.has(entry.endpoint)) continue
      const reachable = entry.connection.connected
      rows.push(this.endpointRow(
        entry.port ?? 0,
        reachable,
        entry,
        entry.endpoint,
        '',
        entry.browserId,
        reachable ? '' : (entry.lastError ?? 'endpoint socket is not connected'),
      ))
    }
    return rows
  }

  /** plan04: build one always-complete endpoint row for the inventory. */
  private endpointRow(
    port: number,
    reachable: boolean,
    entry: PooledEndpoint | undefined,
    endpoint: string,
    browser: string,
    browserId: string,
    error: string,
  ): CdpEndpointRow {
    const active = entry !== undefined && entry.connection === this.connection
    const targets = entry === undefined
      ? 0
      : active ? this.targets.length : (entry.registry?.targets().length ?? 0)
    return {
      port,
      reachable,
      attached: entry !== undefined && entry.connection.connected,
      active,
      state: entry === undefined ? (reachable ? 'unattached' : 'unreachable') : entry.state,
      endpoint,
      browser,
      browserId,
      // plan13-profile: the PROFILE column. A pooled entry knows the directory
      // it was launched on, so it answers with the real identity; a port we
      // only probed exposes no profile through `/json/version`, and says so
      // with `''` rather than guessing from the browser banner.
      profile: entry?.profileName ?? '',
      kind: entry?.launchedByService === true ? 'dsh' : 'user',
      connectionId: entry?.connectionId ?? '',
      targets,
      error,
    }
  }

  /**
   * plan04: create an isolated browser context inside the ACTIVE browser —
   * cookie/storage isolation without launching another Chromium.
   * @returns the `browserContextId` the browser assigned.
   */
  async createContext(): Promise<{ contextId: string }> {
    const connection = this.requireConnection()
    const reply = await connection.send('Target.createBrowserContext', { disposeOnDetach: false }) as { browserContextId?: unknown }
    const contextId = typeof reply.browserContextId === 'string' ? reply.browserContextId : ''
    if (contextId === '') throw new Error('cdp: contexts: browser did not return a browserContextId')
    return { contextId }
  }

  /**
   * plan04: list every browser context with its live target count. The default
   * context is reported with `contextId: ''` when it holds targets (or when
   * the browser reports no isolated contexts at all).
   * @returns context rows, default first.
   */
  async listContexts(): Promise<Array<{ contextId: string, isDefault: boolean, targets: number }>> {
    const connection = this.requireConnection()
    let ids: string[] = []
    try {
      const reply = await connection.send('Target.getBrowserContexts') as { browserContextIds?: unknown }
      if (Array.isArray(reply.browserContextIds)) {
        ids = reply.browserContextIds.filter((value): value is string => typeof value === 'string')
      }
    } catch {
      // Older Chromium without the command: fall back to target-derived rows.
    }
    const reply = await connection.send('Target.getTargets') as { targetInfos?: unknown }
    const infos = Array.isArray(reply.targetInfos)
      ? reply.targetInfos as Array<{ browserContextId?: unknown }>
      : []
    const counts = new Map<string, number>()
    let defaults = 0
    for (const info of infos) {
      const contextId = typeof info.browserContextId === 'string' ? info.browserContextId : ''
      if (contextId === '') defaults += 1
      else counts.set(contextId, (counts.get(contextId) ?? 0) + 1)
    }
    const rows = ids.map(contextId => ({ contextId, isDefault: false, targets: counts.get(contextId) ?? 0 }))
    if (defaults > 0 || rows.length === 0) {
      rows.unshift({ contextId: '', isDefault: true, targets: defaults })
    }
    return rows
  }

  /**
   * plan04: open a tab inside one isolated context.
   * @param contextId - `browserContextId`; `''` opens in the default context.
   * @param url - initial URL.
   * @returns the created target id (the registry picks it up via targetCreated).
   */
  async openContextTab(contextId: string, url: string): Promise<{ targetId: string }> {
    const connection = this.requireConnection()
    // plan07-fix: same first-navigation race as createTab (T1 Wire A) —
    // seed about:blank, register the profile story on the session, then
    // navigate; a context tab must NOT steal the active tab while seeding.
    const seedFirst = url !== '' && url !== 'about:blank'
    const reply = await connection.send('Target.createTarget', {
      url: seedFirst ? 'about:blank' : url,
      ...(contextId !== '' ? { browserContextId: contextId } : {}),
    }) as { targetId?: unknown }
    if (typeof reply.targetId !== 'string' || reply.targetId === '') {
      throw new Error('cdp: contexts: createTarget returned no targetId')
    }
    if (seedFirst) {
      let seeded = false
      try {
        const session = await this.getPageSession(reply.targetId, { activate: false })
        await connection.send('Page.navigate', { url }, session.sessionId)
        seeded = true
      } catch {
        // Direct navigation below; per-layer stealth warnings already stand.
      }
      if (!seeded) {
        const sessionId = this.registry?.attachedSession(reply.targetId)
        await connection.send('Page.navigate', { url }, sessionId).catch(() => undefined)
      }
    }
    return { targetId: reply.targetId }
  }

  /**
   * plan04: dispose an isolated context — the browser closes its tabs and
   * wipes its storage. The default context cannot be disposed.
   * @param contextId - `browserContextId`.
   * @returns how many targets the context held when it was disposed.
   */
  async disposeContext(contextId: string): Promise<{ closed: number }> {
    if (contextId === '') throw new Error('cdp: contexts: the default context cannot be disposed')
    const before = await this.listContexts()
    const closed = before.find(row => row.contextId === contextId)?.targets ?? 0
    const connection = this.requireConnection()
    await connection.send('Target.disposeBrowserContext', { browserContextId: contextId })
    return { closed }
  }

  // ---------------------------------------------------------------------------
  // plan10: downloads root, downloads, print round-trip, PDF reading
  // ---------------------------------------------------------------------------

  /** plan10: absolute downloads root, materialized on first use. */
  get downloadsRootPath(): string {
    return ensureDownloadsDir(resolveDownloadsRoot(this.serviceOptions.downloadsDir))
  }

  /** plan10: root-relative display path (forward slashes on every platform). */
  private displayPath(root: string, target: string): string {
    const rel = relative(root, target)
    return rel === '' ? '' : rel.replaceAll('\\', '/')
  }

  /** plan10: the download manager bound to the live connection (lazy). */
  get downloadManager(): DownloadManager {
    const connection = this.requireConnection()
    if (this.downloadManagerInstance === undefined) {
      this.downloadManagerInstance = new DownloadManager({
        send: (method, params, sessionId) => connection.send(method, params, sessionId),
        on: (event, listener) => connection.on(event, cdpEvent =>
          listener(cdpEvent.params as Record<string, unknown>)),
      }, this.downloadsRootPath)
    }
    return this.downloadManagerInstance
  }

  /**
   * plan10: wait for the next browser download to settle.
   * @param options - timeout and optional explicit destination name.
   * @returns the settled outcome (`ok:false` carries the reason).
   */
  async downloadNext(options: { timeoutMs?: number | undefined; renameTo?: string | undefined } = {}): Promise<ArmOutcome> {
    return await this.downloadManager.arm(options)
  }

  /**
   * plan10: every tracked download, newest first; empty when none exist.
   * @returns the recorded downloads, or an empty array before any manager
   *   instance exists.
   */
  downloadStatus(): DownloadRecord[] {
    return this.downloadManagerInstance?.status() ?? []
  }

  /**
   * plan10: `Page.printToPDF` round-trip: decode the reply, save it inside the
   * downloads root, and report the page count (the print test's page parity
   * check) without ever returning bytes over the tool channel.
   * @param options - print parameters.
   * @returns the saved path, size, decoded bytes, and page count.
   * @throws Error `cdp: printToPDF: …` on a malformed reply.
   */
  async printToPdf(options: PrintToPdfOptions = {}): Promise<PrintToPdfResult> {
    const session = await this.getPageSession(options.targetId)
    const connection = this.requireConnection()
    const paper: Record<string, readonly [number, number]> = {
      A4: [8.27, 11.69],
      Letter: [8.5, 11],
      Legal: [8.5, 14],
      Tabloid: [11, 17],
    }
    const size = options.format === undefined ? undefined : paper[options.format]
    const margin = options.marginIn ?? {}
    const params: Record<string, unknown> = {
      printBackground: options.printBackground ?? true,
      ...(size !== undefined ? { paperWidth: size[0], paperHeight: size[1] } : {}),
      ...(options.landscape !== undefined ? { landscape: options.landscape } : {}),
      ...(options.scale !== undefined ? { scale: options.scale } : {}),
      ...(options.pageRanges !== undefined ? { pageRanges: options.pageRanges } : {}),
      ...(margin.top !== undefined ? { marginTop: margin.top } : {}),
      ...(margin.bottom !== undefined ? { marginBottom: margin.bottom } : {}),
      ...(margin.left !== undefined ? { marginLeft: margin.left } : {}),
      ...(margin.right !== undefined ? { marginRight: margin.right } : {}),
    }
    const reply = await connection.send('Page.printToPDF', params, session.sessionId)
    const data = parsePrintToPdfReply(reply)
    const root = this.downloadsRootPath
    const name = chooseWriteName(root, `print-${String(Date.now())}.pdf`, options.saveTo)
    const target = resolveInsideRoot(root, name)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, data)
    const pageCount = extractPdfText(data, { includeMeta: false }).pageCount
    return { path: this.displayPath(root, target), bytes: data.byteLength, pageCount, data }
  }

  /**
   * plan10: read a PDF from the downloads root with the budgeted extractor.
   * @param options - path and window/budget options.
   * @returns the root-relative path plus the extraction result.
   * @throws Error on escape, missing file, oversize, non-PDF, or a bad window.
   */
  async readPdf(options: ReadPdfOptions): Promise<{ path: string; extracted: ExtractPdfResult }> {
    const root = this.downloadsRootPath
    const target = resolveInsideRoot(root, options.path)
    const info = await stat(target).catch(() => undefined)
    if (info === undefined) throw new Error(`cdp: not found: ${options.path}`)
    if (info.isDirectory()) throw new Error(`cdp: is a directory: ${this.displayPath(root, target)}`)
    const maxBytes = this.serviceOptions.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES
    if (info.size > maxBytes) {
      const mib = Math.round(maxBytes / (1024 * 1024))
      throw new Error(`cdp: ${options.path}: exceeds ${String(mib)} MiB`)
    }
    const data = await readFile(target)
    if (!isPdf(data)) throw new Error(`cdp: ${options.path}: not a PDF (the %PDF- header is missing)`)
    const extracted = extractPdfText(data, {
      ...(options.page !== undefined ? { page: options.page } : {}),
      ...(options.pageFrom !== undefined ? { pageFrom: options.pageFrom } : {}),
      ...(options.pages !== undefined ? { pages: options.pages } : {}),
      ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
      ...(options.includeMeta !== undefined ? { includeMeta: options.includeMeta } : {}),
    })
    return { path: this.displayPath(root, target), extracted }
  }

  /**
   * plan10: extract text from the PDF the page is showing (network → print →
   * axtree strategies, or one pinned strategy).
   * @param options - strategy pin, budget, and timeout.
   * @returns the first successful strategy's outcome.
   * @throws Error `cdp: pdftotext: all strategies failed (…)` when none works.
   */
  async readPdfFromViewer(options: ViewerReadOptions = {}): Promise<ViewerExtractOutcome> {
    await this.getPageSession(options.targetId)
    return await extractFromViewer(this.viewerContext(), {
      ...(options.strategy !== undefined ? { strategy: options.strategy } : {}),
      ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
      ...(options.page !== undefined ? { page: options.page } : {}),
      ...(options.pageFrom !== undefined ? { pageFrom: options.pageFrom } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    })
  }

  /** plan10: the viewer strategy engine's view of this service. */
  private viewerContext(): ViewerContext {
    return {
      pageUrl: async () => (await this.getPageSession()).url(),
      fetchImpl: this.serviceOptions.fetch ?? globalThis.fetch,
      getAllCookies: async () => {
        const connection = this.requireConnection()
        const reply = await connection.send('Network.getAllCookies', {}).catch(async () => {
          const session = await this.getPageSession()
          await connection.send('Network.enable', {}, session.sessionId).catch(() => {})
          return await connection.send('Network.getAllCookies', {}, session.sessionId)
        }) as { cookies?: Array<{ name: string; value: string; domain?: string; path?: string }> }
        return (reply.cookies ?? []).map(cookie => ({
          name: cookie.name,
          value: cookie.value,
          ...(typeof cookie.domain === 'string' ? { domain: cookie.domain } : {}),
          ...(typeof cookie.path === 'string' ? { path: cookie.path } : {}),
        }))
      },
      targets: async () => this.targets.map(target => ({
        targetId: target.targetId,
        type: target.type,
        title: target.title,
        url: target.url,
      })),
      attach: async (targetId) => {
        const registry = this.registry
        if (registry === undefined) throw new Error('cdp: no active browser connection')
        return registry.attachedSession(targetId) ?? await registry.attach(targetId)
      },
      send: async (method, params, sessionId) => await this.requireConnection().send(method, params, sessionId),
      printToPdfFile: async () => {
        const printed = await this.printToPdf({})
        return { path: printed.path, data: printed.data, pageCount: printed.pageCount }
      },
      savePdf: async (suggestedName, bytes) => {
        const root = this.downloadsRootPath
        const name = chooseWriteName(root, suggestedName)
        const target = resolveInsideRoot(root, name)
        await writeFile(target, bytes)
        return this.displayPath(root, target)
      },
    }
  }

  // ---------------------------------------------------------------------------
  // plan05: dialog guard (branch 1 synchronous peek, branch 2 in-flight
  // race), cdp_dialog, and cdp_upload. Appended region — no plan01/02/03/06/10
  // method is touched.
  // ---------------------------------------------------------------------------

  /** plan05: extra upload roots contributed by config (resolved at load). */
  private uploadRootsExtra: readonly string[] = []

  /** plan05: config escape hatch skipping the upload root allow-list. */
  private allowUploadAnyPath = false

  /**
   * plan05: record the configured upload roots and escape hatch once at load.
   * @param options - extra roots and the allowAnyPath flag.
   */
  setUploadPolicy(options: { roots?: readonly string[] | undefined; allowAnyPath?: boolean | undefined }): void {
    this.uploadRootsExtra = options.roots ?? []
    this.allowUploadAnyPath = options.allowAnyPath === true
  }

  /** plan05: the policy cdp_upload validates against (cwd, downloads dir, extras). */
  private uploadPolicy(): UploadPolicy {
    const roots = [process.cwd(), this.downloadsRootPath, ...this.uploadRootsExtra]
    return { roots, allowAnyPath: this.allowUploadAnyPath }
  }

  /**
   * plan05 (branch 1): synchronous pending-dialog peek behind the global tool
   * guard. It never attaches and never creates a tab — only sessions that
   * already exist are read, so evaluating the guard has no side effects.
   * @param targetId - preferred target; omitted reads the active tab.
   * @returns the pending dialog brief, or undefined when none is known.
   */
  peekPendingDialog(targetId?: string): DialogBrief | undefined {
    const registry = this.registry
    if (registry === undefined) return undefined
    const active = registry.active()
    const sessionId = targetId !== undefined
      ? registry.attachedSession(targetId)
      : (active === undefined ? undefined : registry.attachedSession(active.targetId))
    if (sessionId === undefined) return undefined
    const session = this.sessions.get(sessionId)
    const pending = session?.pendingDialog()
    if (session === undefined || pending === undefined) return undefined
    return briefDialog(pending, this.targetIdOfSession(sessionId))
  }

  /** plan05: reverse-map a flattened session to its target id ('' when unknown). */
  private targetIdOfSession(sessionId: string): string {
    const registry = this.registry
    if (registry === undefined) return ''
    for (const target of registry.targets()) {
      if (registry.attachedSession(target.targetId) === sessionId) return target.targetId
    }
    return ''
  }

  /** plan05: every pending dialog across live sessions, each with its target. */
  private pendingDialogEntries(): Array<{ session: PageSession; brief: DialogBrief }> {
    const entries: Array<{ session: PageSession; brief: DialogBrief }> = []
    for (const [sessionId, session] of this.sessions) {
      const pending = session.pendingDialog()
      if (pending !== undefined) entries.push({ session, brief: briefDialog(pending, this.targetIdOfSession(sessionId)) })
    }
    return entries
  }

  /**
   * plan05: resolve a dialog target WITHOUT creating tabs — a caller asked
   * for dialog state, not for a new page session.
   * @param targetId - preferred target; omitted resolves the active tab.
   * @returns the attached session id (when one exists) and the target id.
   */
  private resolveDialogSession(targetId?: string): { sessionId: string | undefined; targetId: string } {
    const registry = this.registry
    if (registry === undefined) return { sessionId: undefined, targetId: targetId ?? '' }
    if (targetId !== undefined) {
      return { sessionId: registry.attachedSession(targetId), targetId }
    }
    const active = registry.active()
    if (active === undefined) return { sessionId: undefined, targetId: '' }
    return { sessionId: registry.attachedSession(active.targetId), targetId: active.targetId }
  }

  /**
   * plan05 (branch 2): wrap one page-scoped operation so an already-open
   * dialog fails fast BEFORE its first command, and a dialog that opens
   * while the operation is in flight fails the operation instead of letting
   * it hang behind the frozen renderer. When no session can be resolved the
   * operation runs untouched, so its own error still surfaces.
   * @param targetId - preferred target; omitted reads the active tab.
   * @param run - the operation body (session-bound by the caller).
   * @returns the operation's result.
   * @throws CdpDialogOpenError on either dialog branch.
   */
  async guardPageDialog<T>(targetId: string | undefined, run: () => Promise<T>): Promise<T> {
    const peeked = this.peekPendingDialog(targetId)
    if (peeked !== undefined) throw new CdpDialogOpenError(peeked)
    let resolved: PageSession | undefined
    try {
      resolved = await this.getPageSession(targetId)
    } catch {
      resolved = undefined
    }
    if (resolved === undefined) return await run()
    const session = resolved
    const pendingNow = session.pendingDialog()
    if (pendingNow !== undefined) {
      throw new CdpDialogOpenError(briefDialog(pendingNow, this.targetIdOfSession(session.sessionId)))
    }
    const operation = run()
    // A lost race must not surface as an unhandled rejection later.
    void operation.catch(() => undefined)
    let stop: (() => void) | undefined
    const raced = await Promise.race([
      operation.then(result => ({ kind: 'done' as const, result })),
      new Promise<{ kind: 'dialog'; record: DialogRecord }>((resolveRace) => {
        stop = session.onDialogOpened(record => resolveRace({ kind: 'dialog', record }))
      }),
    ])
    if (stop !== undefined) stop()
    if (raced.kind === 'dialog') {
      throw new CdpDialogOpenError(briefDialog(raced.record, this.targetIdOfSession(session.sessionId)))
    }
    return raced.result
  }

  /** plan05: one dialog snapshot (pending across tabs, resolved tab's ring + policy). */
  private dialogSnapshot(targetIdHint?: string): CdpDialogSnapshot {
    const entries = this.pendingDialogEntries()
    const resolved = this.resolveDialogSession(targetIdHint)
    const session = resolved.sessionId === undefined ? undefined : this.sessions.get(resolved.sessionId)
    return {
      targetId: resolved.targetId,
      pending: entries.map(entry => entry.brief),
      recent: session === undefined
        ? []
        : session.recentDialogs().map(record => briefDialog(record, this.targetIdOfSession(record.sessionId))),
      policy: session?.getDialogPolicy().action ?? 'none',
    }
  }

  /**
   * plan05: `cdp_dialog` — list pending/recent dialogs, answer the pending
   * one, or set the session's auto-answer policy. Answering never guesses a
   * tab: with several pending dialogs and no targetId it refuses and names
   * the candidates (report R1).
   * @param options - action plus optional target/prompt/policy fields.
   * @returns the dialog report; `ok:false` carries the failure code.
   */
  async dialog(options: CdpDialogOptions = {}): Promise<CdpDialogResult> {
    const action = options.action ?? 'list'
    const snapshot = this.dialogSnapshot(options.targetId)
    if (action !== 'list' && action !== 'accept' && action !== 'dismiss' && action !== 'policy') {
      return {
        ...snapshot,
        ok: false,
        error: {
          code: 'unknown-action',
          message: `cdp_dialog: unknown action "${String(action)}"; expected list, accept, dismiss, or policy`,
        },
      }
    }

    if (action === 'list') return { ...snapshot, ok: true }

    if (action === 'policy') {
      const policy = options.policy
      if (policy === undefined
        || (policy.action !== 'none' && policy.action !== 'accept' && policy.action !== 'dismiss')) {
        return {
          ...snapshot,
          ok: false,
          error: { code: 'unknown-action', message: 'cdp_dialog: policy.action must be none, accept, or dismiss' },
        }
      }
      const resolved = this.resolveDialogSession(options.targetId)
      let session = resolved.sessionId === undefined ? undefined : this.sessions.get(resolved.sessionId)
      if (session === undefined && options.targetId !== undefined) {
        try {
          session = await this.getPageSession(options.targetId)
        } catch {
          session = undefined
        }
      }
      if (session === undefined) {
        return {
          ...snapshot,
          ok: false,
          error: { code: 'no-session', message: 'cdp_dialog: no page session to apply the policy to; open a tab first' },
        }
      }
      session.setDialogPolicy(policy)
      const after = this.dialogSnapshot(resolved.targetId === '' ? options.targetId : resolved.targetId)
      return { ...after, ok: true }
    }

    // accept / dismiss: exactly one owner, never a guess.
    const entries = this.pendingDialogEntries()
    if (entries.length === 0) {
      return {
        ...snapshot,
        ok: false,
        error: {
          code: 'no-dialog',
          message: `cdp_dialog: no dialog is pending${action === 'accept' ? ' to accept' : ' to dismiss'} — list first with cdp_dialog({action:"list"})`,
        },
      }
    }
    let entry: { session: PageSession; brief: DialogBrief } | undefined
    if (options.targetId !== undefined) {
      entry = entries.find(candidate => candidate.brief.targetId === options.targetId)
      if (entry === undefined) {
        const pendingTargets = entries.map(candidate => candidate.brief.targetId).join(', ')
        return {
          ...snapshot,
          ok: false,
          error: {
            code: 'no-dialog',
            message: `cdp_dialog: target ${options.targetId} has no pending dialog (pending targets: ${pendingTargets})`,
          },
        }
      }
    } else if (entries.length > 1) {
      const pendingTargets = entries.map(candidate => candidate.brief.targetId).join(', ')
      return {
        ...snapshot,
        ok: false,
        error: {
          code: 'ambiguous-target',
          message: `cdp_dialog: ${String(entries.length)} tabs have pending dialogs (${pendingTargets}); pass targetId`,
        },
      }
    } else {
      entry = entries[0]
    }
    if (entry === undefined) {
      return { ...snapshot, ok: false, error: { code: 'no-dialog', message: 'cdp_dialog: no dialog is pending' } }
    }
    const accept = action === 'accept'
    try {
      await entry.session.answerDialog(accept, options.promptText)
    } catch (error) {
      return {
        ...snapshot,
        ok: false,
        error: {
          code: 'handle-failed',
          message: `cdp_dialog: the browser refused the answer: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
    const answeredTarget = entry.brief.targetId === '' ? options.targetId : entry.brief.targetId
    return {
      ...this.dialogSnapshot(answeredTarget),
      ok: true,
      answered: accept
        ? { action: 'accepted' as const, ...(options.promptText !== undefined ? { promptText: options.promptText } : {}) }
        : { action: 'dismissed' as const },
    }
  }

  /**
   * plan05: `cdp_upload` — validate absolute host paths against the policy,
   * then bind them onto the page's file input (selector mode) or into an
   * already-open file chooser (chooser mode), with an `input.files` read-back
   * as evidence. It refuses with a structured `dialog-open` while a dialog is
   * pending, and the whole bind runs inside the branch-2 race.
   * @param options - file paths, locator, target, mode, and timeout.
   * @returns the binding report; `ok:false` carries the failure code.
   */
  async upload(options: CdpUploadOptions): Promise<CdpUploadResult> {
    const mode: 'set' | 'chooser' = options.chooser === true ? 'chooser' : 'set'
    const targetId = options.targetId ?? ''
    const fail = (
      code: string,
      message: string,
      extra?: { files?: UploadFileBrief[] | undefined; targetId?: string | undefined },
    ): CdpUploadResult => ({
      ok: false,
      targetId: extra?.targetId ?? targetId,
      mode,
      files: extra?.files ?? [],
      matched: 0,
      bound: false,
      error: { code, message },
    })

    const paths = options.files ?? []
    if (paths.length === 0) {
      return fail('bad-request', 'cdp_upload: files must contain at least one absolute path')
    }
    if (paths.length > DEFAULT_MAX_UPLOAD_FILES) {
      return fail('too-many-files', `cdp_upload: at most ${String(DEFAULT_MAX_UPLOAD_FILES)} files per call, got ${String(paths.length)}`)
    }
    if (mode === 'set' && (options.selector === undefined || options.selector === '')) {
      return fail('missing-locator', 'cdp_upload: pass selector for set mode, or chooser:true to wait for an open file chooser')
    }

    const policy = this.uploadPolicy()
    const files: UploadFileBrief[] = []
    for (const rawPath of paths) {
      const checked = await validateUploadPath(rawPath, policy)
      if (!checked.ok) return fail(checked.code, checked.message, { files })
      files.push(checked.file)
    }

    // Branch 1 parity inside the tool itself: cdp_upload reports dialog-open
    // structurally instead of relying on the global guard.
    const peeked = this.peekPendingDialog(options.targetId)
    if (peeked !== undefined) return fail('dialog-open', dialogDenialReason(peeked), { files })

    let session: PageSession
    try {
      session = await this.getPageSession(options.targetId)
    } catch (error) {
      return fail('no-session', `cdp_upload: ${error instanceof Error ? error.message : String(error)}`, { files })
    }
    const connection = this.requireConnection()
    const resolvedTargetId = this.registry?.active()?.targetId ?? options.targetId ?? ''
    const send: UploadSender = async (method, params) => await connection.send(method, params, session.sessionId)

    let outcome: UploadBindOutcome
    let boundMode: 'set' | 'chooser' = mode
    try {
      outcome = await this.guardPageDialog(options.targetId, async () => {
        if (mode === 'chooser') {
          boundMode = 'chooser'
          await connection.send('Page.setInterceptFileChooserDialog', { enabled: true }, session.sessionId)
          try {
            const timeoutMs = Math.min(30_000, Math.max(500, options.timeoutMs ?? 5_000))
            const chooser = await session.awaitFileChooser(timeoutMs)
            return await bindFilePickerFiles({
              mode: chooser.mode,
              backendNodeId: chooser.backendNodeId,
              files,
              send,
            })
          } finally {
            await connection
              .send('Page.setInterceptFileChooserDialog', { enabled: false }, session.sessionId)
              .catch(() => {})
          }
        }
        boundMode = 'set'
        return await bindFileInput({ selector: options.selector ?? '', files, send })
      })
    } catch (error) {
      if (error instanceof CdpDialogOpenError) {
        return fail('dialog-open', error.message, { files, targetId: error.dialog.targetId })
      }
      if (error instanceof Error && error.name === 'CdpTimeoutError') {
        const timeoutMs = Math.min(30_000, Math.max(500, options.timeoutMs ?? 5_000))
        return fail('chooser-timeout', `cdp_upload: no file chooser opened within ${String(timeoutMs)}ms`, { files })
      }
      return fail('dom-error', `cdp_upload: ${error instanceof Error ? error.message : String(error)}`, { files })
    }

    if (!outcome.ok) {
      return { ...fail(outcome.code, outcome.message, { files }), mode: boundMode }
    }
    return {
      ok: true,
      targetId: resolvedTargetId,
      mode: boundMode,
      files,
      matched: 1,
      bound: true,
      input: outcome.input,
    }
  }

  /* plan02 wave 1 — read-only locator surface: resolve, read, assert.
     plan08: the ref path is now OPEN (resolveRef / readTextByRef /
     expectCheckByRef below); css/aria ladders and their evidence stay as
     plan02 left them. */

  /** Resolve one locator page-side and parse the reply; locator failures come back as data, not throws. */
  private async runLocator(spec: LocatorSpec | null, targetId?: string): Promise<LocatorRun> {
    const session = await this.getPageSession(targetId)
    const resolved = this.registry?.active()?.targetId ?? targetId ?? ''
    const evaluation = await session.evaluate(buildLocatorExpression(spec), {
      awaitPromise: true,
      timeoutMs: LOCATOR_EVAL_TIMEOUT_MS,
    })
    const run = parseLocatorReply(evaluation, resolved)
    // Failed replies carry no page URL; fetch it once so every envelope has one.
    if (run.reply.url === '') run.reply.url = await session.url().catch(() => '')
    return run
  }

  /**
   * Read the visible text behind a locator. Polls until the element resolves
   * unambiguously and is visible, or until the budget runs out (0 = single
   * attempt); every failure returns in-band with reason + candidate evidence.
   * @param spec - the locator naming whose visible text is read.
   * @param options - poll budget (`timeoutMs`), text cap (`maxChars`), and
   *   the target id to read against.
   * @returns the outcome: matched text (with the truncation flag when capped),
   *   or an in-band failure carrying reason and candidate evidence.
   */
  async readText(spec: LocatorSpec, options: ReadTextOptions = {}): Promise<TextOutcome> {
    const started = Date.now()
    const timeout = clampWaitTimeout(options.timeoutMs)
    const maxChars = clampMaxChars(options.maxChars)
    const deadline = started + timeout
    for (;;) {
      const run = await this.runLocator(spec, options.targetId)
      const verdict = evaluateText(run.reply, maxChars)
      const waitedMs = Date.now() - started
      if (verdict.ok || Date.now() >= deadline) {
        const failedReason = verdict.ok ? undefined : (verdict.reason ?? 'locator did not resolve')
        const reason = failedReason !== undefined && timeout > 0
          ? `${failedReason} (timed out after ${String(waitedMs)}ms)`
          : failedReason
        return {
          ok: verdict.ok,
          matched: run.reply.matched,
          strategy: run.reply.strategy,
          candidates: run.reply.candidates,
          waitedMs,
          ...(run.reply.target !== undefined ? { target: run.reply.target } : {}),
          ...(run.reply.actionability !== undefined ? { actionability: run.reply.actionability } : {}),
          ...(verdict.text !== undefined ? { text: verdict.text } : {}),
          ...(verdict.truncated !== undefined ? { truncated: verdict.truncated } : {}),
          ...(reason !== undefined ? { reason } : {}),
          ...(run.reply.warning !== undefined ? { warning: run.reply.warning } : {}),
          targetId: run.targetId,
          url: run.reply.url,
        }
      }
      await sleep(LOCATOR_POLL_MS)
    }
  }

  /**
   * Poll one expect check until it passes or the budget runs out (default 0 =
   * single attempt, capped at 30s). Expected conditions never throw: mismatch,
   * not-found, and ambiguity all come back as `passed:false` + reason.
   * @param options - the assertion: the `check` to run, its `expected` value,
   *   the locator supplying it (ignored by `urlMatches`), timeout, and target.
   * @returns the verdict with actual/expected evidence on success, or
   *   `passed:false` plus the failure reason; never throws on mismatch.
   */
  async expectCheck(options: ExpectOptions): Promise<ExpectOutcome> {
    const started = Date.now()
    const timeout = clampWaitTimeout(options.timeoutMs)
    const deadline = started + timeout
    // urlMatches asserts the page URL and deliberately ignores any locator.
    const spec = options.check === 'urlMatches' ? null : (options.spec ?? null)
    for (;;) {
      const run = await this.runLocator(spec, options.targetId)
      const verdict = evaluateExpect(run.reply, options.check, options.expected)
      const waitedMs = Date.now() - started
      if (verdict.passed || Date.now() >= deadline) {
        const failedReason = verdict.passed ? undefined : (verdict.reason ?? 'assertion failed')
        const reason = failedReason !== undefined && timeout > 0
          ? `${failedReason} (timed out after ${String(waitedMs)}ms)`
          : failedReason
        return {
          ok: verdict.passed,
          check: options.check,
          passed: verdict.passed,
          matched: run.reply.matched,
          strategy: run.reply.strategy,
          candidates: run.reply.candidates,
          waitedMs,
          ...(run.reply.target !== undefined ? { target: run.reply.target } : {}),
          ...(run.reply.actionability !== undefined ? { actionability: run.reply.actionability } : {}),
          ...(options.expected !== undefined ? { expected: options.expected } : {}),
          ...(verdict.actual !== undefined ? { actual: verdict.actual } : {}),
          ...(reason !== undefined ? { reason } : {}),
          targetId: run.targetId,
          url: run.reply.url,
        }
      }
      await sleep(LOCATOR_POLL_MS)
    }
  }

  /**
   * Coordinate-mode evidence for `cdp_click`: whatever sits at the viewport
   * point plus the page URL. Best-effort — undefined when the page cannot
   * answer; the click itself never depends on it.
   * @param x - viewport CSS x of the point.
   * @param y - viewport CSS y of the point.
   * @param targetId - optional target id.
   * @returns the resolved target and page URL plus the node hit at the point,
   *   or undefined when the page could not answer.
   */
  async describePoint(x: number, y: number, targetId?: string): Promise<PointEvidence | undefined> {
    const session = await this.getPageSession(targetId)
    const resolved = this.registry?.active()?.targetId ?? targetId ?? ''
    const evaluation = await session.evaluate(buildPointExpression(x, y), { timeoutMs: 3_000 })
    if (evaluation.error !== undefined || !evaluation.hasValue || evaluation.value === '') return undefined
    const reply = parseEvidenceReply(evaluation.value)
    if (reply === undefined) return undefined
    return { targetId: resolved, url: reply.url, ...(reply.info !== undefined ? { hit: reply.info } : {}) }
  }

  /**
   * Focus evidence for `cdp_type`: where keystrokes are about to go.
   * Best-effort, like {@link describePoint}.
   * @param targetId - optional target id.
   * @returns the resolved target and page URL plus the focused-node info, or
   *   undefined when the page could not answer.
   */
  async describeFocus(targetId?: string): Promise<FocusEvidence | undefined> {
    const session = await this.getPageSession(targetId)
    const resolved = this.registry?.active()?.targetId ?? targetId ?? ''
    const evaluation = await session.evaluate(buildFocusExpression(), { timeoutMs: 3_000 })
    if (evaluation.error !== undefined || !evaluation.hasValue || evaluation.value === '') return undefined
    const reply = parseEvidenceReply(evaluation.value)
    if (reply === undefined) return undefined
    return { targetId: resolved, url: reply.url, ...(reply.info !== undefined ? { focused: reply.info } : {}) }
  }

  /**
   * plan02-fix-type-focus: arm the focus gate — remember which node the click
   * about to run will land on. The click itself stays untouched; only the
   * post-click check uses this. Best-effort: a page that cannot answer leaves
   * the gate open (nothing is refused because of a probe the page refused).
   * @param x - viewport CSS x of the click point.
   * @param y - viewport CSS y of the click point.
   * @param targetId - optional target id.
   * @returns true when a node was armed; undefined when the page could not say.
   */
  async armTypeFocus(x: number, y: number, targetId?: string): Promise<boolean | undefined> {
    const session = await this.getPageSession(targetId)
    const evaluation = await session.evaluate(buildFocusArmExpression(x, y), { timeoutMs: 2_000 })
    if (evaluation.error !== undefined || !evaluation.hasValue || evaluation.value === '') return undefined
    try {
      const parsed: unknown = JSON.parse(evaluation.value)
      if (typeof parsed === 'object' && parsed !== null && (parsed as { armed?: unknown }).armed === true) return true
    } catch {
      return undefined
    }
    return false
  }

  /**
   * plan02-fix-type-focus: read the focus gate armed by {@link armTypeFocus} —
   * is the clicked element (or a relative of it) still `document.activeElement`?
   * undefined means the page gave no verdict, and the caller then types
   * exactly as before: only a positive "focus is elsewhere" may refuse.
   * @param targetId - optional target id.
   * @returns the verdict, or undefined when the page could not judge.
   */
  async verifyTypeFocus(targetId?: string): Promise<TypeFocusCheck | undefined> {
    const session = await this.getPageSession(targetId)
    const evaluation = await session.evaluate(buildFocusCheckExpression(), { timeoutMs: 2_000 })
    if (evaluation.error !== undefined || !evaluation.hasValue || evaluation.value === '') return undefined
    return parseFocusCheckReply(evaluation.value)
  }

  /* plan02 wave 2 (Faz 2/3) — fill, the pre-click resolve, and network-idle. */

  /**
   * Resolve a locator for a CLICK (§4.1/§4.2): poll like {@link readText}, but
   * succeed only when every actionability axis passes. The click point is the
   * centre of the visible rect; a final failure carries reason + candidates.
   * @param spec - the locator to resolve and test for actionability.
   * @param targetId - optional target id; defaults to the active target.
   * @param timeoutMs - poll budget for resolution; defaults to 5s, clamped.
   * @returns the centre point and actionability evidence when every axis
   *   passes, or an in-band failure with reason and candidates.
   */
  async resolveForAction(spec: LocatorSpec, targetId?: string, timeoutMs?: number): Promise<ActionResolution> {
    const started = Date.now()
    const budget = clampWaitTimeout(timeoutMs ?? 5_000)
    const deadline = started + budget
    const resolved = this.registry?.active()?.targetId ?? targetId ?? ''
    let failure: ActionResolution = {
      ok: false,
      targetId: resolved,
      url: '',
      matched: 0,
      strategy: 'none',
      reason: 'locator did not resolve',
      candidates: [],
    }
    for (;;) {
      const run = await this.runLocator(spec, targetId)
      const reply = run.reply
      if (reply.ok && reply.target !== undefined && reply.actionability !== undefined) {
        if (reply.actionability.failures.length === 0) {
          const rect = reply.target.rect
          return {
            ok: true,
            targetId: run.targetId,
            url: reply.url,
            point: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
            matched: reply.matched,
            strategy: reply.strategy,
            target: reply.target,
            actionability: reply.actionability,
          }
        }
        failure = {
          ok: false,
          targetId: run.targetId,
          url: reply.url,
          matched: reply.matched,
          strategy: reply.strategy,
          reason: `not clickable: ${reply.actionability.failures.join('; ')}`,
          candidates: reply.candidates,
        }
      } else if (reply.ok) {
        failure = {
          ok: false,
          targetId: run.targetId,
          url: reply.url,
          matched: reply.matched,
          strategy: reply.strategy,
          reason: 'locator resolved but carried no actionability report',
          candidates: reply.candidates,
        }
      } else {
        failure = {
          ok: false,
          targetId: run.targetId,
          url: reply.url,
          matched: reply.matched,
          strategy: reply.strategy,
          reason: reply.reason ?? 'locator did not resolve',
          candidates: reply.candidates,
        }
      }
      if (Date.now() >= deadline) {
        return budget > 0 && failure.ok === false
          ? { ...failure, reason: `${failure.reason} (timed out after ${String(Date.now() - started)}ms)` }
          : failure
      }
      await sleep(LOCATOR_POLL_MS)
    }
  }

  /**
   * Fill one form field (§4.4): one page evaluate resolves the locator and
   * writes through the native setter (+ input/change, or option selection,
   * or a contenteditable Selection + execCommand); the raw read-back decides
   * whether an `Input.insertText` fallback is needed (the script has already
   * focused + selected the element for it). Locator failures poll until the
   * budget; kind rejections (file input, non-fillable element, missing
   * option) stop immediately.
   * @param spec - the locator naming the field to fill.
   * @param value - the text to write into it.
   * @param options - fill knobs: `clear`, `verify`, poll budget `timeoutMs`,
   *   and the target id.
   * @returns the outcome: the written length with read-back evidence, or an
   *   in-band failure carrying the reason (kind rejections stop immediately).
   */
  async fill(spec: LocatorSpec, value: string, options: FillOptions = {}): Promise<FillOutcome> {
    const started = Date.now()
    const clear = options.clear !== false
    const verify = options.verify !== false
    const budget = options.timeoutMs === undefined ? FILL_DEFAULT_TIMEOUT_MS : clampWaitTimeout(options.timeoutMs)
    const targetId = options.targetId
    const resolved = this.registry?.active()?.targetId ?? targetId ?? ''
    const deadline = started + budget
    let last: FillOutcome = { ok: false, action: 'fill', length: value.length, targetId: resolved, url: '', reason: 'fill did not run' }
    for (;;) {
      const session = await this.getPageSession(targetId)
      const evaluation = await session.evaluate(
        buildFillExpression(spec, { value, clear, verify }),
        { awaitPromise: true, timeoutMs: FILL_EVAL_TIMEOUT_MS },
      )
      const run = parseFillReply(evaluation, resolved)
      const reply = run.reply
      if (reply.ok) return fillOutcomeFromReply(reply, run.targetId, value.length)
      if (reply.fallbackNeeded === true && reply.post !== undefined) {
        await this.insertText(value, targetId)
        const readSession = await this.getPageSession(targetId)
        const probe = await readSession.evaluate(buildFillReadExpression(reply.fallbackKind ?? 'value'), { timeoutMs: 3_000 })
        const parsed = parseFillRead(probe)
        return fillFallbackOutcome(reply, run.targetId, value.length, parsed?.actual, parsed?.url ?? '')
      }
      last = fillOutcomeFromReply(reply, run.targetId, value.length)
      if (reply.reason !== undefined && isFillFatal(reply.reason)) return last
      if (Date.now() >= deadline) {
        return budget > 0 && reply.reason !== undefined
          ? { ...last, reason: `${reply.reason} (timed out after ${String(Date.now() - started)}ms)` }
          : last
      }
      await sleep(FILL_POLL_MS)
    }
  }

  /**
   * `Input.insertText` — the fallback write for a framework that reverted the
   * setter value. The element must already be focused + selected (the fill
   * script does both before reporting `fallbackNeeded`).
   * @param text - the raw text to insert.
   * @param targetId - optional target id.
   */
  async insertText(text: string, targetId?: string): Promise<void> {
    const session = await this.getPageSession(targetId)
    if (this.connection === undefined) throw new Error('cdp: no active connection')
    await this.connection.send('Input.insertText', { text }, session.sessionId)
  }

  /**
   * network-idle (§4.7): count requests through session-scoped connection
   * events and pass after `idleMs` of quiet. The Network domain is enabled
   * only for the wait and is always disabled + unsubscribed afterwards.
   * @param timeoutMs - overall budget for the wait.
   * @param idleMs - quiet period with no counted requests that satisfies it.
   * @param targetId - optional target id.
   * @returns the verdict: whether idle was reached, the time actually waited,
   *   and whether the budget ran out first.
   */
  async waitNetworkIdle(timeoutMs: number, idleMs: number, targetId?: string): Promise<WaitNetworkReply> {
    const session = await this.getPageSession(targetId)
    const connection = this.connection
    if (connection === undefined) throw new Error('cdp: no active connection')
    const sessionId = session.sessionId
    return await waitForNetworkIdle({
      sessionId,
      send: (method, params, sid) => connection.send(method, params, sid),
      on: (event, listener) => connection.on(event, listener, sessionId),
    }, timeoutMs, idleMs)
  }

  /* plan08 — the ref path. Tab resolution still runs through
     `getPageSession` first, so plan03's evidence verdicts and refusals are
     untouched; only the ELEMENT lookup is new. Every resolution reads a
     FRESH document, so a ref from an earlier snapshot either resolves to the
     element that carries it NOW or fails with a `stale-ref:` reason. */

  /**
   * Resolve one woven snapshot ref to live element evidence at action time:
   * fresh `DOM.getDocument {depth:-1, pierce:true}`, the weaver's own ref
   * rules (`buildRefIndex`, identical to `cdp_snapshot`), then
   * `DOM.resolveNode` + `Runtime.callFunctionOn` for geometry/visibility.
   *
   * plan08-fix-ref-rename: a ref is a NAME, so an element that renames itself
   * ("Onayla" → "Onayla ✓") misses by name while its node is still right
   * there. The node this ref pointed at when the snapshot published it is
   * handed to the resolver, which re-matches it inside the fresh document: a
   * hit is DELIVERED with `evidence.renamed` set, only a miss is `stale-ref`.
   * @param ref - reference from `cdp_snapshot` (`role|name|ordinal`, `#n`-disambiguated).
   * @param targetId - optional target id (plan03 policy applies when absent).
   * @returns fresh element evidence for that tab.
   * @throws RefStaleError with a `stale-ref:` message when the ref's node is
   *   really gone, or with `unresolved-ref:` when the string was not a ref.
   */
  async resolveRef(ref: string, targetId?: string): Promise<RefEvidence> {
    const session = await this.getPageSession(targetId)
    if (this.connection === undefined) {
      throw new RefStaleError(ref, `${REF_STALE_PREFIX}: no active connection`)
    }
    const docRes = await this.connection.send(
      'DOM.getDocument',
      { depth: -1, pierce: true },
      session.sessionId,
    ) as { root?: CdpDomNode }
    const root = docRes.root
    if (root === undefined) {
      throw new RefStaleError(ref, `${REF_STALE_PREFIX}: the page exposed no document`)
    }
    const resolved = this.registry?.active()?.targetId ?? targetId ?? ''
    const origin = lookupRefOrigin(resolved, ref)
    const evidence = await resolveRefOn(
      this.connection,
      session.sessionId,
      ref,
      root,
      origin === undefined ? undefined : { origin },
    )
    return { ...evidence, targetId: resolved }
  }

  /**
   * One ref resolution attempt as a locator run — success carries the fresh
   * candidate/actionability report, failure carries the `stale-ref:` reason.
   * Never throws: the poll loops consume ref failures as data.
   * @param ref - the woven reference.
   * @param targetId - optional target id.
   * @returns a `strategy:'ref'` locator run.
   */
  private async runRefLocator(ref: string, targetId?: string): Promise<LocatorRun> {
    try {
      const evidence = await this.resolveRef(ref, targetId)
      return refLocatorRun(evidence, evidence.targetId ?? '')
    } catch (error) {
      const reason = error instanceof RefStaleError
        ? error.message
        : `${REF_STALE_PREFIX}: ref resolution failed (${error instanceof Error ? error.message : String(error)})`
      const resolved = this.registry?.active()?.targetId ?? targetId ?? ''
      return refFailureRun(ref, resolved, reason)
    }
  }

  /**
   * plan08: `readText` behind a ref. Same poll/verdict/reason contract as the
   * locator ladder; the outcome echoes the ref and flags `staleRef` when the
   * refusal was a stale-ref (vs. merely not-yet visible).
   * @param ref - the woven reference.
   * @param options - same wait/text options as {@link readText}.
   * @returns the text envelope plus ref provenance.
   */
  async readTextByRef(ref: string, options: ReadTextOptions = {}): Promise<RefTextOutcome> {
    const started = Date.now()
    const timeout = clampWaitTimeout(options.timeoutMs)
    const maxChars = clampMaxChars(options.maxChars)
    const deadline = started + timeout
    for (;;) {
      const run = await this.runRefLocator(ref, options.targetId)
      const verdict = evaluateText(run.reply, maxChars)
      const waitedMs = Date.now() - started
      if (verdict.ok || Date.now() >= deadline) {
        const failedReason = verdict.ok ? undefined : (verdict.reason ?? 'ref did not resolve')
        const reason = failedReason !== undefined && timeout > 0
          ? `${failedReason} (timed out after ${String(waitedMs)}ms)`
          : failedReason
        return {
          ok: verdict.ok,
          matched: run.reply.matched,
          strategy: run.reply.strategy,
          candidates: run.reply.candidates,
          waitedMs,
          ...(run.reply.target !== undefined ? { target: run.reply.target } : {}),
          ...(run.reply.actionability !== undefined ? { actionability: run.reply.actionability } : {}),
          ...(verdict.text !== undefined ? { text: verdict.text } : {}),
          ...(verdict.truncated !== undefined ? { truncated: verdict.truncated } : {}),
          ...(reason !== undefined ? { reason } : {}),
          ...(run.reply.warning !== undefined ? { warning: run.reply.warning } : {}),
          targetId: run.targetId,
          url: run.reply.url,
          ref,
          staleRef: isStaleRefReason(reason),
        }
      }
      await sleep(LOCATOR_POLL_MS)
    }
  }

  /**
   * plan08: `expectCheck` behind a ref (urlMatches keeps its own path — a URL
   * assertion needs no element). Same pass/fail contract; the outcome echoes
   * the ref and flags stale refusals.
   * @param ref - the woven reference.
   * @param options - same expect options as {@link expectCheck}.
   * @returns the expect envelope plus ref provenance.
   */
  async expectCheckByRef(ref: string, options: ExpectOptions): Promise<RefExpectOutcome> {
    const started = Date.now()
    const timeout = clampWaitTimeout(options.timeoutMs)
    const deadline = started + timeout
    for (;;) {
      const run = await this.runRefLocator(ref, options.targetId)
      const verdict = evaluateExpect(run.reply, options.check, options.expected)
      const waitedMs = Date.now() - started
      if (verdict.passed || Date.now() >= deadline) {
        const failedReason = verdict.passed ? undefined : (verdict.reason ?? 'assertion failed')
        const reason = failedReason !== undefined && timeout > 0
          ? `${failedReason} (timed out after ${String(waitedMs)}ms)`
          : failedReason
        return {
          ok: verdict.passed,
          check: options.check,
          passed: verdict.passed,
          matched: run.reply.matched,
          strategy: run.reply.strategy,
          candidates: run.reply.candidates,
          waitedMs,
          ...(run.reply.target !== undefined ? { target: run.reply.target } : {}),
          ...(run.reply.actionability !== undefined ? { actionability: run.reply.actionability } : {}),
          ...(options.expected !== undefined ? { expected: options.expected } : {}),
          ...(verdict.actual !== undefined ? { actual: verdict.actual } : {}),
          ...(reason !== undefined ? { reason } : {}),
          // plan08-fix-ref-rename: an assertion against a renamed ref PASSES on
          // the element that is still there, carrying the honest note.
          ...(run.reply.warning !== undefined ? { warning: run.reply.warning } : {}),
          targetId: run.targetId,
          url: run.reply.url,
          ref,
          staleRef: isStaleRefReason(reason),
        }
      }
      await sleep(LOCATOR_POLL_MS)
    }
  }

  /* plan08 §4.2 — find: element discovery over ONE fresh document. The
     candidate universe is `buildRefIndex` (the same weave `cdp_snapshot`
     prints), so every returned ref is byte-identical to the model's
     snapshot refs; the chosen node is re-measured at action time through
     the ref path. A missing element is DATA (`ok:false + warnings`), never
     a thrown stale-ref — while plan03 tab/session refusals propagate
     untouched because `getPageSession` still runs first. */
  /**
   * Find elements by ref/selector/ariaLabel/role/text and report fresh
   * rect + actionability for the chosen one (plan §4.2).
   * @param options - query keys (at least one of ref/selector/ariaLabel/role/text).
   * @returns the find envelope; every branch carries ok/matched/targetId/url/warnings.
   */
  async find(options: FindOptions = {}): Promise<FindOutcome> {
    const query: FindQuery = {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.ariaLabel ? { ariaLabel: options.ariaLabel } : {}),
      ...(options.role ? { role: options.role } : {}),
      ...(options.text ? { text: options.text } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
    }
    const initialTarget = this.registry?.active()?.targetId ?? options.targetId ?? ''
    if (!hasFindQuery(query)) {
      const reason = 'cdp_find: pass at least one of ref, selector, ariaLabel, role, text'
      return { ok: false, matched: 0, targetId: initialTarget, url: '', warnings: [reason], reason }
    }
    const timeout = clampWaitTimeout(options.timeoutMs)
    const nth = typeof options.nth === 'number' && Number.isFinite(options.nth) && options.nth > 0
      ? Math.trunc(options.nth)
      : 0
    const deadline = Date.now() + timeout

    let session: PageSession | undefined
    let root: CdpDomNode | undefined
    let index: ReadonlyMap<string, RefIndexEntry> = new Map()
    let matches: FindMatch[] = []
    let scopeMiss = false
    let selectorMiss = false

    for (;;) {
      session = await this.getPageSession(options.targetId)
      if (this.connection === undefined) {
        throw new Error('cdp: no active connection')
      }
      await this.connection.send('DOM.enable', {}, session.sessionId).catch(() => {})
      const docRes = await this.connection.send(
        'DOM.getDocument',
        { depth: -1, pierce: true },
        session.sessionId,
      ) as { root?: CdpDomNode }
      root = docRes.root
      if (root === undefined) {
        matches = []
        if (Date.now() >= deadline) break
        await sleep(LOCATOR_POLL_MS)
        continue
      }
      index = buildRefIndex(root)
      scopeMiss = false
      selectorMiss = false
      let scopeIds: ReadonlySet<number> | undefined
      let scopeNodeId: number | undefined
      if (query.scope !== undefined) {
        const scoped = await this.connection.send(
          'DOM.querySelector',
          { nodeId: root.nodeId, selector: query.scope },
          session.sessionId,
        ) as { nodeId?: number }
        scopeNodeId = typeof scoped.nodeId === 'number' && scoped.nodeId !== 0 ? scoped.nodeId : undefined
        scopeMiss = scopeNodeId === undefined
        if (scopeNodeId !== undefined) {
          const desc = await this.connection.send(
            'DOM.querySelectorAll',
            { nodeId: scopeNodeId, selector: '*' },
            session.sessionId,
          ) as { nodeIds?: number[] }
          scopeIds = new Set(desc.nodeIds ?? [])
        }
      }
      let selectorIds: number[] | undefined
      if (query.selector !== undefined && !scopeMiss) {
        const found = await this.connection.send(
          'DOM.querySelectorAll',
          { nodeId: scopeNodeId ?? root.nodeId, selector: query.selector },
          session.sessionId,
        ) as { nodeIds?: number[] }
        selectorIds = found.nodeIds ?? []
        selectorMiss = selectorIds.length === 0
      }
      matches = scopeMiss ? [] : matchFindCandidates(index, query, { scopeIds, selectorIds })
      if (matches.length > 0 || Date.now() >= deadline) break
      await sleep(LOCATOR_POLL_MS)
    }

    const resolvedTarget = this.registry?.active()?.targetId ?? options.targetId ?? ''
    if (session === undefined || root === undefined) {
      const reason = 'cdp_find: the page exposed no document'
      return { ok: false, matched: 0, targetId: resolvedTarget, url: '', warnings: [reason], reason }
    }
    const liveSession = session
    const documentRoot = root
    const url = await liveSession.url().catch(() => '')
    // plan08-fix-ref-rename: find publishes refs exactly like a snapshot does,
    // so the nodes behind them are remembered the same way.
    recordRefOrigins(resolvedTarget, index, url)
    if (matches.length === 0) {
      const line = scopeMiss && query.scope !== undefined
        ? `scope matched nothing: ${query.scope}`
        : selectorMiss && query.selector !== undefined
          ? `no element matched selector ${JSON.stringify(query.selector)}`
          : `no element matched ${querySummary(query)}`
      const reason = line + (timeout > 0 ? ` (waited ${String(timeout)}ms)` : '')
      return { ok: false, matched: 0, targetId: resolvedTarget, url, warnings: [reason], reason }
    }
    if (nth >= matches.length) {
      const reason = `nth ${String(nth)} is out of range: ${String(matches.length)} element(s) matched`
      return { ok: false, matched: matches.length, targetId: resolvedTarget, url, warnings: [reason], reason }
    }

    if (this.connection === undefined) {
      throw new Error('cdp: no active connection')
    }
    const connection = this.connection
    const sessionId = liveSession.sessionId
    const resolve = async (match: FindMatch): Promise<{ evidence?: RefEvidence, failure?: string }> => {
      try {
        const evidence = await resolveRefOn(connection, sessionId, match.ref, documentRoot, { index })
        return { evidence: { ...evidence, targetId: resolvedTarget } }
      } catch (error) {
        return {
          failure: error instanceof RefStaleError
            ? error.message
            : `cdp_find: resolving ${match.ref} failed (${error instanceof Error ? error.message : String(error)})`,
        }
      }
    }

    const candidateMatches = matches.slice(0, 10)
    const evidenceByRef = new Map<string, RefEvidence>()
    let staleListed = 0
    for (const candidate of candidateMatches) {
      const outcome = await resolve(candidate)
      if (outcome.evidence !== undefined) {
        evidenceByRef.set(candidate.ref, outcome.evidence)
      } else {
        staleListed += 1
      }
    }
    const chosenMatch = matches[nth] as FindMatch
    let chosenEvidence = evidenceByRef.get(chosenMatch.ref)
    if (chosenEvidence === undefined) {
      const outcome = await resolve(chosenMatch)
      if (outcome.evidence === undefined) {
        const reason = outcome.failure ?? `cdp_find: ${chosenMatch.ref} went stale during find`
        return { ok: false, matched: matches.length, targetId: resolvedTarget, url, warnings: [reason], reason }
      }
      chosenEvidence = outcome.evidence
    }

    const warnings: string[] = []
    if (matches.length > 1) {
      warnings.push(
        `search matched ${String(matches.length)} elements; nth=${String(nth)} shown — pass nth to pick another`,
      )
    }
    if (staleListed > 0) {
      warnings.push(`${String(staleListed)} of ${String(candidateMatches.length)} listed candidates went stale while measuring`)
    }
    if (chosenEvidence.frameLocal) {
      warnings.push('chosen element is frame-local: its box is not top-viewport (cdp_click/cdp_type with this ref will refuse)')
    }

    const candidates: FindCandidateRow[] = []
    for (const candidate of candidateMatches) {
      const evidence = evidenceByRef.get(candidate.ref)
      if (evidence === undefined) continue
      candidates.push({
        ref: evidence.ref,
        role: evidence.role,
        name: displayNormalize(evidence.name),
        box: evidence.rect,
        visible: evidence.visible,
      })
    }
    const chosen: FindChosen = {
      ref: chosenEvidence.ref,
      role: chosenEvidence.role,
      name: displayNormalize(chosenEvidence.name),
      rawName: chosenEvidence.name,
      box: chosenEvidence.rect,
      visible: chosenEvidence.visible,
      inViewport: chosenEvidence.inViewport,
      frameLocal: chosenEvidence.frameLocal,
    }
    const actionable: FindActionable = {
      connected: true,
      visible: chosenEvidence.visible,
      inViewport: chosenEvidence.inViewport,
      enabled: chosenEvidence.enabled,
      hitTarget: chosenEvidence.hitTarget,
      ...(chosenEvidence.coveredBy !== undefined ? { coveredBy: chosenEvidence.coveredBy } : {}),
    }
    return {
      ok: true,
      matched: matches.length,
      targetId: resolvedTarget,
      url,
      warnings,
      chosen,
      actionable,
      candidates,
    }
  }

  /* plan14 — locate: "what is AT (x,y)?". The visual loop's missing query:
     the model reads a point off a `cdp_screenshot` and this tells it what the
     DOM has there BEFORE any click is dispatched, so a wrong aim is a cheap
     `ok:false + nearest` instead of an irreversible wrong click. Strictly a
     PROBE: it never clicks, and the two-stage order (screenshot → locate →
     click) is what makes a mis-aim structurally recoverable. */
  /**
   * Identify the element at one viewport point (plan14).
   * @param options - `x`/`y` in viewport CSS pixels + optional target.
   * @returns the locate envelope; an empty point is data, never a throw.
   */
  async locate(options: LocateOptions): Promise<LocateOutcome> {
    const rawX = typeof options.x === 'number' ? options.x : Number.NaN
    const rawY = typeof options.y === 'number' ? options.y : Number.NaN
    const x = Number.isFinite(rawX) ? rawX : 0
    const y = Number.isFinite(rawY) ? rawY : 0
    const targetId = this.registry?.active()?.targetId ?? options.targetId ?? ''
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      const reason = 'cdp_locate: pass finite x and y in viewport CSS pixels'
      return { ok: false, x, y, targetId, url: '', warnings: [reason], reason }
    }
    const session = await this.getPageSession(options.targetId)
    const evaluation = await session.evaluate(buildLocateExpression(x, y), { timeoutMs: LOCATE_EVAL_TIMEOUT_MS })
    if (evaluation.error !== undefined) {
      const reason = `cdp_locate: the page-side probe failed (${evaluation.error.kind})`
      return { ok: false, x, y, targetId, url: '', warnings: [reason], reason }
    }
    if (!evaluation.hasValue || evaluation.value === '') {
      const reason = `cdp_locate: the page-side probe produced no value (${evaluation.exception ?? 'no result'})`
      return { ok: false, x, y, targetId, url: '', warnings: [reason], reason }
    }
    const parsed = parseLocateReply(evaluation.value)
    if (!parsed.ok) {
      return { ok: false, x, y, targetId, url: '', warnings: [parsed.reason], reason: parsed.reason }
    }
    const { record } = parsed
    const warnings = [...record.warnings]
    if (evaluation.truncated) {
      warnings.push('the page-side probe output was truncated, so some fields may be missing')
    }
    if (record.node === null) {
      const reason = `no element at (${String(x)},${String(y)})`
      if (record.nearest === null) {
        warnings.push('the page exposed no element box, so no nearest element could be named')
      }
      return {
        ok: false,
        x,
        y,
        targetId,
        url: record.url,
        warnings,
        reason,
        ...(record.nearest !== null ? { nearest: record.nearest } : {}),
      }
    }
    const node = record.node
    if (!node.inViewport) {
      warnings.push('the point is outside the viewport: a click at this point would not reach the element — scroll it into view first')
    }
    if (node.coveredBy !== undefined) {
      warnings.push(`covered by ${node.coveredBy}: a fresh hit test at this point returned a different topmost element, so a click now would land on it, not on the reported node`)
    }
    return {
      ok: true,
      x,
      y,
      targetId,
      url: record.url,
      warnings,
      node,
      viewport: record.viewport,
    }
  }

  /* plan08 §4.3 — extract: a JSON projection spec against one fresh
     document. Spec validation is host-side and pre-protocol (broken JSON /
     unknown kinds / bad regexes answer `ok:false + error` in-band); a
     successful projection ALWAYS returns `data` (possibly []) plus
     complete/missing/truncatedFields honesty — never an empty swallow. */
  /**
   * Project page/list/field data per a JSON spec (plan §4.3).
   * @param options - `spec` string + optional target/wait window.
   * @returns the extract envelope; ok:true always carries data + honesty fields.
   */
  async extract(options: ExtractOptions): Promise<ExtractOutcome> {
    const parsed = parseExtractSpec(options.spec)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const spec: ExtractSpec = parsed.spec
    const timeout = clampWaitTimeout(options.timeoutMs)
    const deadline = Date.now() + timeout

    let session: PageSession | undefined
    let last: ExtractOutcome | undefined

    for (;;) {
      session = await this.getPageSession(options.targetId)
      if (this.connection === undefined) {
        throw new Error('cdp: no active connection')
      }
      await this.connection.send('DOM.enable', {}, session.sessionId).catch(() => {})
      const docRes = await this.connection.send(
        'DOM.getDocument',
        { depth: -1, pierce: true },
        session.sessionId,
      ) as { root?: CdpDomNode }
      const root = docRes.root
      const resolvedTarget = this.registry?.active()?.targetId ?? options.targetId ?? ''
      if (root === undefined) {
        last = {
          ok: false,
          kind: spec.kind,
          targetId: resolvedTarget,
          error: 'cdp_extract: the page exposed no document',
        }
        if (Date.now() >= deadline) break
        await sleep(LOCATOR_POLL_MS)
        continue
      }
      const index = buildRefIndex(root)
      const url = await session.url().catch(() => '')
      const title = await session.title().catch(() => '')

      if (spec.kind === 'page') {
        const warnings: string[] = []
        let pageFields: Record<string, LosslessJsonValue> = {}
        const evaluation = await session
          .evaluate(PAGE_FIELDS_EXPRESSION, { timeoutMs: 3_000 })
          .catch(() => undefined)
        if (evaluation === undefined || evaluation.error !== undefined || !evaluation.hasValue || evaluation.value === '') {
          warnings.push(`page probe failed${evaluation?.error !== undefined ? `: ${evaluation.error}` : ''}`)
        } else {
          if (evaluation.truncated) warnings.push('page probe output was truncated')
          try {
            const probe: unknown = JSON.parse(evaluation.value)
            if (typeof probe === 'object' && probe !== null) {
              pageFields = probe as Record<string, LosslessJsonValue>
            } else {
              warnings.push('page probe returned unexpected data')
            }
          } catch {
            warnings.push('page probe returned unparseable data')
          }
        }
        const projection = projectExtract(
          spec,
          { index, matches: [], totalMatched: 0, totalNodes: index.size, resolvedNodes: 0 },
          pageFields,
        )
        last = {
          ok: true,
          kind: spec.kind,
          targetId: resolvedTarget,
          url,
          title,
          data: projection.data,
          count: projection.count,
          complete: projection.honesty.complete,
          missing: [...projection.honesty.missing],
          truncatedFields: [...projection.honesty.truncatedFields],
          warnings: [...warnings, ...projection.honesty.warnings],
          source: { nodes: projection.honesty.source.nodes, totalNodes: projection.honesty.source.totalNodes },
        }
        if (projection.honesty.complete || Date.now() >= deadline) break
        await sleep(LOCATOR_POLL_MS)
        continue
      }

      // kind: list | field — host candidates, then fresh measurement.
      let selectorIds: number[] | undefined
      if (spec.from?.selector !== undefined) {
        const found = await this.connection.send(
          'DOM.querySelectorAll',
          { nodeId: root.nodeId, selector: spec.from.selector },
          session.sessionId,
        ) as { nodeIds?: number[] }
        selectorIds = found.nodeIds ?? []
      }
      const hostMatches = matchExtractCandidates(index, spec, selectorIds).matches
      if (hostMatches.length === 0 && Date.now() < deadline) {
        await sleep(LOCATOR_POLL_MS)
        continue
      }
      const toResolve = hostMatches.slice(0, spec.limit)
      const resolved = new Map<string, ResolvedCandidate>()
      let resolvedNodes = 0
      const wantedAttributes: string[] = []
      for (const [, source] of extractFieldPairs(spec)) {
        if (source === 'href') wantedAttributes.push('href')
        else if (source.startsWith('attr:')) wantedAttributes.push(source.slice('attr:'.length))
      }
      const attributes = [...new Set(wantedAttributes)]
      for (const match of toResolve) {
        try {
          const evidence = await resolveRefOn(this.connection, session.sessionId, match.ref, root, {
            index,
            ...(attributes.length > 0 ? { attributes } : {}),
          })
          resolved.set(match.ref, { evidence: { ...evidence, targetId: resolvedTarget } })
          resolvedNodes += 1
        } catch (error) {
          resolved.set(match.ref, {
            resolveError: error instanceof RefStaleError
              ? error.message
              : `resolution failed (${error instanceof Error ? error.message : String(error)})`,
          })
        }
      }
      const projection = projectExtract(spec, {
        index,
        matches: toResolve,
        resolved,
        totalMatched: hostMatches.length,
        totalNodes: index.size,
        resolvedNodes,
      })
      last = {
        ok: true,
        kind: spec.kind,
        targetId: resolvedTarget,
        url,
        title,
        data: projection.data,
        count: projection.count,
        complete: projection.honesty.complete,
        missing: [...projection.honesty.missing],
        truncatedFields: [...projection.honesty.truncatedFields],
        warnings: [
          ...projection.honesty.warnings,
          ...(hostMatches.length === 0 && timeout > 0 ? [`waited ${String(timeout)}ms with no match`] : []),
        ],
        source: { nodes: projection.honesty.source.nodes, totalNodes: projection.honesty.source.totalNodes },
        ...(hostMatches.length > spec.limit ? { limitApplied: true } : {}),
      }
      break
    }

    if (last === undefined) {
      return { ok: false, error: 'cdp_extract: no result was produced' }
    }
    return last
  }

  /* plan11 §3.1 — cdp_captcha: one tool, three actions.
     - `scan`  (Katman A) — a page-side signature sweep + a deep-DOM probe per
       candidate (rect → scrollIntoView → FRESH re-measure → elementFromPoint),
       plus the overlay/trap inventories and a third-party verdict reported
       alongside the candidates.
     - `drag`  (Katman B) — a real Input.dispatchMouseEvent gesture built from a
       READ track geometry, with a K2 re-measure before the release and a
       read-back that decides `delivered` (K5 in-tool: a dispatched gesture
       proves nothing).
     - `verify` — the solution metric table T6 assembled by hand, in one call;
       a counter the page does not publish is OMITTED, never invented. */
  /**
   * Run one `cdp_captcha` action.
   * @param command - the parsed action + its parameters.
   * @returns the action's own envelope; `ok:false` carries a `reason`.
   */
  async captcha(command: CaptchaCommand): Promise<CaptchaScanOutcome | CaptchaDragOutcome | CaptchaVerifyOutcome> {
    if (command.action === 'scan') return await this.captchaScan(command)
    if (command.action === 'drag') return await this.captchaDrag(command)
    return await this.captchaVerify(command)
  }

  /** plan11: the `scan` action — classification + deep DOM + third-party verdict. */
  private async captchaScan(command: CaptchaCommand): Promise<CaptchaScanOutcome> {
    const budget = clampWaitTimeout(command.timeoutMs ?? 3_000)
    const deadline = Date.now() + budget
    const resolved = this.registry?.active()?.targetId ?? command.targetId ?? ''
    let last: CaptchaScanOutcome | undefined
    // Only a SUCCESSFUL-but-empty first-party scan is retryable; every other
    // branch is a final answer the caller should read.
    let retryable = false

    for (;;) {
      retryable = false
      const session = await this.getPageSession(command.targetId)
      const resolvedTarget = this.registry?.active()?.targetId ?? command.targetId ?? ''
      const evaluation = await session.evaluate(CAPTCHA_SCAN_EXPRESSION, { timeoutMs: 8_000 })
      if (!evaluation.hasValue || evaluation.value === '') {
        last = {
          ok: false,
          action: 'scan',
          found: 0,
          candidates: [],
          overlays: [],
          honeypots: [],
          thirdParty: thirdPartyVerdict([], ''),
          url: await session.url().catch(() => ''),
          targetId: resolvedTarget,
          warnings: [],
          reason: `cdp_captcha: the page-side scan produced no value (${evaluation.exception ?? evaluation.error?.kind ?? 'no value'})`,
        }
      } else {
        /* plan11-fix-scan-cap: a reply the evaluate layer CUT is not a smaller
           answer, it is an unparseable one — parsing it is what turned a page
           with a busy inline stylesheet into "scan reply is not JSON (… at
           position 16384)" and threw the whole scan away. The page-side script
           now budgets itself (see CAPTCHA_SCAN_BUDGET_*), and this is the host
           side of the same contract: say what happened and how to recover,
           never ship half a JSON object as a diagnosis. */
        if (evaluation.truncated) {
          last = {
            ok: false,
            action: 'scan',
            found: 0,
            candidates: [],
            overlays: [],
            honeypots: [],
            thirdParty: thirdPartyVerdict([], ''),
            url: '',
            targetId: resolvedTarget,
            warnings: ['the page-side scan reply was cut at the 16 KiB evaluate limit; the inventory it carried was incomplete'],
            reason: CAPTCHA_SCAN_BUDGET_REASON,
          }
        } else {
          const parsed = parseScanReply(evaluation.value)
          if (!parsed.ok) {
            last = {
              ok: false,
              action: 'scan',
              found: 0,
              candidates: [],
              overlays: [],
              honeypots: [],
              thirdParty: thirdPartyVerdict([], ''),
              url: parsed.url,
              targetId: resolvedTarget,
              warnings: [...parsed.warnings],
              reason: parsed.reason,
            }
          } else {
            const candidates = classifyCandidates(parsed.records)
            const overlays = classifyOverlays(parsed.overlays)
            const honeypots = classifyHoneypots(parsed.records)
            const thirdParty = thirdPartyVerdict(parsed.frames, parsed.host)
            const warnings = [...parsed.warnings]
            if (thirdParty.verdict === 'third-party-present') {
              warnings.push(`third-party provider present (${thirdParty.iframes.filter(frame => frame.origin === 'third-party').map(frame => frame.host ?? frame.src).join(', ')}) — reported alongside candidates`)
            }
            last = {
              action: 'scan',
              ok: true,
              found: candidates.length,
              candidates,
              overlays,
              honeypots,
              thirdParty,
              url: parsed.url,
              targetId: resolvedTarget,
              warnings,
              ...(candidates.length === 0
                ? { reason: 'cdp_captcha: no first-party verification candidate matched this page' }
                : {}),
              ...(thirdParty.reason !== undefined ? { reason: thirdParty.reason } : {}),
            }
            // An empty, first-party, SUCCESSFUL scan may still be a page that is
            // about to render its challenge — that is the one case worth waiting.
            retryable = candidates.length === 0 && thirdParty.verdict === 'first-party'
          }
        }
      }
      // A page that ALREADY answered is final: found>0, a third-party verdict,
      // or a hard failure (the page refused / threw). Only an empty but
      // SUCCESSFUL first-party scan is worth re-probing — a refusal retried
      // for the whole budget would just burn the caller's time.
      if (last === undefined) break
      if (!retryable) break
      if (Date.now() >= deadline) break
      await sleep(LOCATOR_POLL_MS)
    }
    void resolved
    return last ?? {
      ok: false,
      action: 'scan',
      found: 0,
      candidates: [],
      overlays: [],
      honeypots: [],
      thirdParty: thirdPartyVerdict([], ''),
      url: '',
      targetId: resolved,
      warnings: [],
      reason: 'cdp_captcha: the scan produced no result',
    }
  }

  /**
   * plan11: the `drag` action — real CDP press-move-release + a read-back gate.
   *
   * plan11-fix-drag-deliver: `delivered` is a TWO-condition verdict — the
   * read-back landed on the requested percent AND something observable changed
   * — and a gesture that travelled ≈0px is a refusal with its own reason, not
   * a success. `attempts` is always 1: a collapsed drag is re-measured, never
   * blindly replayed.
   */
  private async captchaDrag(command: CaptchaCommand): Promise<CaptchaDragOutcome> {
    const session = await this.getPageSession(command.targetId)
    const dragTarget = this.registry?.active()?.targetId ?? command.targetId ?? ''
    const url = await session.url().catch(() => '')
    const warnings: string[] = []
    const fail = (reason: string): CaptchaDragOutcome => ({
      ok: false,
      action: 'drag',
      delivered: false,
      startX: 0,
      startY: 0,
      targetX: 0,
      targetY: 0,
      finalValue: 0,
      expectedValue: 0,
      beforeValue: 0,
      matched: false,
      deltaMs: 0,
      attempts: 0,
      verifiedBy: 'none',
      stateDiffs: [],
      url,
      targetId: dragTarget,
      warnings,
      reason,
    })

    // The locator DSL decides WHICH slider; a ref/css/role+name answer supplies
    // the near box so a page with several tracks still addresses the right one.
    let near: { x: number, y: number, width: number, height: number } | undefined
    if (command.spec !== undefined) {
      const problem = validateLocatorSpec(command.spec)
      if (problem !== undefined) return fail(`cdp_captcha: ${problem}`)
      const resolution = await this.resolveForAction(command.spec, command.targetId, command.timeoutMs ?? 5_000)
      if (!resolution.ok) return fail(`cdp_captcha: the slider locator did not resolve: ${resolution.reason}`)
      near = { ...resolution.target.rect }
    } else if (typeof command.ref === 'string') {
      let evidence: RefEvidence
      try {
        evidence = await this.resolveRef(command.ref, command.targetId)
      } catch (error) {
        if (!(error instanceof RefStaleError)) throw error
        return fail(error.message)
      }
      if (evidence.frameLocal) {
        return fail('cdp_captcha: the ref resolves inside a frame — its rect is frame-local, not top-viewport (drag it with a css locator instead)')
      }
      near = { ...evidence.rect }
    }

    const hints = {
      ...(command.spec?.css !== undefined ? { trackSelector: command.spec.css } : {}),
      ...(command.thumbSelector !== undefined ? { thumbSelector: command.thumbSelector } : {}),
      ...(near !== undefined ? { near } : {}),
    }
    const measure = async (): Promise<{ geometry: SliderGeometry | null, declared?: number, reason?: string }> => {
      const evaluation = await session.evaluate(buildDragMeasureExpression(hints), { timeoutMs: 5_000 })
      if (!evaluation.hasValue || evaluation.value === '') {
        return { geometry: null, reason: 'cdp_captcha: the slider measurement produced no value' }
      }
      const geometry = parseDragMeasureReply(evaluation.value)
      if (geometry === null) {
        let reason = 'cdp_captcha: the slider geometry could not be read'
        try {
          const parsed = JSON.parse(evaluation.value) as { reason?: unknown }
          if (typeof parsed.reason === 'string' && parsed.reason !== '') reason = parsed.reason
        } catch { /* keep the default line */ }
        return { geometry: null, reason }
      }
      const declared = declaredTargetPct(evaluation.value)
      return { geometry, ...(declared !== undefined ? { declared } : {}) }
    }

    const first = await measure()
    if (first.geometry === null) return fail(first.reason ?? 'cdp_captcha: the slider geometry could not be read')
    // The inset is measured ONCE, here, while the thumb is still at rest, and
    // carried into the release point AND the read-back. Re-deriving it from a
    // thumb that has already travelled would make "where do I release" and
    // "what did it read back as" disagree — the exact failure T6 §3.4 hit.
    const inset = sliderInset(first.geometry)
    const before: SliderGeometry = { ...first.geometry, inset }

    const requested = clampTargetPct(command.targetPct) ?? first.declared
    if (requested === undefined) {
      return fail('cdp_captcha: no target percent — pass targetPct, or use a track that declares data-target / input[type=range][max]')
    }
    if (first.declared !== undefined && command.targetPct !== undefined
      && Math.abs(first.declared - requested) > 0.01) {
      warnings.push(`targetPct=${String(requested)} overrides the track's data-target=${String(first.declared)}`)
    }

    const plan = buildDragPlan(before, {
      targetPct: requested,
      steps: clampDragSteps(command.steps),
      approach: command.approach !== false,
      overshoot: command.overshoot !== false,
      seed: command.seed ?? DRAG_DEFAULT_SEED,
    })
    for (const line of plan.warnings) warnings.push(line)

    // K2: a FRESH re-measure right before the release. T6 §3.4 — a window
    // resize between plan and release moved the track and the first drag landed
    // on 74 instead of the declared 72.
    const retarget = async (): Promise<{ x: number, y: number } | null> => {
      const fresh = await measure()
      if (fresh.geometry === null) {
        warnings.push('pre-release re-measure failed — released at the planned coordinate')
        return null
      }
      const x = releaseXFor({ ...fresh.geometry, inset }, requested)
      const drifted = Math.abs(x - plan.target.x)
      if (drifted > 0.5) warnings.push(`track drifted ${String(Math.round(drifted))}px between plan and release — re-targeted from a fresh rect`)
      return { x, y: plan.start.y }
    }

    const inputAdapter = createInputConnectionAdapter(this.requireConnection())
    const dispatch = await dispatchDrag(inputAdapter, plan, {
      sessionId: session.sessionId,
      approach: command.approach !== false,
      now: () => Date.now(),
      random: seededSource(command.seed ?? DRAG_DEFAULT_SEED, 'dwell'),
      retarget,
    })
    if (dispatch.error !== undefined) warnings.push(`gesture reported: ${dispatch.error}`)
    /* plan11-fix-drag-time: a page that is not producing frames (a hidden or
       occluded tab) never acks a mouse MOVE — Chrome waits out a fixed 5s per
       sample, which is exactly the 71–156s this action used to take. The moves
       are dispatched in order regardless, so the gesture no longer waits for
       them; the un-acked count is reported so a caller reading the timing knows
       why the gesture was fast on a background tab. */
    if (dispatch.unackedMoves > 0) {
      warnings.push(`${String(dispatch.unackedMoves)} mouse-move acknowledgements were still outstanding at the release (the page is not compositing — hidden/occluded tab); the moves were dispatched in order and the gesture did not wait for them`)
    }

    // K5: the read-back is the verdict. "Dispatched" is not "landed".
    const after = await measure()
    if (after.geometry === null) {
      return {
        ok: false,
        action: 'drag',
        delivered: false,
        startX: plan.start.x,
        startY: plan.start.y,
        targetX: plan.target.x,
        targetY: plan.target.y,
        finalValue: 0,
        expectedValue: requested,
        beforeValue: thumbPercent(before),
        matched: false,
        verifiedBy: 'none',
        stateDiffs: [],
        deltaMs: dispatch.deltaMs,
        attempts: 1,
        url,
        targetId: dragTarget,
        warnings,
        reason: after.reason ?? 'cdp_captcha: the post-release read-back failed — the value could not be confirmed',
      }
    }
    const beforeValue = thumbPercent(before)
    // The SAME carried inset on the way back: the read-back compares like with like.
    const finalValue = thumbPercent({ ...after.geometry, inset })
    // AND the page's own state, read verbatim. A moved thumb alone is not
    // delivery: a live T7 run moved the thumb AND matched the target while the
    // page's `data-done` never advanced, because the `mouseup` never arrived.
    const diffs = stateDifferences(before.state, after.geometry.state)
    const verdict = judgeDrag(beforeValue, finalValue, requested, diffs)

    /* plan11-fix-drag-deliver: the delivery criterion is TWO conditions, and a
       gesture that moved nothing is neither of them.
       A live run: the thumb already sat at/near the requested release point, so
       the whole plan degenerated — press (464,301) → release (463,301), one
       pixel — while the plan still reported a full sample path. The read-back
       then showed the value unmoved, and the page's `data-done` happened to
       read 0→1 for its OWN reasons (the floor was already ~68, nothing to do
       with this gesture). The old gate accepted "something changed" and
       printed DELIVERED with `targetPct:20` never applied — a silent success,
       the most dangerous answer this tool can give. */
    const span = dispatchedSpanPx(dispatch.trace)
    // An incomplete gesture is a FAILED one, not a collapsed one: the press or
    // the release never went out, and its own error line already says so.
    const collapsed = span !== undefined && span <= DRAG_COLLAPSE_MAX_PX
    const delivered = verdict.delivered && !collapsed

    if (!verdict.matched) {
      // The requested target and the read-back are far apart: say both numbers
      // rather than leaving the caller to subtract them from the envelope.
      warnings.push(`value did not reach the requested target: asked for ${String(requested)}%, the thumb read back ${String(Math.round(finalValue * 100) / 100)}%`)
    }
    if (collapsed) {
      warnings.push(`the dispatched gesture travelled ${String(Math.round((span ?? 0) * 100) / 100)}px between press and release — the thumb was already at/near the requested point, so there was nothing to drag`)
    } else if (!verdict.delivered && verdict.verifiedBy === 'none') {
      warnings.push(`the value did not move (${String(Math.round(beforeValue))}% → ${String(Math.round(finalValue))}%) and the page published no completion-state change — the gesture did not land`)
    } else if (delivered && verdict.verifiedBy === 'value-moved') {
      warnings.push('delivered by thumb movement alone — this page published no completion-state change to confirm it, so treat `matched` as unverified')
    }

    /* `attempts` stays 1 and the gesture is never replayed: a collapsed drag is
       a measurement, not a transient — retrying the same 0px gesture blindly
       would only produce a second identical non-answer. */
    const reason = collapsed
      ? `cdp_captcha: gesture collapsed: the thumb was already at/near the target, no movement was dispatched (press → release travelled ${String(Math.round((span ?? 0) * 100) / 100)}px) — re-read the slider state with cdp_captcha({action:'verify'}) before asking for another drag`
      : delivered
        ? undefined
        : verdict.matched
          ? 'cdp_captcha: not delivered — the read-back landed on the target but neither the slider value nor the page state changed after the release'
          : `cdp_captcha: not delivered — the read-back stopped at ${String(Math.round(finalValue * 100) / 100)}% against a requested target of ${String(requested)}%`
    return {
      ok: delivered,
      action: 'drag',
      delivered,
      startX: plan.start.x,
      startY: plan.start.y,
      targetX: dispatch.trace[dispatch.trace.length - 1]?.x ?? plan.target.x,
      targetY: plan.start.y,
      finalValue: Math.round(finalValue * 100) / 100,
      expectedValue: requested,
      beforeValue: Math.round(beforeValue * 100) / 100,
      matched: verdict.matched,
      verifiedBy: verdict.verifiedBy,
      stateDiffs: verdict.stateDiffs,
      deltaMs: dispatch.deltaMs,
      attempts: 1,
      url,
      targetId: dragTarget,
      warnings,
      ...(reason !== undefined ? { reason } : {}),
    }
  }

  /** plan11: the `verify` action — solution state + the page's own counters. */
  private async captchaVerify(command: CaptchaCommand): Promise<CaptchaVerifyOutcome> {
    const session = await this.getPageSession(command.targetId)
    const resolved = this.registry?.active()?.targetId ?? command.targetId ?? ''
    const url = await session.url().catch(() => '')
    const evaluation = await session.evaluate(CAPTCHA_VERIFY_EXPRESSION, { timeoutMs: 5_000 })
    if (!evaluation.hasValue || evaluation.value === '') {
      return {
        ok: false,
        action: 'verify',
        solved: false,
        signals: { ariaChecked: [], dataSolved: [], dataConfirmed: [], sliders: [], badges: [], flags: [] },
        url,
        targetId: resolved,
        warnings: [],
        reason: `cdp_captcha: the page-side verify produced no value (${evaluation.exception ?? evaluation.error?.kind ?? 'no value'})`,
      }
    }
    const parsed = parseVerifyReply(evaluation.value)
    if (!parsed.ok) {
      return {
        ok: false,
        action: 'verify',
        solved: false,
        signals: { ariaChecked: [], dataSolved: [], dataConfirmed: [], sliders: [], badges: [], flags: [] },
        url,
        targetId: resolved,
        warnings: [],
        reason: parsed.reason,
      }
    }
    const read = collectSolutionSignals(parsed.record)
    return {
      ok: true,
      action: 'verify',
      solved: read.solved,
      signals: read.signals,
      ...(read.wrongClicks !== undefined ? { wrongClicks: read.wrongClicks } : {}),
      ...(read.decoyClicks !== undefined ? { decoyClicks: read.decoyClicks } : {}),
      ...(read.honeypotHit !== undefined ? { honeypotHit: read.honeypotHit } : {}),
      ...(read.solvedAt !== undefined ? { solvedAt: read.solvedAt } : {}),
      url,
      targetId: resolved,
      warnings: [...read.warnings],
    }
  }
}

/** plan08 §4.2: options for {@link CdpService.find}. */
export interface FindOptions {
  /** Target id (defaults to the active tab). */
  targetId?: string
  /** Exact woven reference from `cdp_snapshot`. */
  ref?: string
  /** CSS selector (scoped when `scope` is given). */
  selector?: string
  /** Exact aria-label / accessible-name match. */
  ariaLabel?: string
  /** Exact woven role match. */
  role?: string
  /** Accessible-name substring match (display-normalized, bidi-safe). */
  text?: string
  /** CSS selector limiting the search to one subtree. */
  scope?: string
  /** 0-based candidate index (default 0). */
  nth?: number
  /** Re-probe window while waiting for the element (0 = single probe). */
  timeoutMs?: number
}

/** plan08: the chosen candidate of a successful find — box measured NOW. */
export interface FindChosen {
  /** Woven reference (byte-identical to `cdp_snapshot`). */
  ref: string
  /** Woven role. */
  role: string
  /** Display-normalized accessible name (bidi controls hidden). */
  name: string
  /** Raw woven name exactly as the ref embeds it. */
  rawName: string
  /** Fresh viewport box (CSS pixels). */
  box: RefRect
  /** Whether the element occupies visible space. */
  visible: boolean
  /** Whether the box intersects the viewport. */
  inViewport: boolean
  /** True when the rect is frame-local (not top-viewport coordinates). */
  frameLocal: boolean
}

/** plan08: actionability of the chosen node at measurement time. */
export interface FindActionable {
  /** The node resolved — always true on a `chosen`-carrying answer. */
  connected: true
  /** Occupies visible space. */
  visible: boolean
  /** Intersects the viewport. */
  inViewport: boolean
  /** Not disabled. */
  enabled: boolean
  /** Topmost at the element centre (best-effort hit-test). */
  hitTarget: boolean
  /** What covers the centre instead; absent when the hit test passed. */
  coveredBy?: string
}

/** plan08: one listed candidate (fresh box, document order, ≤10 rows). */
export interface FindCandidateRow {
  /** Woven reference. */
  ref: string
  /** Woven role. */
  role: string
  /** Display-normalized accessible name. */
  name: string
  /** Fresh viewport box. */
  box: RefRect
  /** Whether it occupies visible space. */
  visible: boolean
}

/** plan08: find envelope — every branch carries ok/matched/targetId/url/warnings. */
export interface FindOutcome {
  /** True only when a chosen node was measured. */
  ok: boolean
  /** How many elements the query matched (0 on refusal). */
  matched: number
  /** Resolved tab the answer belongs to. */
  targetId: string
  /** Page URL at answer time (empty when no session was reachable). */
  url: string
  /** Honest caution lines (`nth shown`, `scope matched nothing`, …). */
  warnings: string[]
  /** Single-line failure detail when `ok` is false. */
  reason?: string
  /** Fresh measurement of the chosen candidate. */
  chosen?: FindChosen
  /** Actionability report for the chosen node. */
  actionable?: FindActionable
  /** Up to 10 fresh-measured candidates in document order. */
  candidates?: FindCandidateRow[]
}

/** plan14: options for {@link CdpService.locate}. */
export interface LocateOptions {
  /** Viewport CSS x of the point (the coordinate `cdp_click` would take). */
  x: number
  /** Viewport CSS y of the point. */
  y: number
  /** Target id (defaults to the active tab). */
  targetId?: string
}

/** plan14: locate envelope — every branch echoes the point it answered. */
export interface LocateOutcome {
  /** True only when a node was identified at the point. */
  ok: boolean
  /** The probed x, echoed so a render never leaves the aim implicit. */
  x: number
  /** The probed y. */
  y: number
  /** Resolved tab the answer belongs to. */
  targetId: string
  /** Page URL at probe time (empty when the probe could not run). */
  url: string
  /** Honest caution lines (off-viewport, covered, truncated probe). */
  warnings: string[]
  /** Single-line failure detail when `ok` is false. */
  reason?: string
  /** The identified node (present when `ok` is true). */
  node?: LocateNode
  /** Closest element to an empty point — the aim correction. */
  nearest?: LocateNearest
  /** Viewport size in CSS pixels at probe time. */
  viewport?: { width: number, height: number }
}

/** plan08 §4.3: options for {@link CdpService.extract}. */
export interface ExtractOptions {
  /** JSON projection spec string (`{"kind":"page|list|field",…}`). */
  spec: string
  /** Target id (defaults to the active tab). */
  targetId?: string
  /** Wait window for the slice to appear (0 = single probe). */
  timeoutMs?: number
}

/** plan11 §3.1: the one command shape `cdp_captcha` dispatches. */
export interface CaptchaCommand {
  /** Which of the three actions to run. */
  action: CaptchaAction
  /** Target id (defaults to the active tab). */
  targetId?: string
  /** Re-probe window; the action's own default applies when absent. */
  timeoutMs?: number
  /* ── action:'drag' only ── */
  /** Locator DSL spec addressing the slider (css / role+name / ariaLabel / text). */
  spec?: LocatorSpec
  /** Snapshot ref addressing the slider; mutually exclusive with `spec`. */
  ref?: string
  /** Explicit thumb selector inside the track (default: the first thumb-like child). */
  thumbSelector?: string
  /** Target percent `0..100`; read from `data-target` when absent. */
  targetPct?: number
  /** Press-move-release sample count (clamped 4..200). */
  steps?: number
  /** Emit the K4 approach path before the press (default true). */
  approach?: boolean
  /** Overshoot the target and pull back before releasing (default true). */
  overshoot?: boolean
  /** Deterministic seed for the path; the same seed always yields the same path. */
  seed?: string
}

/** plan11: the hosts reported as third-party by `scan`, re-exported for the tool text. */
export { CAPTCHA_PROVIDER_HOSTS }

/** plan08: extract envelope — ok:false carries `error`; ok:true carries data + honesty. */
export interface ExtractOutcome {
  /** True only when a projection ran (even if `data` ended up empty). */
  ok: boolean
  /** Projection shape that answered. */
  kind?: string
  /** Resolved tab the answer belongs to. */
  targetId?: string
  /** Page URL at answer time. */
  url?: string
  /** Document title at answer time. */
  title?: string
  /** Projected rows — ALWAYS an array on success (empty = honest none). */
  data?: ExtractRow[]
  /** Rows emitted after `limit`. */
  count?: number
  /** False whenever missing/truncatedFields/limit cut the answer. */
  complete?: boolean
  /** Why anything could not be answered. */
  missing?: string[]
  /** Row keys cut at the text limit. */
  truncatedFields?: string[]
  /** Extra caution lines (limit applied, visibleOnly removed …). */
  warnings?: string[]
  /** Where the data came from. */
  source?: { nodes: number, totalNodes: number }
  /** True when the spec's `limit` capped a larger match set. */
  limitApplied?: boolean
  /** Spec/validation failure detail when `ok` is false. */
  error?: string
}

// ---------------------------------------------------------------------------
// plan03: tab-lifecycle and scroll contracts, plus the small helpers the
// service methods above lean on. Types only — the runtime constants live here
// beside them.
// ---------------------------------------------------------------------------

/** plan03: hard cap on page tabs `cdp_tab_new` will open. */
const PLAN03_MAX_PAGES = 24

/** plan03: expression reading the live scroll box; JSON so one round trip suffices. */
const PLAN03_SCROLL_POSITION_EXPRESSION =
  'JSON.stringify({ sx: window.scrollX, sy: window.scrollY, '
  + 'mx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth), '
  + 'my: Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight), '
  + 'iw: window.innerWidth, ih: window.innerHeight, href: location.href })'

/** plan03: options for {@link CdpService.createTab}. */
export interface CdpTabCreateOptions {
  /** URL to open; defaults to `about:blank`. */
  readonly url?: string | undefined
  /** Activate the new tab after creating it; defaults to `true`. */
  readonly focus?: boolean | undefined
}

/** plan03: what {@link CdpService.createTab} reports back. */
export interface CdpTabCreateResult {
  /** Always `true` on success. */
  readonly ok: true
  /** The new tab's target id. */
  readonly targetId: string
  /** URL the browser reports for the new tab. */
  readonly url: string
  /** Title the browser reports (empty for `about:blank`). */
  readonly title: string
  /** Whether the new tab became the active one. */
  readonly focused: boolean
  /** The active target after the call; absent when none is active. */
  readonly activeTargetId?: string
  /** Total tracked targets. */
  readonly tabCount: number
  /** Tracked page tabs. */
  readonly pages: number
}

/** plan03: options for {@link CdpService.closeTab}. */
export interface CdpTabCloseOptions {
  /** Tab to close; defaults to the active tab. */
  readonly targetId?: string | undefined
  /** Permit closing the last remaining page tab. */
  readonly force?: boolean | undefined
  /** Required when the resolved id is the active tab and `targetId` was omitted. */
  readonly confirmActive?: boolean | undefined
}

/** plan03: what {@link CdpService.closeTab} reports back. */
export interface CdpTabCloseResult {
  /** Always `true` on success. */
  readonly ok: true
  /** The closed target id. */
  readonly closedTargetId: string
  /** Whether the closed tab was the active one. */
  readonly wasActive: boolean
  /** Page tabs left after the close. */
  readonly remainingPages: number
  /** The tab that became active; absent when no pages remain. */
  readonly activeTargetId?: string
  /** The browser's own `Target.closeTarget` `success` flag. */
  readonly browserClosed: boolean
}

/** plan03: what {@link CdpService.focusTab} reports back. */
export interface CdpTabFocusResult {
  /** Always `true` on success. */
  readonly ok: true
  /** The focused target id. */
  readonly targetId: string
  /** The previously active target; absent when there was none or it is unchanged. */
  readonly previousTargetId?: string
  /** URL the browser reports for the focused tab. */
  readonly url: string
  /** Title the browser reports for the focused tab. */
  readonly title: string
  /** Whether `Target.activateTarget` was sent to the browser. */
  readonly activated: boolean
  /** Tracked page tabs. */
  readonly pageCount: number
}

/** plan03: how a scroll request is carried out. */
export type CdpScrollMode = 'wheel' | 'pagedown' | 'pageup' | 'top' | 'bottom' | 'anchor' | 'selector'

/** plan03: options for {@link CdpService.scroll}. */
export interface CdpScrollRequest {
  /** Scroll strategy; defaults to `wheel`. */
  readonly mode?: CdpScrollMode | undefined
  /** Horizontal wheel delta in CSS pixels (wheel mode). */
  readonly deltaX?: number | undefined
  /** Vertical wheel delta in CSS pixels; positive scrolls down (wheel mode). */
  readonly deltaY?: number | undefined
  /** Pointer X for wheel dispatch; defaults to the viewport centre. */
  readonly x?: number | undefined
  /** Pointer Y for wheel dispatch; defaults to the viewport centre. */
  readonly y?: number | undefined
  /** CSS selector to scroll into view (`mode: 'selector'`). */
  readonly selector?: string | undefined
  /** Element id or name to jump to (`mode: 'anchor'`). */
  readonly anchor?: string | undefined
  /** Use `behavior: 'smooth'` for anchor/selector/top/bottom jumps. */
  readonly smooth?: boolean | undefined
  /** Repeat the unit 1–20 times (wheel and paging modes). */
  readonly repetitions?: number | undefined
  /** Wait 0–2000 ms after the action before reading the final position. */
  readonly settleMs?: number | undefined
  /** Target id; defaults to the resolution policy of `getPageSession`. */
  readonly targetId?: string | undefined
}

/** plan03: one verified scroll box, read after (and before) the action. */
export interface CdpScrollPosition {
  /** `window.scrollX`. */
  readonly scrollX: number
  /** `window.scrollY`. */
  readonly scrollY: number
  /** Horizontal scroll extent. */
  readonly maxScrollX: number
  /** Vertical scroll extent. */
  readonly maxScrollY: number
  /** `window.innerWidth`. */
  readonly innerWidth: number
  /** `window.innerHeight`. */
  readonly innerHeight: number
  /** `location.href` at read time. */
  readonly href: string
}

/** plan03: what {@link CdpService.scroll} reports back. */
export interface CdpScrollReport {
  /** Always `true` on success. */
  readonly ok: true
  /** The strategy that ran. */
  readonly mode: CdpScrollMode
  /** The target the scroll actually resolved to. */
  readonly targetId: string
  /** URL at read time. */
  readonly url: string
  /** Wheel steps or key presses dispatched. */
  readonly steps: number
  /** Wheel delta actually dispatched (bounds may cut it). */
  readonly deltaX: number
  /** Wheel delta actually dispatched (bounds may cut it). */
  readonly deltaY: number
  /** `window.scrollX` after the scroll. */
  readonly scrollX: number
  /** `window.scrollY` after the scroll. */
  readonly scrollY: number
  /** Horizontal scroll extent after the scroll. */
  readonly maxScrollX: number
  /** Vertical scroll extent after the scroll. */
  readonly maxScrollY: number
  /** Whether the window sits at the top. */
  readonly atTop: boolean
  /** Whether the window sits at the bottom. */
  readonly atBottom: boolean
  /** How the target was proven by `getPageSession`. */
  readonly resolvedBy: CdpResolutionVia
  /** Whether an anchor/selector was found; absent for the other modes. */
  readonly found?: boolean
  /** An advisory when the action reported success but the window did not move. */
  readonly note?: string
}

/** plan03: clamp a numeric request field into its documented range. */
function plan03Clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/** plan03: `mode: 'anchor'` expression — id, then `[name=…]`, reporting found. */
function plan03AnchorExpression(anchor: string, behavior: 'auto' | 'smooth'): string {
  const nameSelector = `[name=${JSON.stringify(anchor)}]`
  return `(() => { const el = document.getElementById(${JSON.stringify(anchor)})`
    + ` || document.querySelector(${JSON.stringify(nameSelector)});`
    + ' if (!el) return JSON.stringify({ found: false });'
    + ` el.scrollIntoView({ behavior: ${JSON.stringify(behavior)}, block: 'start' });`
    + ' return JSON.stringify({ found: true }); })()'
}

/** plan03: `mode: 'selector'` expression — main-document query, centred block. */
function plan03SelectorExpression(selector: string, behavior: 'auto' | 'smooth'): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)});`
    + ' if (!el) return JSON.stringify({ found: false });'
    + ` el.scrollIntoView({ behavior: ${JSON.stringify(behavior)}, block: 'center' });`
    + ' return JSON.stringify({ found: true }); })()'
}

/** plan03: read `{found}` out of an anchor/selector expression reply. */
function plan03ParseFound(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { found?: unknown }
    return parsed.found === true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// plan05: dialog + upload contracts (types only; the methods live in the
// class above).
// ---------------------------------------------------------------------------

/** plan05: fields every `cdp_dialog` report carries, success or failure. */
export interface CdpDialogSnapshot {
  /** Resolved target the report is anchored to; empty when none resolved. */
  readonly targetId: string
  /** Pending dialogs across ALL live tabs, each carrying its own target. */
  readonly pending: DialogBrief[]
  /** The resolved tab's recent-dialog ring (answered or not), oldest first. */
  readonly recent: DialogBrief[]
  /** The resolved tab's auto-answer policy. */
  readonly policy: 'none' | 'accept' | 'dismiss'
}

/** plan05: options for {@link CdpService.dialog}. */
export interface CdpDialogOptions {
  /** `list` (default), `accept`, `dismiss`, or `policy`. */
  readonly action?: 'list' | 'accept' | 'dismiss' | 'policy' | undefined
  /** Target whose dialog to answer (required when several tabs are pending). */
  readonly targetId?: string | undefined
  /** Explicit reply for an accepted `prompt` dialog. */
  readonly promptText?: string | undefined
  /** Replacement policy for `action: 'policy'`. */
  readonly policy?: DialogPolicy | undefined
}

/** plan05: what {@link CdpService.dialog} reports back. */
export interface CdpDialogResult extends CdpDialogSnapshot {
  /** True on success; a failure carries `error` with a stable code. */
  readonly ok: boolean
  /** What an accept/dismiss actually did; absent for list/policy reports. */
  readonly answered?: { readonly action: 'accepted' | 'dismissed'; readonly promptText?: string }
  /** Failure code + teaching message; absent on success. */
  readonly error?: { readonly code: string; readonly message: string }
}

/** plan05: options for {@link CdpService.upload}. */
export interface CdpUploadOptions {
  /** Absolute host paths to bind (validated against the upload policy). */
  readonly files?: readonly string[] | undefined
  /** CSS selector of the file input (set mode). */
  readonly selector?: string | undefined
  /** Target id; defaults to the resolution policy of `getPageSession`. */
  readonly targetId?: string | undefined
  /** Wait for an open file chooser instead of selecting by selector. */
  readonly chooser?: boolean | undefined
  /** Chooser wait budget in milliseconds (bounded 500–30000). */
  readonly timeoutMs?: number | undefined
}

/** plan05: what {@link CdpService.upload} reports back. */
export interface CdpUploadResult {
  /** True on success; a failure carries `error` with a stable code. */
  readonly ok: boolean
  /** Resolved target the bind ran against. */
  readonly targetId: string
  /** `set` (selector path) or `chooser` (open file chooser path). */
  readonly mode: 'set' | 'chooser'
  /** Validated files that were handed over (empty when validation failed early). */
  readonly files: UploadFileBrief[]
  /** Whether the locator matched (0 or 1). */
  readonly matched: number
  /** True only when files were bound AND the read-back confirmed them. */
  readonly bound: boolean
  /** Live DOM evidence (tag/accept/multiple/fileList); present on success. */
  readonly input?: UploadInputInfo
  /** Failure code + teaching message; absent on success. */
  readonly error?: { readonly code: string; readonly message: string }
}
