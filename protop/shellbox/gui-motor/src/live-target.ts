/**
 * Live target provisioning for the desktop-gated real A/B: one deterministic
 * WinForms window, spawned on the real input desktop (CodexNative) and onto
 * the NativeWin private desktop through the engine's own `launch`. The script
 * writes a probe JSON (actual device-pixel geometry per control) the fixture
 * composer turns into ground truth — reviewed constants for a live run.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Window title both backends resolve (CodexNative matches by title, NativeWin via its window snapshot). */
export const LIVE_WINDOW_TITLE = 'gui-motor-live-target'

/** Actual device-pixel geometry of one running target, written by the target script. */
export interface LiveProbe {
  readonly title: string
  readonly form: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly controls: Readonly<Record<'accent' | 'edit' | 'username' | 'ok' | 'status' | 'hello', { readonly x: number; readonly y: number; readonly w: number; readonly h: number }>>
  readonly screen: { readonly w: number; readonly h: number }
}

/**
 * The target window script: fixed layout with KNOWN colors (accent panel
 * `#2b6cb0`, form background `#1e1e1e`) so capture fidelity can anchor on
 * exact expected colors, and known text (`metin`, `OK`, `Ready`) so property
 * accuracy has ground truth. Writes the probe after Show, then blocks in
 * `Application.Run` until killed.
 */
export const TARGET_PS = `
param([string]$ProbePath)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GuiMotorDpi {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[void][GuiMotorDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = '${LIVE_WINDOW_TITLE}'
$form.Name = 'root'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(40, 40)
$form.Size = New-Object System.Drawing.Size(640, 480)
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$accent = New-Object System.Windows.Forms.Panel
$accent.Name = 'accent'
$accent.Location = New-Object System.Drawing.Point(20, 20)
$accent.Size = New-Object System.Drawing.Size(240, 90)
$accent.BackColor = [System.Drawing.Color]::FromArgb(43, 108, 176)
[void]$form.Controls.Add($accent)
$edit = New-Object System.Windows.Forms.Panel
$edit.Name = 'edit'
$edit.Location = New-Object System.Drawing.Point(20, 130)
$edit.Size = New-Object System.Drawing.Size(360, 70)
[void]$form.Controls.Add($edit)
$username = New-Object System.Windows.Forms.TextBox
$username.Name = 'username'
$username.Text = 'metin'
$username.Location = New-Object System.Drawing.Point(8, 8)
$username.Size = New-Object System.Drawing.Size(340, 32)
[void]$edit.Controls.Add($username)
$ok = New-Object System.Windows.Forms.Button
$ok.Name = 'ok'
$ok.Text = 'OK'
$ok.Location = New-Object System.Drawing.Point(20, 220)
$ok.Size = New-Object System.Drawing.Size(100, 36)
[void]$form.Controls.Add($ok)
$status = New-Object System.Windows.Forms.Label
$status.Name = 'status'
$status.Text = 'Ready'
$status.Location = New-Object System.Drawing.Point(20, 280)
$status.Size = New-Object System.Drawing.Size(200, 30)
[void]$form.Controls.Add($status)
$hello = New-Object System.Windows.Forms.Label
$hello.Name = 'hello'
$hello.Text = 'gui-motor live'
$hello.Location = New-Object System.Drawing.Point(20, 320)
$hello.Size = New-Object System.Drawing.Size(240, 30)
[void]$form.Controls.Add($hello)
[void]$form.Show()
[System.Windows.Forms.Application]::DoEvents()
function Rect($c) {
  $r = $c.RectangleToScreen($c.ClientRectangle)
  return @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
}
$outer = $form.Bounds
$probe = @{
  title = $form.Text
  form = @{ x = [int]$outer.X; y = [int]$outer.Y; w = [int]$outer.Width; h = [int]$outer.Height }
  controls = @{
    accent = (Rect $accent)
    edit = (Rect $edit)
    username = (Rect $username)
    ok = (Rect $ok)
    status = (Rect $status)
    hello = (Rect $hello)
  }
  screen = @{ w = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; h = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height }
}
Set-Content -Path $ProbePath -Value ($probe | ConvertTo-Json -Compress -Depth 4)
[System.Windows.Forms.Application]::Run($form)
`

/** Write the target script into a directory; returns the script path. */
export function writeTargetScript(directory: string): string {
  const script = join(directory, 'gui-motor-target.ps1')
  writeFileSync(script, TARGET_PS, 'utf8')
  return script
}

/** Start the target on the real input desktop; the caller owns killing it. */
export function spawnRealDesktopTarget(script: string, probePath: string): ChildProcess {
  return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProbePath', probePath], {
    stdio: 'ignore',
  })
}

/**
 * Wait for the target's probe JSON.
 * @param probePath - where the target script writes geometry.
 * @param timeoutMs - budget for the window to show.
 * @returns the actual device-pixel geometry.
 */
export async function waitForProbe(probePath: string, timeoutMs: number): Promise<LiveProbe> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(probePath)) {
    if (Date.now() > deadline) throw new Error(`gui-motor: live target probe never appeared at ${probePath}.`)
    await delay(200)
  }
  await delay(300)
  return JSON.parse(readFileSync(probePath, 'utf8')) as LiveProbe
}

/** Center point of a rect, the input scenarios click. */
export function rectCenter(rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): { x: number; y: number } {
  return { x: rect.x + Math.floor(rect.w / 2), y: rect.y + Math.floor(rect.h / 2) }
}

/** Window-relative point of the center of one probed control. */
export function relativeToForm(probe: LiveProbe, control: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): { x: number; y: number } {
  return {
    x: control.x + Math.floor(control.w / 2) - probe.form.x,
    y: control.y + Math.floor(control.h / 2) - probe.form.y,
  }
}
