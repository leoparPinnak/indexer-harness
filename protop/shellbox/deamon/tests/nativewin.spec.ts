/**
 * D8 native-Win32 surface: the additive `input mode` grammar, the `uia`
 * accessibility route's clamping contract, the frozen-protocol edits
 * (`PROTOCOL.md` grammar row and the rewritten SendInput paragraph), and the
 * helper's compiled interop — SendInput struct layout, the input-desktop gate,
 * and the uniform-black capture key. Desktop-dependent pieces (a live UIA walk,
 * a live composite) live behind `d8-desktop.spec.ts`; everything here runs
 * without a window.
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import {
  handleSandboxInputLocal,
  handleSandboxUiaLocal,
  parseInputEvents,
  parseInputMode,
  parseUiaResult,
  SandboxSessionManager,
  shellboxInputLines,
  type SandboxLogger,
} from '../src/sandbox.ts'
import type { ShellboxInputEvent } from '../src/types.ts'

const PROTOCOL = fileURLToPath(new URL('../sandbox/PROTOCOL.md', import.meta.url))
const HELPER = fileURLToPath(new URL('../sandbox/sandbox-host.ps1', import.meta.url))

/** Minimal request stand-in: method plus optional query, no socket. */
function makeRequest(method: string, body?: string, urlPath = '/'): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [body])
  return Object.assign(stream, { method, url: urlPath }) as unknown as IncomingMessage
}

/** A manager with no sessions: every route reaches its refusal without a helper. */
function emptyManager(): SandboxSessionManager {
  const log: SandboxLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return new SandboxSessionManager(log, { persistencePath: false })
}

const EVENTS: ShellboxInputEvent[] = [
  { t: 'move', x: 10, y: 20 },
  { t: 'button', b: 'left', p: 'down' },
  { t: 'wheel', dx: 0, dy: -120 },
  { t: 'key', vk: 65, p: 'down' },
  { t: 'char', c: 65 },
]

describe('input mode grammar', () => {
  it('parses both modes and defaults an absent mode to post', () => {
    expect(parseInputMode(undefined)).toEqual({ ok: true, mode: 'post' })
    expect(parseInputMode(null)).toEqual({ ok: true, mode: 'post' })
    expect(parseInputMode('post')).toEqual({ ok: true, mode: 'post' })
    expect(parseInputMode('send')).toEqual({ ok: true, mode: 'send' })
    expect(parseInputMode('synth')).toEqual({ ok: false, error: 'mode must be one of post, send' })
    expect(parseInputMode(1)).toEqual({ ok: false, error: 'mode must be one of post, send' })
  })

  it('renders post batches exactly as the pre-mode grammar did', () => {
    expect(shellboxInputLines(EVENTS)).toEqual([
      'input move 10 20',
      'input button left down',
      'input wheel 0 -120',
      'input key 65 down',
      'input char 65',
    ])
    expect(shellboxInputLines([], 'post')).toEqual([])
  })

  it('opens a send batch with its mode line and keeps every event line after it', () => {
    expect(shellboxInputLines(EVENTS, 'send')).toEqual([
      'input mode send',
      'input move 10 20',
      'input button left down',
      'input wheel 0 -120',
      'input key 65 down',
      'input char 65',
    ])
    // The mode line is a batch header: an empty send batch still carries it so
    // the helper's gate re-evaluates, but it never counts as an event.
    expect(shellboxInputLines([], 'send')).toEqual(['input mode send'])
  })

  it('keeps the frozen wire caps under either mode', () => {
    const batch = (count: number): unknown[] => Array.from({ length: count }, () => ({ t: 'move', x: 0, y: 0 }))
    expect(parseInputEvents(batch(64)).ok).toBe(true)
    const tooMany = parseInputEvents(batch(65))
    expect(tooMany).toEqual({ ok: false, error: 'events must hold at most 64 entries' })
    expect(parseInputEvents([{ t: 'move', x: 5120, y: 0 }]).ok).toBe(true)
    expect(parseInputEvents([{ t: 'move', x: 5121, y: 0 }]).ok).toBe(false)
    expect(parseInputEvents([{ t: 'move', x: 0, y: -1 }]).ok).toBe(false)
    expect(parseInputEvents([{ t: 'key', vk: 1, p: 'up' }]).ok).toBe(true)
    expect(parseInputEvents([{ t: 'key', vk: 0, p: 'up' }]).ok).toBe(false)
    expect(parseInputEvents([{ t: 'key', vk: 255, p: 'up' }]).ok).toBe(false)
    expect(parseInputEvents([{ t: 'char', c: 65535 }]).ok).toBe(true)
    expect(parseInputEvents([{ t: 'char', c: 65536 }]).ok).toBe(false)
  })

  it('refuses a bad mode in the route before any helper lookup', async () => {
    const manager = emptyManager()
    const body = JSON.stringify({ session: 'unknown', events: [], mode: 'synth' })
    const result = await handleSandboxInputLocal(manager, makeRequest('POST', body), body)
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ ok: false, error: 'mode must be one of post, send' })
  })

  it('reaches the missing-helper conflict when the mode is valid', async () => {
    const manager = emptyManager()
    const body = JSON.stringify({ session: 'unknown', events: [], mode: 'send' })
    const result = await handleSandboxInputLocal(manager, makeRequest('POST', body), body)
    expect(result.status).toBe(409)
  })
})

describe('uia result clamping', () => {
  const helperDoc = (over: Record<string, unknown> = {}): string => JSON.stringify({
    ok: true,
    error: '',
    hwnd: 42,
    max: 8,
    truncated: false,
    nodes: [
      { ct: 'Window', name: 'n'.repeat(300), cls: 'Notepad', value: 'v'.repeat(300), x: -5, y: 6000, w: 99999, h: 48, enabled: true, offscreen: false, hwnd: 42 },
      { ct: 'Button', name: 'ok', cls: '', value: '', x: 10, y: 10, w: 20, h: 20, enabled: 'yes', offscreen: 1, hwnd: 'x' },
      { ct: 7 },
      'not-an-object',
    ],
    ...over,
  })

  it('clamps every field into the protocol ranges', () => {
    const result = parseUiaResult(helperDoc(), 8)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a parsed document')
    expect(result.hwnd).toBe(42)
    expect(result.truncated).toBe(false)
    expect(result.nodes).toHaveLength(3)
    const [first, second, third] = result.nodes
    if (first === undefined || second === undefined || third === undefined) throw new Error('expected three parsed nodes')
    expect(first).toEqual({
      ct: 'Window',
      name: 'n'.repeat(200),
      cls: 'Notepad',
      value: 'v'.repeat(200),
      x: 0,
      y: 5120,
      w: 5120,
      h: 48,
      enabled: true,
      offscreen: false,
      hwnd: 42,
    })
    expect(second.enabled).toBe(false)
    expect(second.offscreen).toBe(false)
    expect(second.hwnd).toBe(0)
    // A malformed node keeps its slot's shape without inventing data.
    expect(third.ct).toBe('')
    expect(third.x).toBe(0)
    expect(third.enabled).toBe(false)
  })

  it('caps the node count and reports truncation', () => {
    const capped = parseUiaResult(helperDoc(), 2)
    expect(capped.ok).toBe(true)
    if (!capped.ok) throw new Error('expected a parsed document')
    expect(capped.nodes).toHaveLength(2)
    expect(capped.truncated).toBe(true)
    const passthrough = parseUiaResult(helperDoc({ truncated: true }), 8)
    expect(passthrough.ok && passthrough.truncated).toBe(true)
    const oversized = parseUiaResult(helperDoc(), 9999)
    expect(oversized.ok && oversized.nodes.length).toBeLessThanOrEqual(256)
  })

  it('answers a broken or refused document with a message, never a throw', () => {
    expect(parseUiaResult('not json', 8)).toEqual({ ok: false, error: 'helper accessibility document is not valid JSON' })
    expect(parseUiaResult('"text"', 8)).toEqual({ ok: false, error: 'helper accessibility document is not an object' })
    expect(parseUiaResult(JSON.stringify({ ok: false, error: 'not a window of this desktop' }), 8))
      .toEqual({ ok: false, error: 'not a window of this desktop' })
    expect(parseUiaResult(JSON.stringify({ ok: false }), 8))
      .toEqual({ ok: false, error: 'helper refused the accessibility read' })
  })
})

describe('uia route', () => {
  it('answers 405 to a non-POST and 400 to an unparseable body', async () => {
    const manager = emptyManager()
    const wrongMethod = await handleSandboxUiaLocal(manager, makeRequest('GET'), '')
    expect(wrongMethod.status).toBe(405)
    const badJson = await handleSandboxUiaLocal(manager, makeRequest('POST', 'not json'), 'not json')
    expect(badJson.status).toBe(400)
  })

  it('refuses an invalid window id and an out-of-range cap before any helper lookup', async () => {
    const manager = emptyManager()
    const badHwnd = await handleSandboxUiaLocal(manager, makeRequest('POST', '{}'), '{}')
    expect(badHwnd.status).toBe(400)
    expect(badHwnd.body).toMatchObject({ error: 'hwnd must be a positive integer' })
    for (const maxNodes of [0, 257, 1.5, '8']) {
      const body = JSON.stringify({ hwnd: 5, maxNodes })
      const result = await handleSandboxUiaLocal(manager, makeRequest('POST', body), body)
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ error: 'maxNodes must be an integer from 1 through 256' })
    }
  })

  it('keeps the host-desktop refusal and the missing-helper conflict', async () => {
    const manager = emptyManager()
    const hostBody = JSON.stringify({ hwnd: 5, instance: 'host-desktop' })
    const host = await handleSandboxUiaLocal(manager, makeRequest('POST', hostBody), hostBody)
    expect(host.status).toBe(403)
    const body = JSON.stringify({ session: 'unknown', hwnd: 5 })
    const missing = await handleSandboxUiaLocal(manager, makeRequest('POST', body), body)
    expect(missing.status).toBe(409)
  })
})

describe('frozen protocol contract', () => {
  const protocol = readFileSync(PROTOCOL, 'utf8')

  it('documents both input modes and keeps the caps sentence', () => {
    expect(protocol).toContain('input mode <post')
    expect(protocol).toMatch(/at most 64 events/)
    expect(protocol).toMatch(/coordinates\s+0\.\.5120/)
    expect(protocol).toContain('A spool file is one batch')
  })

  it('rewrites the SendInput paragraph truthfully instead of claiming it is never used', () => {
    expect(protocol).not.toContain('are never used')
    expect(protocol).toContain('send-input=refused')
    expect(protocol).toContain('worker-bind-failed')
    expect(protocol).toContain('SetThreadDesktop')
    expect(protocol).toContain('input desktop')
    expect(protocol).toContain('`SendInput` subsumes their semantics')
    expect(protocol).toContain('SetCursorPos')
    expect(protocol).toContain('KEYEVENTF_UNICODE')
  })

  it('carries the accessibility channel, route, and capture evidence', () => {
    expect(protocol).toContain('`uia <hwnd> [max]`')
    expect(protocol).toContain('<commandFile>.uia')
    expect(protocol).toContain('/api/server/sandbox/uia')
    expect(protocol).toContain('taskbar=<source>')
    expect(protocol).toContain('skipped-black')
    expect(protocol).toContain('screen DC')
  })
})

describe.runIf(process.platform === 'win32' && process.arch === 'x64')('helper interop (compiled, desktop-free)', () => {
  it('compiles the shipped Add-Type block with the x64 SendInput layout and a working gate', { timeout: 15_000 }, () => {
    const source = readFileSync(HELPER, 'utf8')
    const match = /Add-Type @'\r?\n([\s\S]*?)\r?\n'@/.exec(source)
    const csSource = match?.[1] ?? ''
    if (csSource === '') throw new Error('sandbox-host.ps1 exposes no Add-Type here-string')
    const dir = mkdtempSync(join(tmpdir(), 'd8-layout-'))
    try {
      const csPath = join(dir, 'Sandbox.cs')
      writeFileSync(csPath, csSource, 'utf8')
      const script = join(dir, 'probe.ps1')
      writeFileSync(script, [
        'param([string]$CsPath)',
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -Path $CsPath',
        "Add-Type @'",
        'using System;using System.Text;using System.Runtime.InteropServices;',
        'public class IDN {',
        '  [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint f,bool i,uint a);',
        '  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);',
        '  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr h,int idx,byte[] b,int l,out int n);',
        '  public static string Name(){ IntPtr h=OpenInputDesktop(0,false,0x1FF); if(h==IntPtr.Zero) return ""; byte[] b=new byte[512]; int need; bool ok=GetUserObjectInformation(h,2,b,b.Length,out need); CloseDesktop(h); return ok?Encoding.Unicode.GetString(b,0,need>2?need-2:0):""; }',
        '}',
        "'@",
        '$name = [IDN]::Name()',
        '$out = [ordered]@{',
        "  input = [Runtime.InteropServices.Marshal]::SizeOf([type][Sandbox+INPUT])",
        "  mouse = [Runtime.InteropServices.Marshal]::SizeOf([type][Sandbox+MOUSEINPUT])",
        "  key = [Runtime.InteropServices.Marshal]::SizeOf([type][Sandbox+KEYBDINPUT])",
        "  unionOffset = [Runtime.InteropServices.Marshal]::OffsetOf([type][Sandbox+INPUT], 'u').ToInt32()",
        '  gateName = [Sandbox]::InputDesktopIs($name)',
        "  gateOther = [Sandbox]::InputDesktopIs($name + '.not-a-desktop')",
        '  blackAllZero = [Sandbox]::LooksUniformBlack([byte[]](0,0,0,0,0,0,0,0), 8)',
        '  blackWithRed = [Sandbox]::LooksUniformBlack([byte[]](0,0,255,0), 4)',
        '  blackAlphaOnly = [Sandbox]::LooksUniformBlack([byte[]](0,0,0,255), 4)',
        '  blackPastCount = [Sandbox]::LooksUniformBlack([byte[]](0,0,0,0,9,9,9,9), 4)',
        "  hasSendInput = ([type][Sandbox]).GetMethod('SendInput') -ne $null",
        "  hasSetCursorPos = ([type][Sandbox]).GetMethod('SetCursorPos') -ne $null",
        "  hasInputDesktopIs = ([type][Sandbox]).GetMethod('InputDesktopIs') -ne $null",
        "  hasSendUnicodeChar = ([type][Sandbox]).GetMethod('SendUnicodeChar') -ne $null",
        "  hasCaptureWin = ([type][Sandbox]).GetMethod('CaptureWin') -ne $null",
        "  hasOwnsWindow = ([type][Sandbox]).GetMethod('OwnsWindow') -ne $null",
        "  hasStartSendWorker = ([type][Sandbox]).GetMethod('StartSendWorker') -ne $null",
        "  hasQueueSendOp = ([type][Sandbox]).GetMethod('QueueSendOp') -ne $null",
        "  hasUiaClient = ([Reflection.Assembly]::LoadWithPartialName('UIAutomationClient') -ne $null)",
        '}',
        '($out | ConvertTo-Json -Compress)',
      ].join('\n'), 'utf8')
      const stdout = execFileSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-CsPath', csPath,
      ], { encoding: 'utf8', windowsHide: true, timeout: 14_000 })
      const report = JSON.parse(stdout.trim()) as Record<string, unknown>
      // x64 ABI: INPUT 40 with its union at 8, MOUSEINPUT 32, KEYBDINPUT 24.
      expect(report.input).toBe(40)
      expect(report.mouse).toBe(32)
      expect(report.key).toBe(24)
      expect(report.unionOffset).toBe(8)
      // The gate agrees with the session's real input desktop in both directions.
      expect(report.gateName).toBe(true)
      expect(report.gateOther).toBe(false)
      // The capture ladder's key ignores the unused alpha byte and respects the scan length.
      expect(report.blackAllZero).toBe(true)
      expect(report.blackWithRed).toBe(false)
      expect(report.blackAlphaOnly).toBe(true)
      expect(report.blackPastCount).toBe(true)
      expect(report.hasSendInput).toBe(true)
      expect(report.hasSetCursorPos).toBe(true)
      expect(report.hasInputDesktopIs).toBe(true)
      expect(report.hasSendUnicodeChar).toBe(true)
      expect(report.hasCaptureWin).toBe(true)
      expect(report.hasOwnsWindow).toBe(true)
      expect(report.hasStartSendWorker).toBe(true)
      expect(report.hasQueueSendOp).toBe(true)
      expect(report.hasUiaClient).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
