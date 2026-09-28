/**
 * @deepseek-ai/dsh-cdp — the stealth surface applied to a page before any page
 * script runs. {@link stealthScript} returns plain, readable JavaScript for
 * `Page.addScriptToEvaluateOnNewDocument`; there is no obfuscation and no
 * encoded payload, so every patch can be reviewed line by line.
 *
 * The script installs each patch through one entry in an internal patch table,
 * and every patch can be disabled individually through {@link StealthOptions}.
 * Each patch defines configurable properties only on the object or prototype it
 * names, and tolerates a page that does not expose the API it patches, so a
 * page's other globals are left alone. Applying the returned script twice to
 * one document is a no-op: the first application marks the document and the
 * second returns immediately.
 *
 * The caller applies the script once per new document; it only makes the
 * browser's own reported surface consistent with a person's browser.
 * @module @deepseek-ai/dsh-cdp/stealth
 */

/** Notification permission state a patched page reports. */
export type NotificationPermissionState = 'default' | 'granted' | 'denied'

/** Name of one individually disableable stealth patch. */
export type StealthPatchName =
  | 'webdriver'
  | 'plugins'
  | 'mimeTypes'
  | 'languages'
  | 'platform'
  | 'webgl'
  | 'notifications'
  | 'permissions'
  | 'chromeRuntime'
  /* plan07: g9–g26 detection/prevention compilation — every new patch stays
     individually toggleable and emits its own `dsh-stealth:<name>` marker. */
  | 'uaCh'
  | 'chromeExtras'
  | 'windowMetrics'
  | 'deviceInfo'
  | 'mediaDevices'
  | 'fonts'
  | 'connection'
  | 'webglNoise'
  | 'canvasNoise'
  | 'audioNoise'
  | 'clientRects'
  | 'hairline'
  | 'cdcVars'
  | 'funcToString'

/**
 * plan07: `navigator.userAgentData` values — projected from one
 * stealth-profiles.ts profile so the JS surface and the `Sec-CH-UA*` headers
 * `Network.setUserAgentOverride` sends tell the same story (G9).
 */
export interface UaChValues {
  /** `Sec-CH-UA` brand list. */
  readonly brands: readonly { readonly brand: string, readonly version: string }[]
  /** `Sec-CH-UA-Full-Version-List`. */
  readonly fullVersionList: readonly { readonly brand: string, readonly version: string }[]
  /** `Sec-CH-UA-Platform`: 'Windows' | 'macOS' | 'Linux' (NOT the navigator.platform string). */
  readonly platform: string
  /** `Sec-CH-UA-Platform-Version`. */
  readonly platformVersion: string
  /** `Sec-CH-UA-Arch`. */
  readonly architecture: string
  /** `Sec-CH-UA-Bitness`. */
  readonly bitness: string
  /** `Sec-CH-UA-Model` — empty on desktop. */
  readonly model: string
  /** `Sec-CH-UA-Mobile`. */
  readonly mobile: boolean
  /** `Sec-CH-UA-WoW64`. */
  readonly wow64: boolean
}

/** plan07: screen constants the windowMetrics patch falls back to when native is degenerate. */
export interface StealthScreenFallback {
  /** Fallback `screen.width` when the native value cannot cover the window. */
  readonly width: number
  /** Fallback `screen.height` when the native value cannot cover the window. */
  readonly height: number
  /** Fallback `screen.colorDepth`/`pixelDepth` when native reports 0. */
  readonly colorDepth: number
}

/**
 * Per-patch toggles and the values the patches embed.
 *
 * Every toggle defaults to `true`; setting one to `false` omits that patch from
 * the returned script and leaves every other patch in place.
 */
export interface StealthOptions {
  /**
   * Make `navigator.webdriver` report `false`. A page reads this flag before
   * any script runs, so it is the first and cheapest automation tell.
   */
  readonly webdriver?: boolean
  /**
   * Replace the empty `navigator.plugins` list with the PDF-viewer set a
   * desktop Chrome exposes, keeping the `PluginArray` prototype.
   */
  readonly plugins?: boolean
  /** Replace `navigator.mimeTypes` with the PDF mime types matching {@link plugins}. */
  readonly mimeTypes?: boolean
  /** Replace `navigator.language` and `navigator.languages` with `languageValues`. */
  readonly languages?: boolean
  /** Replace `navigator.platform` with `platformValue`. */
  readonly platform?: boolean
  /** Answer the two unmasked WebGL vendor/renderer parameters from the configured values. */
  readonly webgl?: boolean
  /** Make `Notification.permission` report `notificationState`. */
  readonly notifications?: boolean
  /** Make `navigator.permissions.query` agree with `notificationState` for notifications. */
  readonly permissions?: boolean
  /**
   * Remove the `window.chrome.runtime` object the automation extension
   * publishes on ordinary pages, while leaving extension pages alone.
   */
  readonly chromeRuntime?: boolean
  /** Ordered language preference list; must not be empty. @default ['en-US', 'en'] */
  readonly languageValues?: readonly string[]
  /** Platform string `navigator.platform` reports. @default 'Win32' */
  readonly platformValue?: string
  /** WebGL unmasked vendor string. @default 'Google Inc. (Intel)' */
  readonly webglVendor?: string
  /** WebGL unmasked renderer string. */
  readonly webglRenderer?: string
  /** Notification permission state both notification-facing patches report. @default 'default' */
  readonly notificationState?: NotificationPermissionState
  /* ── plan07: g9–g26 additions — all optional, all additive ─────────── */
  /**
   * Complete `User-Agent` string of the profile story. The JS layer reads
   * `navigator.userAgent` live (CDP override owns the header); this value is
   * the profile's canonical UA for cross-layer checks and reports. @default Windows Chrome UA
   */
  readonly userAgent?: string
  /** `navigator.userAgentData` values mirroring the `Sec-CH-UA*` metadata. */
  readonly uaChValues?: UaChValues
  /** Make `navigator.hardwareConcurrency` report this fixed value. @default 8 */
  readonly hardwareConcurrency?: number
  /** Make `navigator.deviceMemory` report this fixed value (GB). @default 8 */
  readonly deviceMemoryGb?: number
  /** Screen constants used only when native `screen.*` cannot cover the window. */
  readonly screenFallback?: StealthScreenFallback
  /**
   * Seed for every noise generator (canvas, WebGL readPixels, audio, rects).
   * FIXED per profile — never randomized per load: a fingerprint that changes
   * between loads is a stronger tell than a stable one (plan07 §8.3).
   * @default 'dsh-stealth'
   */
  readonly noiseSeed?: string
  /** Make `navigator.userAgentData` tell the profile's UA-CH story. @default true */
  readonly uaCh?: boolean
  /** Add `chrome.csi()`/`chrome.loadTimes()` (and a bare `window.chrome` when missing). @default true */
  readonly chromeExtras?: boolean
  /** Keep `outer*`/`screen.*` coherent with the real viewport (never patches `inner*`). @default true */
  readonly windowMetrics?: boolean
  /** Fixed `hardwareConcurrency`/`deviceMemory`/`maxTouchPoints` reporting. @default true */
  readonly deviceInfo?: boolean
  /** Answer an empty `enumerateDevices()` with a plausible fixed device set. @default true */
  readonly mediaDevices?: boolean
  /** Keep `navigator.fonts`/`document.fonts.status` coherent with desktop Chrome. @default true */
  readonly fonts?: boolean
  /** Fixed `navigator.connection` values (`4g`, rtt, downlink) when the API exists or is missing. @default true */
  readonly connection?: boolean
  /** Coherent WebGL extension list + seeded deterministic `readPixels` noise. @default true */
  readonly webglNoise?: boolean
  /** Seeded deterministic canvas noise shared by `toDataURL`/`toBlob`/`getImageData`. @default true */
  readonly canvasNoise?: boolean
  /** Seeded deterministic `AudioBuffer.getChannelData` noise (idempotent per buffer). @default true */
  readonly audioNoise?: boolean
  /** Seeded sub-pixel `getBoundingClientRect`/`getClientRects` offsets (same box ⇒ same offset). @default true */
  readonly clientRects?: boolean
  /** Keep `matchMedia` resolution/dppx queries consistent with `devicePixelRatio`. @default true */
  readonly hairline?: boolean
  /** Delete `$cdc_`/`cdc_` automation variables from `document`/`window`. @default true */
  readonly cdcVars?: boolean
  /** Make `Function.prototype.toString` report `[native code]` for patched functions. @default true */
  readonly funcToString?: boolean
}

/**
 * Prefix of the comment marker every patch's emitted source starts with, so a
 * reviewer and a test can tell which patches a generated script carries.
 */
export const STEALTH_PATCH_MARKER_PREFIX = 'dsh-stealth:'

/** Every patch name, in the order {@link stealthScript} emits them. */
export const STEALTH_PATCH_NAMES: readonly StealthPatchName[] = [
  'webdriver',
  'plugins',
  'mimeTypes',
  'languages',
  'platform',
  'webgl',
  'notifications',
  'permissions',
  'chromeRuntime',
  // plan07: appended names keep the original nine in their original order.
  'uaCh',
  'chromeExtras',
  'windowMetrics',
  'deviceInfo',
  'mediaDevices',
  'fonts',
  'connection',
  'webglNoise',
  'canvasNoise',
  'audioNoise',
  'clientRects',
  'hairline',
  'cdcVars',
  'funcToString',
]

/** Default ordered language preference list. */
const DEFAULT_LANGUAGE_VALUES: readonly string[] = ['en-US', 'en']

/** Default platform string, matching the harness's primary deployment. */
const DEFAULT_PLATFORM_VALUE = 'Win32'

/** Default unmasked WebGL vendor, matching a common integrated-GPU ANGLE report. */
const DEFAULT_WEBGL_VENDOR = 'Google Inc. (Intel)'

/** Default unmasked WebGL renderer, matching a common Windows ANGLE report. */
const DEFAULT_WEBGL_RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'

/** Default notification permission state, the state a browser reports before any prompt. */
const DEFAULT_NOTIFICATION_STATE: NotificationPermissionState = 'default'

/* plan07 defaults — one coherent desktop-Chrome story; the profile layer
   (stealth-profiles.ts) overrides all of these per profile. */

/** Default `User-Agent` string of the default profile. */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Default UA-CH values mirroring DEFAULT_USER_AGENT. */
const DEFAULT_UA_CH: UaChValues = {
  brands: [
    { brand: 'Google Chrome', version: '131' },
    { brand: 'Chromium', version: '131' },
    { brand: 'Not_A Brand', version: '24' },
  ],
  fullVersionList: [
    { brand: 'Google Chrome', version: '131.0.0.0' },
    { brand: 'Chromium', version: '131.0.0.0' },
    { brand: 'Not_A Brand', version: '10.0.0.0' },
  ],
  platform: 'Windows',
  platformVersion: '10.0.0',
  architecture: 'x86',
  bitness: '64',
  model: '',
  mobile: false,
  wow64: false,
}

/** Default fixed hardwareConcurrency. */
const DEFAULT_HARDWARE_CONCURRENCY = 8

/** Default fixed deviceMemory in GB. */
const DEFAULT_DEVICE_MEMORY_GB = 8

/** Default screen fallback used only when native screen cannot cover the window. */
const DEFAULT_SCREEN_FALLBACK: StealthScreenFallback = { width: 1920, height: 1080, colorDepth: 24 }

/** Default noise seed — FIXED, never randomized per load (plan07 §8.3). */
const DEFAULT_NOISE_SEED = 'dsh-stealth'

/** Option values embedded into the generated patches. */
interface ResolvedStealthOptions {
  /** Ordered language preference list. */
  readonly languageValues: readonly string[]
  /** Platform string. */
  readonly platformValue: string
  /** WebGL unmasked vendor. */
  readonly webglVendor: string
  /** WebGL unmasked renderer. */
  readonly webglRenderer: string
  /** Notification permission state. */
  readonly notificationState: NotificationPermissionState
  /** Profile `User-Agent` string (cross-layer check/report value). */
  readonly userAgent: string
  /** UA-CH values mirroring the `Sec-CH-UA*` metadata. */
  readonly uaChValues: UaChValues
  /** Fixed navigator.hardwareConcurrency. */
  readonly hardwareConcurrency: number
  /** Fixed navigator.deviceMemory (GB). */
  readonly deviceMemoryGb: number
  /** Screen fallback constants. */
  readonly screenFallback: StealthScreenFallback
  /** Fixed noise seed. */
  readonly noiseSeed: string
}

/** One patch: its option name and the source its builder returns. */
interface StealthPatch {
  /** Option that enables or disables this patch. */
  readonly name: StealthPatchName
  /** Emit this patch's JavaScript source. */
  readonly build: (options: ResolvedStealthOptions) => string
}

/**
 * Script prefix: the idempotency marker and the helpers shared by more than one
 * patch. The marker is a non-enumerable property so it does not appear in a
 * page's `Object.keys(globalThis)`.
 */
const SCRIPT_PREAMBLE = `(() => {
'use strict'
// Applied through Page.addScriptToEvaluateOnNewDocument before any page script
// runs. Apply one instance per new document: the marker below makes a second
// application of this script a no-op.
const dshGlobal = globalThis
if (dshGlobal.__dshStealthInstalled === true) return
try {
  Object.defineProperty(dshGlobal, '__dshStealthInstalled', {
    value: true,
    writable: false,
    enumerable: false,
    configurable: true,
  })
} catch {}

// Define a configurable getter, preserving the original when the property
// cannot be redefined. Never replaces a whole object a page owns.
const dshDefineGetter = (target, property, value) => {
  try {
    const dshGetter = () => value
    // plan07: record every function WE create so the funcToString patch can
    // make it report native code. Cheap and inert when that patch is off.
    dshNativeize(dshGetter, 'get ' + property)
    Object.defineProperty(target, property, { configurable: true, get: dshGetter })
    return true
  } catch {
    return false
  }
}

// plan07-fix: patch through the PROTOTYPE, never as an instance own
// property. Real Chrome keeps webdriver/languages/hardwareConcurrency/
// deviceMemory/plugins/... on Navigator.prototype only — an own copy on the
// instance is exactly what sannysoft's _.has(navigator, "webdriver")
// tripwire reports, and it lets the untouched native prototype getter
// (32 cores, raw language tags) contradict the instance (8 cores, profile
// languages). Any own copy left behind is deleted first, and a prototype
// that refuses the redefine leaves the NATIVE value in place — planting an
// own-property would be the worse lie.
const dshDefineProtoGetter = (target, property, value) => {
  try {
    if (Object.prototype.hasOwnProperty.call(target, property)) {
      try { delete target[property] } catch {}
    }
    const dshProto = Object.getPrototypeOf(target)
    if (dshProto === null || dshProto === undefined) return false
    return dshDefineGetter(dshProto, property, value)
  } catch {
    return false
  }
}

// plan07: the funcToString patch's registry. Weak, per-function, and never
// consulted unless that patch is enabled.
const dshNativeSet = new WeakSet()
const dshNativeLabels = new WeakMap()
const dshNativeize = (fn, label) => {
  try {
    if (typeof fn === 'function') {
      dshNativeSet.add(fn)
      if (typeof label === 'string' && label !== '') dshNativeLabels.set(fn, label)
    }
  } catch {}
  return fn
}

const dshPdfPluginNames = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF']
const dshPdfMimeNames = ['application/pdf', 'text/pdf']

// The plugin-list replacement keeps the PluginArray prototype and its
// item()/namedItem() accessors so instanceof tests and indexed reads agree.
const dshBuildPdfPlugins = () => {
  if (typeof PluginArray === 'undefined') return null
  const plugins = Object.create(PluginArray.prototype)
  const item = index => (plugins[index] === undefined ? null : plugins[index])
  const namedItem = name => {
    for (let index = 0; index < dshPdfPluginNames.length; index += 1) {
      if (dshPdfPluginNames[index] === name) return plugins[index]
    }
    return null
  }
  dshPdfPluginNames.forEach((name, index) => {
    // plan07-fix: real Chrome's plugin objects inherit from Plugin.prototype —
    // a plain object fails the standard "plugins[0] instanceof Plugin" check.
    // The data properties shadow the interface accessors for our own
    // instances only; no prototype of a page-owned object is rewritten.
    const plugin = typeof Plugin === 'function' ? Object.create(Plugin.prototype) : {}
    Object.defineProperty(plugin, 'name', {
      value: name,
      configurable: true,
      enumerable: true,
    })
    Object.defineProperty(plugin, 'filename', {
      value: 'internal-pdf-viewer',
      configurable: true,
      enumerable: true,
    })
    Object.defineProperty(plugin, 'description', {
      value: 'Portable Document Format',
      configurable: true,
      enumerable: true,
    })
    Object.defineProperty(plugin, 'length', {
      value: dshPdfMimeNames.length,
      configurable: true,
      enumerable: true,
    })
    Object.defineProperty(plugins, index, {
      value: plugin,
      configurable: true,
      enumerable: true,
    })
  })
  Object.defineProperty(plugins, 'length', { value: dshPdfPluginNames.length, configurable: true })
  Object.defineProperty(plugins, 'item', { value: item, configurable: true })
  Object.defineProperty(plugins, 'namedItem', { value: namedItem, configurable: true })
  return plugins
}

// The mime-type replacement mirrors the plugin list, including the
// enabledPlugin link that a real Chrome reports.
const dshBuildPdfMimeTypes = enabledPlugin => {
  if (typeof MimeTypeArray === 'undefined' || typeof MimeType === 'undefined') return null
  const types = Object.create(MimeTypeArray.prototype)
  const item = index => (types[index] === undefined ? null : types[index])
  const namedItem = name => {
    for (let index = 0; index < dshPdfMimeNames.length; index += 1) {
      if (dshPdfMimeNames[index] === name) return types[index]
    }
    return null
  }
  dshPdfMimeNames.forEach((name, index) => {
    const type = Object.create(MimeType.prototype)
    Object.defineProperty(type, 'type', { value: name, configurable: true, enumerable: true })
    Object.defineProperty(type, 'suffixes', { value: 'pdf', configurable: true, enumerable: true })
    Object.defineProperty(type, 'description', { value: 'Portable Document Format', configurable: true, enumerable: true })
    Object.defineProperty(type, 'enabledPlugin', { value: enabledPlugin, configurable: true, enumerable: true })
    Object.defineProperty(types, index, { value: type, configurable: true, enumerable: true })
  })
  Object.defineProperty(types, 'length', { value: dshPdfMimeNames.length, configurable: true })
  Object.defineProperty(types, 'item', { value: item, configurable: true })
  Object.defineProperty(types, 'namedItem', { value: namedItem, configurable: true })
  return types
}
`

/**
 * Patch `webdriver`: `navigator.webdriver` is `true` whenever the browser is
 * under DevTools control, and a page can read it before any page script runs.
 * plan07-fix: the override lives on `Navigator.prototype` like real Chrome —
 * `in` checks still see the property, `Object.hasOwn(navigator,'webdriver')`
 * stays false exactly as on an uninstrumented Chrome, and the prototype
 * getter a detector invokes IS the one reporting `false`.
 * @param _options - resolved option values; this patch embeds none.
 * @returns the patch's JavaScript source.
 */
function webdriverPatch(_options: ResolvedStealthOptions): string {
  return `// dsh-stealth:webdriver — navigator.webdriver is true when the browser is
// driven by the DevTools protocol; a page can read it before any script runs.
// plan07-fix: prototype override only — never an instance own-property
// (sannysoft _.has(navigator, "webdriver") reads own keys).
try {
  if (typeof navigator !== 'undefined' && navigator !== null) {
    dshDefineProtoGetter(navigator, 'webdriver', false)
  }
} catch {}`
}

/**
 * Patch `plugins`: a fresh automation profile reports `navigator.plugins` as
 * empty, while every desktop Chrome reports a fixed PDF-viewer set.
 * @param _options - resolved option values; this patch embeds none.
 * @returns the patch's JavaScript source.
 */
function pluginsPatch(_options: ResolvedStealthOptions): string {
  return `// dsh-stealth:plugins — headless Chrome exposes an empty navigator.plugins,
// which no desktop Chrome does. The replacement keeps PluginArray's prototype.
try {
  if (typeof navigator !== 'undefined' && navigator !== null) {
    const dshPlugins = dshBuildPdfPlugins()
    if (dshPlugins !== null) dshDefineProtoGetter(navigator, 'plugins', dshPlugins)
  }
} catch {}`
}

/**
 * Patch `mimeTypes`: `navigator.mimeTypes` is the other half of the same tell
 * and must list the PDF types whose `enabledPlugin` is the plugin set the
 * `plugins` patch installed. This patch runs after `plugins` for that reason.
 * @param _options - resolved option values; this patch embeds none.
 * @returns the patch's JavaScript source.
 */
function mimeTypesPatch(_options: ResolvedStealthOptions): string {
  return `// dsh-stealth:mimeTypes — the mime-type list must match the plugin list; the
// enabledPlugin link points at the PDF viewer the plugins patch installed.
try {
  if (typeof navigator !== 'undefined' && navigator !== null) {
    const dshPlugins = navigator.plugins
    const dshEnabled = dshPlugins !== undefined && dshPlugins.length > 0 ? dshPlugins[0] : null
    const dshMimeTypes = dshBuildPdfMimeTypes(dshEnabled)
    if (dshMimeTypes !== null) dshDefineProtoGetter(navigator, 'mimeTypes', dshMimeTypes)
  }
} catch {}`
}

/**
 * Patch `languages`: a fresh automation profile reports one language while a
 * person's browser reports an ordered preference list; the first entry is also
 * `navigator.language`.
 * @param options - resolved option values carrying the language list.
 * @returns the patch's JavaScript source.
 */
function languagesPatch(options: ResolvedStealthOptions): string {
  return `// dsh-stealth:languages — a fresh automation profile reports a single
// language; a person's browser reports an ordered preference list.
try {
  if (typeof navigator !== 'undefined' && navigator !== null) {
    const dshLanguages = ${JSON.stringify(options.languageValues)}
    dshDefineProtoGetter(navigator, 'language', dshLanguages[0])
    dshDefineProtoGetter(navigator, 'languages', dshLanguages.slice())
  }
} catch {}`
}

/**
 * Patch `platform`: the platform string is a cheap fingerprint and headless
 * Linux reports a value no desktop install of the emulated OS would.
 * @param options - resolved option values carrying the platform string.
 * @returns the patch's JavaScript source.
 */
function platformPatch(options: ResolvedStealthOptions): string {
  return `// dsh-stealth:platform — navigator.platform is a cheap fingerprint and
// headless hosts report a platform the emulated browser profile contradicts.
try {
  if (typeof navigator !== 'undefined' && navigator !== null) {
    dshDefineProtoGetter(navigator, 'platform', ${JSON.stringify(options.platformValue)})
  }
} catch {}`
}

/**
 * Patch `webgl`: the two unmasked WebGL parameters name the exact GPU and
 * driver, and a software renderer names the automation host. The patch answers
 * only those two parameters and delegates every other parameter to the
 * original `getParameter`.
 * @param options - resolved option values carrying the vendor and renderer.
 * @returns the patch's JavaScript source.
 */
function webglPatch(options: ResolvedStealthOptions): string {
  return `// dsh-stealth:webgl — the unmasked vendor and renderer identify the GPU and
// driver; software rendering identifies the automation host. Every other
// parameter still comes from the browser's own getParameter.
try {
  const dshPatchGetParameter = prototype => {
    const dshOriginalGetParameter = prototype.getParameter
    prototype.getParameter = function (parameter) {
      if (parameter === 37445) return ${JSON.stringify(options.webglVendor)}
      if (parameter === 37446) return ${JSON.stringify(options.webglRenderer)}
      return dshOriginalGetParameter.call(this, parameter)
    }
  }
  if (typeof WebGLRenderingContext !== 'undefined') dshPatchGetParameter(WebGLRenderingContext.prototype)
} catch {}
try {
  const dshPatchGetParameter2 = prototype => {
    const dshOriginalGetParameter = prototype.getParameter
    prototype.getParameter = function (parameter) {
      if (parameter === 37445) return ${JSON.stringify(options.webglVendor)}
      if (parameter === 37446) return ${JSON.stringify(options.webglRenderer)}
      return dshOriginalGetParameter.call(this, parameter)
    }
  }
  if (typeof WebGL2RenderingContext !== 'undefined') dshPatchGetParameter2(WebGL2RenderingContext.prototype)
} catch {}`
}

/**
 * Patch `notifications`: `Notification.permission` reports `denied` in a
 * profile that never prompted, which is both unusual and inconsistent with a
 * permissions query answering `prompt`. The patch reports the configured state.
 * @param options - resolved option values carrying the notification state.
 * @returns the patch's JavaScript source.
 */
function notificationsPatch(options: ResolvedStealthOptions): string {
  return `// dsh-stealth:notifications — Notification.permission reports 'denied' in a
// profile that never prompted, which a person's browser does not do.
try {
  if (typeof Notification !== 'undefined') {
    dshDefineGetter(Notification, 'permission', ${JSON.stringify(options.notificationState)})
  }
} catch {}`
}

/**
 * Patch `permissions`: `navigator.permissions.query({name:'notifications'})`
 * must agree with the reported `Notification.permission`; automation answers
 * `prompt` while the notification property answers `denied`, and that
 * disagreement is itself the tell. Non-notification queries pass through.
 * @param options - resolved option values carrying the notification state.
 * @returns the patch's JavaScript source.
 */
function permissionsPatch(options: ResolvedStealthOptions): string {
  return `// dsh-stealth:permissions — a permissions query for notifications must agree
// with Notification.permission; automation reports denied from the property
// and prompt from the query, and that disagreement is itself a tell.
try {
  if (typeof navigator !== 'undefined' && navigator !== null
    && navigator.permissions !== undefined && navigator.permissions !== null) {
    const dshPermissions = navigator.permissions
    const dshOriginalQuery = dshPermissions.query.bind(dshPermissions)
    dshPermissions.query = descriptor => {
      const dshResult = dshOriginalQuery(descriptor)
      if (descriptor === undefined || descriptor.name !== 'notifications') return dshResult
      return Promise.resolve(dshResult).then(status => {
        try {
          Object.defineProperty(status, 'state', {
            configurable: true,
            get: () => ${JSON.stringify(options.notificationState)},
          })
        } catch {}
        return status
      })
    }
  }
} catch {}`
}

/**
 * Patch `chromeRuntime`: the automation extension publishes
 * `window.chrome.runtime` on ordinary pages, while real Chrome exposes
 * `runtime` only to extension contexts. The patch removes that one property and
 * leaves `window.chrome` and every other page global untouched.
 * @param _options - resolved option values; this patch embeds none.
 * @returns the patch's JavaScript source.
 */
function chromeRuntimePatch(_options: ResolvedStealthOptions): string {
  return `// dsh-stealth:chromeRuntime — the automation extension publishes
// window.chrome.runtime on ordinary pages; real Chrome exposes runtime only to
// extension contexts. Only that one property is removed.
try {
  if (typeof window !== 'undefined' && window !== null && window.chrome !== undefined && window.chrome !== null
    && window.chrome.runtime !== undefined) {
    const dshOnExtensionPage = typeof document !== 'undefined' && document !== null
      && document.location !== undefined && document.location !== null
      && document.location.protocol === 'chrome-extension:'
    if (!dshOnExtensionPage) {
      try {
        delete window.chrome.runtime
      } catch {}
      if (window.chrome.runtime !== undefined) dshDefineGetter(window.chrome, 'runtime', undefined)
    }
  }
} catch {}`
}

/**
 * plan07: stable FNV-1a-style hash so one `noiseSeed` string yields one fixed
 * numeric seed per noise domain (canvas/WebGL/audio/rects). Same seed ⇒ same
 * numbers on every load — never randomized (plan07 §8.3).
 * @param seed - the caller's seed string.
 * @param domain - separates the four noise generators from each other.
 * @returns a stable unsigned 32-bit number.
 */
function seedNumber(seed: string, domain: string): number {
  const text = `${seed}:${domain}`
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/* ── plan07 patch builders: g9–g26 detection/prevention compilation ──────────
   Each builder returns readable, self-contained JavaScript with its
   `dsh-stealth:<name>` marker, tolerates missing APIs, and never touches a
   global it does not name. No CAPTCHA provider, no credential, no obfuscation
   (src/stealth.ts:15-17 contract preserved). */

/** G9: UA-CH — brand versions follow the LIVE UA, platform follows patched navigator.platform. */
function uaChPatch(options: ResolvedStealthOptions): string {
  const high = JSON.stringify({
    ua: options.userAgent,
    platform: options.uaChValues.platform,
    platformVersion: options.uaChValues.platformVersion,
    architecture: options.uaChValues.architecture,
    bitness: options.uaChValues.bitness,
    model: options.uaChValues.model,
    mobile: options.uaChValues.mobile,
    wow64: options.uaChValues.wow64,
    brandsMajor: (options.uaChValues.brands[0]?.version ?? '131'),
  })
  return `// dsh-stealth:uaCh — navigator.userAgentData must tell the same story as the
// User-Agent and Sec-CH-UA* headers: brand versions derive from the LIVE UA
// string and the platform from the (patched) navigator.platform, so no two
// layers can disagree even when the network override was unavailable.
try {
  if (typeof navigator !== 'undefined' && navigator !== null
    && navigator.userAgentData !== undefined && navigator.userAgentData !== null) {
    const dshHigh = ${high}
    const dshUa = typeof navigator.userAgent === 'string' ? navigator.userAgent : ''
    const dshMajorMatch = /Chrome\\/(\\d+)/.exec(dshUa)
    const dshProfileMatch = dshMajorMatch === null && typeof dshHigh.ua === 'string' ? /Chrome\\/(\\d+)/.exec(dshHigh.ua) : null
    const dshMajor = dshMajorMatch !== null ? dshMajorMatch[1]
      : (dshProfileMatch !== null ? dshProfileMatch[1] : dshHigh.brandsMajor)
    const dshFull = dshMajor + '.0.0.0'
    const dshPlatform = typeof navigator.platform === 'string' && navigator.platform.indexOf('Win') === 0
      ? 'Windows'
      : (typeof navigator.platform === 'string' && navigator.platform.indexOf('Mac') === 0 ? 'macOS' : dshHigh.platform)
    const dshBrands = [
      { brand: 'Google Chrome', version: dshMajor },
      { brand: 'Chromium', version: dshMajor },
      { brand: 'Not_A Brand', version: '24' },
    ]
    const dshFullList = [
      { brand: 'Google Chrome', version: dshFull },
      { brand: 'Chromium', version: dshFull },
      { brand: 'Not_A Brand', version: '10.0.0.0' },
    ]
    const dshData = navigator.userAgentData
    // plan07-fix: prototype routing again — NavigatorUAData keeps its
    // accessors on the prototype in real Chrome too.
    dshDefineProtoGetter(dshData, 'mobile', dshHigh.mobile)
    dshDefineProtoGetter(dshData, 'platform', dshPlatform)
    dshDefineProtoGetter(dshData, 'brands', dshBrands.map(function (brand) { return { brand: brand.brand, version: brand.version } }))
    if (typeof dshData.getHighEntropyValues === 'function') {
      const dshHighValues = function getHighEntropyValues() {
        return Promise.resolve({
          architecture: dshHigh.architecture,
          bitness: dshHigh.bitness,
          brands: dshBrands.map(function (brand) { return { brand: brand.brand, version: brand.version } }),
          fullVersionList: dshFullList.map(function (brand) { return { brand: brand.brand, version: brand.version } }),
          mobile: dshHigh.mobile,
          model: dshHigh.model,
          platform: dshPlatform,
          platformVersion: dshHigh.platformVersion,
          uaFullVersion: dshFull,
          wow64: dshHigh.wow64,
        })
      }
      try {
        dshDefineProtoGetter(dshData, 'getHighEntropyValues', dshNativeize(dshHighValues, 'getHighEntropyValues'))
      } catch {}
    }
  }
} catch {}`
}

/** G8: chrome.csi()/chrome.loadTimes() exist on real Chrome pages. */
function chromeExtrasPatch(_options: ResolvedStealthOptions): string {
  return `// dsh-stealth:chromeExtras — desktop Chrome exposes window.chrome.csi() and
// chrome.loadTimes() on ordinary pages; missing or throw-only variants are a
// cheap tell. plan07-fix2: real Chromium reports startLoadTime ===
// performance.timeOrigin/1000 (same epoch, same millisecond); a FIXED
// calendar date was hundreds of days off the document's own timeOrigin —
// a one-line consistency check any detector can run. All stamps keep their
// FIXED deltas from the LIVE origin (ordered, never per-load random).
try {
  if (typeof window !== 'undefined' && window !== null) {
    if (window.chrome === undefined || window.chrome === null) {
      try {
        Object.defineProperty(window, 'chrome', { configurable: true, enumerable: false, value: {} })
      } catch {}
    }
    if (window.chrome !== undefined && window.chrome !== null) {
      dshDefineGetter(window.chrome, 'csi', function csi() {
        return {
          startE: 2, onloadT: 4, pageT: 612, tranT: 0,
          domSt: 118, domSc: 402, reqSt: 118, reqSc: 402,
          loadSt: 604, loadSc: 612,
        }
      })
      dshDefineGetter(window.chrome, 'loadTimes', function loadTimes() {
        // plan07-fix2: seconds since epoch, anchored to the LIVE document.
        const dshOrigin = typeof performance !== 'undefined' && performance !== null
          && typeof performance.timeOrigin === 'number' && performance.timeOrigin > 0
          ? performance.timeOrigin
          : (typeof Date !== 'undefined' ? Date.now() : 0)
        const dshStart = dshOrigin / 1000
        return {
          requestTime: dshStart - 0.001,
          startLoadTime: dshStart,
          commitLoadTime: dshStart + 0.177,
          finishDocumentLoadTime: dshStart + 0.328,
          finishLoadTime: dshStart + 0.487,
          firstPaintTime: dshStart + 0.346,
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          alternateProtocolUsage: 0,
          connectionInfo: 'h2',
        }
      })
    }
  }
} catch {}`
}

/** G10: outer/inner/screen coherence. NEVER patches inner* (the real viewport is truth). */
function windowMetricsPatch(options: ResolvedStealthOptions): string {
  const fallback = JSON.stringify(options.screenFallback)
  return `// dsh-stealth:windowMetrics — outerWidth/outerHeight must not report 0×0 and
// screen.* must always cover the window. inner*/innerHeight are NEVER patched
// (the 492px incident: the real viewport was right; its window context was
// missing). Values track the LIVE viewport so cdp_viewport resizes stay coherent.
try {
  const dshFb = ${fallback}
  if (typeof window !== 'undefined' && window !== null) {
    const dshInnerW = () => (typeof window.innerWidth === 'number' && window.innerWidth > 0 ? window.innerWidth : 1280)
    const dshInnerH = () => (typeof window.innerHeight === 'number' && window.innerHeight > 0 ? window.innerHeight : 800)
    const dshOutW = () => dshInnerW() + 16
    const dshOutH = () => dshInnerH() + 85
    try {
      Object.defineProperty(window, 'outerWidth', { configurable: true, get: dshNativeize(() => dshOutW(), 'get outerWidth') })
      Object.defineProperty(window, 'outerHeight', { configurable: true, get: dshNativeize(() => dshOutH(), 'get outerHeight') })
    } catch {}
    try {
      let dshNatW = 0
      let dshNatH = 0
      let dshNatAw = 0
      let dshNatAh = 0
      let dshNatCd = 0
      if (typeof screen !== 'undefined' && screen !== null) {
        dshNatW = typeof screen.width === 'number' ? screen.width : 0
        dshNatH = typeof screen.height === 'number' ? screen.height : 0
        dshNatAw = typeof screen.availWidth === 'number' ? screen.availWidth : 0
        dshNatAh = typeof screen.availHeight === 'number' ? screen.availHeight : 0
        dshNatCd = typeof screen.colorDepth === 'number' ? screen.colorDepth : 0
      }
      const dshScreenW = () => (dshNatW >= dshOutW() && dshNatW > 0 ? dshNatW : Math.max(dshFb.width, dshOutW()))
      const dshScreenH = () => (dshNatH >= dshOutH() && dshNatH > 0 ? dshNatH : Math.max(dshFb.height, dshOutH()))
      const dshScreenAw = () => Math.min(dshScreenW(), dshNatAw >= dshOutW() && dshNatAw > 0 ? dshNatAw : dshScreenW())
      const dshScreenAh = () => Math.min(dshScreenH(), dshNatAh >= dshOutH() && dshNatAh > 0 ? dshNatAh : dshScreenH())
      const dshColor = () => (dshNatCd > 0 ? dshNatCd : dshFb.colorDepth)
      Object.defineProperty(screen, 'width', { configurable: true, get: dshNativeize(dshScreenW, 'get width') })
      Object.defineProperty(screen, 'height', { configurable: true, get: dshNativeize(dshScreenH, 'get height') })
      Object.defineProperty(screen, 'availWidth', { configurable: true, get: dshNativeize(dshScreenAw, 'get availWidth') })
      Object.defineProperty(screen, 'availHeight', { configurable: true, get: dshNativeize(dshScreenAh, 'get availHeight') })
      Object.defineProperty(screen, 'colorDepth', { configurable: true, get: dshNativeize(dshColor, 'get colorDepth') })
      Object.defineProperty(screen, 'pixelDepth', { configurable: true, get: dshNativeize(dshColor, 'get pixelDepth') })
    } catch {}
  }
} catch {}`
}

/** G11/G24: fixed hardwareConcurrency/deviceMemory; maxTouchPoints keeps a real touch device's value. */
function deviceInfoPatch(options: ResolvedStealthOptions): string {
  const hw = options.hardwareConcurrency
  const mem = options.deviceMemoryGb
  return `// dsh-stealth:deviceInfo — 0/undefined hardwareConcurrency or deviceMemory is a
// headless tell. Values are FIXED per profile (never randomized).
try {
  if (typeof navigator !== 'undefined' && navigator !== null) {
    dshDefineProtoGetter(navigator, 'hardwareConcurrency', ${hw})
    dshDefineProtoGetter(navigator, 'deviceMemory', ${mem})
    if (typeof navigator.maxTouchPoints === 'number') {
      const dshTouch = navigator.maxTouchPoints
      dshDefineProtoGetter(navigator, 'maxTouchPoints', dshTouch > 0 ? dshTouch : 0)
    }
  }
} catch {}`
}

/** G12: headless enumerateDevices() returns []; desktop Chrome always lists devices. */
function mediaDevicesPatch(_options: ResolvedStealthOptions): string {
  return `// dsh-stealth:mediaDevices — an empty device list is a headless tell. Only an
// EMPTY result is replaced (a populated, permission-aware list is left alone);
// labels stay empty exactly as Chrome reports before any device permission.
try {
  if (typeof navigator !== 'undefined' && navigator !== null
    && navigator.mediaDevices !== undefined && navigator.mediaDevices !== null
    && typeof navigator.mediaDevices.enumerateDevices === 'function') {
    const dshOrigEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
    const dshDevices = [
      { deviceId: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0e1', groupId: 'dsh-group-0001', kind: 'audiooutput', label: '' },
      { deviceId: 'b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0e1f2', groupId: 'dsh-group-0002', kind: 'audioinput', label: '' },
      { deviceId: 'c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0e1f2a3', groupId: 'dsh-group-0003', kind: 'videoinput', label: '' },
    ]
    const dshEnumerate = function enumerateDevices() {
      return dshOrigEnumerate().then(function (devices) {
        if (devices !== undefined && devices !== null && devices.length > 0) return devices
        return dshDevices.slice()
      })
    }
    dshNativeize(dshEnumerate, 'enumerateDevices')
    navigator.mediaDevices.enumerateDevices = dshEnumerate
  }
} catch {}`
}

/** G13: navigator.fonts must exist where document.fonts does; status settles on 'loaded'. */
function fontsPatch(_options: ResolvedStealthOptions): string {
  return `// dsh-stealth:fonts — navigator.fonts mirrors document.fonts on current Chrome;
// a stuck document.fonts.status === 'loading' is equally artificial.
try {
  if (typeof document !== 'undefined' && document !== null && document.fonts !== undefined && document.fonts !== null) {
    if (typeof navigator !== 'undefined' && navigator !== null && navigator.fonts === undefined) {
      dshDefineProtoGetter(navigator, 'fonts', document.fonts)
    }
    dshDefineGetter(document.fonts, 'status', 'loaded')
  }
} catch {}`
}

/** G14: navigator.connection story — 4g + fixed rtt/downlink, or a plausible object when absent. */
function connectionPatch(_options: ResolvedStealthOptions): string {
  return `// dsh-stealth:connection — NetworkInformation is stable per machine; report the
// profile's fixed desktop values whether the API exists (coerce) or is missing.
try {
  if (typeof navigator !== 'undefined' && navigator !== null) {
    const dshConn = { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false, type: 'wifi' }
    if (navigator.connection === undefined || navigator.connection === null) {
      // plan07-fix: even the synthetic fallback lives on the prototype —
      // an own 'connection' on the instance is the same class of trace.
      dshDefineProtoGetter(navigator, 'connection', dshConn)
    } else {
      dshDefineProtoGetter(navigator.connection, 'effectiveType', dshConn.effectiveType)
      dshDefineProtoGetter(navigator.connection, 'rtt', dshConn.rtt)
      dshDefineProtoGetter(navigator.connection, 'downlink', dshConn.downlink)
      dshDefineProtoGetter(navigator.connection, 'saveData', dshConn.saveData)
    }
  }
} catch {}`
}

/** G16a: coherent extension list (∩ native) + seeded deterministic readPixels noise. */
function webglNoisePatch(options: ResolvedStealthOptions): string {
  const seed = seedNumber(options.noiseSeed, 'webgl')
  return `// dsh-stealth:webglNoise — the renderer string must come with a matching
// extension list (SwiftShader leaks extras), and readPixels carries a FIXED
// seeded ±1 nibble on a fixed stride: identical across loads, identical for
// identical framebuffers. Rendering itself is never altered.
try {
  const dshSeed = ${seed}
  const dshPreferred = [
    'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float',
    'EXT_float_blend', 'EXT_frag_depth', 'EXT_shader_texture_lod',
    'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic',
    'OES_element_index_uint', 'OES_fbo_render_mipmap', 'OES_standard_derivatives',
    'OES_vertex_array_object', 'WEBGL_color_buffer_float',
    'WEBGL_compressed_texture_s3tc', 'WEBGL_debug_renderer_info',
    'WEBGL_debug_shaders', 'WEBGL_depth_texture', 'WEBGL_draw_buffers',
    'WEBGL_lose_context', 'EXT_clip_control', 'EXT_color_buffer_float',
    'EXT_texture_mirror_clamp_to_edge', 'WEBGL_multi_draw',
  ]
  const dshPatchGl = dshProto => {
    if (dshProto === undefined || dshProto === null) return
    const dshOrigSupported = dshProto.getSupportedExtensions
    if (typeof dshOrigSupported === 'function') {
      const dshSupported = function getSupportedExtensions() {
        const dshNativeList = dshOrigSupported.call(this)
        if (dshNativeList === undefined || dshNativeList === null) return dshPreferred.slice()
        const dshPresent = new Set(dshNativeList)
        return dshPreferred.filter(function (name) { return dshPresent.has(name) })
      }
      dshNativeize(dshSupported, 'getSupportedExtensions')
      dshProto.getSupportedExtensions = dshSupported
    }
    const dshOrigGetExtension = dshProto.getExtension
    if (typeof dshOrigGetExtension === 'function') {
      const dshGetExtension = function getExtension(name) {
        const dshList = typeof this.getSupportedExtensions === 'function' ? this.getSupportedExtensions() : null
        if (dshList !== null && dshList.indexOf(String(name)) === -1) return null
        return dshOrigGetExtension.call(this, name)
      }
      dshNativeize(dshGetExtension, 'getExtension')
      dshProto.getExtension = dshGetExtension
    }
    const dshOrigRead = dshProto.readPixels
    if (typeof dshOrigRead === 'function') {
      const dshReadPixels = function readPixels(x, y, width, height, format, type, pixels) {
        dshOrigRead.call(this, x, y, width, height, format, type, pixels)
        try {
          if (pixels !== null && pixels !== undefined && pixels.BYTES_PER_ELEMENT === 1) {
            for (let i = 13 + (dshSeed % 61); i < pixels.length; i += 61) {
              // Stride 61 is odd, so (i + seed) parity alternates: any run of
              // samples deterministically mixes +0 and +1 for every seed.
              pixels[i] = (pixels[i] + ((i + dshSeed) & 1)) & 255
            }
          }
        } catch {}
      }
      dshNativeize(dshReadPixels, 'readPixels')
      dshProto.readPixels = dshReadPixels
    }
  }
  if (typeof WebGLRenderingContext !== 'undefined') dshPatchGl(WebGLRenderingContext.prototype)
  if (typeof WebGL2RenderingContext !== 'undefined') dshPatchGl(WebGL2RenderingContext.prototype)
} catch {}`
}

/** G15: canvas noise — ONE seeded delta shared by getImageData/toDataURL/toBlob. */
function canvasNoisePatch(options: ResolvedStealthOptions): string {
  const seed = seedNumber(options.noiseSeed, 'canvas')
  return `// dsh-stealth:canvasNoise — a FIXED, content-addressed ±1 RGB delta: the same
// pixels always produce the same noise, so getImageData(), toDataURL() and
// toBlob() agree with each other AND with the previous page load. Random
// per-load noise would betray itself the moment a site remembers us.
try {
  const dshSeed = ${seed}
  if (typeof HTMLCanvasElement !== 'undefined' && typeof document !== 'undefined'
    && typeof CanvasRenderingContext2D !== 'undefined'
    && typeof CanvasRenderingContext2D.prototype.getImageData === 'function') {
    const dshHash = (x, y, channel) => {
      let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(channel, 2246822519) + dshSeed) | 0
      h = Math.imul(h ^ (h >>> 13), 1274126177) | 0
      return ((h ^ (h >>> 16)) >>> 0) % 3 - 1
    }
    const dshNoiseImage = (img, offX, offY) => {
      try {
        const d = img.data
        const w = img.width
        const h = img.height
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const i = (y * w + x) * 4
            d[i] = Math.max(0, Math.min(255, d[i] + dshHash(offX + x, offY + y, 0)))
            d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + dshHash(offX + x, offY + y, 1)))
            d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + dshHash(offX + x, offY + y, 2)))
          }
        }
      } catch {}
      return img
    }
    const dshOrigGetImageData = CanvasRenderingContext2D.prototype.getImageData
    const dshGetImageData = function getImageData(sx, sy, sw, sh) {
      return dshNoiseImage(dshOrigGetImageData.call(this, sx, sy, sw, sh), sx, sy)
    }
    dshNativeize(dshGetImageData, 'getImageData')
    CanvasRenderingContext2D.prototype.getImageData = dshGetImageData
    const dshNoisedCopy = source => {
      const temp = document.createElement('canvas')
      temp.width = source.width
      temp.height = source.height
      const ctx = temp.getContext('2d')
      if (ctx === null || ctx === undefined) return null
      ctx.drawImage(source, 0, 0)
      const img = ctx.getImageData(0, 0, temp.width, temp.height)
      ctx.putImageData(img, 0, 0)
      return temp
    }
    const dshOrigToDataURL = HTMLCanvasElement.prototype.toDataURL
    if (typeof dshOrigToDataURL === 'function') {
      const dshToDataURL = function toDataURL(type, quality) {
        try {
          const temp = dshNoisedCopy(this)
          if (temp !== null) return dshOrigToDataURL.call(temp, type, quality)
        } catch {}
        return dshOrigToDataURL.call(this, type, quality)
      }
      dshNativeize(dshToDataURL, 'toDataURL')
      HTMLCanvasElement.prototype.toDataURL = dshToDataURL
    }
    const dshOrigToBlob = HTMLCanvasElement.prototype.toBlob
    if (typeof dshOrigToBlob === 'function') {
      const dshToBlob = function toBlob(callback, type, quality) {
        try {
          const temp = dshNoisedCopy(this)
          if (temp !== null) return dshOrigToBlob.call(temp, callback, type, quality)
        } catch {}
        return dshOrigToBlob.call(this, callback, type, quality)
      }
      dshNativeize(dshToBlob, 'toBlob')
      HTMLCanvasElement.prototype.toBlob = dshToBlob
    }
  }
} catch {}`
}

/** G16b: AudioContext fingerprint — fixed stride, idempotent per buffer (WeakSet). */
function audioNoisePatch(options: ResolvedStealthOptions): string {
  const seed = seedNumber(options.noiseSeed, 'audio')
  return `// dsh-stealth:audioNoise — ±1e-7 at a FIXED seeded stride: identical across
// loads, and applied at most once per buffer (re-reading must not drift).
try {
  const dshSeed = ${seed}
  if (typeof AudioBuffer !== 'undefined' && typeof AudioBuffer.prototype.getChannelData === 'function') {
    const dshNoised = new WeakSet()
    const dshOrigChannel = AudioBuffer.prototype.getChannelData
    const dshGetChannelData = function getChannelData(channel) {
      const dshData = dshOrigChannel.call(this, channel)
      try {
        if (dshData !== null && dshData !== undefined && dshData.length > 64 && !dshNoised.has(dshData)) {
          for (let i = 11 + (dshSeed % 89); i < dshData.length; i += 97) {
            const dshBit = ((Math.imul(i, 2654435761) + dshSeed) >>> 14) & 1
            dshData[i] = dshData[i] + (dshBit === 1 ? 1e-7 : -1e-7)
          }
          dshNoised.add(dshData)
        }
      } catch {}
      return dshData
    }
    dshNativeize(dshGetChannelData, 'getChannelData')
    AudioBuffer.prototype.getChannelData = dshGetChannelData
  }
} catch {}`
}

/** Sub-pixel rect offsets: the SAME box always yields the SAME offset in both rect APIs. */
function clientRectsPatch(options: ResolvedStealthOptions): string {
  const seed = seedNumber(options.noiseSeed, 'rects')
  return `// dsh-stealth:clientRects — real browsers hand out fractional rects; we add a
// FIXED sub-pixel offset keyed by the box's own rounded coordinates, so
// getBoundingClientRect() and getClientRects()[0] agree exactly.
try {
  const dshSeed = ${seed}
  if (typeof Element !== 'undefined' && typeof Element.prototype.getBoundingClientRect === 'function') {
    const dshDelta = value => {
      const rounded = Math.round(value)
      let h = (Math.imul(rounded, 2654435761) + dshSeed) | 0
      h = (h ^ (h >>> 15)) >>> 0
      return (h % 100) / 100 - 0.5
    }
    const dshOffset = rect => {
      try {
        const dx = dshDelta(rect.x)
        const dy = dshDelta(rect.y)
        rect.x = rect.x + dx
        rect.y = rect.y + dy
      } catch {}
      return rect
    }
    const dshOrigBCR = Element.prototype.getBoundingClientRect
    const dshBCR = function getBoundingClientRect() {
      return dshOffset(dshOrigBCR.call(this))
    }
    dshNativeize(dshBCR, 'getBoundingClientRect')
    Element.prototype.getBoundingClientRect = dshBCR
    if (typeof Element.prototype.getClientRects === 'function') {
      const dshOrigRects = Element.prototype.getClientRects
      const dshRects = function getClientRects() {
        const dshList = dshOrigRects.call(this)
        try {
          for (let i = 0; i < dshList.length; i += 1) dshOffset(dshList[i])
        } catch {}
        return dshList
      }
      dshNativeize(dshRects, 'getClientRects')
      Element.prototype.getClientRects = dshRects
    }
  }
} catch {}`
}

/** Hairline/zoom queries: every resolution/dppx matchMedia query answers from the live devicePixelRatio. */
function hairlinePatch(_options: ResolvedStealthOptions): string {
  return `// dsh-stealth:hairline — resolution / device-pixel-ratio media queries (the
// 0.5px hairline & zoom tests) must answer from the LIVE devicePixelRatio, so
// they can never disagree with the DPR the page measures elsewhere.
try {
  if (typeof window !== 'undefined' && window !== null && typeof window.matchMedia === 'function') {
    const dshOrigMatchMedia = window.matchMedia
    // A regex LITERAL, not a string: a string would lose its backslashes to
    // template-literal escaping and silently degrade into a useless pattern.
    const dshSource = /\\(\\s*(?:-webkit-|-moz-)?(min|max)-([a-z-]*(?:resolution|device-pixel-ratio))\\s*:\\s*([0-9.]+)\\s*(dppx|dpi|dpcm)?\\s*\\)/gi
    const dshComputed = query => {
      const dshRe = dshSource
      dshRe.lastIndex = 0
      const dpr = typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
      let found = false
      let ok = true
      let match = dshRe.exec(String(query))
      while (match !== null) {
        found = true
        let value = parseFloat(match[3])
        const unit = match[4] === undefined ? 'dppx' : match[4]
        if (unit === 'dpi') value = value / 96
        else if (unit === 'dpcm') value = value / 3.7795275591
        if (match[1] === 'min') {
          if (!(dpr >= value)) ok = false
        } else if (!(dpr <= value)) ok = false
        match = dshRe.exec(String(query))
      }
      return found ? ok : null
    }
    const dshMatchMedia = function matchMedia(query) {
      const dshMql = dshOrigMatchMedia.call(window, query)
      const dshInstall = dshComputed(query)
      if (dshInstall !== null) {
        try {
          Object.defineProperty(dshMql, 'matches', {
            configurable: true,
            get: () => {
              const dshNow = dshComputed(query)
              return dshNow === null ? dshInstall : dshNow
            },
          })
        } catch {}
      }
      return dshMql
    }
    dshNativeize(dshMatchMedia, 'matchMedia')
    window.matchMedia = dshMatchMedia
  }
} catch {}`
}

/** G19: Selenium/automation `cdc_`/`$cdc_` document variables. */
function cdcVarsPatch(_options: ResolvedStealthOptions): string {
  return `// dsh-stealth:cdcVars — automation frameworks park $cdc_*/cdc_* variables on
// document/window; only those exact prefixes are deleted, nothing else.
try {
  const dshTargets = [typeof document !== 'undefined' ? document : null, typeof window !== 'undefined' ? window : null]
  for (let t = 0; t < dshTargets.length; t += 1) {
    const dshTarget = dshTargets[t]
    if (dshTarget === null || dshTarget === undefined) continue
    try {
      const dshKeys = Object.getOwnPropertyNames(dshTarget)
      for (let k = 0; k < dshKeys.length; k += 1) {
        if (/^\\$?cdc_/.test(dshKeys[k])) {
          try {
            delete dshTarget[dshKeys[k]]
          } catch {}
        }
      }
    } catch {}
  }
} catch {}`
}

/** G20/G21: Function.prototype.toString reports native code for OUR functions only. */
function funcToStringPatch(_options: ResolvedStealthOptions): string {
  return `// dsh-stealth:funcToString — inspecting a patched getter or wrapper must not
// reveal our script. Only functions WE registered are masked; every page
// function keeps its real source. The interceptor masks itself too.
try {
  const dshOrigToString = Function.prototype.toString
  const dshMaskedToString = function toString() {
    if (dshNativeSet.has(this)) {
      const dshLabel = dshNativeLabels.get(this)
      const dshName = dshLabel !== undefined ? dshLabel : (typeof this.name === 'string' ? this.name : '')
      return 'function ' + dshName + '() { [native code] }'
    }
    return dshOrigToString.call(this)
  }
  dshNativeSet.add(dshMaskedToString)
  try {
    Object.defineProperty(Function.prototype, 'toString', {
      configurable: true,
      writable: true,
      value: dshMaskedToString,
    })
  } catch {}
} catch {}
// Retro-register the two wrappers the original webgl/permissions patches install.
try {
  if (typeof WebGLRenderingContext !== 'undefined' && typeof WebGLRenderingContext.prototype.getParameter === 'function') {
    dshNativeize(WebGLRenderingContext.prototype.getParameter, 'getParameter')
  }
  if (typeof WebGL2RenderingContext !== 'undefined' && typeof WebGL2RenderingContext.prototype.getParameter === 'function') {
    dshNativeize(WebGL2RenderingContext.prototype.getParameter, 'getParameter')
  }
} catch {}
try {
  if (typeof navigator !== 'undefined' && navigator !== null && navigator.permissions !== undefined
    && navigator.permissions !== null && typeof navigator.permissions.query === 'function') {
    dshNativeize(navigator.permissions.query, 'query')
  }
} catch {}`
}

/** The patch table: one entry per patch, in emission order. */
const PATCHES: readonly StealthPatch[] = [
  { name: 'webdriver', build: webdriverPatch },
  { name: 'plugins', build: pluginsPatch },
  { name: 'mimeTypes', build: mimeTypesPatch },
  { name: 'languages', build: languagesPatch },
  { name: 'platform', build: platformPatch },
  { name: 'webgl', build: webglPatch },
  { name: 'notifications', build: notificationsPatch },
  { name: 'permissions', build: permissionsPatch },
  { name: 'chromeRuntime', build: chromeRuntimePatch },
  // plan07: appended after the original nine, in STEALTH_PATCH_NAMES order.
  { name: 'uaCh', build: uaChPatch },
  { name: 'chromeExtras', build: chromeExtrasPatch },
  { name: 'windowMetrics', build: windowMetricsPatch },
  { name: 'deviceInfo', build: deviceInfoPatch },
  { name: 'mediaDevices', build: mediaDevicesPatch },
  { name: 'fonts', build: fontsPatch },
  { name: 'connection', build: connectionPatch },
  { name: 'webglNoise', build: webglNoisePatch },
  { name: 'canvasNoise', build: canvasNoisePatch },
  { name: 'audioNoise', build: audioNoisePatch },
  { name: 'clientRects', build: clientRectsPatch },
  { name: 'hairline', build: hairlinePatch },
  { name: 'cdcVars', build: cdcVarsPatch },
  { name: 'funcToString', build: funcToStringPatch },
]

/**
 * Apply the documented defaults to the caller's options.
 * @param options - caller options; every field is optional.
 * @returns complete option values.
 * @throws Error when `languageValues` is present but empty.
 */
function resolveStealthOptions(options: StealthOptions): ResolvedStealthOptions {
  const languageValues = options.languageValues ?? DEFAULT_LANGUAGE_VALUES
  if (languageValues.length === 0) {
    throw new Error('cdp stealth: languageValues must contain at least one language')
  }
  return {
    languageValues: [...languageValues],
    platformValue: options.platformValue ?? DEFAULT_PLATFORM_VALUE,
    webglVendor: options.webglVendor ?? DEFAULT_WEBGL_VENDOR,
    webglRenderer: options.webglRenderer ?? DEFAULT_WEBGL_RENDERER,
    notificationState: options.notificationState ?? DEFAULT_NOTIFICATION_STATE,
    // plan07: the cross-layer values every new patch embeds.
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    uaChValues: options.uaChValues ?? DEFAULT_UA_CH,
    hardwareConcurrency: options.hardwareConcurrency ?? DEFAULT_HARDWARE_CONCURRENCY,
    deviceMemoryGb: options.deviceMemoryGb ?? DEFAULT_DEVICE_MEMORY_GB,
    screenFallback: options.screenFallback ?? DEFAULT_SCREEN_FALLBACK,
    noiseSeed: options.noiseSeed ?? DEFAULT_NOISE_SEED,
  }
}

/**
 * Build the stealth script for `Page.addScriptToEvaluateOnNewDocument`.
 *
 * The script is plain JavaScript, applies each enabled patch with the marker
 * comment `// dsh-stealth:<name>`, and defines everything it uses. Apply it once
 * per new document; a second application to the same document returns without
 * touching anything.
 *
 * @param options - per-patch toggles and the values those patches embed.
 * @returns the JavaScript source to evaluate in each new document.
 * @throws Error when `languageValues` is present but empty.
 */
export function stealthScript(options: StealthOptions = {}): string {
  const resolved = resolveStealthOptions(options)
  const enabled = PATCHES.filter(patch => options[patch.name] !== false)
  const before = SCRIPT_PREAMBLE
  const body = enabled.map(patch => patch.build(resolved)).join('\n')
  return `${before}${body}\n})()\n`
}
