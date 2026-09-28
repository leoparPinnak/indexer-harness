/**
 * @deepseek-ai/dsh-cdp/stealth-profiles — plan07: ONE source of truth for the
 * browser story every layer tells.
 *
 * Three CDP layers can disagree about the same browser: the JS surface
 * (`stealthScript()` patches), the network headers (`Network.setUserAgentOverride`
 * / `Accept-Language`), and the launch flags (`--lang`). The incident class this
 * module exists to kill is the *coherence tell* — `navigator.languages[0]`
 * saying `en-US` while the wire header says `tr-TR`, or `navigator.userAgentData`
 * brands disagreeing with the `Chrome/<v>` in `User-Agent`.
 *
 * Every value below is FIXED per profile (never randomized per load — random
 * noise is worse than a stable fingerprint; see plan07 §8.3), and every layer
 * derives from the same object through {@link deriveAcceptLanguage},
 * {@link deriveStealthOptions}, and {@link deriveLaunchArgs}.
 *
 * Named `stealth-profiles.ts` (NOT `profiles.ts`) to avoid the plan04 filename
 * collision recorded in 99-IS-AKISI-VE-FAZLAR.md.
 * @module @deepseek-ai/dsh-cdp/stealth-profiles
 */

import type { StealthOptions, UaChValues } from './stealth.ts'

/** One coherent browser identity shared by JS, headers, and flags. */
export interface StealthProfile {
  /** Stable profile id (`cdp_stealth profile` argument). */
  readonly name: string
  /** BCP-47 UI locale — drives `--lang` and the first entry of `languageValues`. */
  readonly locale: string
  /** Ordered preference list — drives JS `navigator.languages` and the wire header. */
  readonly languageValues: readonly string[]
  /** Complete `User-Agent` request header value (single Chrome version source). */
  readonly userAgent: string
  /** `navigator.userAgentData` values, identical to the `Sec-CH-UA*` metadata. */
  readonly uaCh: UaChValues
  /** `navigator.platform` string (layer-specific: 'Win32' ≠ UA-CH 'Windows'). */
  readonly platformValue: string
  /** Chrome major/full version shared by UA and brands (`Chrome/<major>` vs `/<full>`). */
  readonly chromeVersion: string
  /** Screen constants the windowMetrics patch falls back to when native is degenerate. */
  readonly screen: { readonly width: number, readonly height: number, readonly colorDepth: number }
  /** Device numbers the deviceInfo patch reports (fixed — never per-load random). */
  readonly device: { readonly hardwareConcurrency: number, readonly deviceMemoryGb: number }
}

/**
 * The Chrome version every layer reports. Bump in ONE place when the fleet
 * upgrades (plan07 §10.2 risk 1).
 */
const CHROME_FULL = '131.0.0.0'
const CHROME_MAJOR = '131'

/** The three-brand shape current desktop Chrome sends in `Sec-CH-UA`. */
function chromeBrands(): readonly { brand: string, version: string }[] {
  return [
    { brand: 'Google Chrome', version: CHROME_MAJOR },
    { brand: 'Chromium', version: CHROME_MAJOR },
    { brand: 'Not_A Brand', version: '24' },
  ]
}

function fullVersionList(): readonly { brand: string, version: string }[] {
  return [
    { brand: 'Google Chrome', version: CHROME_FULL },
    { brand: 'Chromium', version: CHROME_FULL },
    { brand: 'Not_A Brand', version: '10.0.0.0' },
  ]
}

/** Windows desktop Chrome — the harness's primary deployment profile. */
export const WINDOWS_CHROME_PROFILE: StealthProfile = {
  name: 'windows-chrome',
  locale: 'en-US',
  languageValues: ['en-US', 'en'],
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`,
  uaCh: {
    brands: chromeBrands(),
    fullVersionList: fullVersionList(),
    platform: 'Windows',
    platformVersion: '10.0.0',
    architecture: 'x86',
    bitness: '64',
    model: '',
    mobile: false,
    wow64: false,
  },
  platformValue: 'Win32',
  chromeVersion: CHROME_FULL,
  screen: { width: 1920, height: 1080, colorDepth: 24 },
  device: { hardwareConcurrency: 8, deviceMemoryGb: 8 },
}

/** macOS desktop Chrome. */
export const MACOS_CHROME_PROFILE: StealthProfile = {
  ...WINDOWS_CHROME_PROFILE,
  name: 'macos-chrome',
  userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`,
  uaCh: { ...WINDOWS_CHROME_PROFILE.uaCh, platform: 'macOS', architecture: 'arm', bitness: '64' },
  platformValue: 'MacIntel',
  device: { hardwareConcurrency: 8, deviceMemoryGb: 8 },
}

/** Linux desktop Chrome. */
export const LINUX_CHROME_PROFILE: StealthProfile = {
  ...WINDOWS_CHROME_PROFILE,
  name: 'linux-chrome',
  userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`,
  uaCh: { ...WINDOWS_CHROME_PROFILE.uaCh, platform: 'Linux', architecture: 'x86', bitness: '64' },
  platformValue: 'Linux x86_64',
}

/** Windows Edge — the `Edg/` suffix and Chromium-identical UA-CH brands. */
export const WINDOWS_EDGE_PROFILE: StealthProfile = {
  ...WINDOWS_CHROME_PROFILE,
  name: 'windows-edge',
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36 Edg/${CHROME_FULL}`,
  platformValue: 'Win32',
}

/** Every built-in profile, in `cdp_stealth profile` listing order. */
export const STEALTH_PROFILES: readonly StealthProfile[] = [
  WINDOWS_CHROME_PROFILE,
  MACOS_CHROME_PROFILE,
  LINUX_CHROME_PROFILE,
  WINDOWS_EDGE_PROFILE,
]

/** The profile used when none is selected — also the launch-time default. */
export const DEFAULT_STEALTH_PROFILE: StealthProfile = WINDOWS_CHROME_PROFILE

/** Every built-in profile id, for error messages and tool listings. */
export const STEALTH_PROFILE_NAMES: readonly string[] = STEALTH_PROFILES.map(p => p.name)

/**
 * Resolve a profile by id.
 * @param name - profile id; empty/undefined selects {@link DEFAULT_STEALTH_PROFILE}.
 * @returns the matching profile.
 * @throws Error naming every known profile when `name` is unknown.
 */
export function resolveStealthProfile(name?: string): StealthProfile {
  if (name === undefined || name === '') return DEFAULT_STEALTH_PROFILE
  const found = STEALTH_PROFILES.find(profile => profile.name === name)
  if (found === undefined) {
    throw new Error(`cdp: unknown stealth profile '${name}' (known: ${STEALTH_PROFILE_NAMES.join(', ')})`)
  }
  return found
}

/**
 * Build the `Accept-Language` header from an ordered language list.
 * The first language has no `q`; each next one steps 0.9, 0.8, … so the header
 * and `navigator.languages` always describe the same preference order (G3/G26).
 * @param languageValues - ordered preference list; must not be empty.
 * @returns the header value, e.g. `en-US,en;q=0.9`.
 */
export function deriveAcceptLanguage(languageValues: readonly string[]): string {
  if (languageValues.length === 0) return 'en-US'
  return languageValues
    .map((lang, index) => (index === 0 ? lang : `${lang};q=${Math.max(0.1, 0.9 - 0.1 * (index - 1)).toFixed(1)}`))
    .join(',')
}

/**
 * Project a profile onto {@link StealthOptions} — the JS half of the story.
 * @param profile - the resolved profile.
 * @param overrides - caller toggles applied last (adapter `stealthOverrides` shape).
 * @returns options safe to pass to `stealthScript()`.
 */
export function deriveStealthOptions(
  profile: StealthProfile,
  overrides: Partial<StealthOptions> = {},
): StealthOptions {
  return {
    languageValues: [...profile.languageValues],
    platformValue: profile.platformValue,
    userAgent: profile.userAgent,
    uaChValues: profile.uaCh,
    hardwareConcurrency: profile.device.hardwareConcurrency,
    deviceMemoryGb: profile.device.deviceMemoryGb,
    screenFallback: profile.screen,
    ...overrides,
  }
}

/**
 * Launch flags every profile story needs (G1/G26): disable the blink feature
 * that exposes `navigator.webdriver`, and pin the UI locale to the same value
 * the JS layers report.
 * @param profile - the resolved profile.
 * @returns the flag list, already deduplicated-safe to append to extraArgs.
 */
export function deriveLaunchArgs(profile: StealthProfile): string[] {
  return [
    '--disable-blink-features=AutomationControlled',
    `--lang=${profile.locale}`,
  ]
}
