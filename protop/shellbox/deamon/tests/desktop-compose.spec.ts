/**
 * Bug B pin — a requested desktop must compose, and the user's real desktop
 * needs an explicit opt-in.
 *
 * Production evidence: a helper ran with `desktop=Default natural=4417x2429`
 * and went on streaming — the isolated desktop had silently degraded to the
 * host's real screen. Measured on this machine, `CreateDesktop("Default")`
 * succeeds and IS that screen (it owns 600 windows), while a private name that
 * will not compose fails at `CreateDesktopW` with a real Win32 error. The fix:
 * `-DesktopName Default` refuses without `-AllowHostDesktop` (the bridge sends
 * the switch only for an explicit host-desktop request), a failed compose exits
 * non-zero with a stderr line naming the desktop and the Win32 error, and a
 * composed handle is verified by name before anything is captured.
 *
 * Fail-before semantics:
 * - the refusal test: before the fix this very run exited 0 and printed
 *   `target=…` — it composed the real desktop and captured it (measured 600
 *   windows), so asserting non-zero + stderr + no `target=` fails on old code;
 * - the compose-failure test: before the fix the only diagnostic was
 *   `CreateDesktop failed (err=…)` via Write-Error, which never names the
 *   desktop, so the `desktop '…' failed to compose` assertion fails on old code;
 * - the opt-in test: before the fix no spawn ever passed `-AllowHostDesktop`,
 *   so the stand-in helper can only answer `allowhost=False` for the host
 *   desktop and the `allowhost=True` assertion fails on old code.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  internals,
  SandboxController,
  SandboxSessionManager,
  type SandboxLogger,
} from '../src/sandbox.ts'

const HELPER = fileURLToPath(new URL('../sandbox/sandbox-host.ps1', import.meta.url))

const wait = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** Run the real helper headlessly; every fixture here exits before any stream. */
function runHelper(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  )
}

/**
 * A deterministic stand-in that echoes the parameters it parsed back on
 * stderr, so a spec can prove which spawn flags the bridge passed — no
 * desktop is composed by it.
 */
const PARAM_ECHO_HELPER = `
param([switch]$Stream, [int]$Width = 800, [int]$Height = 600, [int]$Fps = 8, [string]$DesktopName = 'x', [string]$CommandFile = '', [string]$InputDir = '', [switch]$AllowHostDesktop)
[Console]::Error.WriteLine("fake allowhost=$AllowHostDesktop desktop=$DesktopName")
$n = 0
while ($n -lt 4000) {
  if ($CommandFile -ne '' -and (Test-Path -LiteralPath $CommandFile)) {
    $text = Get-Content -LiteralPath $CommandFile -Raw -ErrorAction SilentlyContinue
    if ($null -ne $text -and $text.Trim() -ne '') {
      Remove-Item -LiteralPath $CommandFile -Force -ErrorAction SilentlyContinue
      if ($text -match 'quit') { break }
    }
  }
  $n++
  Start-Sleep -Milliseconds 20
}
[Environment]::Exit(0)
`

describe('private desktop composition', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-compose-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('refuses to stream the interactive desktop without the explicit opt-in', () => {
    const out = runHelper(['-CaptureOnce', '-DesktopName', 'Default', '-Out', join(tempDir, 'never.png')])
    expect(out.status).not.toBe(0)
    expect(out.stderr).toContain("'Default'")
    expect(out.stderr).toContain('-AllowHostDesktop')
    // The refusal precedes composition: nothing was captured, nothing streamed.
    expect(out.stdout).not.toContain('target=')
    expect(existsSync(join(tempDir, 'never.png'))).toBe(false)
  }, 60000)

  it('exits non-zero with a stderr line naming the desktop when it will not compose', () => {
    // 'a\b' is a deterministic CreateDesktopW failure: ERROR_INVALID_NAME
    // (161, measured on this host), before any shell or capture exists.
    const out = runHelper(['-CaptureOnce', '-DesktopName', 'a\\b', '-Out', join(tempDir, 'never.png')])
    expect(out.status).not.toBe(0)
    expect(out.stderr).toContain("desktop 'a\\b' failed to compose")
    expect(out.stderr).toMatch(/CreateDesktopW error=\d+/)
    expect(out.stdout).not.toContain('target=')
    expect(existsSync(join(tempDir, 'never.png'))).toBe(false)
  }, 60000)

  it('passes -AllowHostDesktop only for the explicitly requested host desktop', async () => {
    const helperPath = join(tempDir, 'echo-helper.ps1')
    writeFileSync(helperPath, PARAM_ECHO_HELPER)
    const savedScript = internalsSnapshot(helperPath)
    const lines: string[] = []
    const log: SandboxLogger = {
      info: (msg) => { lines.push(msg) },
      warn: () => {},
      error: () => {},
      debug: () => {},
    }
    try {
      // The manager side of the opt-in chain: the default path composes a
      // private desktop, and only the explicit target reaches 'Default'.
      const manager = new SandboxSessionManager(log, { persistencePath: false })
      expect(manager.get().desktop).toBe('dsh-shellbox')
      expect(manager.get(undefined, undefined, 'host-desktop').desktop).toBe('Default')

      const host = new SandboxController(log, 'Default', 'host-desktop')
      expect(host.launch('notepad.exe')).toBe(true)
      await waitForLine(lines, 'fake allowhost=True desktop=Default')
      await host.stop()

      lines.length = 0
      const priv = new SandboxController(log, 'dsh-shellbox', '')
      expect(priv.launch('notepad.exe')).toBe(true)
      await waitForLine(lines, 'fake allowhost=False desktop=dsh-shellbox')
      await priv.stop()
    } finally {
      restoreInternals()
    }
  }, 60000)
})

/** Saved seam values restored after the stand-in runs. */
let savedScript = ''
let savedCommandFile = ''
function internalsSnapshot(helperPath: string): void {
  savedScript = internals.helperScript
  savedCommandFile = internals.commandFile
  internals.helperScript = helperPath
  internals.commandFile = ''
}
function restoreInternals(): void {
  internals.helperScript = savedScript
  internals.commandFile = savedCommandFile
}

/** Poll the captured helper log until it carries the stand-in's echo line. */
async function waitForLine(lines: readonly string[], needle: string): Promise<void> {
  const deadline = Date.now() + 20000
  for (;;) {
    if (lines.some((line) => line.includes(needle))) return
    if (Date.now() >= deadline) throw new Error(`never saw "${needle}" in helper log: ${lines.join(' | ')}`)
    await wait(50)
  }
}
