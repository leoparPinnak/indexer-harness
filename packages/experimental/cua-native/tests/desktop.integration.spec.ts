/**
 * Live desktop integration for the CodexNative helper: gated behind
 * `DSH_CUA_DESKTOP=1` on a win32 host with a built helper, so the ordinary
 * `vitest run cua-native` lane never touches a display.
 *
 * On the REAL interactive input desktop this suite proves, with a target
 * window it owns (WinForms, pumped by a spawned powershell):
 *   - native COM UIA tree reads plus a ValuePattern write,
 *   - SendInput landing AND focus/foreground transfer to the target
 *     (the exact pair that fails on a private isolated desktop),
 *   - WGC capture, region sampling, and PNG screenshots,
 *   - the launch_app approval round trip (helper-issued approvalRequest).
 * The final test spawns a second helper on a PRIVATE desktop
 * (`CUA_PRIVATE_DESKTOP`) and measures the cross-desktop activation wall,
 * printing both columns side by side.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CuaApprovalRequiredError, CuaHelperClient, resolveHelperPath, type CuaWindowRef } from '../src/index.ts'

const TARGET_TITLE_PREFIX = 'cua-native target'
const DECOY_TITLE_PREFIX = 'cua-native decoy'
// Per-run nonce: stale windows from a crashed run can never satisfy this run's
// exact title match, so cross-run zombie forms cannot occlude or shadow it.
const nonce = Date.now().toString(36)
const TARGET_TITLE = `${TARGET_TITLE_PREFIX} ${nonce}`
const DECOY_TITLE = `${DECOY_TITLE_PREFIX} ${nonce}`
const PRIVATE_DESKTOP = 'cuaNativePrivate'

let helperAvailable = false
if (process.platform === 'win32') {
  try {
    resolveHelperPath()
    helperAvailable = true
  } catch {
    helperAvailable = false
  }
}
const ENABLED = process.env['DSH_CUA_DESKTOP'] === '1' && helperAvailable

const sleep = (ms: number): Promise<void> => {
  const gate = Promise.withResolvers<true>()
  setTimeout(() => {
    gate.resolve(true)
  }, ms)
  return gate.promise.then(() => undefined)
}

// One form per process, compiled to a real WinForms executable with a proper
// message loop: PowerShell's DoEvents pump processed keystrokes too slowly and
// intermittently (measured: typed text went missing over multi-second polls),
// and two forms on one UI thread made keyboard input land on the sibling.
const source = [
  'using System;',
  'using System.Drawing;',
  'using System.Windows.Forms;',
  '',
  'internal static class TargetForm {',
  '  [STAThread]',
  '  private static void Main(string[] args) {',
  '    string title = args.Length > 0 ? args[0] : "cua-native target";',
  '    int x = args.Length > 1 ? int.Parse(args[1]) : 80;',
  '    int y = args.Length > 2 ? int.Parse(args[2]) : 80;',
  '    Form form = new Form();',
  '    form.Text = title;',
  '    form.StartPosition = FormStartPosition.Manual;',
  '    form.Location = new Point(x, y);',
  '    form.Size = new Size(420, 300);',
  '    Label label = new Label();',
  '    label.Text = "hello cua";',
  '    label.Location = new Point(20, 20);',
  '    label.Size = new Size(200, 30);',
  '    form.Controls.Add(label);',
  '    TextBox box = new TextBox();',
  '    box.Multiline = true;',
  '    box.Location = new Point(20, 60);',
  '    box.Size = new Size(360, 120);',
  '    form.Controls.Add(box);',
  '    Application.Run(form);',
  '  }',
  '}',
].join('\n')

let workDir = ''
let targetProcess: ChildProcess | null = null
let decoyProcess: ChildProcess | null = null
let real: CuaHelperClient
let approving: CuaHelperClient
let privateClient: CuaHelperClient | null = null
let target: CuaWindowRef
let decoy: CuaWindowRef

async function findWindow(client: CuaHelperClient, title: string, deadlineMs: number): Promise<CuaWindowRef> {
  const until = Date.now() + deadlineMs
  for (;;) {
    const windows = await client.listWindows()
    const match = windows.find(candidate => candidate.title === title)
    if (match !== undefined) return match
    if (Date.now() > until) throw new Error(`cua-native desktop gate: no window titled "${title}" appeared`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

describe.runIf(ENABLED)('live Win32 desktop (DSH_CUA_DESKTOP=1)', () => {
  beforeAll(async () => {
    // Sweep stale targets from any crashed earlier run: a leftover window at
    // the same coordinates pixel-overlaps this run's target (measured: the
    // overlap suppresses WGC window frames and starts focus fights).
    spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | Where-Object { $_.CommandLine -match \'forms\\.ps1\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-CimInstance Win32_Process -Filter "Name=\'target-form.exe\'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
    ])
    workDir = mkdtempSync(join(tmpdir(), 'cua-native-'))
    const sourcePath = join(workDir, 'target-form.cs')
    const exePath = join(workDir, 'target-form.exe')
    writeFileSync(sourcePath, source, 'utf8')
    const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
    const compiled = spawnSync(csc, ['/nologo', '/target:winexe', `/out:${exePath}`, sourcePath], { encoding: 'utf8' })
    if (compiled.status !== 0) {
      throw new Error(`cua-native desktop gate: target compile failed: ${compiled.stderr}`)
    }
    targetProcess = spawn(exePath, [TARGET_TITLE, '80', '80'], { windowsHide: false })
    decoyProcess = spawn(exePath, [DECOY_TITLE, '560', '80'], { windowsHide: false })
    real = new CuaHelperClient()
    approving = new CuaHelperClient({ env: { CUA_REQUIRE_LAUNCH_APPROVAL: '1' } })
    target = await findWindow(real, TARGET_TITLE, 30_000)
    decoy = await findWindow(real, DECOY_TITLE, 30_000)
  }, 60_000)

  afterAll(async () => {
    await privateClient?.close().catch(() => {})
    await approving?.close().catch(() => {})
    await real?.close().catch(() => {})
    // Force-kill the targets synchronously: rmSync over their still-locked
    // executable races a plain kill() and fails with EPERM.
    for (const process of [targetProcess, decoyProcess]) {
      if (process?.pid !== undefined) {
        spawnSync('taskkill', ['/pid', String(process.pid), '/T', '/F'])
      }
    }
    if (workDir !== '') {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          rmSync(workDir, { recursive: true, force: true })
          break
        } catch {
          await sleep(150)
        }
      }
    }
  })

  it('reads a live COM UIA tree and writes a value through the ValuePattern', { timeout: 30_000 }, async () => {
    const info = await real.getHelperInfo()
    expect(info.desktop).toBe('Default') // the interactive input desktop, not a private one
    expect(info.helper).toBe('cua-helper')

    const state = await real.getWindowState(target, { includeScreenshot: false, includeText: true, disableDiff: true })
    const elements = state.accessibility?.elements ?? []
    expect(elements.length).toBeGreaterThan(2)
    expect(elements[0]?.path).toBe('') // the root keeps "" (the window id is the caller's prefix)
    const label = elements.find(element => element.name === 'hello cua')
    expect(label).toBeDefined()
    expect(label?.path.startsWith('/')).toBe(true)
    expect(label?.bounds.width).toBeGreaterThan(0)

    const edit = elements.find(element => element.controlType === 'edit')
    expect(edit).toBeDefined()
    const applied = await real.setValue(target, edit?.element_index ?? -1, 'metin')
    expect(applied).toMatchObject({ applied: true, value: 'metin' })

    const reread = await real.getWindowState(target, { includeScreenshot: false, includeText: true, disableDiff: true })
    const editAfter = (reread.accessibility?.elements ?? []).find(element => element.controlType === 'edit')
    expect(editAfter?.value).toBe('metin')
  })

  it('SendInput lands and focus transfers on the interactive desktop', { timeout: 30_000 }, async () => {
    const state = await real.getWindowState(target, { includeScreenshot: false, includeText: true, disableDiff: true })
    const elements = state.accessibility?.elements ?? []
    const root = elements[0]
    expect(root).toBeDefined()
    const rootBounds = root?.bounds ?? { x: 0, y: 0, width: 1, height: 1 }

    // (a) cursor synthesis lands on the input queue at the requested point.
    const move = await real.move(target, rootBounds.x + rootBounds.width / 2, rootBounds.y + rootBounds.height / 2)
    expect(move.delivered).toBe(true)
    expect(move.detail).toContain('input queue')

    // (b) a click lands AND foreground transfers to the target window.
    const edit = elements.find(element => element.controlType === 'edit')
    expect(edit).toBeDefined()
    const bounds = edit?.bounds ?? { x: 0, y: 0, width: 1, height: 1 }
    // Foreground matters here too: this build only delivers WGC window frames
    // for the visible-on-top window, so activating also arms the capture test.
    const click = await real.click(target, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
    expect(click.delivered).toBe(true)
    expect(click.focusTransferred).toBe(true)
    expect(click.foreground).toBe(target.id)
    expect(click.detail).toContain('input queue')

    // Give the target's pump a beat to place the caret from the click before
    // typing: the helper cannot observe child-focus placement from outside.
    await sleep(120)

    // Keystrokes reach the application itself: typed text reads back over UIA.
    // The box already holds `metin` from the ValuePattern write above; the click
    // parks the caret past it, so the typed `hi` appends. Poll the readback:
    // the target processes WM_CHAR asynchronously after SendInput returns.
    const typed = await real.typeText(target, 'hi')
    expect(typed.delivered).toBe(true)
    expect(typed.focusTransferred).toBe(true)
    let value: string | undefined
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reread = await real.getWindowState(target, { includeScreenshot: false, includeText: true, disableDiff: true })
      value = (reread.accessibility?.elements ?? []).find(element => element.controlType === 'edit')?.value
      if (value?.includes('hi') === true) break
      if (attempt === 0) {
        console.log('typed-text diagnostics:', JSON.stringify({
          focused: reread.accessibility?.focused_element,
          click,
          typed,
          editBounds: bounds,
          firstValue: value,
        }, null, 2))
      }
      await sleep(100)
    }
    expect(value).toContain('hi')
  })

  it('captures a WGC frame with region samples and a PNG screenshot', { timeout: 30_000 }, async () => {
    // Foreground-first: on this build an occluded window yields no window-item
    // frames, so the WGC path (the capability under test) needs the target on
    // top. The helper's negative cache would otherwise fall back to GDI.
    const armed = await real.activateWindow(target)
    expect(armed.focusTransferred).toBe(true)
    // The compositor needs a beat after activation before window frames flow;
    // poll the probe instead of demanding the very first attempt.
    let probe: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 5; attempt += 1) {
      probe = await real.probeCapture(target)
      if (probe['freshFrameOk'] === true) break
      await sleep(600)
    }
    if (probe['freshFrameOk'] !== true) console.log('capture probe diagnostics:', JSON.stringify(probe, null, 2))
    expect(probe).toMatchObject({ freshFrameOk: true })
    const state = await real.getWindowState(target, { includeScreenshot: false, includeText: true, disableDiff: true })
    const root = state.accessibility?.elements[0]
    const bounds = root?.bounds ?? { x: 0, y: 0, width: 1, height: 1 }
    const frame = await real.capture(target, [
      { name: 'client', space: 'window', x: bounds.width / 2, y: bounds.height / 2 },
      { name: 'taskbar', space: 'desktop', x: bounds.x + bounds.width / 2, y: 1080 },
    ])
    expect(frame.mode).toBe('wgc')
    expect(frame.regions['client']).toMatch(/^#[0-9a-f]{6}$/u)
    expect(frame.regions['client']).not.toBe('#000000') // the window surface is opaque
    expect(frame.regions['taskbar']).toMatch(/^#[0-9a-f]{6}$/u)

    const withShot = await real.getWindowState(target, { includeScreenshot: true, includeText: false })
    expect(withShot.captureMode).toBe('wgc')
    const shot = withShot.screenshots[0]
    expect(shot?.url.startsWith('data:image/png;base64,')).toBe(true)
    const png = Buffer.from((shot?.url ?? '').slice('data:image/png;base64,'.length), 'base64')
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47')
    expect(png.readUInt32BE(16)).toBe(shot?.width)
  })

  it('performs the Raise secondary action with focus evidence', { timeout: 30_000 }, async () => {
    const decoyOutcome = await real.activateWindow(decoy)
    expect(decoyOutcome.focusTransferred).toBe(true)
    const raised = await real.performSecondaryAction(target, 0, 'Raise')
    expect(raised).toMatchObject({ action: 'Raise', applied: true, focusTransferred: true })
  })

  it('round-trips the launch_app approval handshake', { timeout: 30_000 }, async () => {
    const app = 'cmd.exe /c exit'
    const refusal = await approving.launchApp(app).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(CuaApprovalRequiredError)
    const approval = refusal as CuaApprovalRequiredError
    expect(approval.approval.app).toBe(app)
    expect(approval.approval.riskLevel).toBe('low')

    const launched = await approving.launchApp(app, { approvedApp: app })
    expect(launched).toEqual({ app, launched: true })
  })

  it('measures the private-desktop activation wall side by side', { timeout: 30_000 }, async () => {
    // Precondition on the interactive desktop: the foreground is the decoy, so
    // any later foreground==target reading can only come from a real transfer.
    const decoyOutcome = await real.activateWindow(decoy)
    expect(decoyOutcome.focusTransferred).toBe(true)
    const before = await real.getHelperInfo()

    privateClient = new CuaHelperClient({ env: { CUA_PRIVATE_DESKTOP: PRIVATE_DESKTOP } })
    const privateInfo = await privateClient.getHelperInfo()
    expect(privateInfo.desktop).toBe(PRIVATE_DESKTOP) // proof the helper really runs off the input desktop

    const state = await real.getWindowState(target, { includeScreenshot: false, includeText: true, disableDiff: true })
    const root = state.accessibility?.elements[0]
    const bounds = root?.bounds ?? { x: 0, y: 0, width: 1, height: 1 }
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }

    const privateActivate = await privateClient.activateWindow(target)
    const privateMove = await privateClient.move(target, point.x, point.y)
    const after = await real.getHelperInfo()

    // Side-by-side measurement record (real desktop vs private desktop).
    console.log(
      JSON.stringify(
        {
          realDesktop: {
            desktop: before.desktop,
            activateFocusTransferred: decoyOutcome.focusTransferred,
            cursorBefore: before.cursor ?? null,
            cursorAfterPrivateMove: after.cursor ?? null,
          },
          privateDesktop: {
            desktop: privateInfo.desktop,
            activateFocusTransferred: privateActivate.focusTransferred,
            activateForeground: privateActivate.foreground,
            moveDelivered: privateMove.delivered,
            moveDetail: privateMove.detail,
            targetWindowId: target.id,
          },
        },
        null,
        2,
      ),
    )

    // THE WALL: a helper on a private desktop cannot move foreground to an
    // interactive-desktop window, while the same call on the real desktop did.
    expect(privateActivate.focusTransferred).toBe(false)
    expect(privateActivate.foreground).not.toBe(target.id)
    // The interactive-desktop cursor is the parent-side witness for whether
    // the private helper's SendInput reached the real input stream.
    expect(after.cursor).toBeDefined()
    expect(before.cursor).toBeDefined()
  })
})
