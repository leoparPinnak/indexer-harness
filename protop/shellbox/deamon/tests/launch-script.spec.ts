/**
 * Bug A pin — launch payloads survive verbatim.
 *
 * A `shellbox_launch` payload carrying quotes, backticks, `$`, or `&` used to
 * ship as `powershell.exe … -Command "<payload>"`, where the Windows
 * command-line quote pass stripped the payload's embedded quotes before
 * PowerShell parsed the command and shredded the script (the production
 * `Add-Type SOURCE_CODE_ERROR` run: `[DllImport(`user32.dll`)]` reached the
 * compiler with its quotes gone and its backticks intact). The fix removes the
 * quoting layers structurally: the bridge splits the launch at the first
 * `-Command` token, stages the payload byte-for-byte as a BOM-marked script
 * beside the command file, and forwards `-File` instead.
 *
 * Fail-before semantics for every test in this file: before the fix there was
 * no `splitPowerShellCommandPayload` export (the import itself fails), no
 * `<commandFile>.launch` directory, and the drained command carried the raw
 * `-Command "…"` line — so each structural assertion below fails on the old
 * code, and the fixture execution proves the staged script really runs with the
 * payload intact rather than only on paper.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { internals, SandboxController, splitPowerShellCommandPayload, type SandboxLogger } from '../src/sandbox.ts'

const wait = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * Minimal deterministic stand-in for the shipped helper: it drains the command
 * file to `<commandFile>.drained` and honours `quit`, through the real
 * PowerShell interpreter, so the bridge's spawn and launch staging are
 * exercised without a desktop.
 */
const DRAIN_HELPER = `
param([switch]$Stream, [int]$Width = 800, [int]$Height = 600, [int]$Fps = 8, [string]$DesktopName = 'x', [string]$CommandFile = '', [string]$InputDir = '')
$n = 0
while ($n -lt 4000) {
  if ($CommandFile -ne '' -and (Test-Path -LiteralPath $CommandFile)) {
    $text = Get-Content -LiteralPath $CommandFile -Raw -ErrorAction SilentlyContinue
    if ($null -ne $text -and $text.Trim() -ne '') {
      Remove-Item -LiteralPath $CommandFile -Force -ErrorAction SilentlyContinue
      Add-Content -LiteralPath ($CommandFile + '.drained') -Value $text.Trim()
      if ($text -match 'quit') { break }
    }
  }
  $n++
  Start-Sleep -Milliseconds 20
}
[Environment]::Exit(0)
`

/** A helper that dies on its own before draining anything: the crash path. */
const CRASH_HELPER = `
param([switch]$Stream, [int]$Width = 800, [int]$Height = 600, [int]$Fps = 8, [string]$DesktopName = 'x', [string]$CommandFile = '', [string]$InputDir = '')
Start-Sleep -Milliseconds 400
[Environment]::Exit(1)
`

/** The payload every hostile character must cross intact: `' " ` $ &`. */
const EXPECTED = 'quote " double, quote \' single, backtick `, dollar $x, amp &'
const PAYLOAD = `$s = '${EXPECTED.replace(/'/gu, "''")}'\nWrite-Output $s`
const LAUNCH_COMMAND = 'powershell.exe -NoProfile -NonInteractive -Command "' + PAYLOAD + '"'

const silent: SandboxLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

describe('shellbox launch script materialisation', () => {
  let tempDir: string
  let commandFile: string
  let savedScript: string
  let savedCommandFile: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-launch-script-'))
    writeFileSync(join(tempDir, 'drain-helper.ps1'), DRAIN_HELPER)
    commandFile = join(tempDir, 'commands.cmd')
    savedScript = internals.helperScript
    savedCommandFile = internals.commandFile
    internals.helperScript = join(tempDir, 'drain-helper.ps1')
    internals.commandFile = commandFile
  })

  afterEach(() => {
    internals.helperScript = savedScript
    internals.commandFile = savedCommandFile
    rmSync(tempDir, { recursive: true, force: true })
  })

  /** Poll the fake helper's drained marker until it carries content. */
  async function waitForDrained(timeoutMs = 15000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        const text = readFileSync(`${commandFile}.drained`, 'utf8')
        if (text.trim() !== '') return text
      } catch {
        // The marker appears only once the helper has drained the command file.
      }
      if (Date.now() >= deadline) throw new Error('the fake helper never wrote the drained marker')
      await wait(50)
    }
  }

  it('splits a hostile -Command payload verbatim and passes every other launch through', () => {
    // Fail-before: this function did not exist; the payload stayed inside the
    // -Command "…" line and lost its quotes to the command-line parse. The
    // equality below pins byte-for-byte extraction of ', ", `, $, and &.
    const split = splitPowerShellCommandPayload(LAUNCH_COMMAND)
    expect(split).toBeDefined()
    expect(split?.prefix).toBe('powershell.exe -NoProfile -NonInteractive')
    expect(split?.payload).toBe(PAYLOAD)

    // A pwsh multi-line payload with no quote wrapper stays untouched as well.
    const multiline = 'pwsh -NoProfile -Command Write-Output one\nWrite-Output two'
    expect(splitPowerShellCommandPayload(multiline)).toEqual({
      prefix: 'pwsh -NoProfile',
      payload: 'Write-Output one\nWrite-Output two',
    })

    // EncodedCommand already is the no-quotes form; other executables and the
    // empty payload must keep flowing through unchanged.
    expect(splitPowerShellCommandPayload('pwsh -EncodedCommand AAA=')).toBeUndefined()
    expect(splitPowerShellCommandPayload('powershell.exe -Command')).toBeUndefined()
    expect(splitPowerShellCommandPayload('notepad.exe')).toBeUndefined()
    expect(splitPowerShellCommandPayload('conhost.exe wsl.exe -d Ubuntu -- ls')).toBeUndefined()
  })

  it('runs the staged script with the payload byte-identical and removes it on stop', async () => {
    const controller = new SandboxController(silent, 'dsh-shellbox', '')
    try {
      expect(controller.launch(LAUNCH_COMMAND)).toBe(true)
      const drained = await waitForDrained()

      // The -Command layer is gone from the wire: only the -File form drains.
      expect(drained).toContain('launch powershell.exe -NoProfile -NonInteractive -File "')
      expect(drained).not.toContain('-Command')

      const match = /-File "([^"]+)"/u.exec(drained)
      expect(match).not.toBeNull()
      const scriptPath = match?.[1] ?? ''
      expect(existsSync(scriptPath)).toBe(true)

      // The staged bytes: UTF-8 BOM (PS 5.1 reads BOM-less UTF-8 as ANSI) plus
      // the payload exactly as supplied.
      const staged = readFileSync(scriptPath)
      expect([...staged.subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF])
      expect(staged.subarray(3).toString('utf8')).toBe(PAYLOAD)

      // Fixture execution: the script really runs and observes every hostile
      // character — no desktop, no stream, just powershell -File.
      const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
      })
      expect(run.status).toBe(0)
      expect(run.stdout.trim()).toBe(EXPECTED)
    } finally {
      await controller.stop()
    }
    // Stop owns the cleanup: the staged directory goes with the spool.
    expect(existsSync(`${commandFile}.launch`)).toBe(false)
  }, 60000)

  it('removes staged scripts when the helper dies without a stop', async () => {
    writeFileSync(join(tempDir, 'drain-helper.ps1'), CRASH_HELPER)
    const controller = new SandboxController(silent, 'dsh-shellbox', '')
    try {
      // Staging happens synchronously in launch(), before the helper's death is
      // noticed; the crash settle is what must reap the directory.
      controller.launch(LAUNCH_COMMAND)
      const deadline = Date.now() + 20000
      while (controller.isActive() && Date.now() < deadline) await wait(50)
      expect(controller.isActive()).toBe(false)
      const reapDeadline = Date.now() + 5000
      while (existsSync(`${commandFile}.launch`) && Date.now() < reapDeadline) await wait(50)
      expect(existsSync(`${commandFile}.launch`)).toBe(false)
    } finally {
      await controller.stop()
    }
  }, 60000)
})
