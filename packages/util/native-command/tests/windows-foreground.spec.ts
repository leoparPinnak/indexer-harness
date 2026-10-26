/**
 * Foreground hand-off behaviour: the program it generates, and how it reads the
 * exit codes back. The program itself is exercised against a real desktop by the
 * package's manual verification; these specs pin the contract the host relies on.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  activateWindowsExplorerWindow, windowsForegroundScript,
} from '../src/windows-foreground.ts'
import type { PathOpenerRunner } from '../src/index.ts'

const signal = () => new AbortController().signal

/** A runner that answers with one exit status, like `runNativeCommand` does. */
function failing(code: number): PathOpenerRunner {
  return vi.fn<PathOpenerRunner>(async () => {
    throw Object.assign(new Error(`exited ${String(code)}`), { code })
  })
}

describe('windowsForegroundScript', () => {
  it('targets the exact folder and keeps every activation step', () => {
    const script = windowsForegroundScript('C:\\work\\my project')
    // The folder under the pointer, not a look-alike window of the same name.
    expect(script).toContain("$target = 'C:\\work\\my project'.TrimEnd('\\')")
    expect(script).toContain('$local.TrimEnd(\'\\\') -ieq $target')
    // The ladder: shared input state, the shell's own switch, a z-order flash,
    // and the synthetic ALT press that unlocks the foreground lock.
    expect(script).toContain('AttachThreadInput($thisThread, $foregroundThread, $true)')
    expect(script).toContain('SetForegroundWindow($handle)')
    expect(script).toContain('SwitchToThisWindow($handle, $true)')
    expect(script).toContain('SetWindowPos($handle, $TOP')
    expect(script).toContain('keybd_event(0x12, 0, 0, [UIntPtr]::Zero)')
    // Every step is verified against the live foreground window.
    expect(script).toContain('GetForegroundWindow() -eq $handle')
    // Documented exit codes: 0 foreground, 2 no window, 3 refused.
    expect(script).toContain('exit 2')
    expect(script).toContain('exit 3')
  })

  it('doubles single quotes so a folder name cannot end the literal', () => {
    const script = windowsForegroundScript("C:\\work\\o'reilly")
    expect(script).toContain("$target = 'C:\\work\\o''reilly'.TrimEnd('\\')")
  })
})

describe('activateWindowsExplorerWindow', () => {
  it('reports the foreground once the helper exits zero', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await expect(activateWindowsExplorerWindow('C:\\work\\project', signal(), run))
      .resolves.toEqual({ outcome: 'foreground' })
    const [command, args, , options] = run.mock.calls[0] ?? []
    expect(command).toBe('powershell.exe')
    expect(args?.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    // The helper is a console process: it must never flash a console window.
    expect(options).toEqual({ windowsHide: true })
  })

  it('reports a folder whose window never appeared', async () => {
    await expect(activateWindowsExplorerWindow('C:\\work\\project', signal(), failing(2)))
      .resolves.toEqual({ outcome: 'not-found' })
  })

  it('reports a window every activation attempt was refused', async () => {
    await expect(activateWindowsExplorerWindow('C:\\work\\project', signal(), failing(3)))
      .resolves.toEqual({ outcome: 'refused' })
  })

  it('retries a refusal and keeps the second answer', async () => {
    const refusedOnce = vi.fn<PathOpenerRunner>()
      .mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 3 }))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    await expect(activateWindowsExplorerWindow('C:\\work\\project', signal(), refusedOnce))
      .resolves.toEqual({ outcome: 'foreground' })
    expect(refusedOnce).toHaveBeenCalledTimes(2)

    const refusedAlways = failing(3)
    await expect(activateWindowsExplorerWindow('C:\\work\\project', signal(), refusedAlways))
      .resolves.toEqual({ outcome: 'refused' })
    expect(refusedAlways).toHaveBeenCalledTimes(3)
  })

  it('keeps looking for a window that is still being created', async () => {
    const late = vi.fn<PathOpenerRunner>()
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 2 }))
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 2 }))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    await expect(activateWindowsExplorerWindow('C:\\work\\project', signal(), late))
      .resolves.toEqual({ outcome: 'foreground' })
    expect(late).toHaveBeenCalledTimes(3)

    const absent = failing(2)
    await expect(activateWindowsExplorerWindow('C:\\work\\project', signal(), absent))
      .resolves.toEqual({ outcome: 'not-found' })
    expect(absent).toHaveBeenCalledTimes(3)
  })

  it('propagates any other failure and the abort reason', async () => {
    const crash = vi.fn<PathOpenerRunner>(async () => {
      throw Object.assign(new Error('powershell missing'), { code: 'ENOENT' })
    })
    await expect(activateWindowsExplorerWindow('C:\\work\\project', signal(), crash))
      .rejects.toThrow('powershell missing')

    const abort = new AbortController()
    abort.abort(new Error('window closed'))
    const cancelled = vi.fn<PathOpenerRunner>(async () => {
      throw Object.assign(new Error('exited 3'), { code: 3 })
    })
    await expect(activateWindowsExplorerWindow('C:\\work\\project', abort.signal, cancelled))
      .rejects.toThrow('window closed')
  })
})
