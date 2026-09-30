/**
 * Desktop-gated D8 harness: the pieces of the native-Win32 surface that need a
 * live interactive session — a real UIA walk over a real window, and a real
 * composite over a freshly spawned shell. Off unless `DSH_D8_DESKTOP=1` on a
 * win32 host, so the ordinary `vitest run deamon` lane never touches a display.
 *
 * The send-mode positive branch (the input desktop IS the sandbox desktop)
 * needs `SwitchDesktop` and therefore takes over the physical screen for a
 * moment; it stays a manual measurement and is reported, not automated here.
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const HELPER = fileURLToPath(new URL('../sandbox/sandbox-host.ps1', import.meta.url))
const GATED = process.env.DSH_D8_DESKTOP === '1' && process.platform === 'win32'

/** Run a PowerShell file and return its stdout; powershell.exe failures throw. */
function runPowerShell(script: string, args: string[], hide = true): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8',
    // Measured: starting the WinForms target with SW_HIDE (windowsHide) leaves
    // its window unshown, and the cross-process UIA walk then sees the root
    // without any children. The gated harness may flash its console.
    windowsHide: hide,
    timeout: 55_000,
  })
}

describe.runIf(GATED)('live Win32 desktop (DSH_D8_DESKTOP=1)', () => {
  it('reads a live window accessibility tree through -UiaOnce', { timeout: 30_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'd8-uia-'))
    try {
      const script = join(dir, 'live-uia.ps1')
      // The target is a window this script owns: Win11 notepad is a singleton
      // that opens a tab in an existing instance, which made "find the new
      // process's window" unreliable. The helper child reads cross-process UIA,
      // so this process must keep pumping messages while it runs.
      writeFileSync(script, [
        'param([string]$HelperPath)',
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.Windows.Forms',
        '$form = New-Object System.Windows.Forms.Form',
        "$form.Text = 'd8-uia-target'",
        "$form.StartPosition = 'Manual'",
        '$form.Location = New-Object System.Drawing.Point(40,40)',
        '$form.Size = New-Object System.Drawing.Size(340,220)',
        '$text = New-Object System.Windows.Forms.TextBox',
        "$text.Multiline = $true",
        "$text.Dock = 'Fill'",
        '[void]$form.Controls.Add($text)',
        'foreach ($i in 1..4) { $b = New-Object System.Windows.Forms.Button; $b.Text = "b" + $i; [void]$form.Controls.Add($b) }',
        '$label = New-Object System.Windows.Forms.Label; $label.Text = "hello d8"; [void]$form.Controls.Add($label)',
        '[void]$form.Show()',
        '[System.Windows.Forms.Application]::DoEvents()',
        '$h = $form.Handle.ToInt64()',
        '$psi = New-Object System.Diagnostics.ProcessStartInfo',
        "$psi.FileName = 'powershell.exe'",
        "$psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File \"' + $HelperPath + '\" -UiaOnce -UiaHwnd ' + $h + ' -UiaMax 6'",
        '$psi.RedirectStandardOutput = $true',
        '$psi.UseShellExecute = $false',
        '$psi.CreateNoWindow = $true',
        '$proc = [System.Diagnostics.Process]::Start($psi)',
        'while (-not $proc.HasExited) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }',
        '$json = $proc.StandardOutput.ReadToEnd()',
        '[void]$form.Close()',
        '$json',
      ].join('\n'), 'utf8')
      const stdout = runPowerShell(script, [HELPER], false)
      const lines = stdout.trim().split(/\r?\n/)
      const lastLine = lines[lines.length - 1] ?? ''
      const doc = JSON.parse(lastLine) as {
        ok: boolean
        max: number
        truncated: boolean
        nodes: Array<{ ct: string; x: number; y: number; w: number; h: number; enabled: boolean }>
      }
      expect(doc.ok).toBe(true)
      expect(doc.max).toBe(6)
      expect(doc.nodes.length).toBeGreaterThan(0)
      expect(doc.nodes.length).toBeLessThanOrEqual(6)
      expect(doc.truncated).toBe(true)
      const first = doc.nodes[0]
      if (first === undefined) throw new Error('expected at least one node')
      expect(first.ct).toBe('Window')
      expect(first.w).toBeGreaterThan(0)
      for (const node of doc.nodes) {
        for (const bound of [node.x, node.y, node.w, node.h]) {
          expect(bound).toBeGreaterThanOrEqual(0)
          expect(bound).toBeLessThanOrEqual(5120)
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('composites a fresh desktop and names the taskbar capture source', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'd8-cap-'))
    const desktopName = `d8test-${randomBytes(3).toString('hex')}`
    try {
      const png = join(dir, 'frame.png')
      const script = join(dir, 'live-cap.ps1')
      writeFileSync(script, [
        'param([string]$HelperPath, [string]$OutPng, [string]$DeskName)',
        "$ErrorActionPreference = 'Continue'",
        '$lines = & powershell -NoProfile -ExecutionPolicy Bypass -File $HelperPath -CaptureOnce -DesktopName $DeskName -Out $OutPng -Width 800 -Height 600',
        '$lines | ForEach-Object { "$_" }',
        'Add-Type @\'',
        'using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;',
        'public class KC {',
        '  public delegate bool EP(IntPtr h, IntPtr l);',
        '  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr OpenDesktop(string n,uint f,bool i,uint a);',
        '  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);',
        '  [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr h, EP cb, IntPtr l);',
        '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
        '  public static List<int> Pids(IntPtr d){ var l=new List<int>(); EnumDesktopWindows(d,delegate(IntPtr w,IntPtr x){ uint pid; GetWindowThreadProcessId(w,out pid); if(pid!=0&&!l.Contains((int)pid)) l.Add((int)pid); return true;},IntPtr.Zero); return l; }',
        '}',
        '\'@',
        '$d = [KC]::OpenDesktop($DeskName, 0, $false, 0x01FF)',
        'if ($d -ne [IntPtr]::Zero) {',
        '  foreach ($procId in [KC]::Pids($d)) { try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {} }',
        '  [KC]::CloseDesktop($d) | Out-Null',
        '}',
      ].join('\n'), 'utf8')
      const stdout = runPowerShell(script, [HELPER, png, desktopName])
      expect(stdout).toMatch(/taskbar=(pw2|dc|dcex|repaint|skipped-black)/)
      expect(existsSync(png)).toBe(true)
      expect(statSync(png).size).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
