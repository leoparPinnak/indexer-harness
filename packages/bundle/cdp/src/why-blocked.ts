/**
 * plan07 A11 — "why blocked" classification: turn a page probe's evidence into
 * an ordered, human-readable reason list explaining which tell would give the
 * automation away.
 *
 * This is a PURE function over plain data: no CDP, no page access, no side
 * effects — `cdp_fingerprint` collects the evidence with one `Runtime.evaluate`
 * probe and calls {@link classifyWhyBlocked} here. Reasons are ordered by
 * severity (critical → high → medium → low), and every reason names the layer
 * it lives on: `js` (script-visible surface), `dom` (automation variables /
 * injected objects), `header` (wire/story divergence), or `behavior` (what the
 * page observes over time).
 *
 * This module only classifies why a page would reject automation; it changes
 * no page state.
 * @module @deepseek-ai/dsh-cdp/why-blocked
 */

/** Severity of one why-blocked reason, highest first in the output order. */
export type WhyBlockedSeverity = 'critical' | 'high' | 'medium' | 'low'

/** Which layer carries the tell. */
export type WhyBlockedLayer = 'js' | 'dom' | 'header' | 'behavior'

/** One ordered reason why the page would (or did) classify us as automation. */
export interface WhyBlockedReason {
  /** Stable machine code, e.g. `A11-webdriver`. */
  readonly code: string
  /** Severity — reasons come back sorted critical → low. */
  readonly severity: WhyBlockedSeverity
  /** Layer the tell lives on. */
  readonly layer: WhyBlockedLayer
  /** One-sentence explanation an agent can act on. */
  readonly message: string
  /** The concrete observed value that triggered the reason. */
  readonly evidence: string
}

/**
 * Evidence collected by the fingerprint probe. Every field is optional: an
 * absent field simply produces no reason for that rule.
 */
export interface WhyBlockedEvidence {
  /** `navigator.webdriver` as observed (true = automation flag up). */
  readonly webdriver?: boolean | null
  /** `navigator.userAgent` string. */
  readonly userAgent?: string | null
  /** `navigator.platform` string. */
  readonly platform?: string | null
  /** `navigator.languages` order. */
  readonly languages?: readonly string[] | null
  /** `navigator.userAgentData.platform`. */
  readonly uaChPlatform?: string | null
  /** `navigator.plugins.length`. */
  readonly pluginsLength?: number | null
  /** Whether `window.chrome` exists at all. */
  readonly hasChrome?: boolean | null
  /** Whether `window.chrome.runtime` is present (extension leak on ordinary pages). */
  readonly chromeHasRuntime?: boolean | null
  /** Whether `chrome.csi`/`chrome.loadTimes` exist (missing = automation tell). */
  readonly chromeHasExtras?: boolean | null
  /** `document.fonts.status`. */
  readonly fontsStatus?: string | null
  /** `navigator.connection.effectiveType`. */
  readonly connectionType?: string | null
  /** Automation-prefixed keys found on document/window (`$cdc_`, `__webdriver_`, …). */
  readonly automationKeys?: readonly string[] | null
  /** Whether screen covers the browser window (false in degenerate headless). */
  readonly screenCoversWindow?: boolean | null
  /** plan07-fix: navigator INSTANCE own keys that real Chrome keeps on Navigator.prototype (`webdriver`, `languages`, …). */
  readonly navigatorOwnKeys?: readonly string[] | null
  /** plan07-fix: properties where the prototype getter's answer differs from the instance's (native 32 vs patched 8, raw vs profile languages). */
  readonly protoInstanceMismatches?: readonly string[] | null
  /** plan07-fix: `navigator.userAgentData.brands` major version — the JS side of the UA-CH story. */
  readonly uaChBrandMajor?: string | null
  /** plan07-fix: language tags carrying `;q=` parameters — an Accept-Language header string split into navigator.languages. */
  readonly languagesWithQ?: readonly string[] | null
  /** plan07-fix: `navigator.plugins[0] instanceof Plugin` (false = plugin objects are fabricated). */
  readonly pluginInstanceof?: boolean | null
}

const SEVERITY_ORDER: Record<WhyBlockedSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

/**
 * Classify probe evidence into ordered why-blocked reasons.
 * @param evidence - plain observations from the page probe; missing fields are skipped.
 * @returns reasons sorted critical → high → medium → low (stable within a tier).
 */
export function classifyWhyBlocked(evidence: WhyBlockedEvidence): WhyBlockedReason[] {
  const reasons: WhyBlockedReason[] = []

  if (evidence.webdriver === true) {
    reasons.push({
      code: 'A11-webdriver',
      severity: 'critical',
      layer: 'js',
      message: 'navigator.webdriver reports true — the page sees the automation flag directly.',
      evidence: 'navigator.webdriver === true (launch without --disable-blink-features=AutomationControlled?)',
    })
  }

  const automationKeys = evidence.automationKeys ?? []
  if (automationKeys.length > 0) {
    reasons.push({
      code: 'A11-automation-vars',
      severity: 'critical',
      layer: 'dom',
      message: 'Automation variables are visible on document/window — a direct Selenium/CDP signature.',
      evidence: automationKeys.join(', '),
    })
  }

  if (evidence.chromeHasRuntime === true) {
    reasons.push({
      code: 'A11-chrome-runtime',
      severity: 'high',
      layer: 'dom',
      message: 'window.chrome.runtime exists on an ordinary page — only the automation extension publishes it.',
      evidence: 'window.chrome.runtime present',
    })
  }

  const uaChromeMajor = evidence.userAgent != null ? /Chrome\/(\d+)/.exec(evidence.userAgent)?.[1] : undefined
  if (evidence.userAgent != null && evidence.uaChPlatform != null && uaChromeMajor === undefined) {
    reasons.push({
      code: 'A11-ua-chrome-missing',
      severity: 'high',
      layer: 'header',
      message: 'User-Agent carries no Chrome/<major> token while UA-CH claims a Chrome platform — the two stories diverge.',
      evidence: evidence.userAgent,
    })
  }

  // A Windows UA-CH platform with a non-Windows navigator.platform is a
  // coherence break the page can read without any network access.
  if (evidence.platform != null && evidence.uaChPlatform === 'Windows' && !evidence.platform.startsWith('Win')) {
    reasons.push({
      code: 'A11-platform-coherence',
      severity: 'high',
      layer: 'header',
      message: 'UA-CH says Windows while navigator.platform does not — layers tell different stories (G4/G9).',
      evidence: `uaChPlatform=${evidence.uaChPlatform} platform=${evidence.platform}`,
    })
  }

  if (evidence.pluginsLength === 0) {
    reasons.push({
      code: 'A11-empty-plugins',
      severity: 'medium',
      layer: 'js',
      message: 'navigator.plugins is empty — desktop Chrome always ships the PDF viewer set.',
      evidence: 'plugins.length === 0',
    })
  }

  if (evidence.hasChrome === false || evidence.chromeHasExtras === false) {
    reasons.push({
      code: 'A11-missing-chrome-extras',
      severity: 'medium',
      layer: 'js',
      message: 'window.chrome or its csi()/loadTimes() helpers are missing — headless automation surface.',
      evidence: `hasChrome=${String(evidence.hasChrome)} chromeHasExtras=${String(evidence.chromeHasExtras)}`,
    })
  }

  if (evidence.screenCoversWindow === false) {
    reasons.push({
      code: 'A11-screen-window',
      severity: 'medium',
      layer: 'behavior',
      message: 'The reported screen is smaller than the browser window — a degenerate headless geometry.',
      evidence: 'screen does not cover outerWidth/outerHeight',
    })
  }

  /* ── plan07-fix: real-vs-forged structure checks (T1 §4) ─────────────── */

  if (evidence.navigatorOwnKeys != null && evidence.navigatorOwnKeys.length > 0) {
    reasons.push({
      code: 'A11-own-prop-trace',
      severity: 'critical',
      layer: 'js',
      message: 'navigator carries patched properties as INSTANCE own keys — real Chrome keeps them on Navigator.prototype, and _.has(navigator,"webdriver")-style probes read own keys.',
      evidence: `own: ${evidence.navigatorOwnKeys.join(', ')}`,
    })
  }

  if (evidence.protoInstanceMismatches != null && evidence.protoInstanceMismatches.length > 0) {
    reasons.push({
      code: 'A11-prototype-mismatch',
      severity: 'critical',
      layer: 'js',
      message: 'Prototype getters and instance reads disagree (native vs patched values) — a detector sees two answers for one property.',
      evidence: `mismatch: ${evidence.protoInstanceMismatches.join(', ')}`,
    })
  }

  // uaChromeMajor comes from the A11-ua-chrome-missing rule above (same run).
  if (
    evidence.uaChBrandMajor != null && evidence.uaChBrandMajor !== ''
    && uaChromeMajor != null && evidence.uaChBrandMajor !== uaChromeMajor
  ) {
    reasons.push({
      code: 'A11-ua-ch-version-mismatch',
      severity: 'high',
      layer: 'header',
      message: 'UA-CH brands advertise a different Chrome major than navigator.userAgent — the two version stories disagree (G9/G4).',
      evidence: `uaChMajor=${evidence.uaChBrandMajor} uaMajor=${uaChromeMajor}`,
    })
  }

  if (evidence.languagesWithQ != null && evidence.languagesWithQ.length > 0) {
    reasons.push({
      code: 'A11-languages-q-pollution',
      severity: 'high',
      layer: 'header',
      message: 'navigator.languages contains Accept-Language-style tags with ";q=" parameters — an HTTP header string leaked into the JS language list.',
      evidence: `tags: ${evidence.languagesWithQ.join(', ')}`,
    })
  }

  if (evidence.pluginInstanceof === false) {
    reasons.push({
      code: 'A11-plugin-instance',
      severity: 'medium',
      layer: 'js',
      message: 'navigator.plugins[0] is not an instance of Plugin — the plugin list is fabricated from plain objects.',
      evidence: 'plugins[0] instanceof Plugin === false',
    })
  }

  if (evidence.fontsStatus === 'loading') {
    reasons.push({
      code: 'A11-fonts-stuck',
      severity: 'low',
      layer: 'behavior',
      message: 'document.fonts.status stays "loading" outside an active load — an artificial document.',
      evidence: 'fonts.status === "loading"',
    })
  }

  if (evidence.connectionType != null && evidence.connectionType !== '4g') {
    reasons.push({
      code: 'A11-connection-story',
      severity: 'low',
      layer: 'js',
      message: 'navigator.connection reports a non-4g effective type — a fixed profile value was expected.',
      evidence: `effectiveType=${evidence.connectionType}`,
    })
  }

  return reasons.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}
