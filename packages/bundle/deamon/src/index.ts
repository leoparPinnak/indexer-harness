/**
 * @deepseek-ai/dsh-deamon — the Deamon bundle's runtime glue plugin. It
 * owns the isolated private Windows desktop feature end to end: the sandbox
 * route surface and WebSocket frame feed ([`registerSandboxRoutes`]), the
 * shared helper daemon (`src/deamon*.ts`), the
 * `sandbox/sandbox-host.ps1` capture helper, the model-facing
 * `shellbox_launch`, `shellbox_state`, and `shellbox_input` tools, the
 * bundled `shellbox` skill, and the `app:shellbox-surface` and
 * `app:shellbox-changes` prompt sections. The browser pane is the
 * `ui-sandbox-view` row in this bundle's patch.
 * @module @deepseek-ai/dsh-deamon
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-skill'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerSandboxRoutes } from './sandbox.ts'
import { shellboxSkillProvider } from './skill.ts'
import {
  registerShellboxChangeTools,
  registerShellboxChangeTracking,
  SHELLBOX_CHANGES_LINE,
  shellboxChangeState,
} from './shellbox-changes.ts'

/** Stable Cordis plugin name. */
export const name = 'deamon'

/** Services required before the Deamon bridge can mount. */
export const inject = ['webServer']

/** Plugin config: composed deployment settings for the Shellbox feature. */
export interface Config {
  /**
   * Register the model-visible surface context (the `app:shellbox-surface`
   * prompt section). A non-interactive layer can turn it off when its user is
   * not in the GUI, so the orientation text would be false.
   */
  surfaceContext: boolean
}

export const Config: z<Config> = z.object({
  surfaceContext: z.boolean().default(true),
})

/** Model-visible orientation for the Shellbox isolated desktop feature. */
function shellboxSurfacePrompt(): string {
  return 'DSH Shellbox Desktop Guidance:\n'
    + '- The DSH Web GUI features a "Shellbox" tab in the right sidebar. '
    + 'It displays a live real-time stream of an isolated private Windows desktop (Win32 desktop: "dsh-shellbox" or session-specific "dsh-sb-<session>"). '
    + 'The user can view applications running on this private desktop in real time; the view dynamically switches when the user changes chat sessions.\n'
    + '- Shellbox is NOT Windows Sandbox (the Hyper-V virtual machine) and NOT the DSH file-permission sandbox. It is an isolated desktop running directly on the host machine using private Win32 APIs.\n'
    + '- You can launch GUI applications onto the Shellbox desktop using the `shellbox_launch` tool. It automatically defaults to the current session\'s isolated desktop. Shellbox sessions are fully authoritative: the desktop\'s windows can be inspected and controlled, and mouse and keyboard input can be sent into win32 desktops; the host desktop is not a target.\n'
    + '- Console applications (cmd/powershell without GUI) cannot attach their console window to the private desktop; run GUI applications (e.g. msedge, notepad, calc, python GUI) or browser instances instead.\n'
    + '- NO GPU / Hardware 3D Acceleration: The isolated Win32 desktop does NOT support hardware GPU acceleration (OpenGL/Vulkan/Direct3D swapchains). Do NOT launch hardware-accelerated 3D games or Android emulators with hardware GPU (-gpu host); use software rendering (e.g. -gpu swiftshader) or headless mode.\n'
    + '- Hyper-V integration: Hyper-V virtual machine consoles can also be streamed through Shellbox via vmconnect (e.g. `shellbox_launch({ command: "vmconnect.exe localhost <VM>" })`).\n'
    + '- Load the `shellbox` skill for the full usage manual, troubleshooting, and known limitations.'
}

/** Mount the Shellbox routes, tool, skill, and prompt section. */
export function apply(ctx: Context, config: Config): void {
  registerSandboxRoutes(ctx)
  // The skill registry belongs to profiles that mount it; the bridge itself
  // mounts on the webServer alone, so registration waits here instead of
  // holding the whole plugin back.
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.registerProvider(() => shellboxSkillProvider)
  })
  registerShellboxChangeTracking(ctx)
  registerShellboxChangeTools(ctx)
  if (config.surfaceContext) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: 'app:shellbox-surface',
        order: promptCtx.systemPrompt.getSectionOrder('WEB_SURFACE') + 5,
        text: () => shellboxSurfacePrompt(),
      })
      // Tracked as this fiber's effect so disposal removes the section; an
      // absent agent or absent projection contributes nothing rather than
      // claiming dirtiness it cannot observe.
      promptCtx.effect(() => promptCtx.systemPrompt.section({
        name: 'app:shellbox-changes',
        order: promptCtx.systemPrompt.getSectionOrder('WEB_SURFACE') + 6,
        text: (context?: AssembleContext) => {
          const agent = context?.agent
          if (agent === undefined) return ''
          const state = shellboxChangeState(promptCtx, agent.session)
          if (state === undefined || state.lastSeq <= state.ackedSeq) return ''
          return SHELLBOX_CHANGES_LINE
        },
      }), 'deamon: app:shellbox-changes section')
    })
  }
}
