/**
 * @deepseek-ai/dsh-cdp — the CDP bundle's runtime glue plugin. It owns the
 * Chrome DevTools Protocol browser-control extension: the
 * `GET /api/server/cdp/status` route and the `cdp_*` model tools,
 * the REST routes mounted on `webServer`, the `CdpService` instance,
 * and the `app:cdp-status` prompt section. The browser pane is the `ui-cdp-view` row in
 * this bundle's patch. The protocol client, tab lifecycle, input engine, proxy
 * listener, and guide web mount behind these same two rows. The standalone
 * `registerCdpStatusRoute`/`registerCdpStatusTool` pair in `./status.ts` is
 * deliberately NOT mounted: the live route/tool come from `registerCdpRoutes`
 * and `registerCdpTools`, so registering the same names twice would collide.
 * @module @deepseek-ai/dsh-cdp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { CdpService } from './service.ts'
import { registerCdpRoutes } from './routes.ts'
import { registerCdpTools } from './tools.ts'
// plan09: the bundled skill provider registers on ctx.skills when the profile mounts that registry.
import type {} from '@deepseek-ai/dsh-skill'
import { createCdpSkillProvider } from './skill.ts'

/** Stable Cordis plugin name. */
export const name = 'cdp'

/** Services required before the CDP bridge can mount. */
export const inject = ['webServer']

/** Plugin config: composed deployment settings for the CDP extension. */
export interface Config {
  /**
   * TCP port of the browser's remote-debugging endpoint
   * (`--remote-debugging-port`). The connection phase attaches to it.
   * @default 9222
   */
  remoteDebuggingPort?: number
  /**
   * TCP port the extension's HTTP proxy listener binds on loopback. A port
   * equal to the resolved `remoteDebuggingPort` is refused at load, because
   * the proxy can never share the browser's debugging endpoint.
   * @default 9333
   */
  proxyListenPort?: number
  /**
   * Directory holding the guide web the `cdp_guide` tools read. Empty resolves
   * the bundle's own published `assets/` directory. The guide web lands in a
   * later phase; the field is validated but not yet read.
   * @default ''
   */
  guideAssetsDir?: string
  /**
   * plan10: downloads root for `cdp_download`, `cdp_printpdf`, `cdp_readpdf`,
   * and `cdp_files`. Empty resolves `<cwd>/.dsh/cdp-downloads`. Every path
   * these tools see is confined to it.
   * @default ''
   */
  downloadsDir?: string
  /**
   * plan10: hard byte cap for `cdp_readpdf` inputs.
   * @default 67108864 (64 MiB)
   */
  maxPdfBytes?: number
  /**
   * plan05: extra absolute roots `cdp_upload` may bind files from, on top of
   * the built-in roots (working directory and the downloads dir).
   * @default []
   */
  uploadRoots?: string[]
  /**
   * plan05: skip the `cdp_upload` root allow-list entirely. True trades the
   * path sandbox for convenience.
   * @default false
   */
  allowAnyPath?: boolean
  /**
   * plan04: loopback debug ports `cdp_endpoints` / `GET …/cdp/endpoints`
   * probes by default (the probe itself always targets 127.0.0.1).
   * @default [9222, 9225, 9333, 9444]
   */
  discoveryPorts?: number[]
}

/** Default remote-debugging port a launched Chromium opens. */
export const DEFAULT_REMOTE_DEBUGGING_PORT = 9222

/** Default loopback port for the extension's HTTP proxy listener. */
export const DEFAULT_PROXY_LISTEN_PORT = 9333

export const Config: z<Config> = z.object({
  remoteDebuggingPort: z.number().step(1).min(1).max(65535).default(DEFAULT_REMOTE_DEBUGGING_PORT),
  proxyListenPort: z.number().step(1).min(1).max(65535).default(DEFAULT_PROXY_LISTEN_PORT),
  guideAssetsDir: z.string().default(''),
  // plan10: defaults surface here (status.spec "deployment defaults" asserts
  // them); the service applies its own fallbacks if these ever go missing.
  downloadsDir: z.string().default(''),
  maxPdfBytes: z.number().step(1).min(1024).max(1073741824).default(67108864),
  // plan05: upload path policy; the service adds cwd + downloads-dir defaults.
  uploadRoots: z.array(z.string()).default([]),
  allowAnyPath: z.boolean().default(true),
  // plan04: discovery probe ports for cdp_endpoints (all loopback by design).
  discoveryPorts: z.array(z.number().step(1).min(1).max(65535)).default([9222, 9225, 9333, 9444]),
})

/** Model-visible orientation for the CDP extension. */
function cdpStatusPrompt(): string {
  return 'DSH CDP Guidance:\n'
    // plan09-fix: this read "the `cdp_*` tools (36 in total, plus `net_capture`/`net_export`)"
    // and counted the net tools twice — tools.ts registers 36 tools in all, of
    // which 34 are `cdp_*` and 2 are the net pair. Naming a count that drifts
    // out of date is worse than naming none, so the sentence states the split.
    + '- The CDP extension drives Chromium-based browsers over the Chrome DevTools Protocol: 36 tools in all — 34 `cdp_*` plus `net_capture` and `net_export`.\n'
    + '- Call `cdp_status` for the installed version, the live target count, and the proxy state; the CDP tab in the right sidebar shows the same state.\n'
    + '- `cdp_exec` runs page code with a guaranteed error envelope and optional post-condition; prefer it over `cdp_eval` when the outcome must be verified.\n'
    + '- A browser endpoint is only reachable while it was launched with remote debugging enabled; `cdp_endpoints` discovers loopback debugging ports and `cdp_contexts` lists targets.\n'
    // plan13-profile: the choice gate is a NEW cdp_open return shape; a model
    // that ignores `needsChoice` would sit waiting for a browser that was
    // deliberately not opened.
    + '- A bare `cdp_open` scans the default debug ports first: if it answers `needsChoice:true`, NOTHING was opened — ask the user which endpoint to use (the table names the port, its profile, and whether it is theirs or yours), then call `cdp_open` again with `switchTo` or `endpoint`.\n'
    + '- `cdp_open({profile:"assistant"})` launches on the persistent signed-in profile under `$DSH_HOME/profiles/assistant`; the login survives restarts. It refuses rather than falling back to a throwaway profile when another browser already holds it.\n'
    // plan02: navigation/readiness discipline — cdp_navigate returns before the DOM is ready (K9).
    + '- After `cdp_navigate`, wait for readiness with `cdp_wait` (selector/visible/text/network-idle/navigation strategies) before evaluating or clicking.\n'
    // plan02: human-like input + locator DSL.
    + '- Prefer the locator DSL (`mode: "locator"`) on `cdp_click`/`cdp_fill` over raw coordinates; `cdp_fill` writes values with native setters + change/input events and verifies the result (K1-K9 in the skill guide).\n'
    // plan08: snapshots carry stable refs for follow-up reads.
    // plan09-fix: this cited `cdp_read`, which is not a tool in this bundle — a
    // name the model cannot call. The refs feed cdp_snapshot itself, the
    // ref-taking tools, and the discovery pair that replaces the dead one.
    + '- `cdp_snapshot` returns stable element refs; keep them fresh for `cdp_snapshot`/`cdp_click`/`cdp_type`, and use `cdp_find`/`cdp_extract` for query + field projection over a page.\n'
    // plan05: dialogs are modal — cdp_dialog must answer before the page advances.
    + '- `cdp_dialog` answers beforeunload/alert/confirm/prompt events, `cdp_upload` sets file inputs under an explicit path policy.\n'
    // plan07: detection posture.
    + '- `cdp_stealth` applies a coherent detection-avoidance profile (UA/UA-CH, noise, extras) and `cdp_fingerprint` reports what a site sees plus a why-blocked classification; it hardens the client\'s reported surface.\n'
    // plan11: the verification-challenge tool — detect → drive → read, in one contract.
    + '- `cdp_captcha` detects a verification challenge (scan: classified candidates with deep-DOM hit-tests, overlays, honeypots, a third-party verdict reported alongside the candidates), drives a slider with a real press-move-release (drag: reads the track, re-measures before release, and PROVES delivery by reading the value back), and reads the solution state plus the page own wrongClick/decoy counters (verify).\n'
    // plan06: capture/reporting.
    + '- `cdp_screenshot`/`cdp_viewport`/`cdp_printpdf`/`cdp_download` cover capture, media and file outcomes; `cdp_tabs` family manages targets; `cdp_text`/`cdp_expect` assert page state in-band.\n'
    // plan14: the visual loop — DOM analysis failed? look at the picture, then
    // ask what is at the point BEFORE clicking. Look and act stay separate.
    + '- DOM analysis could not solve it? Do not write a script — look at the picture: `cdp_screenshot` → the model names a point → `cdp_locate` (DOM\'da ne olduğunu sormak için `cdp_locate`; görsel akış: `cdp_screenshot` → model → `cdp_locate` → `cdp_click`) proves what is there → `cdp_click({x,y})` acts. An empty point answers `ok:false` + `nearest`, so a wrong aim is corrected, not clicked.\n'
}

/** Mount the CDP service, REST routes, model tools, and the prompt section. */
// plan04-fix2: returns the capture-proxy startup promise (NOT `async` — the
// validation below must keep THROWING synchronously; Cordis awaits the result
// as startup work, so `await apply(...)` sees the settled proxy state).
export function apply(ctx: Context, config: Config): Promise<void> {
  const remoteDebuggingPort = config.remoteDebuggingPort ?? DEFAULT_REMOTE_DEBUGGING_PORT
  const proxyListenPort = config.proxyListenPort ?? DEFAULT_PROXY_LISTEN_PORT
  // Misconfiguration fails loud at load: a proxy listener on the browser's
  // debugging port can never bind, and both values are known here.
  if (proxyListenPort === remoteDebuggingPort) {
    throw new Error('cdp: proxyListenPort must differ from remoteDebuggingPort')
  }

  // plan10: downloads root + PDF byte cap flow into the service; omitted → defaults.
  const service = new CdpService({
    ...(config.downloadsDir !== undefined ? { downloadsDir: config.downloadsDir } : {}),
    ...(config.maxPdfBytes !== undefined ? { maxPdfBytes: config.maxPdfBytes } : {}),
    // plan04: endpoint discovery ports; omitted → the service's built-in set.
    ...(config.discoveryPorts !== undefined ? { discoveryPorts: config.discoveryPorts } : {}),
    // plan04-FAZ7: this is the reader Config.proxyListenPort never had — the
    // capture proxy binds it at load (and net_capture/net_export re-fire it).
    ...(config.proxyListenPort !== undefined ? { proxyListenPort: config.proxyListenPort } : {}),
  })

  // plan04-FAZ7: start the capture proxy on the configured port (plan04-fix2:
  // an idle-port scan inside ensureProxy skips a busy default). Never fatal —
  // ensureProxy answers {active:false} instead of throwing, the net tools
  // surface an honest ok:false + reason, and first use retries the bind. The
  // promise is returned so callers (and Cordis) await the settled state.
  const proxyReady = service.ensureProxy()

  // plan05: upload path policy (extra roots + escape hatch) reaches the service.
  service.setUploadPolicy({
    ...(config.uploadRoots !== undefined ? { roots: config.uploadRoots } : {}),
    ...(config.allowAnyPath !== undefined ? { allowAnyPath: config.allowAnyPath } : {}),
  })

  // Register teardown on plugin context disposal.
  ctx.effect(() => () => {
    void service.stop()
  }, 'cdp: service teardown')

  // Register HTTP REST routes on webServer.
  registerCdpRoutes(ctx, service)

  // Register model-facing tools on tools service.
  registerCdpTools(ctx, service)

  // plan09: the skill registry belongs to profiles that mount it; the bundle
  // mounts on the webServer alone, so registration waits here instead of
  // holding the whole plugin back (deamon's shellbox pattern). This is also
  // the first read of guideAssetsDir: empty resolves the published assets/.
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.registerProvider(() => createCdpSkillProvider(
      config.guideAssetsDir,
      (message) => skillCtx.logger.warn(message),
    ))
  })

  // Prompt section waits for systemPrompt registry.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'app:cdp-status',
      order: promptCtx.systemPrompt.getSectionOrder('WEB_SURFACE') + 7,
      text: () => cdpStatusPrompt(),
    }), 'cdp: app:cdp-status section')
  })

  // plan04-fix2: resolve only once the capture-proxy startup settled — every
  // registration above already ran synchronously, so un-awaited callers lose
  // nothing but the timing guarantee of `proxy.active`.
  return proxyReady.then(() => undefined)
}

// Re-export core modules and types for bundle consumers.
export {
  CdpService,
  createTargetConnectionAdapter,
  createPageConnectionAdapter,
  createInputConnectionAdapter,
  type CdpOpenOptions,
  /* plan05: dialog + upload service contracts. */
  type CdpDialogOptions,
  type CdpDialogResult,
  type CdpDialogSnapshot,
  type CdpUploadOptions,
  type CdpUploadResult,
} from './service.ts'

/* plan05: dialog primitives and the upload path policy / DOM binding. */
export {
  CdpDialogOpenError,
  DIALOG_GUARDED_TOOLS,
  briefDialog,
  dialogDenialReason,
  isDialogGuardedTool,
  normalizeDialogType,
  quoteDialogText,
  sanitizeDialogText,
  MAX_DIALOG_HISTORY,
  MAX_DIALOG_MESSAGE_CHARS,
  MAX_DIALOG_PROMPT_CHARS,
  MAX_DIALOG_URL_CHARS,
  type DialogAnswer,
  type DialogBrief,
  type DialogPolicy,
  type DialogRecord,
  type DialogType,
} from './dialog.ts'

export {
  DEFAULT_MAX_UPLOAD_FILES,
  bindFileInput,
  bindFilePickerFiles,
  readAttribute,
  validateUploadPath,
  type UploadBindCode,
  type UploadBindOutcome,
  type UploadFileBrief,
  type UploadInputInfo,
  type UploadPathCode,
  type UploadPathOutcome,
  type UploadPolicy,
  type UploadSender,
} from './upload.ts'

export {
  CdpConnection,
  CdpError,
  CdpConnectionClosedError,
  CdpTimeoutError as CdpConnectionTimeoutError,
  CDP_CONNECTED_EVENT,
  CDP_DISCONNECTED_EVENT,
  type CdpEvent,
  type CdpEventListener,
  type CdpConnectionOptions,
} from './connection.ts'

export {
  TargetRegistry,
  CdpTargetError,
  type TargetInfo,
  type TargetConnection,
} from './targets.ts'

export {
  PageSession,
  CdpPageError,
  CdpSessionClosedError,
  CdpTimeoutError as CdpPageTimeoutError,
  MAX_EVALUATE_CHARS,
  type EvaluationError,
  type NavigationOutcome,
  type PageEvaluation,
  type PageConnection,
} from './page.ts'

/* plan01: the pure error-envelope module behind cdp_exec / cdp_eval. */
export {
  DEFAULT_EXEC_TIMEOUT_MS,
  MIN_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  MAX_POST_CONDITION_CHARS,
  buildExecOutcome,
  buildEvalOutcome,
  buildEvalFailureOutcome,
  classifyCdpError,
  isInfrastructureError,
  clampTimeout,
  postConditionExpression,
  renderExecText,
  renderEvalFailure,
  hiddenEnvelopeValue, /* plan15-hidden */
  readPageActivity, /* plan15-hidden */
  PAGE_ACTIVITY_EXPRESSION, /* plan15-hidden */
  UNVERIFIED_ACTIVITY, /* plan15-hidden */
  type ExecError,
  type ExecErrorKind,
  type ExecOptions,
  type ExecOutcome,
  type ExecPostCondition,
  type EvalOutcome,
  type PageActivityProbe,
  type PageHiddenState,
} from './exec.ts'

export {
  weaveSnapshot,
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_TEXT_LENGTH,
  DEFAULT_MAX_BYTES,
  type CdpSnapshot,
  type CdpSnapshotInput,
  type CdpSnapshotLimits,
  type CdpWovenNode,
  type CdpWovenCounts,
  type CdpWovenBox,
  type CdpDomNode,
  type CdpViewport,
} from './snapshot.ts'

export {
  launchBrowser,
  CdpBrowserNotFoundError,
  CdpBrowserSpawnError,
  CdpBrowserPortTimeoutError,
  type LaunchedBrowser,
  type BrowserLaunchOptions,
} from './launch.ts'

export {
  HumanInput,
  CdpInputError,
  keyDefinition,
  characterKeyDefinition,
  KEY_DEFINITIONS,
  MODIFIER_BITS,
  DEFAULT_INPUT_BOUNDS,
  type Point,
  type MoveOptions,
  type ClickOptions,
  type ScrollDelta,
  type ScrollOutcome,
  type TextEntryOutcome,
  type KeyOutcome,
  type HumanInputOptions,
} from './input.ts'

export {
  stealthScript,
  STEALTH_PATCH_NAMES,
  STEALTH_PATCH_MARKER_PREFIX,
  type StealthOptions,
  type StealthPatchName,
} from './stealth.ts'

export {
  CaptureStore,
  classifyCaptureBody,
  parseCaptureJson,
  extractCaptureQuery,
  groupCaptureByHost,
  findDuplicateCaptureRequests,
  buildCaptureTimeline,
  CAPTURE_REDACTED_MARKER,
  DEFAULT_CAPTURE_REDACTION,
  type CapturedExchange,
  type CapturedRequest,
  type CapturedResponse,
  type CaptureBody,
  type CaptureHeader,
  type CaptureLimits,
  type CaptureRedactionPolicy,
  type CaptureStoreOptions,
  type CaptureJsonParse,
  type CaptureHostGroup,
  type CaptureDuplicateGroup,
  type CaptureTimelineEntry,
} from './net/capture.ts'

export {
  CDP_STATUS_PATH,
  readCdpStatus,
  registerCdpStatusRoute,
  registerCdpStatusTool,
  CDP_STATUS_DESCRIPTION,
  CDP_STATUS_OUTPUT_SCHEMA,
  renderCdpStatus,
  type CdpStatusSurface,
} from './status.ts'

export {
  registerCdpRoutes,
  CDP_STATUS_ROUTE,
  CDP_OPEN_ROUTE,
  CDP_NAVIGATE_ROUTE,
  CDP_TABS_ROUTE,
  CDP_SNAPSHOT_ROUTE,
  CDP_EVAL_ROUTE,
  CDP_EXEC_ROUTE, /* plan01 */
  CDP_CLOSE_ROUTE,
  CDP_SCREENSHOT_ROUTE, /* plan06 */
  CDP_VIEWPORT_ROUTE, /* plan06 */
  CDP_ENDPOINTS_ROUTE, /* plan04 */
  CDP_CONNECTIONS_ROUTE, /* plan04 */
  CDP_CONTEXTS_ROUTE, /* plan04 */
  CDP_DISCONNECT_ROUTE, /* plan04 */
  CDP_REF_ROUTE, /* plan08 */
} from './routes.ts'

export { registerCdpTools } from './tools.ts'
/* plan06: screenshot capture core, live viewport probing, and the PNG annotator. */
export {
  ScreenshotCapture,
  probeViewport,
  normalizeScreenshotRequest,
  readImageSize,
  buildLegend,
  writeArtifact,
  resolveArtifactPath,
  defaultArtifactPath,
  errorEnvelope,
  MAX_SCREENSHOT_INLINE_BYTES,
  MAX_SCREENSHOT_BYTES,
  DEFAULT_INLINE_MAX_BYTES,
  MAX_SCREENSHOT_RECTS,
  VIEWPORT_CACHE_MS,
  UNAVAILABLE_VIEWPORT,
  parseResizeProbeAnswer, /* plan15-viewport */
  renderViewportOutcomeText, /* plan15-viewport */
  resizeNotDeliveredReason, /* plan15-viewport */
  RESIZE_PROBE_ARM_EXPRESSION, /* plan15-viewport */
  RESIZE_PROBE_READ_EXPRESSION, /* plan15-viewport */
  CdpScreenshotError,
  CdpScreenshotSelectorError,
  CdpScreenshotWriteError,
  CdpScreenshotTooLargeError,
  CdpViewportError,
  type ScreenshotRequest,
  type ScreenshotResult,
  type ScreenshotClip,
  type ViewportObservation,
  type ViewportApplyArgs,
  type ViewportApplyOutcome,
  type ViewportApplySuccess,
  type ViewportApplyFailure,
  type ViewportMetrics,
  type ViewportResizeProbe,
  type ResizeDelivery,
  type ResizeProbeReading,
  type ImageRect,
  type LegendEntry,
  type CaptureContext,
  type CdpMethodSender,
  type CdpErrorEnvelope,
} from './capture.ts'
export {
  annotatePng,
  type PngRect,
} from './png.ts'
export {
  AdapterRegistry,
  DEFAULT_HTML_ADAPTER,
  GITHUB_ADAPTER,
  WIKIPEDIA_ADAPTER,
  HACKER_NEWS_ADAPTER,
  type SiteAdapter,
  type AdapterSelectors,
} from './adapters.ts'
export {
  CertificateAuthority,
  type CaOptions,
  type LeafCertificate,
} from './net/ca.ts'

export {
  CdpProxy,
  type CdpProxyOptions,
} from './net/proxy.ts'

export type {
  CdpStatusResponse,
  CdpProxyStatus,
  CdpViewportStatus, /* plan06 */
  CdpStatusDetail,
  CdpConnectionState,
  CdpTabBrief,
  CdpConnectionBrief, /* plan04 */
} from './types.ts' /* plan01 */

/* plan02 wave 1: the shared locator DSL, actionability report, and expect checks. */
export {
  EXPECT_CHECKS,
  HIT_INFO_SCHEMA,
  LOCATOR_ACTIONABILITY_SCHEMA,
  LOCATOR_CANDIDATE_SCHEMA,
  LOCATOR_CANDIDATES_SCHEMA,
  LOCATOR_DEFAULT_MAX_CHARS,
  LOCATOR_EVAL_TIMEOUT_MS,
  LOCATOR_MAX_CHARS,
  LOCATOR_MAX_WAIT_MS,
  LOCATOR_POLL_MS,
  LOCATOR_RECT_SCHEMA,
  LOCATOR_TARGET_SCHEMA,
  buildFocusExpression,
  buildLocatorExpression,
  buildPointExpression,
  clampMaxChars,
  clampWaitTimeout,
  evaluateExpect,
  evaluateText,
  asLocatorReply,
  locatorPageCore,
  locatorSpecFromArgs,
  normalizeText,
  parseEvidenceReply,
  parseLocatorReply,
  renderCdpExpect,
  renderCdpText,
  validateExpectOptions,
  validateLocatorSpec,
  type ActionabilityReport,
  type ActionResolveFailure,
  type ActionResolution,
  type ActionResolveSuccess,
  type EvidenceReply,
  type ExpectCheck,
  type ExpectOptions,
  type ExpectOutcome,
  type ExpectRenderInput,
  type ExpectVerdict,
  type FocusEvidence,
  type HitInfo,
  type LocatorArgs,
  type LocatorCandidate,
  type LocatorRect,
  type LocatorReply,
  type LocatorRun,
  type LocatorSpec,
  type PointEvidence,
  type ReadTextOptions,
  type ResolvedTarget,
  type TextMatchMode,
  type TextOutcome,
  type TextRenderInput,
  type TextVerdict,
} from './locator.ts'

/* plan02 wave 2: framework-safe fill (§4.4) — native setter write, read-back
   verification, and the Input.insertText fallback for reverted values. */
export {
  FILL_DEFAULT_TIMEOUT_MS,
  FILL_POST_SCHEMA,
  buildFillExpression,
  buildFillReadExpression,
  fillFallbackOutcome,
  fillOutcomeFromReply,
  isFillFatal,
  parseFillReply,
  parseFillRead,
  renderFill,
  validateFillArgs,
  type FillOptions,
  type FillOutcome,
  type FillPostReport,
  type FillRenderInput,
  type FillRenderTarget,
  type FillReply,
  type FillRun,
} from './fill.ts'

/* plan02 wave 2: the seven wait strategies (§4.7) behind cdp_wait — legacy css
   presence byte-compatible, everything else in-band with waitedMs + reason. */
export {
  WAIT_DEFAULT_IDLE_MS,
  WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_STRATEGIES,
  WAIT_URL_POLL_MS,
  renderWait,
  runWait,
  validateWaitArgs,
  waitPlan,
  waitForNetworkIdle,
  waitForUrlPattern,
  type NetworkIdleEvent,
  type NetworkIdleSeam,
  type WaitArgs,
  type WaitExpectReply,
  type WaitNetworkReply,
  type WaitOutcome,
  type WaitPlan,
  type WaitRenderInput,
  type WaitSeam,
  type WaitStrategy,
} from './waits.ts'

/* plan08 wave: the ref path — weaver-identical ref indexing and action-time
   element resolution (stale refs answer `stale-ref:`, never a wrong rect).
   plan08-fix-ref-rename adds the node-identity fallback: a renamed element is
   delivered to and reported as `ref-target-renamed`, never as a stale ref. */
export {
  REF_DESCRIBE_FUNCTION,
  REF_RENAMED_PREFIX,
  REF_STALE_PREFIX,
  RefStaleError,
  buildRefIndex,
  centerOf,
  clearRefOrigins,
  collectElementIdentities,
  collectElementIds,
  isRefRenamedReason,
  isRefStaleError,
  isStaleRefReason,
  lookupRefByIdentity,
  lookupRefOrigin,
  recordRefOrigins,
  refFailureRun,
  refLocatorRun,
  renameNote,
  resolveRefOn,
  type RefEvidence,
  type RefExpectOutcome,
  type RefIndexEntry,
  type RefNodeIdentity,
  type RefOrigin,
  type RefRect,
  type RefRename,
  type RefTextOutcome,
} from './refs.ts'

/* plan14: "what is AT this point?" — the pure probe engine behind cdp_locate,
   plus the service envelope types and the hit-test wording cdp_find shares. */
export {
  LOCATE_EVAL_TIMEOUT_MS,
  LOCATE_MAX_ANCESTRY,
  LOCATE_MAX_CLASSES,
  LOCATE_MAX_NEAREST_SCAN,
  LOCATE_MAX_TEXT_CHARS,
  LOCATE_NEAREST_DEPTH,
  buildLocateExpression,
  hitTestFailures,
  locateLabel,
  parseLocateReply,
  renderLocate,
  type LocateNearest,
  type LocateNode,
  type LocateRecord,
  type LocateRect,
  type ParsedLocateReply,
} from './locate.ts'

export type {
  LocateOptions,
  LocateOutcome,
} from './service.ts'

/* plan04: the endpoint connection pool, loopback discovery, and reattach driver. */
export {
  ConnectionPool,
  CdpPoolFullError,
  probeEndpoint,
  discoverEndpoints,
  parseEndpoint,
  connectionIdOf,
  normalizeEndpoint,
  DEFAULT_DISCOVERY_PORTS,
  DEFAULT_MAX_POOL_ENTRIES,
  DEFAULT_PROBE_TIMEOUT_MS,
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  type CdpEndpointRow,
  type ConnectionPoolOptions,
  type DiscoveredEndpoint,
  type PooledEndpoint,
  type PooledState,
  type PoolHooks,
} from './connection-pool.ts'
