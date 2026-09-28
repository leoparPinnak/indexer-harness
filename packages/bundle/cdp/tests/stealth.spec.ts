/**
 * Unit tests for the stealth script generator: syntax validity, patch presence,
 * individual patch disablement, custom value substitution, and idempotency.
 */

import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  STEALTH_PATCH_MARKER_PREFIX,
  STEALTH_PATCH_NAMES,
  stealthScript,
} from '../src/stealth.ts'

describe('stealthScript', () => {
  it('generates syntactically valid JavaScript', () => {
    const script = stealthScript()
    expect(script).toContain('(() => {')
    expect(script).toContain('})()')
    // Evaluates without throwing a SyntaxError.
    expect(() => new Script(script)).not.toThrow()
  })

  it('includes all documented patch markers by default', () => {
    const script = stealthScript()
    for (const name of STEALTH_PATCH_NAMES) {
      expect(script).toContain(`${STEALTH_PATCH_MARKER_PREFIX}${name}`)
    }
  })

  it('omits disabled patches when option is set to false', () => {
    const script = stealthScript({
      webdriver: false,
      chromeRuntime: false,
      plugins: false,
    })
    expect(script).not.toContain(`${STEALTH_PATCH_MARKER_PREFIX}webdriver`)
    expect(script).not.toContain(`${STEALTH_PATCH_MARKER_PREFIX}chromeRuntime`)
    expect(script).not.toContain(`${STEALTH_PATCH_MARKER_PREFIX}plugins`)
    // Other patches remain
    expect(script).toContain(`${STEALTH_PATCH_MARKER_PREFIX}languages`)
    expect(script).toContain(`${STEALTH_PATCH_MARKER_PREFIX}webgl`)
  })

  it('embeds custom options into the generated script', () => {
    const script = stealthScript({
      platformValue: 'CustomPlatformX',
      webglVendor: 'CustomVendorCorp',
      webglRenderer: 'CustomGPU_9000',
      notificationState: 'denied',
      languageValues: ['tr-TR', 'tr'],
    })
    expect(script).toContain('CustomPlatformX')
    expect(script).toContain('CustomVendorCorp')
    expect(script).toContain('CustomGPU_9000')
    expect(script).toContain('denied')
    expect(script).toContain('tr-TR')
  })

  it('is idempotent and protects against double application', () => {
    const script = stealthScript()
    expect(script).toContain('if (dshGlobal.__dshStealthInstalled === true) return')
  })

  it('throws an error when languageValues is empty', () => {
    expect(() => stealthScript({ languageValues: [] })).toThrow(
      'cdp stealth: languageValues must contain at least one language',
    )
  })
})
