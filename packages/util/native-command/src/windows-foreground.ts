/**
 * Windows foreground hand-off for a folder window this package opened.
 *
 * Opening a folder creates a window owned by a process the operator did not
 * start from the foreground application, so Windows denies that window's own
 * activation request: it appears behind whatever the operator was using. This
 * module asks for the foreground explicitly instead — locate the exact Explorer
 * window for the folder, then drive a ladder of Win32 activation calls and
 * verify the result after each one, escalating until the window provably owns
 * the foreground or the ladder is exhausted.
 *
 * The ladder is ordered by side effect. `AttachThreadInput` shares this
 * process's input state with the current foreground thread, which is what makes
 * `SetForegroundWindow` succeed where the same call alone is refused;
 * `SwitchToThisWindow` is the shell's own alt-tab path; a short topmost flash is
 * last because it momentarily changes the window's z-order policy.
 * @module @deepseek-ai/dsh-native-command/windows-foreground
 */

import type { PathOpenerRunner } from './path-opener.ts'

/** How the foreground hand-off ended. */
export type WindowsForegroundOutcome =
  /** The window was located and now owns the foreground. */
  | 'foreground'
  /** No Explorer window for that folder appeared within the poll window. */
  | 'not-found'
  /** The window exists but every activation attempt was refused. */
  | 'refused'

/**
 * Helper passes before the hand-off gives up. Three passes cover a slow Explorer
 * start and one busy foreground owner without spawning helpers indefinitely.
 */
const WINDOWS_FOREGROUND_ATTEMPTS = 3

/** Tail of the process-wide hand-off queue; see {@link serializeWindowsForeground}. */
let foregroundTail: Promise<unknown> = Promise.resolve()

/**
 * Result of one hand-off, with the Explorer window it acted on when located.
 */
export interface WindowsForegroundResult {
  readonly outcome: WindowsForegroundOutcome
}

/** PowerShell single-quoted literal (doubles embedded quotes). */
function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Build the PowerShell program that locates one folder's Explorer window and
 * takes the foreground.
 *
 * The window is identified by the shell's own record of each open window, so a
 * folder already open in an existing window resolves to that window instead of
 * a look-alike; matching display titles would confuse two folders of the same
 * name. Exit codes are the contract: 0 foreground, 2 no window, 3 refused.
 * @param path - absolute folder path the operator asked to open.
 * @param pollTicks - 100ms window-creation polls before the helper gives up.
 * @returns the complete `-Command` program.
 */
export function windowsForegroundScript(path: string, pollTicks = 50): string {
  return `
$ErrorActionPreference = 'Stop'
$target = ${powershellLiteral(path)}.TrimEnd('\\')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
function Get-FolderWindow {
  $shell = New-Object -ComObject Shell.Application
  foreach ($window in @($shell.Windows())) {
    try {
      if ($window.FullName -notlike '*explorer.exe') { continue }
      $url = $window.LocationURL
      if ([string]::IsNullOrEmpty($url)) { continue }
      $local = ([uri]$url).LocalPath
      if ([string]::IsNullOrEmpty($local)) { continue }
      if ($local.TrimEnd('\\') -ieq $target) { return [IntPtr][int64]$window.HWND }
    } catch { }
  }
  return [IntPtr]::Zero
}
function Set-Foreground([IntPtr]$handle) {
  [void][DshForeground]::ShowWindow($handle, 9)
  $foreground = [DshForeground]::GetForegroundWindow()
  $foregroundThread = [DshForeground]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
  $thisThread = [DshForeground]::GetCurrentThreadId()
  [void][DshForeground]::AttachThreadInput($thisThread, $foregroundThread, $true)
  [void][DshForeground]::SetForegroundWindow($handle)
  [void][DshForeground]::BringWindowToTop($handle)
  [void][DshForeground]::SetFocus($handle)
  [void][DshForeground]::AttachThreadInput($thisThread, $foregroundThread, $false)
}
$handle = [IntPtr]::Zero
# A cold Explorer start can take seconds under load: keep looking rather than
# reporting a window that simply has not been created yet.
for ($poll = 0; $poll -lt ${String(pollTicks)} -and $handle -eq [IntPtr]::Zero; $poll++) {
  $handle = Get-FolderWindow
  if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($handle -eq [IntPtr]::Zero) { exit 2 }
function Send-AltTap {
  # A synthetic ALT press marks this thread as the input owner, which is the
  # condition Windows checks before it allows a foreground change.
  [DshForeground]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 25
  [DshForeground]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 25
}
function Test-Foreground {
  return [DshForeground]::GetForegroundWindow() -eq $handle
}
$TOP = [IntPtr](-1)
$NOTOP = [IntPtr](-2)
# SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW: policy change only, never geometry.
$flags = 0x0001 -bor 0x0002 -bor 0x0040
for ($attempt = 0; $attempt -lt 8; $attempt++) {
  switch ($attempt) {
    0 { Set-Foreground $handle }
    1 { Set-Foreground $handle }
    2 { [DshForeground]::SwitchToThisWindow($handle, $true) }
    3 { Send-AltTap; Set-Foreground $handle }
    4 { Send-AltTap; [DshForeground]::SwitchToThisWindow($handle, $true) }
    5 {
      [void][DshForeground]::SetWindowPos($handle, $TOP, 0, 0, 0, 0, $flags)
      Start-Sleep -Milliseconds 120
      [void][DshForeground]::SetWindowPos($handle, $NOTOP, 0, 0, 0, 0, $flags)
    }
    6 { Send-AltTap; Set-Foreground $handle }
    7 { Start-Sleep -Milliseconds 250; Set-Foreground $handle }
  }
  Start-Sleep -Milliseconds 150
  if (Test-Foreground) { exit 0 }
}
exit 3
`.trim()
}

/**
 * Take the foreground for one folder's Explorer window, verifying each step.
 *
 * The helper is retried until it reports the foreground, a bounded number of
 * times. Both of its other answers are worth another pass: a folder whose
 * window was still being created, and a ladder that lost to a foreground owner
 * that was itself busy activating. A cap keeps a genuinely unmovable window from
 * spawning helpers forever.
 * @param path - absolute folder path that was just opened.
 * @param signal - caller lifetime; abort terminates the helper.
 * @param run - command runner (the package default hides the console window).
 * @returns how the hand-off ended after the final attempt.
 */
export async function activateWindowsExplorerWindow(
  path: string,
  signal: AbortSignal,
  run: PathOpenerRunner,
): Promise<WindowsForegroundResult> {
  const attempt = async (pollTicks: number): Promise<WindowsForegroundOutcome> => {
    try {
      await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', windowsForegroundScript(path, pollTicks)],
        signal,
        { windowsHide: true },
      )
      return 'foreground'
    } catch (error) {
      signal.throwIfAborted()
      const code = (error as { readonly code?: unknown }).code
      if (code === 2) return 'not-found'
      if (code === 3) return 'refused'
      throw error
    }
  }
  return await serializeWindowsForeground(async () => {
    // The first pass waits out a cold Explorer start; a retry only has to
    // re-raise a window that already exists.
    let outcome = await attempt(50)
    for (let pass = 1; pass < WINDOWS_FOREGROUND_ATTEMPTS && outcome !== 'foreground'; pass++) {
      outcome = await attempt(10)
    }
    return { outcome }
  })
}

/**
 * Run one hand-off at a time across the whole process.
 *
 * Two helpers racing would fight for the same foreground: each one takes it and
 * the other's verification then reads the wrong window, so both retry and both
 * lose. Serializing is what makes rapid successive opens deterministic — the
 * second window is raised after the first has settled.
 * @param handoff - the hand-off to run once its turn arrives.
 * @returns that hand-off's result.
 */
function serializeWindowsForeground<T>(handoff: () => Promise<T>): Promise<T> {
  const previous = foregroundTail.catch(() => undefined)
  const next = previous.then(handoff)
  foregroundTail = next.then(() => undefined, () => undefined)
  return next
}
