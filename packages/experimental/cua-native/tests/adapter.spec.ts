/**
 * Adapter identity, capability descriptor, and the compile-time contract check
 * against the benchmark's `GuiBackend` (the host program type-checks both the
 * benchmark sources and this package's tests, so the assertion below is real).
 */

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import type { GuiBackend } from '../../../../benchmarks/gui-motor/src/backend.ts'
import {
  codexNativeBackendIdentity,
  codexNativeCapabilities,
  createCodexNativeBackend,
  type CodexNativeBackend,
} from '../src/index.ts'

const STUB = fileURLToPath(new URL('./fixtures/helper-stub.mjs', import.meta.url))

/** Type-level conformance: CodexNativeBackend is usable as the harness contract. */
function asHarnessBackend(backend: CodexNativeBackend): GuiBackend {
  return backend
}

describe('capability descriptor', () => {
  it('locks the Codex-native mechanism claims', () => {
    expect(codexNativeCapabilities).toEqual({ nativeInjection: true, comUia: true, capturesWinRt: true })
  })

  it('keeps the harness identity stable and never labeled MOCK', () => {
    expect(codexNativeBackendIdentity).toEqual({
      id: 'codex-native',
      label: 'CodexNative (COM UIA + SendInput + WGC)',
      mock: false,
    })
  })
})

describe('createCodexNativeBackend', () => {
  it('spawns the helper at construction and exposes a conforming backend', async () => {
    const backend = createCodexNativeBackend({ helperPath: process.execPath, helperArgs: [STUB] })
    try {
      expect(backend.id).toBe('codex-native')
      expect(backend.mock).toBe(false)
      expect(backend.capabilities).toEqual({ nativeInjection: true, comUia: true, capturesWinRt: true })
      expect(backend.client.pid).toBeTypeOf('number')
      // Compile-time GuiBackend conformance plus the identity a result row reads.
      const harness: GuiBackend = asHarnessBackend(backend)
      expect(harness.id).toBe('codex-native')
      expect(typeof harness.sendInput).toBe('function')
      expect(typeof harness.readUia).toBe('function')
      expect(typeof harness.capture).toBe('function')
    } finally {
      await backend.client.close()
    }
    await backend.client.exited
  })
})
