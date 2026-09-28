/**
 * @deepseek-ai/dsh-cdp/tools — Model-facing tool registrations for CDP browser control.
 * Exposes cdp_status, cdp_open, cdp_navigate, cdp_tabs, cdp_snapshot,
 * cdp_eval, cdp_click, cdp_type, and cdp_wait to the agent.
 *
 * @module @deepseek-ai/dsh-cdp/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { errorEnvelope, normalizeScreenshotRequest, renderViewportOutcomeText } from './capture.ts' /* plan06, plan15-viewport */
import { renderEvalFailure, renderExecText } from './exec.ts'
import { listFiles, mkdirUnder, readFileUnder, statFile, deleteFile, writeFileUnder } from './files.ts' /* plan10 */
import { groupCaptureByHost } from './net/capture.ts'
import type { CdpService, CdpScrollMode, StealthStatusResult } from './service.ts' /* plan03 · plan07 */
import { CDP_STATUS_DESCRIPTION, CDP_STATUS_OUTPUT_SCHEMA, renderCdpStatus } from './status.ts'
import { dialogDenialReason, isDialogGuardedTool } from './dialog.ts' /* plan05 */
// plan02 wave 1: the locator DSL (specs, verdicts, renders) and its shared output schemas.
import {
  EXPECT_CHECKS,
  HIT_INFO_SCHEMA,
  LOCATOR_ACTIONABILITY_SCHEMA,
  LOCATOR_CANDIDATES_SCHEMA,
  LOCATOR_TARGET_SCHEMA,
  locatorSpecFromArgs,
  renderCdpExpect,
  renderCdpText,
  validateExpectOptions,
  validateLocatorSpec,
  type ExpectCheck,
} from './locator.ts' /* plan02 */
// plan02 wave 2: fill (§4.4) and the seven wait strategies (§4.7).
import { FILL_POST_SCHEMA, renderFill, validateFillArgs } from './fill.ts' /* plan02 */
import { WAIT_STRATEGIES, renderWait, runWait, validateWaitArgs, waitPlan, type WaitOutcome, type WaitSeam } from './waits.ts' /* plan02 */
// plan08 wave: the ref path — action-time element resolution behind a snapshot ref.
/* plan08-fix-ref-rename: `renameNote` is what a ref that resolved by NODE
   identity reports, so the model is told "renamed", never "re-rendered". */
import { RefStaleError, centerOf, isStaleRefReason, renameNote, type RefEvidence } from './refs.ts' /* plan08 */
import { compactNode, diffSnapshots, filterInteractive } from './snapshot-view.ts' /* plan16-view */
import { TabLockRegistry, clampLockTtl } from './tab-lock.ts' /* plan16-lock */
import type { CdpWovenNode } from './snapshot.ts'
/* plan11: cdp_captcha — the detect/drive/read tool. The LOCATOR DSL is
   imported from plan02 (`locatorSpecFromArgs`), never re-implemented: one
   ladder, one spec builder, one set of validation rules. */
import { renderCaptcha } from './captcha.ts' /* plan11 */
/* plan02-fix-type-focus: the focus gate `cdp_type` reads after its click. */
import type { TypeFocusCheck } from './locator.ts'
/* plan14: the point probe behind cdp_locate, plus `hitTestFailures` — the ONE
   wording cdp_find's render and cdp_locate's render both use for the
   inViewport/coveredBy axes, so the two tools cannot drift apart. */
import { hitTestFailures, renderLocate } from './locate.ts'

/** plan05: one dialog row shared by cdp_dialog's `pending`/`recent` arrays. */
const PLAN05_DIALOG_BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    targetId: { type: 'string', required: true },
    type: { type: 'string', enum: ['alert', 'confirm', 'prompt', 'beforeunload'], required: true },
    message: { type: 'string', required: true },
    url: { type: 'string', required: true },
    defaultPrompt: { type: 'string' },
    ageMs: { type: 'integer', required: true },
    answered: {
      type: 'string',
      enum: ['accepted', 'dismissed', 'auto-accepted', 'auto-dismissed', 'closed-externally'],
    },
  },
} as const

/**
 * plan02-fix-type-focus: run one focus-gate probe without letting the probe
 * break the type path. A page that cannot answer (no session, a closed target,
 * a service surface without the probe) yields undefined, and undefined means
 * "no verdict" — the type then proceeds exactly as it did before. Only a real
 * `holds:false` may refuse.
 * @param probe - the service probe to run.
 * @returns its verdict, or undefined when the probe could not answer.
 */
async function typeFocusProbe<T>(probe: () => Promise<T>): Promise<T | undefined> {
  try {
    return await probe()
  } catch {
    return undefined
  }
}

/**
 * plan02-fix-type-focus: the one honest line for a lost focus. It names what
 * actually holds focus (usually `body`) and the two steps that fix it, so the
 * model retries with a click instead of repeating the same lost keystrokes.
 * @param check - the page's focus verdict.
 * @returns the failure reason.
 */
function focusLostReason(check: TypeFocusCheck): string {
  const active = check.active
  const where = active === undefined
    ? 'document.activeElement is not the resolved element'
    : `document.activeElement is <${active.tag}${active.name !== '' ? ` "${active.name}"` : ''}>`
  return `focus lost — ${where}, so nothing was typed. `
    + 'Click the field with cdp_click first, then type again'
}

/**
 * Register all model-facing CDP tools when the `tools` registry is present.
 * @param ctx - Cordis context.
 * @param service - CdpService instance backing the tools.
 */
export function registerCdpTools(ctx: Context, service: CdpService): void {
  ctx.inject(['tools'], (toolCtx) => {
    // 1. cdp_status
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_status',
      description: CDP_STATUS_DESCRIPTION,
      parameters: {},
      output: {
        // plan01 §5.6: the single shared schema (plan06's optional `viewport`
        // included) — the standalone status registration cannot drift from it.
        schema: CDP_STATUS_OUTPUT_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: renderCdpStatus(value),
        }],
      },
      // plan01: the async live surface — refreshes plan06's viewport
      // observation (2s cache; never creates a tab) and reports the enriched state.
      execute: () => service.statusLive(),
    })), 'cdp: cdp_status tool')

    // 2. cdp_open
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_open',
      description: 'Open or attach to a Chromium browser instance via Chrome DevTools Protocol. '
        + 'Called with no endpoint/port it FIRST scans the default loopback debug ports: if a live '
        + 'browser is found it returns needsChoice with the discovery table and attaches to NOTHING, '
        + 'so the user picks ("that Google profile on 9222, or a new port?"). '
        + "Pass switchTo/port/endpoint to make that decision, or profile:'assistant' to launch on the "
        + 'persistent signed-in profile under $DSH_HOME/profiles (its session survives restarts).',
      parameters: {
        port: { type: 'number', description: 'Port of an already running remote debugging browser.' },
        headless: { type: 'boolean', description: 'Whether to launch headless when starting a new browser.' },
        executablePath: { type: 'string', description: 'Custom path to Chromium/Chrome/Edge executable.' },
        // plan04: attach a specific debugger URL directly — no port discovery, no launch.
        endpoint: { type: 'string', description: 'Explicit ws:// debugger URL; skips port discovery and launching.' },
        // plan13-profile: the named-answer surface of a needsChoice envelope.
        switchTo: { type: 'number', description: 'The chosen live port from a needsChoice table; switches to it explicitly.' },
        // plan13-profile: the durable session. Omit for a throwaway profile.
        profile: { type: 'string', description: "Named persistent profile under $DSH_HOME/profiles (e.g. 'assistant'); the signed-in session survives restarts." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            endpoint: { type: 'string', required: true },
            targets: { type: 'integer', required: true },
            // plan04: stable pool id of the attached endpoint (e.g. ep-9222).
            connectionId: { type: 'string', required: true, description: 'Pool connection id of the attached endpoint.' },
            // plan04: true when the endpoint was already pooled — no socket was re-dialed.
            reused: { type: 'boolean', required: true, description: 'True when an existing pooled connection was adopted.' },
            // plan04-F6: set when the live session was kept despite a differing request.
            note: { type: 'string', description: 'Why the live session was kept instead of the requested port.' },
            // plan13-profile: the active browser's profile identity.
            profile: { type: 'string', description: "Active profile identity: a named profile (e.g. 'assistant'), 'ephemeral', or 'external'." },
            // plan13-profile: the choice table; the ONLY time anything is attached is when this is absent.
            needsChoice: { type: 'boolean', description: 'True when live endpoints were discovered and NOTHING was attached — ask the user, then call again with switchTo/endpoint/profile.' },
            discovered: {
              type: 'array',
              description: 'The live endpoints found while needsChoice was decided; present only then.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  port: { type: 'integer', required: true },
                  profile: { type: 'string', required: true, description: "Profile identity; '' when /json/version exposes none." },
                  kind: { type: 'string', required: true, enum: ['user', 'dsh'], description: 'dsh = launched by DSH; user = somebody else\'s browser.' },
                  targets: { type: 'integer', required: true },
                  attached: { type: 'boolean', required: true },
                  active: { type: 'boolean', required: true },
                  endpoint: { type: 'string', required: true },
                  browser: { type: 'string', required: true },
                },
              },
            },
            choices: { type: 'array', items: { type: 'string' }, description: 'Concrete parameter values that resolve the choice.' },
            // plan13-profile: the honest refusal (invalid profile name, profile already open elsewhere).
            reason: { type: 'string', description: 'Why the call did nothing at all.' },
            reasonCode: { type: 'string', enum: ['INVALID_PROFILE_NAME', 'PROFILE_LOCKED'] },
            profileDir: { type: 'string', description: 'The absolute profile directory a refusal concerns.' },
          },
        },
        render: (_args, val) => {
          // plan13-profile: a choice request renders as a QUESTION with the
          // table, never as "Connected to browser at " — nothing was attached.
          if (val.needsChoice === true) {
            const rows = val.discovered ?? []
            return [{
              type: 'text',
              text: `No decision made — ${String(rows.length)} live browser endpoint(s) found; nothing was opened or closed.`
                + `\nAsk the user which one to use, then call cdp_open again with switchTo/endpoint/profile:`
                + rows.map(row => `\n  ${row.active ? '*' : ' '} port=${String(row.port)} profile=${row.profile === '' ? '(unknown)' : row.profile}`
                  + ` kind=${row.kind} ${row.attached ? 'attached' : 'not attached'} targets=${String(row.targets)}`
                  + `${row.browser !== '' ? ` ${row.browser}` : ''}`).join(''),
            }]
          }
          if (val.ok === false) {
            return [{
              type: 'text',
              text: `cdp_open refused — nothing was opened.\n${String(val.reason ?? 'no reason given')}`
                + (val.profileDir !== undefined ? `\nProfile directory: ${val.profileDir}` : ''),
            }]
          }
          return [{
            type: 'text',
            text: `Connected to browser at ${val.endpoint} (${String(val.targets)} targets)`
              // plan04: name the pool id / reuse so multi-endpoint stays legible.
              + ` [${String(val.connectionId)}${val.reused ? ', reused' : ''}].`
              // plan13-profile: the profile is the first question a user asks.
              + (val.profile !== undefined ? ` profile=${val.profile}.` : '')
              // plan04-F6: surface the kept-session verdict when the request differed.
              + ('note' in val && val.note !== undefined ? ` ${String(val.note)}` : ''),
          }]
        },
      },
      execute: async (args) => {
        const res = await service.open({
          port: typeof args.port === 'number' ? args.port : undefined,
          headless: typeof args.headless === 'boolean' ? args.headless : undefined,
          executablePath: typeof args.executablePath === 'string' ? args.executablePath : undefined,
          endpoint: typeof args.endpoint === 'string' ? args.endpoint : undefined, // plan04
          // plan13-profile: the named answer and the durable profile.
          switchTo: typeof args.switchTo === 'number' ? args.switchTo : undefined,
          profile: typeof args.profile === 'string' && args.profile !== '' ? args.profile : undefined,
        })
        return {
          // plan13-profile: `ok` is FALSE exactly when a `reason` explains why
          // nothing happened. A needsChoice envelope is not a failure — it is a
          // successful report that the decision belongs to the user.
          ok: res.reason === undefined,
          endpoint: res.endpoint,
          targets: res.targets,
          // plan04: pool identity of the endpoint this call attached to.
          connectionId: res.connectionId,
          reused: res.reused,
          // plan04-F6: only present when the live session was kept.
          ...(res.note !== undefined ? { note: res.note } : {}),
          ...(res.profile !== undefined ? { profile: res.profile } : {}),
          ...(res.needsChoice === true
            ? { needsChoice: true, discovered: [...res.discovered ?? []], choices: [...res.choices ?? []] }
            : {}),
          ...(res.reason !== undefined ? { reason: res.reason } : {}),
          ...(res.reasonCode !== undefined ? { reasonCode: res.reasonCode } : {}),
          ...(res.profileDir !== undefined ? { profileDir: res.profileDir } : {}),
        }
      },
    })), 'cdp: cdp_open tool')

    // 3. cdp_tabs
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_tabs',
      // plan03: name the live refresh, the active marker, and the filters —
      // the model must know which tab a mutation would resolve to.
      description: 'List open tabs and targets in the controlled browser, marking the active tab. '
        + 'Refreshes from the browser by default; filter by type or a title/url substring.',
      parameters: {
        refresh: { type: 'boolean', description: 'Force a Target.getTargets round trip (default true).' },
        type: { type: 'string', description: "Filter rows by target type, e.g. 'page'." },
        query: { type: 'string', description: 'Case-insensitive substring matched against title and url.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            // plan03: which tab mutations resolve to when targetId is omitted.
            activeTargetId: { type: 'string', description: 'The active tab; absent when none is active.' },
            // plan03: set when refresh was requested but the round trip failed.
            stale: { type: 'boolean', description: 'True when the list was NOT refreshed from the browser.' },
            tabs: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  targetId: { type: 'string', required: true },
                  type: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  url: { type: 'string', required: true },
                  // Hotfix: TargetInfo always carries `attached` (targets.ts TargetInfo),
                  // and the runtime rejects any undeclared key under additionalProperties:false
                  // (ToolOutputError INVALID_TOOL_OUTPUT on every cdp_tabs call).
                  attached: { type: 'boolean', required: true },
                  // plan03: 1-based position in the full tracked list (additive).
                  index: { type: 'integer' },
                  // plan03: marks the active row (additive).
                  active: { type: 'boolean' },
                },
              },
            },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: [
            ...(val.activeTargetId !== undefined ? [`Active tab: ${val.activeTargetId}`] : []),
            ...val.tabs.map((t) => {
              const index = typeof t.index === 'number' ? `${String(t.index)}. ` : ''
              return `${index}[${t.type}]${t.active === true ? '*' : ''} ${t.title || 'Untitled'} - ${t.url} (${t.targetId})`
            }),
            ...(val.stale === true ? ['(tracked list, refresh failed)'] : []),
          ].join('\n') || 'No tabs open.',
        }],
      },
      execute: async (args) => {
        // plan03: refresh by default so the list mirrors the browser's own
        // state; a failed round trip is reported as `stale`, never hidden.
        const refresh = args.refresh !== false
        let stale = false
        if (refresh) {
          try {
            await service.refreshTargets()
          } catch {
            stale = true
          }
        }
        const activeTargetId = service.status().activeTargetId
        const typeFilter = typeof args.type === 'string' && args.type !== '' ? args.type : undefined
        const query = typeof args.query === 'string' && args.query !== ''
          ? args.query.toLowerCase()
          : undefined
        const tabs = [...service.targets]
          .map((target, index) => ({
            ...target,
            index: index + 1,
            active: target.targetId === activeTargetId,
          }))
          .filter(row => typeFilter === undefined || row.type === typeFilter)
          .filter(row => query === undefined
            || row.title.toLowerCase().includes(query)
            || row.url.toLowerCase().includes(query))
        return {
          ok: true,
          ...(activeTargetId !== undefined ? { activeTargetId } : {}),
          ...(refresh && stale ? { stale: true } : {}),
          tabs,
        }
      },
    })), 'cdp: cdp_tabs tool')

    // 4. cdp_navigate
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_navigate',
      description: 'Navigate the active or specified browser tab to a URL.',
      parameters: {
        url: { type: 'string', required: true, description: 'Destination URL to navigate to.' },
        targetId: { type: 'string', description: 'Target id of tab to navigate (defaults to active tab).' },
        timeoutMs: { type: 'number', description: 'Maximum load wait timeout in milliseconds.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            url: { type: 'string', required: true },
            frameId: { type: 'string' },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Navigated to ${val.url} (frameId: ${val.frameId ?? 'main'}).`,
        }],
      },
      execute: async (args) => {
        // plan05 branch 2: fail fast before the first command, and fail the
        // call if a dialog opens while the navigation is in flight.
        const outcome = await service.guardPageDialog(
          typeof args.targetId === 'string' ? args.targetId : undefined,
          async () => await service.navigate(
            args.url,
            typeof args.targetId === 'string' ? args.targetId : undefined,
            typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          ),
        )
        return { ok: true, url: args.url, frameId: outcome.frameId }
      },
    })), 'cdp: cdp_navigate tool')

    // plan16-view: one remembered woven model per target key so `includeDiff`
    // has a base; best-effort state that never widens an answer.
    const lastSnapshotNodes = new Map<string, CdpWovenNode[]>()
    // plan16-lock: one TTL lease desk per registration — parallel writers on a
    // tab queue instead of interleaving input garble (cursor browser_lock).
    const tabLocks = new TabLockRegistry()

    // 5. cdp_snapshot
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_snapshot',
      description: 'Capture a woven DOM snapshot of the current page with stable element references and bounding boxes. '
        + 'plan08: pass `ref` to additionally verify that reference against the fresh document '
        + '(stale-ref comes back honest instead of trusting an old rect).',
      parameters: {
        targetId: { type: 'string', description: 'Target id of the tab (defaults to active tab).' },
        // plan08: optional ref verification — checked against the same fresh document.
        ref: { type: 'string', description: 'Snapshot ref to verify in this call; adds ref/staleRef/refRect to the answer.' },
        // plan16-view: payload lenses over the same woven model.
        interactive: { type: 'boolean', description: 'Keep only interactive entries (buttons, links, fields…); nodeCount stays the woven total.' },
        compact: { type: 'boolean', description: `Clip names/values to 80 chars — smaller payload, identical refs.` },
        includeDiff: { type: 'boolean', description: 'Diff against the previous cdp_snapshot of the same target key: the nodes list narrows to what changed and a diff block carries the full delta (a rename shows as removed+added since the ref carries the name).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            title: { type: 'string', required: true },
            url: { type: 'string', required: true },
            nodeCount: { type: 'integer', required: true },
            // plan06: live CSS viewport the snapshot was measured in (replaces
            // the old hardcoded 1280x800) plus where the numbers came from.
            viewport: {
              type: 'object',
              description: 'Live CSS viewport the snapshot was measured in, in CSS pixels.',
              required: true,
              additionalProperties: false,
              properties: {
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                source: { type: 'string' },
              },
            },
            nodes: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ref: { type: 'string', required: true },
                  role: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  value: { type: 'string' },
                },
              },
            },
            // plan16-view: lens note (present when interactive/compact/includeDiff narrowed the list).
            filtered: { type: 'string', description: 'What the lenses kept/dropped; present when interactive, compact, or includeDiff was used.' },
            // plan16-view: delta vs the previous snapshot; present only with includeDiff.
            diff: {
              type: 'object',
              description: 'Delta vs the previous cdp_snapshot of the same target key (includeDiff).',
              additionalProperties: false,
              properties: {
                base: { type: 'string', description: "'previous' when diffed against a remembered model, 'none' on the first call." },
                added: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      ref: { type: 'string', required: true },
                      role: { type: 'string', required: true },
                      name: { type: 'string', required: true },
                      value: { type: 'string' },
                    },
                  },
                },
                removed: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      ref: { type: 'string', required: true },
                      role: { type: 'string', required: true },
                      name: { type: 'string', required: true },
                      value: { type: 'string' },
                    },
                  },
                },
                changed: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      ref: { type: 'string', required: true },
                      role: { type: 'string', required: true },
                      name: { type: 'string', required: true },
                      was: { type: 'string', required: true },
                    },
                  },
                },
                unchangedCount: { type: 'integer', required: true },
              },
            },
            // plan08: ref verification echo (all four present only when args.ref was passed).
            ref: { type: 'string', description: 'The ref verified against this fresh document.' },
            staleRef: { type: 'boolean', description: 'True when the ref no longer resolves (stale-ref).' },
            refReason: { type: 'string', description: 'stale-ref failure line; present only when staleRef is true.' },
            // plan08-fix-ref-rename: the ref resolved through node identity —
            // the element is still there, only its accessible name changed.
            refNote: { type: 'string', description: 'ref-target-renamed note; present when the ref was matched by node id after a name change.' },
            refRect: {
              type: 'object',
              description: 'Fresh viewport rect of the verified ref (CSS pixels); present when it resolves.',
              additionalProperties: false,
              properties: {
                x: { type: 'number', required: true },
                y: { type: 'number', required: true },
                width: { type: 'number', required: true },
                height: { type: 'number', required: true },
              },
            },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          // plan06: the model sees the measured viewport next to the node count.
          text: `Snapshot of "${val.title}" (${val.url}) - ${String(val.nodeCount)} nodes @ ${String(val.viewport.width)}x${String(val.viewport.height)} css px:\n`
            // plan16-view: when lenses narrowed the list, say so before the rows.
            + (typeof val.filtered === 'string' ? `FILTERED: ${val.filtered}\n` : '')
            // plan08-fix (T3 F2): refs print RAW in quotes — never decorated.
            // A model copies this string verbatim, so `@ref` here meant every
            // consumer answered stale-ref on a healthy page.
            + val.nodes.map(n => `"${n.ref}" [${n.role}] ${n.name}${n.value ? ` = "${n.value}"` : ''}`).join('\n')
            // plan16-view: the delta prints after the rows so a widened walk reads top-down.
            + (val.diff !== undefined
              ? `\nDIFF vs ${String(val.diff.base)}: +${String(val.diff.added.length)} -${String(val.diff.removed.length)} ~${String(val.diff.changed.length)}, ${String(val.diff.unchangedCount)} unchanged`
                + val.diff.added.map(n => `\n+ "${n.ref}" [${n.role}] ${n.name}`).join('')
                + val.diff.removed.map(n => `\n- "${n.ref}" [${n.role}] ${n.name}`).join('')
                + val.diff.changed.map(n => `\n~ "${n.ref}" [${n.role}] ${n.name} (was: ${n.was})`).join('')
                + (val.diff.added.length === 0 && val.diff.removed.length === 0 && val.diff.changed.length === 0 ? ' (no changes)' : '')
              : '')
            // plan08: a stale ref must be visible in the rendered line too.
            + (val.staleRef === true && typeof val.refReason === 'string' ? `\nREF STALE: ${val.refReason}` : '')
            // plan08-fix: an unresolved FORMAT error is not staleness — label it honestly.
            + (val.staleRef === false && typeof val.refReason === 'string' ? `\nREF UNRESOLVED: ${val.refReason}` : '')
            // plan08-fix-ref-rename: a rename is neither stale nor unresolved.
            + (typeof val.refNote === 'string' ? `\nREF RENAMED: ${val.refNote}` : ''),
        }],
      },
      execute: async (args) => {
        const targetId = typeof args.targetId === 'string' ? args.targetId : undefined
        // plan05 branch 2: the snapshot must not hang behind a frozen renderer.
        const snap = await service.guardPageDialog(
          targetId,
          async () => await service.snapshot(targetId),
        )
        // plan06: the cache was refreshed by snapshot() just above.
        const observedSource = service.status().viewport?.source
        // plan16-view: the lenses narrow the ROWS only — nodeCount stays the
        // woven total and the ref path below still verifies the full model (a
        // filtered-out element must not go stale by request).
        const fullNodes = snap.nodes
        const interactiveOnly = args.interactive === true
        const targetKey = typeof targetId === 'string' && targetId.length > 0 ? targetId : '<active>'
        const previous = args.includeDiff === true ? lastSnapshotNodes.get(targetKey) : undefined
        const delta = args.includeDiff === true && previous !== undefined ? diffSnapshots(previous, fullNodes) : undefined
        // plan16-view: with includeDiff the list narrows to what MOVED — the
        // full delta rides in `diff`, so the steady-state page costs ~nothing.
        const narrowedRefs = new Set<string>([
          ...(delta?.added.map(n => n.ref) ?? []),
          ...(delta?.changed.map(ch => ch.ref) ?? []),
        ])
        const rows = args.includeDiff === true && previous !== undefined
          ? fullNodes.filter(n => narrowedRefs.has(n.ref))
          : (interactiveOnly ? filterInteractive(fullNodes) : [...fullNodes])
        const viewNodes = args.compact === true ? rows.map(n => compactNode(n)) : rows
        // plan16-view: remember this model as the NEXT call's base (always — a
        // skipped includeDiff must not freeze the base forever).
        lastSnapshotNodes.set(targetKey, [...fullNodes])
        const lensNote = [
          args.includeDiff === true && previous !== undefined
            ? `includeDiff: ${String(rows.length)} moved of ${String(fullNodes.length)} woven`
            : (args.includeDiff === true ? 'includeDiff: no previous snapshot for this target key — full list, base none' : ''),
          interactiveOnly && args.includeDiff !== true ? `interactive only: ${String(rows.length)} of ${String(fullNodes.length)} woven` : '',
          args.compact === true ? 'names/values clipped to 80 chars' : '',
        ].filter(part => part.length > 0).join('; ')
        const base = {
          ok: true,
          title: snap.title,
          url: snap.url,
          nodeCount: fullNodes.length,
          viewport: {
            width: snap.viewport.width,
            height: snap.viewport.height,
            ...(observedSource !== undefined ? { source: observedSource } : {}),
          },
          nodes: viewNodes.map(n => ({
            ref: n.ref,
            role: n.role,
            name: n.name,
            ...(n.value !== undefined ? { value: n.value } : {}),
          })),
          ...(lensNote.length > 0 ? { filtered: lensNote } : {}),
          ...(args.includeDiff === true
            ? {
              diff: {
                base: previous !== undefined ? 'previous' : 'none',
                added: (delta?.added ?? []).map(n => ({ ref: n.ref, role: n.role, name: n.name, ...(n.value !== undefined ? { value: n.value } : {}) })),
                removed: (delta?.removed ?? []).map(n => ({ ref: n.ref, role: n.role, name: n.name, ...(n.value !== undefined ? { value: n.value } : {}) })),
                changed: delta?.changed ?? [],
                unchangedCount: delta?.unchangedCount ?? 0,
              },
            }
            : {}),
        }
        // plan08: when a ref was passed, verify it against a FRESH document so
        // a re-render answers stale-ref inside the same call as the snapshot.
        if (typeof args.ref !== 'string') return base
        try {
          const evidence = await service.resolveRef(args.ref, targetId)
          return {
            ...base,
            ref: args.ref,
            staleRef: false,
            refRect: evidence.rect,
            // plan08-fix-ref-rename: verified through node identity — the node
            // is alive, so this is emphatically NOT a stale ref.
            ...(evidence.renamed !== undefined ? { refNote: renameNote(evidence.renamed) } : {}),
          }
        } catch (error) {
          // Only a true stale-ref answers in-band; plan03 session refusals rethrow unchanged.
          if (!(error instanceof RefStaleError)) throw error
          return { ...base, ref: args.ref, staleRef: isStaleRefReason(error.message), refReason: error.message }
        }
      },
    })), 'cdp: cdp_snapshot tool')

    // plan16-lock: cursor browser_lock muadili TTL lease — iki paralel yazarın
    // aynı sekmeye girdiğini sıraya sokar; TTL'siz kilit kalamaz.
    // 37. cdp_lock
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_lock',
      description: 'Take a TTL lease on one tab so parallel automations queue instead of interleaving input on the same page. '
        + 'The lease dies at `lockedUntil` without any timer — a forgotten lock never sticks past its TTL. '
        + 'lock-held answers in-band with the holder and expiry (data, not an error).',
      parameters: {
        targetId: { type: 'string', description: 'Target id of the tab to lease (defaults to the active tab).' },
        holder: { type: 'string', description: 'Who is taking the lease (e.g. the subagent id); echoed in lock-held answers. Defaults to "session".' },
        ttlMs: { type: 'number', description: 'Lease lifetime in ms, clamped to 1000..300000 (default 60000).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            lockId: { type: 'string', description: 'The lease id; pass it to cdp_unlock. Present when acquired.' },
            targetKey: { type: 'string', required: true },
            holder: { type: 'string', required: true },
            lockedUntil: { type: 'string', required: true },
            reason: { type: 'string', description: "In-band refusal: 'lock-held'." },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: val.ok === true
            ? `Locked ${val.targetKey} for ${val.holder} until ${val.lockedUntil} (${String(val.lockId)})`
            : `LOCK HELD: ${val.targetKey} is leased by ${val.holder} until ${val.lockedUntil}`,
        }],
      },
      execute: async (args) => {
        const now = Date.now()
        const targetKey = typeof args.targetId === 'string' && args.targetId.length > 0 ? args.targetId : '<active>'
        const holder = typeof args.holder === 'string' && args.holder.length > 0 ? args.holder : 'session'
        const outcome = tabLocks.acquire(targetKey, holder, typeof args.ttlMs === 'number' ? args.ttlMs : 60_000, now)
        const iso = new Date(outcome.ok ? outcome.lease.lockedUntil : outcome.lockedUntil).toISOString()
        if (!outcome.ok) {
          return { ok: false, targetKey, holder: outcome.holder, lockedUntil: iso, reason: 'lock-held' }
        }
        return { ok: true, lockId: outcome.lease.lockId, targetKey, holder, lockedUntil: iso }
      },
    })), 'cdp: cdp_lock tool')

    // 38. cdp_unlock
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_unlock',
      description: 'Give back a cdp_lock lease. The holder must match when `holder` is passed; an unknown or already-released id answers in-band (double unlock is data, not an error).',
      parameters: {
        lockId: { type: 'string', description: 'Lease id returned by cdp_lock.' },
        holder: { type: 'string', description: 'Unlocking owner; must match the lease holder when given.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            targetKey: { type: 'string', description: 'The freed key. Present when released.' },
            reason: { type: 'string', description: "In-band refusal: 'unknown-lock' or 'not-holder'." },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: val.ok === true
            ? `Released ${String(val.targetKey)}`
            : `UNLOCK REFUSED: ${String(val.reason)}`,
        }],
      },
      execute: async (args) => {
        const lockId = typeof args.lockId === 'string' ? args.lockId : ''
        const holder = typeof args.holder === 'string' && args.holder.length > 0 ? args.holder : undefined
        const outcome = tabLocks.release(lockId, holder, Date.now())
        if (!outcome.ok) return { ok: false, reason: outcome.reason }
        return { ok: true, targetKey: outcome.released.targetKey }
      },
    })), 'cdp: cdp_unlock tool')

    // 6. cdp_eval
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_eval',
      description: 'Evaluate a bounded JavaScript expression in the page execution context.',
      parameters: {
        expression: { type: 'string', required: true, description: 'JavaScript code to evaluate.' },
        targetId: { type: 'string', description: 'Target id (defaults to active tab).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // plan01 §4.1: the three original fields keep their names; `ok`
            // may now be false and `result` stays '' — never a thrown crash.
            ok: { type: 'boolean', required: true },
            result: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            exception: { type: 'string', description: 'Raw exception text when the expression threw.' },
            error: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: {
                  type: 'string',
                  required: true,
                  enum: ['exception', 'timeout', 'connection', 'session', 'protocol'] as const,
                },
                name: { type: 'string' },
                message: { type: 'string', required: true },
                stack: { type: 'string' },
              },
            },
            targetId: { type: 'string', description: 'The target the evaluation actually resolved to.' },
            url: { type: 'string', description: 'location.href read before evaluating (wrong-tab evidence).' },
            terminated: {
              type: 'boolean',
              description: 'plan10-fix: on a timeout, true when Runtime.terminateExecution cancelled the page script (zombie prevention).',
            },
            documentHidden: {
              type: 'boolean',
              description: 'plan15-hidden: pre-run page-activity probe, reported only when corroborated — true requires document.visibilityState=hidden as well. Absent when the probe proved nothing.',
            },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: val.ok === true
            ? `Eval result: ${val.result}${val.truncated ? ' (truncated)' : ''}`
            : renderEvalFailure(val),
        }],
      },
      execute: async (args) => {
        const expression = args.expression
        const targetId = typeof args.targetId === 'string' ? args.targetId : undefined
        try {
          const res = await service.evalWithMeta(expression, targetId)
          return service.buildEvalOutcome(res.evaluation, res.targetId, res.url, res.documentHidden) /* plan10-fix */
        } catch (error) {
          // Known infrastructure failures become envelopes (§3.5); unknown
          // errors are rethrown by classifyCdpError and reach the pipeline.
          return service.buildEvalFailure(error, expression, targetId)
        }
      },
    })), 'cdp: cdp_eval tool')

    // 7. cdp_click
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_click',
      description: 'Click on viewport coordinates using realistic human-like pointer motion and timing. '
        + 'plan08: pass a snapshot `ref` instead of x/y to click that element\u2019s FRESH centre '
        + '(resolved at action time; a re-rendered page answers stale-ref, never a wrong coordinate).',
      parameters: {
        x: { type: 'number', description: 'X coordinate in CSS pixels (required together with y, unless ref is passed).' },
        y: { type: 'number', description: 'Y coordinate in CSS pixels (required together with x, unless ref is passed).' },
        // plan08: element reference path — resolution replaces raw coordinates.
        ref: { type: 'string', description: 'Snapshot ref from cdp_snapshot; clicks that element\u2019s fresh centre instead of x/y.' },
        // plan02: locator DSL mode — resolve + gate on actionability, click the centre.
        css: { type: 'string', description: 'CSS selector; when any locator param is present, x/y are refused.' },
        ariaLabel: { type: 'string', description: 'Match the aria-label attribute (normalized comparison).' },
        role: { type: 'string', description: 'ARIA role to match (requires name).' },
        name: { type: 'string', description: 'Accessible name; only used together with role.' },
        text: { type: 'string', description: 'Visible text resolved through the ladder aria-label > role+name > tag+text > innerText.' },
        textMatch: { type: 'string', enum: ['exact', 'contains'] as const, description: 'How text compares (default exact).' },
        nth: { type: 'integer', description: '0-based candidate index; required when more than one element matches.' },
        scope: { type: 'string', description: 'CSS selector bounding the whole search.' },
        timeoutMs: { type: 'number', description: 'Locator resolve budget in ms (default 5000, max 30000).' },
        targetId: { type: 'string', description: 'Target id (defaults to active tab).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            // plan02: optional coordinate evidence — present when the point could be described.
            targetId: { type: 'string' },
            url: { type: 'string' },
            hit: HIT_INFO_SCHEMA,
            // plan08: ref-path provenance and honest failure lines.
            ref: { type: 'string', description: 'Echoed when the click resolved a snapshot ref.' },
            staleRef: { type: 'boolean', description: 'True when the ref no longer resolves (stale-ref).' },
            // plan08-fix-ref-rename: present when the ref resolved through node
            // identity — the same element under a new accessible name.
            refNote: { type: 'string', description: 'ref-target-renamed note; the element was found by node id, not by name, and the click still went to it.' },
            reason: { type: 'string', description: 'Failure line for ok:false (stale-ref or argument error).' },
            resolvedBy: { type: 'string', enum: ['explicit', 'active', 'single-page', 'created', 'ref'], description: 'Provenance; \'ref\' when a snapshot ref drove the click.' },
            // plan02: locator-mode resolution evidence — optional so ref/coordinate envelopes stay stable.
            mode: { type: 'string', enum: ['coordinates', 'locator'], description: 'How the target was addressed; present only on the locator path.' },
            matched: { type: 'integer' },
            strategy: { type: 'string' },
            candidates: LOCATOR_CANDIDATES_SCHEMA,
            target: LOCATOR_TARGET_SCHEMA,
            actionability: LOCATOR_ACTIONABILITY_SCHEMA,
          },
        },
        render: (_args, val) => [{
          type: 'text',
          // plan08: an ok:false result must never render the legacy success line.
          text: val.ok === false && typeof val.reason === 'string'
            ? `Click failed: ${val.reason}`
            // plan02: locator mode names the resolution; coordinate/ref keep the legacy line.
            : typeof val.mode === 'string'
              ? `Clicked via locator (strategy=${String(val.strategy ?? 'none')}, matched=${String(val.matched ?? 0)}).`
              : 'Click dispatched successfully.'
            // plan08-fix-ref-rename: the click went to the SAME element under a
            // new name — say so, instead of letting the model think it moved.
            + (typeof val.refNote === 'string' ? `\nREF RENAMED: ${val.refNote}` : ''),
        }],
      },
      execute: async (args) => {
        const targetId = typeof args.targetId === 'string' ? args.targetId : undefined
        // plan02 (§4.1): locator-mode detection + mode conflicts, decided before any path runs.
        const hasLocator = (typeof args.css === 'string' && args.css !== '')
          || (typeof args.ariaLabel === 'string' && args.ariaLabel !== '')
          || (typeof args.role === 'string' && args.role !== '')
          || (typeof args.name === 'string' && args.name !== '')
          || (typeof args.text === 'string' && args.text !== '')
        if (hasLocator && typeof args.ref === 'string') {
          return { ok: false, reason: 'pass either ref or a locator, not both' }
        }
        // plan08 ref path: resolve NOW against a fresh document, click the fresh centre.
        if (typeof args.ref === 'string') {
          let evidence: RefEvidence
          try {
            evidence = await service.resolveRef(args.ref, targetId)
          } catch (error) {
            // Only a true stale-ref answers in-band; plan03 session refusals rethrow unchanged.
            if (!(error instanceof RefStaleError)) throw error
            return { ok: false, ref: args.ref, staleRef: isStaleRefReason(error.message), resolvedBy: 'ref' as const, reason: error.message }
          }
          if (evidence.frameLocal) {
            return {
              ok: false,
              ref: args.ref,
              staleRef: false,
              resolvedBy: 'ref' as const,
              reason: 'ref resolves inside a frame (its rect is frame-local), so a viewport-coordinate click would land elsewhere; frame clicks are not supported yet',
            }
          }
          const viewport = service.status().viewport
          const centre = centerOf(evidence.rect, viewport?.width, viewport?.height)
          const hit = await service.describePoint(centre.x, centre.y, targetId).catch(() => undefined)
          // plan05 branch 2: a dialog opened mid-click must fail the call.
          const refDelivery = await service.guardPageDialog(targetId, async () => await service.click({ x: centre.x, y: centre.y }, targetId))
          // F1 (T3/T6): a ref click may only report success for a DELIVERED event.
          if (refDelivery?.delivered === false) {
            return {
              ok: false,
              ref: args.ref,
              staleRef: false,
              resolvedBy: 'ref' as const,
              reason: 'click not delivered: no click event reached the page (target hidden or in the background?) — activate the tab with cdp_tab_focus and retry',
            }
          }
          return {
            ok: true,
            ref: args.ref,
            staleRef: false,
            resolvedBy: 'ref' as const,
            // plan08-fix-ref-rename: the click was DELIVERED to the element the
            // ref meant; only its name moved. Report that, not a false staleness.
            ...(evidence.renamed !== undefined ? { refNote: renameNote(evidence.renamed) } : {}),
            ...(hit !== undefined
              ? {
                  targetId: hit.targetId,
                  url: hit.url,
                  ...(hit.hit !== undefined ? { hit: hit.hit } : {}),
                }
              : {}),
          }
        }
        // plan08: x/y are no longer schema-required (ref-only clicks) — validate in-band.
        const x = args.x
        const y = args.y
        // plan02 (Adım 5): locator DSL mode — resolve NOW, gate on all actionability
        // axes, then click the rect centre. Coordinate and ref modes stay untouched.
        if (hasLocator) {
          if (typeof x === 'number' || typeof y === 'number') {
            return { ok: false, mode: 'locator' as const, reason: 'pass either coordinates or a locator, not both' }
          }
          const spec = locatorSpecFromArgs(args)
          const invalid = validateLocatorSpec(spec)
          if (invalid !== undefined) {
            return { ok: false, mode: 'locator' as const, reason: invalid }
          }
          const resolution = await service.resolveForAction(
            spec,
            targetId,
            typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          )
          if (!resolution.ok) {
            return {
              ok: false,
              mode: 'locator' as const,
              matched: resolution.matched,
              strategy: resolution.strategy,
              candidates: resolution.candidates,
              reason: resolution.reason,
              targetId: resolution.targetId,
              url: resolution.url,
            }
          }
          // plan05 branch 2: a dialog opened mid-click must fail the call.
          const locatorDelivery = await service.guardPageDialog(targetId, async () => await service.click(resolution.point, targetId))
          // F1 (T3/T6): "Clicked via locator" may only follow a delivered event —
          // hidden/background targets drop input and used to fake success.
          if (locatorDelivery?.delivered === false) {
            return {
              ok: false,
              mode: 'locator' as const,
              matched: resolution.matched,
              strategy: resolution.strategy,
              targetId: resolution.targetId,
              url: resolution.url,
              reason: 'click not delivered: no click event reached the page (target hidden or in the background?) — activate the tab with cdp_tab_focus and retry',
            }
          }
          // plan02: post-click evidence — what the click actually hit (best-effort).
          const evidence = await service.describePoint(resolution.point.x, resolution.point.y, targetId).catch(() => undefined)
          return {
            ok: true,
            mode: 'locator' as const,
            matched: resolution.matched,
            strategy: resolution.strategy,
            target: resolution.target,
            actionability: resolution.actionability,
            ...(evidence !== undefined
              ? {
                  targetId: evidence.targetId,
                  url: evidence.url,
                  ...(evidence.hit !== undefined ? { hit: evidence.hit } : {}),
                }
              : { targetId: resolution.targetId, url: resolution.url }),
          }
        }
        if (typeof x !== 'number' || typeof y !== 'number') {
          return { ok: false, reason: 'pass ref, or pass both x and y' }
        }
        // F5: a coordinate the page cannot receive is an honest failure, not a
        // silent dispatch — negatives/NaN first, then the page-side viewport.
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
          return { ok: false, reason: `out-of-bounds coordinate (${String(x)},${String(y)}); coordinates must be finite and non-negative` }
        }
        const viewport = await service.readViewport(targetId).catch(() => undefined)
        if (viewport !== undefined && (x >= viewport.width || y >= viewport.height)) {
          return {
            ok: false,
            reason: `out-of-bounds coordinate (${String(viewport.width)}×${String(viewport.height)} viewport, got ${String(x)},${String(y)})`,
          }
        }
        // plan02: describe what sits at the point first; strictly optional evidence.
        const evidence = await service.describePoint(
          x,
          y,
          targetId,
        ).catch(() => undefined)
        // plan05 branch 2: a dialog opened mid-click must fail the call.
        const coordDelivery = await service.guardPageDialog(
          targetId,
          async () => await service.click(
            { x, y },
            targetId,
          ),
        )
        // F1 (T3/T6): dispatch without a delivered event = failure, never success.
        if (coordDelivery?.delivered === false) {
          return {
            ok: false,
            reason: 'click not delivered: no click event reached the page (target hidden or in the background?) — activate the tab with cdp_tab_focus and retry',
          }
        }
        return {
          ok: true,
          ...(evidence !== undefined
            ? {
                targetId: evidence.targetId,
                url: evidence.url,
                ...(evidence.hit !== undefined ? { hit: evidence.hit } : {}),
              }
            : {}),
        }
      },
    })), 'cdp: cdp_click tool')

    // 8. cdp_type
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_type',
      description: 'Type text into the focused page element with human-like cadence and character delays. '
        + 'plan08: pass a snapshot `ref` to focus that element first (clicked at its fresh centre, then typed).',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to type.' },
        // plan08: element reference path — focus by resolving the ref, then type.
        ref: { type: 'string', description: 'Snapshot ref from cdp_snapshot; clicks that element\u2019s fresh centre to focus it, then types.' },
        targetId: { type: 'string', description: 'Target id (defaults to active tab).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            typedCharacters: { type: 'integer', required: true },
            // plan02: optional focus evidence — present when the active element could be described.
            targetId: { type: 'string' },
            url: { type: 'string' },
            focused: HIT_INFO_SCHEMA,
            // plan08: ref-path provenance and honest failure lines.
            ref: { type: 'string', description: 'Echoed when typing resolved a snapshot ref.' },
            staleRef: { type: 'boolean', description: 'True when the ref no longer resolves (stale-ref).' },
            // plan08-fix-ref-rename: present when the ref resolved through node
            // identity — the same element under a new accessible name.
            refNote: { type: 'string', description: 'ref-target-renamed note; the element was found by node id, not by name, and the keystrokes still went to it.' },
            reason: { type: 'string', description: 'Failure line for ok:false (stale-ref or frame limitation).' },
            resolvedBy: { type: 'string', enum: ['explicit', 'active', 'single-page', 'created', 'ref'], description: 'Provenance; \'ref\' when a snapshot ref drove the focus.' },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          // plan08: an ok:false result must never render the legacy success line.
          text: val.ok === false && typeof val.reason === 'string'
            ? `Typing failed: ${val.reason}`
            : `Typed ${String(val.typedCharacters)} characters.`
            // plan08-fix-ref-rename: focused the SAME element under a new name.
            + (typeof val.refNote === 'string' ? `\nREF RENAMED: ${val.refNote}` : ''),
        }],
      },
      execute: async (args) => {
        const targetId = typeof args.targetId === 'string' ? args.targetId : undefined
        // plan08 ref path: resolve now, click the fresh centre to focus, then type.
        if (typeof args.ref === 'string') {
          let evidence: RefEvidence
          try {
            evidence = await service.resolveRef(args.ref, targetId)
          } catch (error) {
            // Only a true stale-ref answers in-band; plan03 session refusals rethrow unchanged.
            if (!(error instanceof RefStaleError)) throw error
            return { ok: false, typedCharacters: 0, ref: args.ref, staleRef: isStaleRefReason(error.message), resolvedBy: 'ref' as const, reason: error.message }
          }
          if (evidence.frameLocal) {
            return {
              ok: false,
              typedCharacters: 0,
              ref: args.ref,
              staleRef: false,
              resolvedBy: 'ref' as const,
              reason: 'ref resolves inside a frame (its rect is frame-local), so a viewport-coordinate focus would land elsewhere; frame focus is not supported yet',
            }
          }
          const viewport = service.status().viewport
          const centre = centerOf(evidence.rect, viewport?.width, viewport?.height)
          // plan02: capture where keystrokes are about to go; strictly optional evidence.
          const focus = await service.describeFocus(targetId).catch(() => undefined)
          // plan02-fix-type-focus: arm the gate BEFORE the click — it must name
          // the node the click lands on, not whatever focus drifts to later.
          await typeFocusProbe(async () => await service.armTypeFocus(centre.x, centre.y, targetId))
          // plan05 branch 2: typing into a frozen renderer would stall forever.
          const outcome = await service.guardPageDialog(targetId, async () => {
            await service.click({ x: centre.x, y: centre.y }, targetId)
            // plan02-fix-type-focus: the focus gate. Keystrokes go to
            // `document.activeElement`, not to the ref we resolved — when the
            // click left focus on `<body>` every character was dispatched into
            // the void while the tool reported "Typed N characters.". A real
            // lost-focus verdict refuses here, before the first keystroke.
            const check = await typeFocusProbe(async () => await service.verifyTypeFocus(targetId))
            if (check?.holds === false) return { focusLost: check }
            return { typed: await service.type(args.text, targetId) }
          })
          // plan02-fix-type-focus: honest in-band refusal — nothing was typed.
          if ('focusLost' in outcome) {
            return {
              ok: false,
              typedCharacters: 0,
              ref: args.ref,
              staleRef: false,
              resolvedBy: 'ref' as const,
              reason: focusLostReason(outcome.focusLost),
              ...(focus !== undefined ? { targetId: focus.targetId, url: focus.url } : {}),
            }
          }
          // F4 (T3/T6): a budget that stopped mid-string is never a success —
          // the envelope says exactly what landed and what to retry.
          const typed = outcome.typed
          const refTruncated = typed.skipped > 0
          return {
            ok: !refTruncated,
            typedCharacters: typed.typed,
            ...(refTruncated
              ? { reason: `typed ${String(typed.typed)} of ${String(typed.typed + typed.skipped)} characters — TRUNCATED by the input budget (retry with the remaining text)` }
              : {}),
            ref: args.ref,
            staleRef: false,
            resolvedBy: 'ref' as const,
            // plan08-fix-ref-rename: the focus click reached the SAME element
            // even though its accessible name changed under the ref.
            ...(evidence.renamed !== undefined ? { refNote: renameNote(evidence.renamed) } : {}),
            ...(focus !== undefined
              ? {
                  targetId: focus.targetId,
                  url: focus.url,
                  ...(focus.focused !== undefined ? { focused: focus.focused } : {}),
                }
              : {}),
          }
        }
        // plan02: capture where keystrokes are about to go; strictly optional evidence.
        const focus = await service.describeFocus(targetId).catch(() => undefined)
        // plan05 branch 2: typing into a frozen renderer would stall forever.
        const outcome = await service.guardPageDialog(
          targetId,
          async () => await service.type(
            args.text,
            targetId,
          ),
        )
        // F4 (T3/T6): partial typing must never render as a plain success.
        const truncated = outcome.skipped > 0
        return {
          ok: !truncated,
          typedCharacters: outcome.typed,
          ...(truncated
            ? { reason: `typed ${String(outcome.typed)} of ${String(outcome.typed + outcome.skipped)} characters — TRUNCATED by the input budget (retry with the remaining text)` }
            : {}),
          ...(focus !== undefined
            ? {
                targetId: focus.targetId,
                url: focus.url,
                ...(focus.focused !== undefined ? { focused: focus.focused } : {}),
              }
            : {}),
        }
      },
    })), 'cdp: cdp_type tool')

    // 9. cdp_wait (plan02 Faz 3: seven strategies, in-band timeout)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_wait',
      description: 'Wait for a page condition: a CSS selector, an aria-label/text/visible element state, '
        + 'network-idle (default 500ms quiet), the next navigation, or a URL regex pattern. Timeouts return '
        + 'in-band (ok:false + reason + waitedMs) instead of throwing. strategy=text waits for visible text '
        + 'matching the text argument (+ textMatch) with NO selector needed. Back-compat: cdp_wait({selector}) '
        + 'waits for CSS presence exactly as before (default timeout 10000ms).',
      parameters: {
        selector: { type: 'string', description: 'Value for css/aria-label/visible strategies (css is the default); may also carry strategy=text for back-compat.' },
        strategy: { type: 'string', enum: WAIT_STRATEGIES, description: 'What to wait for: css, aria-label, text, visible, network-idle, navigation, url (default css; defaults to text when text is passed).' },
        text: { type: 'string', description: 'Expected visible text for strategy=text — works standalone, no selector required.' },
        textMatch: { type: 'string', enum: ['exact', 'contains'], description: 'How strategy=text compares the text (default exact).' },
        url: { type: 'string', description: 'Regex for strategy=url (the selector may carry it instead).' },
        idleMs: { type: 'number', description: 'Quiet window for network-idle in milliseconds (default 500).' },
        timeoutMs: { type: 'number', description: 'Maximum wait timeout in milliseconds (default: 10000).' },
        targetId: { type: 'string', description: 'Target id (defaults to active tab).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', enum: ['wait'], required: true },
            waitedMs: { type: 'number', required: true },
            timedOut: { type: 'boolean', required: true },
            strategy: { type: 'string', enum: WAIT_STRATEGIES },
            selector: { type: 'string' },
            text: { type: 'string' },
            url: { type: 'string' },
            target: LOCATOR_TARGET_SCHEMA,
            reason: { type: 'string' },
          },
        },
        render: (_args, val) => [{ type: 'text', text: renderWait(val) }],
      },
      execute: async (args) => {
        // Structural failures never touch the page: reason in-band, no round trip.
        const invalid = validateWaitArgs(args)
        if (invalid !== undefined) {
          // Echo a schema-valid strategy so the failure line names the real
          // one (an unknown value stays out — the enum would reject it).
          const known = typeof args.strategy === 'string' && (WAIT_STRATEGIES as readonly string[]).includes(args.strategy)
          return {
            ok: false,
            action: 'wait' as const,
            ...(known ? { strategy: args.strategy } : {}),
            waitedMs: 0,
            timedOut: false,
            reason: invalid,
          }
        }
        const plan = waitPlan(args)
        const targetId = typeof args.targetId === 'string' ? args.targetId : undefined
        // plan05 branch 2: the wait must abort the moment a dialog opens.
        return await service.guardPageDialog(targetId, async (): Promise<WaitOutcome> => {
          const session = await service.getPageSession(targetId)
          const seam: WaitSeam = {
            // plan02: byte-compat with the legacy contract — same call, raw timeout.
            waitForSelector: (selector, timeout) => session.waitForSelector(selector, timeout),
            waitForLoad: (timeout) => session.waitForLoad(timeout),
            currentUrl: () => session.url(),
            expectCheck: (check, spec, timeout) => service.expectCheck({ check, spec, timeoutMs: timeout, targetId }),
            networkIdle: (timeout, idle) => service.waitNetworkIdle(timeout, idle, targetId),
          }
          return await runWait(seam, plan)
        })
      },
    })), 'cdp: cdp_wait tool')

    // 10. net_capture
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'net_capture',
      description: 'Query captured HTTP/HTTPS network exchanges intercepted by the local proxy.',
      parameters: {
        limit: { type: 'number', description: 'Maximum number of exchanges to return (default 50).' },
        host: { type: 'string', description: 'Filter captured requests by target host.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            // plan04-FAZ7: present only when ok:false — why capture is impossible.
            reason: { type: 'string' },
            total: { type: 'integer', required: true },
            returned: { type: 'integer', required: true },
            exchanges: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  method: { type: 'string', required: true },
                  url: { type: 'string', required: true },
                  status: { type: 'integer', required: true },
                  durationMs: { type: 'number', required: true },
                  redacted: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, val) => 'reason' in val
          // plan04-FAZ7: never dress an impossible capture up as `0 of 0`.
          ? [{ type: 'text', text: `Capture unavailable: ${String(val.reason)}` }]
          : [{
              type: 'text',
              text: `Captured ${String(val.returned)} of ${String(val.total)} exchanges:\n`
                + val.exchanges.map(e => `[${e.method}] ${e.url} -> ${String(e.status)} (${String(e.durationMs)}ms)`).join('\n'),
            }],
      },
      execute: async (args) => {
        // plan04-FAZ7: make sure the interceptor can listen before reporting;
        // an unreachable bind is an honest ok:false, not a silent empty list.
        const proxy = await service.ensureProxy()
        if (!proxy.active) {
          return {
            ok: false,
            reason: 'proxy inactive — capture impossible; the local capture proxy is not listening'
              + (proxy.error !== undefined ? ` (${proxy.error})` : '')
              + ' — cdp_status.proxy.active must be true before exchanges can be recorded',
            total: 0,
            returned: 0,
            exchanges: [],
          }
        }
        let list = [...service.captureStore.list()]
        if (typeof args.host === 'string' && args.host.length > 0) {
          list = list.filter(e => e.request.url.includes(args.host ?? ''))
        }
        const total = list.length
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 50
        const items = list.slice(0, limit)
        return Promise.resolve({
          ok: true,
          total,
          returned: items.length,
          exchanges: items.map(e => ({
            id: e.id,
            method: e.request.method,
            url: e.request.url,
            status: e.response.status,
            durationMs: Math.max(0, e.response.finishedAt - e.request.startedAt),
            redacted: e.redacted,
          })),
        })
      },
    })), 'cdp: net_capture tool')

    // 11. net_export
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'net_export',
      description: 'Export traffic metrics, host groups, and request timelines from the proxy capture store.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            // plan04-FAZ7: present only when ok:false — why export is impossible.
            reason: { type: 'string' },
            totalExchanges: { type: 'integer', required: true },
            totalBodyBytes: { type: 'integer', required: true },
            hosts: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  host: { type: 'string', required: true },
                  exchanges: { type: 'integer', required: true },
                  totalBodyBytes: { type: 'integer', required: true },
                },
              },
            },
          },
        },
        render: (_args, val) => 'reason' in val
          // plan04-FAZ7: an impossible export is reported, not summarized as 0.
          ? [{ type: 'text', text: `Capture unavailable: ${String(val.reason)}` }]
          : [{
              type: 'text',
              text: `Traffic Summary: ${String(val.totalExchanges)} exchanges, ${String(val.totalBodyBytes)} body bytes across ${String(val.hosts.length)} hosts:\n`
                + val.hosts.map(h => `${h.host || '(local)'}: ${String(h.exchanges)} requests, ${String(h.totalBodyBytes)} bytes`).join('\n'),
            }],
      },
      execute: async () => {
        // plan04-FAZ7: same honest gate as net_capture — try to bind first.
        const proxy = await service.ensureProxy()
        if (!proxy.active) {
          return {
            ok: false,
            reason: 'proxy inactive — capture impossible; the local capture proxy is not listening'
              + (proxy.error !== undefined ? ` (${proxy.error})` : '')
              + ' — cdp_status.proxy.active must be true before exchanges can be recorded',
            totalExchanges: 0,
            totalBodyBytes: 0,
            hosts: [],
          }
        }
        const store = service.captureStore
        const list = store.list()
        const hostGroups = groupCaptureByHost(list)
        return Promise.resolve({
          ok: true,
          totalExchanges: store.size,
          totalBodyBytes: store.totalBodyBytes,
          hosts: hostGroups.map(h => ({
            host: h.host,
            exchanges: h.exchanges,
            totalBodyBytes: h.totalBodyBytes,
          })),
        })
      },
    })), 'cdp: net_export tool')

    // 12. cdp_screenshot (plan06)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_screenshot',
      description: 'Capture a screenshot to a file: returns the path plus parsed dimensions, never raw binary. Optional fullPage/clip/selector capture, jpeg quality, inline base64 within a small budget, and DOM-free rect legend/annotate.',
      parameters: {
        targetId: { type: 'string', description: 'Target id of the tab (defaults to active tab).' },
        fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of the viewport.' },
        format: { type: 'string', description: 'Image format: "png" (default) or "jpeg".' },
        quality: { type: 'number', description: 'JPEG quality 0..100 (default 80; ignored for png).' },
        clip: {
          type: 'object',
          description: 'Explicit CSS-pixel capture region {x, y, width, height, scale?}; overrides fullPage.',
          additionalProperties: false,
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            scale: { type: 'number' },
          },
        },
        selector: { type: 'string', description: 'CSS selector; captures that element\'s bounding box (top document only).' },
        saveTo: { type: 'string', description: 'Workspace-relative destination; defaults to screenshots/<timestamp>-<n>.<ext>.' },
        inline: { type: 'boolean', description: 'Also return the image as base64 when it fits inlineMaxBytes (default false).' },
        inlineMaxBytes: { type: 'number', description: 'Inline budget in bytes (default 65536, capped at 65536).' },
        rects: { type: 'boolean', description: 'Return snapshot box rects mapped onto image pixels with a coordinate legend.' },
        annotate: { type: 'boolean', description: 'Paint the legend rects onto the saved png after capture; the page DOM is never touched.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            // plan06: success-only fields stay optional because the ok:false
            // envelope (CdpScreenshotError and friends) carries no path.
            path: { type: 'string' },
            format: { type: 'string' },
            byteSize: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            cssWidth: { type: 'integer' },
            cssHeight: { type: 'integer' },
            deviceScaleFactor: { type: 'number' },
            fullPage: { type: 'boolean' },
            viewport: {
              type: 'object',
              additionalProperties: false,
              properties: {
                width: { type: 'integer' },
                height: { type: 'integer' },
              },
            },
            selector: { type: 'string' },
            rects: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ref: { type: 'string' },
                  x: { type: 'number' },
                  y: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                  label: { type: 'string' },
                },
              },
            },
            rectsTruncated: { type: 'boolean' },
            coordinateSpace: { type: 'string' },
            inline: { type: 'string' },
            inlineOmitted: { type: 'boolean' },
            durationMs: { type: 'number' },
            error: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: val.ok !== true
            ? `Screenshot failed: ${val.error?.name ?? 'Error'}: ${val.error?.message ?? 'unknown error'}`
            : `Screenshot saved: ${val.path} (${String(val.width ?? 0)}x${String(val.height ?? 0)} px, css ${String(val.cssWidth ?? 0)}x${String(val.cssHeight ?? 0)} @dpr${String(val.deviceScaleFactor ?? 1)}, ${String(val.byteSize ?? 0)} bytes${val.fullPage === true ? ', fullPage' : ''}${val.inline === undefined ? '' : val.inlineOmitted === true ? '; inline omitted (over budget)' : ', inline attached'}${(val.rects?.length ?? 0) > 0 ? `, ${String(val.rects?.length)} legend rects` : ''}).`,
        }],
      },
      execute: async (args) => {
        try {
          const request = normalizeScreenshotRequest(args as unknown as Record<string, unknown>)
          return await service.screenshot(request)
        } catch (err) {
          return errorEnvelope(err)
        }
      },
    })), 'cdp: cdp_screenshot tool')

    // 13. cdp_viewport (plan06)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_viewport',
      description: 'Read or explicitly change the viewport (Emulation.setDeviceMetricsOverride). Without parameters it only reports the live viewport; width+height set it; reset clears it. No other tool ever changes the viewport. '
        + 'A change is only reported applied when the page own resize handler provably ran — otherwise ok:false with the reason. '
        + 'appliedViewport is what this call actually acted on. /* plan15-viewport */',
      parameters: {
        width: { type: 'number', description: 'Viewport width in CSS pixels (16..10000, integer; requires height).' },
        height: { type: 'number', description: 'Viewport height in CSS pixels (16..10000, integer; requires width).' },
        deviceScaleFactor: { type: 'number', description: 'Device pixel ratio to emulate (default: keep the observed one).' },
        mobile: { type: 'boolean', description: 'Whether to emulate a mobile (touch) viewport; default false.' },
        reset: { type: 'boolean', description: 'Clear the emulation override and restore the live window metrics.' },
        targetId: { type: 'string', description: 'Target id of the tab (defaults to active tab).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            viewport: {
              type: 'object',
              additionalProperties: false,
              properties: {
                width: { type: 'integer' },
                height: { type: 'integer' },
                deviceScaleFactor: { type: 'number' },
                mobile: { type: 'boolean' },
              },
            },
            source: { type: 'string' },
            applied: { type: 'boolean' },
            // plan15-viewport: the viewport this call actually acted on, measured
            // at the instant the Emulation call went out. It differs from
            // `viewport` whenever the shared window moved in between — the
            // pre-fix answer reported only the post-state and hid that race.
            appliedViewport: {
              type: 'object',
              description: 'plan15-viewport: the viewport measured at dispatch time; the acted-on number, not the wished-for one.',
              additionalProperties: false,
              properties: {
                width: { type: 'integer' },
                height: { type: 'integer' },
                deviceScaleFactor: { type: 'number' },
                mobile: { type: 'boolean' },
              },
            },
            // plan15-viewport: page-side proof that the page's OWN resize
            // handler ran — the metrics read alone could not tell.
            resizeEvent: {
              type: 'object',
              additionalProperties: false,
              properties: {
                delivered: {
                  type: 'string',
                  required: true,
                  enum: ['delivered', 'not-delivered', 'unverified'] as const,
                  description: 'plan15-viewport: whether a resize event provably reached the page; unverified is NOT delivered.',
                },
                events: { type: 'integer', description: 'plan15-viewport: resize events the page counted between the two reads.' },
                visibilityState: { type: 'string' },
                documentHidden: { type: 'boolean' },
              },
            },
            // plan15-viewport: the honest in-band reason a change the browser
            // accepted but the page never heard about is not an applied one.
            reason: { type: 'string', description: 'plan15-viewport: what was not delivered and what to do about it.' },
            error: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: renderViewportOutcomeText(val),
        }],
      },
      execute: async (args) => {
        try {
          return await service.applyViewport({
            ...(typeof args.width === 'number' ? { width: args.width } : {}),
            ...(typeof args.height === 'number' ? { height: args.height } : {}),
            ...(typeof args.deviceScaleFactor === 'number' ? { deviceScaleFactor: args.deviceScaleFactor } : {}),
            ...(typeof args.mobile === 'boolean' ? { mobile: args.mobile } : {}),
            ...(typeof args.reset === 'boolean' ? { reset: args.reset } : {}),
            ...(typeof args.targetId === 'string' ? { targetId: args.targetId } : {}),
          })
        } catch (err) {
          return errorEnvelope(err)
        }
      },
    })), 'cdp: cdp_viewport tool')

    // 14. cdp_printpdf (plan10)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_printpdf',
      description: 'Print the current page to a PDF inside the downloads root (Page.printToPDF round-trip). Returns the saved path, size, and page count; the bytes stay on disk.',
      parameters: {
        format: { type: 'string', description: 'Paper format: A4, Letter, Legal, or Tabloid (default: CDP default).' },
        landscape: { type: 'boolean', description: 'Landscape orientation.' },
        scale: { type: 'number', description: 'Paper scale 0.1..2.0.' },
        printBackground: { type: 'boolean', description: 'Include background graphics (default true).' },
        pageRanges: { type: 'string', description: 'Page range such as "1-3,5".' },
        targetId: { type: 'string', description: 'Target id of the tab to print (defaults to active tab).' },
        saveTo: { type: 'string', description: 'Explicit destination filename inside the downloads root; hard-errors if it exists.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            path: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            pageCount: { type: 'integer', required: true },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Printed to PDF: ${val.path} (${String(val.bytes)} bytes, ${String(val.pageCount)} pages).`,
        }],
      },
      execute: async (args) => {
        const printed = await service.printToPdf({
          ...(typeof args.format === 'string' && (args.format === 'A4' || args.format === 'Letter' || args.format === 'Legal' || args.format === 'Tabloid') ? { format: args.format } : {}),
          ...(typeof args.landscape === 'boolean' ? { landscape: args.landscape } : {}),
          ...(typeof args.scale === 'number' ? { scale: args.scale } : {}),
          ...(typeof args.printBackground === 'boolean' ? { printBackground: args.printBackground } : {}),
          ...(typeof args.pageRanges === 'string' ? { pageRanges: args.pageRanges } : {}),
          ...(typeof args.targetId === 'string' ? { targetId: args.targetId } : {}),
          ...(typeof args.saveTo === 'string' ? { saveTo: args.saveTo } : {}),
        })
        return { ok: true, path: printed.path, bytes: printed.bytes, pageCount: printed.pageCount }
      },
    })), 'cdp: cdp_printpdf tool') /* plan10 */

    // 15. cdp_download (plan10)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_download',
      description: 'Wait for the next browser download to finish and report where it landed inside the downloads root. Renames auto-named files to their suggested filename; an occupied renameTo is a hard error.',
      parameters: {
        timeoutMs: { type: 'number', description: 'How long to wait for a download to begin (default 60000).' },
        renameTo: { type: 'string', description: 'Explicit destination basename (must not already exist).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            path: { type: 'string', required: true },
            suggestedFilename: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            guid: { type: 'string', required: true },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Downloaded ${val.suggestedFilename} → ${val.path} (${String(val.bytes)} bytes).`,
        }],
      },
      execute: async (args) => {
        const outcome = await service.downloadNext({
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
          ...(typeof args.renameTo === 'string' ? { renameTo: args.renameTo } : {}),
        })
        if (!outcome.ok) throw new Error(outcome.error ?? `cdp: download: ${outcome.state}`)
        if (outcome.path === undefined) throw new Error('cdp: download: completed without a path')
        return {
          ok: true,
          path: outcome.path,
          suggestedFilename: outcome.suggestedFilename,
          bytes: outcome.bytes,
          guid: outcome.guid,
        }
      },
    })), 'cdp: cdp_download tool') /* plan10 */

    // 16. cdp_readpdf (plan10)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_readpdf',
      description: 'Read a PDF from the downloads root with page-marked, budget-bounded text. Supports page/pageFrom cursors, a pages spec ("1-5", "3,7"), meta/forms/barcode honesty fields, and honest reports for encrypted or image-only documents.',
      parameters: {
        path: { type: 'string', required: true, description: 'Root-relative PDF path inside the downloads root.' },
        page: { type: 'number', description: 'Read exactly this page (single-page mode; its own budget, cursor = next page).' },
        pageFrom: { type: 'number', description: 'First page to read when continuing a previous window.' },
        pages: { type: 'string', description: 'Page list/range spec, e.g. "1-5" or "3,7,9-12".' },
        maxChars: { type: 'number', description: 'Character budget for this call (default 16000, cap 64000).' },
        includeMeta: { type: 'boolean', description: 'Skip /Info metadata parsing when false.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            path: { type: 'string', required: true },
            pageCount: { type: 'integer', required: true },
            encrypted: { type: 'boolean', required: true },
            passwordRequired: { type: 'boolean', required: true },
            textLayer: { type: 'string', required: true },
            pagesWithText: { type: 'integer', required: true },
            pageFrom: { type: 'integer', required: true },
            pageTo: { type: 'integer', required: true },
            nextPage: { type: 'integer' },
            hasMore: { type: 'boolean', required: true },
            chars: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
            pages: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  page: { type: 'integer', required: true },
                  text: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                },
              },
            },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
            meta: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                author: { type: 'string' },
                subject: { type: 'string' },
                producer: { type: 'string' },
                creator: { type: 'string' },
                creationDate: { type: 'string' },
              },
            },
            forms: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  field: { type: 'string', required: true },
                  value: { type: 'string', required: true },
                },
              },
            },
            barcode: { type: 'string' },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: val.encrypted
            ? `PDF ${val.path}: encrypted — password required (no text).`
            : `Read ${val.path}: ${String(val.pageCount)} pages, text layer ${val.textLayer}, `
              + `showing ${String(val.pageFrom)}–${String(val.pageTo)} (${String(val.chars)} chars`
              + `${val.truncated ? ', truncated' : ''}${val.hasMore ? `, nextPage ${String(val.nextPage ?? val.pageTo + 1)}` : ''}).`
              + (val.pages[0] !== undefined && val.pages[0].text !== '' ? ` First: ${val.pages[0].text.slice(0, 160)}` : ''),
        }],
      },
      execute: async (args) => {
        const { path, extracted } = await service.readPdf({
          path: args.path,
          ...(typeof args.page === 'number' ? { page: args.page } : {}),
          ...(typeof args.pageFrom === 'number' ? { pageFrom: args.pageFrom } : {}),
          ...(typeof args.pages === 'string' ? { pages: args.pages } : {}),
          ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
          ...(typeof args.includeMeta === 'boolean' ? { includeMeta: args.includeMeta } : {}),
        })
        const meta = extracted.meta
        return {
          ok: true,
          path,
          pageCount: extracted.pageCount,
          encrypted: extracted.encrypted,
          passwordRequired: extracted.passwordRequired,
          textLayer: extracted.textLayer,
          pagesWithText: extracted.pagesWithText,
          pageFrom: extracted.pageFrom,
          pageTo: extracted.pageTo,
          hasMore: extracted.hasMore,
          chars: extracted.chars,
          truncated: extracted.truncated,
          pages: extracted.pages,
          warnings: extracted.warnings,
          ...(extracted.nextPage !== undefined ? { nextPage: extracted.nextPage } : {}),
          ...(meta !== undefined ? {
            meta: {
              ...(meta.title !== undefined ? { title: meta.title } : {}),
              ...(meta.author !== undefined ? { author: meta.author } : {}),
              ...(meta.subject !== undefined ? { subject: meta.subject } : {}),
              ...(meta.producer !== undefined ? { producer: meta.producer } : {}),
              ...(meta.creator !== undefined ? { creator: meta.creator } : {}),
              ...(meta.creationDate !== undefined ? { creationDate: meta.creationDate } : {}),
            },
          } : {}),
          ...(extracted.forms !== undefined ? { forms: extracted.forms } : {}),
          ...(extracted.barcode !== undefined ? { barcode: extracted.barcode } : {}),
        }
      },
    })), 'cdp: cdp_readpdf tool') /* plan10 */

    // 17. cdp_pdftotext (plan10)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_pdftotext',
      description: 'Extract text from the PDF the page is showing: auto strategies network → print → axtree (or pin one with strategy). Reports the strategy detail and honesty notes; all strategies failing aggregates their reasons.',
      parameters: {
        strategy: { type: 'string', description: 'Pin one strategy: network, print, axtree, or auto (default).' },
        maxChars: { type: 'number', description: 'Character budget (default 16000, cap 64000).' },
        page: { type: 'number', description: 'Read exactly this page.' },
        pageFrom: { type: 'number', description: 'First page when continuing a window.' },
        timeoutMs: { type: 'number', description: 'Per-strategy wall-clock budget (default 20000).' },
        targetId: { type: 'string', description: 'Target id of the PDF tab (defaults to active tab).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            url: { type: 'string', required: true },
            strategy: { type: 'string', required: true },
            strategyDetail: { type: 'string', required: true },
            chars: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
            nextPage: { type: 'integer' },
            pageCount: { type: 'integer' },
            textLayer: { type: 'string' },
            text: { type: 'string' },
            pages: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  page: { type: 'integer', required: true },
                  text: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                },
              },
            },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Extracted ${String(val.chars)} chars from ${val.url} via ${val.strategy} `
            + `(${val.strategyDetail})${val.truncated ? ', truncated' : ''}.`
            + (val.text !== undefined ? ` ${val.text.slice(0, 160)}` : ''),
        }],
      },
      execute: async (args) => {
        const result = await service.readPdfFromViewer({
          ...(typeof args.strategy === 'string' ? { strategy: args.strategy } : {}),
          ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
          ...(typeof args.page === 'number' ? { page: args.page } : {}),
          ...(typeof args.pageFrom === 'number' ? { pageFrom: args.pageFrom } : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
          ...(typeof args.targetId === 'string' ? { targetId: args.targetId } : {}),
        })
        return {
          ok: true,
          url: result.url,
          strategy: result.strategy,
          strategyDetail: result.strategyDetail,
          chars: result.chars,
          truncated: result.truncated,
          warnings: result.warnings,
          ...(result.nextPage !== undefined ? { nextPage: result.nextPage } : {}),
          ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
          ...(result.textLayer !== undefined ? { textLayer: result.textLayer } : {}),
          ...(result.text !== undefined ? { text: result.text } : {}),
          ...(result.pages !== undefined ? { pages: result.pages } : {}),
        }
      },
    })), 'cdp: cdp_pdftotext tool') /* plan10 */

    // 18. cdp_files (plan10)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_files',
      description: 'File operations confined to the downloads root: list, read, write, stat, delete, mkdir. Paths escaping the root are rejected; reads are bounded; writes never create directories outside the root.',
      parameters: {
        op: { type: 'string', required: true, description: 'Operation: list, read, write, stat, delete, or mkdir.' },
        path: { type: 'string', description: 'Root-relative path; empty addresses the root (list/stat/delete only).' },
        content: { type: 'string', description: 'Text to write (write only).' },
        encoding: { type: 'string', description: 'utf8 (default) or base64 for read/write.' },
        overwrite: { type: 'boolean', description: 'Allow write to replace an existing file (default false → hard error).' },
        recursive: { type: 'boolean', description: 'Allow delete to remove a directory tree (default false).' },
        maxBytes: { type: 'number', description: 'Read byte budget (default and cap 4 MiB).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            op: { type: 'string', required: true },
            path: { type: 'string', required: true },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  type: { type: 'string', required: true },
                  size: { type: 'integer', required: true },
                  mtime: { type: 'string', required: true },
                },
              },
            },
            content: { type: 'string' },
            encoding: { type: 'string' },
            bytes: { type: 'integer' },
            truncated: { type: 'boolean' },
            type: { type: 'string' },
            size: { type: 'integer' },
            mtime: { type: 'string' },
            deleted: { type: 'boolean' },
            created: { type: 'boolean' },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: val.op === 'list'
            ? `Listed ${val.path === '' ? '<downloads root>' : val.path}: ${String(val.entries?.length ?? 0)} entries.`
            : val.op === 'read'
              ? `Read ${val.path} (${String(val.bytes ?? 0)} bytes${val.truncated === true ? ', truncated' : ''}).`
              : val.op === 'write'
                ? `Wrote ${val.path} (${String(val.bytes ?? 0)} bytes).`
                : val.op === 'stat'
                  ? `Stat ${val.path}: ${val.type ?? '?'} ${String(val.size ?? 0)} bytes.`
                  : val.op === 'delete'
                    ? `Deleted ${val.path}.`
                    : `Created ${val.path}.`,
        }],
      },
      execute: async (args) => {
        const root = service.downloadsRootPath
        const op = typeof args.op === 'string' ? args.op : ''
        const path = typeof args.path === 'string' ? args.path : ''
        const encoding = args.encoding === 'base64' ? 'base64' : 'utf8'
        switch (op) {
          case 'list': {
            const result = await listFiles(root, path)
            return { ok: true, op, path: result.path, entries: result.entries }
          }
          case 'read': {
            const result = await readFileUnder(root, path, {
              encoding,
              ...(typeof args.maxBytes === 'number' ? { maxBytes: args.maxBytes } : {}),
            })
            return { ok: true, op, path: result.path, content: result.content, encoding: result.encoding, bytes: result.bytes, truncated: result.truncated }
          }
          case 'write': {
            if (typeof args.content !== 'string') throw new Error('cdp: write: content is required')
            const result = await writeFileUnder(root, path, args.content, {
              encoding,
              ...(typeof args.overwrite === 'boolean' ? { overwrite: args.overwrite } : {}),
            })
            return { ok: true, op, path: result.path, bytes: result.bytes }
          }
          case 'stat': {
            const result = await statFile(root, path)
            return { ok: true, op, path: result.path, type: result.type, size: result.size, mtime: result.mtime }
          }
          case 'delete': {
            const result = await deleteFile(root, path, {
              ...(typeof args.recursive === 'boolean' ? { recursive: args.recursive } : {}),
            })
            return { ok: true, op, path: result.path, deleted: true }
          }
          case 'mkdir': {
            const result = await mkdirUnder(root, path)
            return { ok: true, op, path: result.path, created: true }
          }
          default:
            throw new Error(`cdp: files: unknown op: ${op} (expected list|read|write|stat|delete|mkdir)`)
        }
      },
    })), 'cdp: cdp_files tool') /* plan10 */

    // 19. cdp_exec (plan01)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_exec',
      description: 'Run a JavaScript expression in the page with a mandatory error envelope, an optional '
        + 'post-condition asserted AFTER the script, optional promise awaiting, and an explicit '
        + '"did anything happen" flag. Never returns an empty result for a thrown expression.',
      parameters: {
        expression: {
          type: 'string',
          required: true,
          description: 'JavaScript to evaluate in the page. May be an IIFE/statement block.',
        },
        targetId: { type: 'string', description: 'Target id (defaults to active tab).' },
        awaitPromise: { type: 'boolean', description: 'Await a returned promise before reading the value (default false).' },
        postCondition: {
          type: 'string',
          description: 'Expression evaluated AFTER the script; must be truthy to pass. Failure marks ok:false.',
        },
        timeoutMs: { type: 'number', description: 'Bound for the whole call in milliseconds (default 15000 — doubled only for a CORROBORATED hidden tab, and the doubled bound comes back as effectiveTimeoutMs; max 60000). /* plan10-fix, plan15-hidden */' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            didAct: { type: 'boolean', required: true },
            result: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            valueType: { type: 'string', required: true },
            targetId: { type: 'string', required: true },
            url: { type: 'string', required: true },
            durationMs: { type: 'number', required: true },
            error: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: {
                  type: 'string',
                  required: true,
                  enum: ['exception', 'postCondition', 'timeout', 'connection', 'session', 'protocol'] as const,
                },
                name: { type: 'string' },
                message: { type: 'string', required: true },
                stack: { type: 'string' },
                expression: { type: 'string' },
                phase: { type: 'string', enum: ['script', 'postCondition'] as const },
              },
            },
            postCondition: {
              type: 'object',
              additionalProperties: false,
              properties: {
                requested: { type: 'boolean', required: true },
                passed: { type: 'boolean', required: true },
                value: { type: 'string' },
              },
            },
            terminated: {
              type: 'boolean',
              description: 'plan10-fix: on a timeout, true when Runtime.terminateExecution cancelled the page script (zombie prevention).',
            },
            documentHidden: {
              type: 'boolean',
              description: 'plan15-hidden: pre-run page-activity probe, reported only when corroborated — true requires document.visibilityState=hidden as well. Absent when the probe proved nothing.',
            },
            effectiveTimeoutMs: {
              type: 'number',
              description: 'plan15-hidden: the per-send bound actually used, present only when a corroborated hidden tab widened it (so the x2 is reported, never silent).',
            },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: renderExecText(val),
        }],
      },
      // plan01 §5.5: service.exec envelopes every expected failure mode
      // (§3.5); only truly unexpected internal errors reach the pipeline.
      execute: (args) => service.exec({
        expression: args.expression,
        ...(typeof args.targetId === 'string' ? { targetId: args.targetId } : {}),
        ...(args.awaitPromise === true ? { awaitPromise: true } : {}),
        ...(typeof args.postCondition === 'string' ? { postCondition: args.postCondition } : {}),
        ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
      }),
    })), 'cdp: cdp_exec tool')

    // 20. cdp_tab_new (plan03)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_tab_new',
      description: 'Open a new browser tab (Target.createTarget) and report its id, url, and focus. '
        + 'This is the only sanctioned way to create a tab — resolution never spawns one silently.',
      parameters: {
        url: { type: 'string', description: 'URL to open. Defaults to about:blank.' },
        focus: { type: 'boolean', description: 'Activate the new tab after creating it (default true).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            targetId: { type: 'string', required: true },
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            focused: { type: 'boolean', required: true },
            activeTargetId: { type: 'string', description: 'The active tab after the call; absent when none.' },
            tabCount: { type: 'integer', required: true },
            pages: { type: 'integer', required: true },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Opened tab ${val.targetId} -> ${val.url} (${val.focused ? 'focused' : 'background'}, `
            + `${String(val.tabCount)} targets / ${String(val.pages)} pages, `
            + `active: ${val.activeTargetId ?? 'none'}).`,
        }],
      },
      execute: (args) => service.createTab({
        ...(typeof args.url === 'string' && args.url !== '' ? { url: args.url } : {}),
        ...(typeof args.focus === 'boolean' ? { focus: args.focus } : {}),
      }),
    })), 'cdp: cdp_tab_new tool')

    // 21. cdp_tab_close (plan03)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_tab_close',
      description: 'Close a browser tab with guards: closing the ACTIVE tab needs an explicit targetId '
        + '(or confirmActive:true), and the LAST remaining page tab needs force:true. Reports the successor active tab.',
      parameters: {
        targetId: { type: 'string', description: 'Tab to close. Defaults to the active tab (guarded).' },
        force: { type: 'boolean', description: 'Permit closing the last remaining page tab (default false).' },
        confirmActive: { type: 'boolean', description: 'Required when targetId is omitted and it is the active tab.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            closedTargetId: { type: 'string', required: true },
            wasActive: { type: 'boolean', required: true },
            remainingPages: { type: 'integer', required: true },
            activeTargetId: { type: 'string', description: 'The successor active tab; absent when no pages remain.' },
            browserClosed: { type: 'boolean', required: true },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Closed tab ${val.closedTargetId}${val.wasActive ? ' (was active)' : ''}: `
            + `${String(val.remainingPages)} page(s) remain, active: ${val.activeTargetId ?? 'none'}`
            + `${val.browserClosed ? '.' : ' (browser refused the close; tab still open).'}`,
        }],
      },
      execute: (args) => service.closeTab({
        ...(typeof args.targetId === 'string' && args.targetId !== '' ? { targetId: args.targetId } : {}),
        ...(args.force === true ? { force: true } : {}),
        ...(args.confirmActive === true ? { confirmActive: true } : {}),
      }),
    })), 'cdp: cdp_tab_close tool')

    // 22. cdp_tab_focus (plan03)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_tab_focus',
      description: 'Focus (activate) a browser tab — the explicit way to switch the tab that omitted-targetId '
        + 'calls resolve to. Also asks the browser to bring the tab to the front (activateBrowser:false skips that).',
      parameters: {
        targetId: { type: 'string', required: true, description: 'Tab to focus.' },
        activateBrowser: { type: 'boolean', description: 'Send Target.activateTarget to the real browser (default true).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            targetId: { type: 'string', required: true },
            previousTargetId: { type: 'string', description: 'The formerly active tab; absent when unchanged/none.' },
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            activated: { type: 'boolean', required: true },
            pageCount: { type: 'integer', required: true },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Focused tab ${val.targetId} ("${val.title}" -> ${val.url})`
            + `${val.previousTargetId !== undefined ? `; previous active was ${val.previousTargetId}` : ''}`
            + `${val.activated ? '' : ' (browser focus not requested)'} (${String(val.pageCount)} pages).`,
        }],
      },
      execute: (args) => service.focusTab(args.targetId, args.activateBrowser !== false),
    })), 'cdp: cdp_tab_focus tool')

    // 23. cdp_scroll (plan03)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_scroll',
      description: 'Scroll the page with human-like wheel events, keyboard paging (PageUp/PageDown), or '
        + 'anchor/selector/edge jumps, and report the VERIFIED post-scroll position (scrollY, extents, edges).',
      parameters: {
        deltaY: { type: 'number', description: "Wheel delta in CSS px, positive = down (mode 'wheel')." },
        deltaX: { type: 'number', description: 'Horizontal wheel delta in CSS px.' },
        mode: {
          type: 'string',
          description: 'wheel (default) | pagedown | pageup | top | bottom | anchor | selector.',
        },
        x: { type: 'number', description: "Pointer X for wheel mode (default: viewport centre)." },
        y: { type: 'number', description: "Pointer Y for wheel mode (default: viewport centre)." },
        selector: { type: 'string', description: "CSS selector to scroll into view (mode 'selector')." },
        anchor: { type: 'string', description: "Element id or name to jump to (mode 'anchor')." },
        smooth: { type: 'boolean', description: "Use behavior:'smooth' for anchor/selector/top/bottom." },
        repetitions: { type: 'number', description: 'Repeat the unit 1-20 times (default 1).' },
        settleMs: { type: 'number', description: 'Wait 0-2000 ms after scrolling before reading the position.' },
        targetId: { type: 'string', description: 'Target id (defaults to the resolution policy).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            mode: { type: 'string', required: true },
            targetId: { type: 'string', required: true },
            url: { type: 'string', required: true },
            steps: { type: 'integer', required: true },
            deltaX: { type: 'number', required: true },
            deltaY: { type: 'number', required: true },
            scrollX: { type: 'number', required: true },
            scrollY: { type: 'number', required: true },
            maxScrollX: { type: 'number', required: true },
            maxScrollY: { type: 'number', required: true },
            atTop: { type: 'boolean', required: true },
            atBottom: { type: 'boolean', required: true },
            // plan08: enum mirrors CdpResolutionVia (types.ts) exactly — 'ref' added with the ref path.
            resolvedBy: { type: 'string', enum: ['explicit', 'active', 'single-page', 'created', 'ref'] as const, required: true },
            found: { type: 'boolean', description: 'anchor/selector lookup result; absent for other modes.' },
            note: { type: 'string', description: 'Advisory when the window did not move.' },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Scrolled via ${val.mode} on ${val.targetId}: scrollY ${String(val.scrollY)}/${String(val.maxScrollY)} `
            + `(${String(val.steps)} step(s), deltaY ${String(val.deltaY)}${val.atBottom ? ', at bottom' : ''})`
            + `${val.found !== undefined ? `, found: ${String(val.found)}` : ''}`
            + `${val.note !== undefined ? `. NOTE: ${val.note}` : ''}.`,
        }],
      },
      execute: (args) => {
        const modes = ['wheel', 'pagedown', 'pageup', 'top', 'bottom', 'anchor', 'selector']
        const mode = typeof args.mode === 'string' && args.mode !== '' ? args.mode : undefined
        if (mode !== undefined && !modes.includes(mode)) {
          throw new Error(`cdp scroll: unknown mode '${mode}'; use one of ${modes.join('|')}`)
        }
        return service.scroll({
          ...(mode !== undefined ? { mode: mode as CdpScrollMode } : {}),
          ...(typeof args.deltaY === 'number' ? { deltaY: args.deltaY } : {}),
          ...(typeof args.deltaX === 'number' ? { deltaX: args.deltaX } : {}),
          ...(typeof args.x === 'number' ? { x: args.x } : {}),
          ...(typeof args.y === 'number' ? { y: args.y } : {}),
          ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
          ...(typeof args.anchor === 'string' ? { anchor: args.anchor } : {}),
          ...(typeof args.smooth === 'boolean' ? { smooth: args.smooth } : {}),
          ...(typeof args.repetitions === 'number' ? { repetitions: args.repetitions } : {}),
          ...(typeof args.settleMs === 'number' ? { settleMs: args.settleMs } : {}),
          ...(typeof args.targetId === 'string' && args.targetId !== '' ? { targetId: args.targetId } : {}),
        })
      },
    })), 'cdp: cdp_scroll tool')

    // plan05 branch 1: one monotonic guard refuses every page-scoped tool
    // while a dialog is pending — a synchronous peek (no attach, no tab
    // creation), so cdp_eval/cdp_exec are covered without editing their
    // plan01-owned regions. Reason text is the shared dialogDenialReason.
    toolCtx.effect(() => toolCtx.tools.guard((execution) => {
      if (!isDialogGuardedTool(execution.name)) return undefined
      const args = typeof execution.arguments === 'object' && execution.arguments !== null
        ? execution.arguments as Record<string, unknown>
        : {}
      const targetId = typeof args.targetId === 'string' ? args.targetId : undefined
      const pending = service.peekPendingDialog(targetId)
      return pending === undefined ? undefined : dialogDenialReason(pending)
    }), 'cdp: plan05 dialog guard')

    // 24. cdp_dialog (plan05)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_dialog',
      description: 'Inspect and answer JavaScript dialogs (alert/confirm/prompt/beforeunload). '
        + 'While a dialog is pending, page-scoped tools are refused with dialog-open until you accept or dismiss it here. '
        + 'Use action:"policy" to auto-answer future dialogs on a session.',
      parameters: {
        action: { type: 'string', description: "'list' (default), 'accept', 'dismiss', or 'policy'." },
        targetId: { type: 'string', description: 'Tab whose dialog to answer; required when several tabs have pending dialogs.' },
        promptText: { type: 'string', description: "Reply sent when accepting a prompt dialog (defaults to the dialog's own defaultPrompt)." },
        policy: { type: 'string', description: "With action:'policy', the new auto-answer policy: 'none', 'accept', or 'dismiss'." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            targetId: { type: 'string', required: true },
            policy: { type: 'string', enum: ['none', 'accept', 'dismiss'] as const, required: true },
            pending: { type: 'array', required: true, items: PLAN05_DIALOG_BRIEF_SCHEMA },
            recent: { type: 'array', required: true, items: PLAN05_DIALOG_BRIEF_SCHEMA },
            answered: {
              type: 'object',
              description: 'Present only after an accept/dismiss succeeded.',
              additionalProperties: false,
              properties: {
                action: { type: 'string', enum: ['accepted', 'dismissed'] as const, required: true },
                promptText: { type: 'string' },
              },
            },
            error: {
              type: 'object',
              description: 'Present only when ok is false.',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: val.ok
            ? `Dialogs for ${val.targetId === '' ? '<no active tab>' : val.targetId}: `
              + `${String(val.pending.length)} pending, ${String(val.recent.length)} recent (policy: ${val.policy}).`
              + (val.answered !== undefined ? ` Answered: ${val.answered.action}.` : '')
              + (val.pending.length > 0
                ? `\n${val.pending.map(row => `- [${row.type}] ${row.url === '' ? '<unknown url>' : row.url}: ${row.message}`).join('\n')}`
                : '')
            : `cdp_dialog failed [${val.error?.code ?? 'unknown'}]: ${val.error?.message ?? 'unknown error'}`,
        }],
      },
      execute: async (args) => await service.dialog({
        ...(typeof args.action === 'string' && args.action !== ''
          ? { action: args.action as 'list' | 'accept' | 'dismiss' | 'policy' }
          : {}),
        ...(typeof args.targetId === 'string' && args.targetId !== '' ? { targetId: args.targetId } : {}),
        ...(typeof args.promptText === 'string' ? { promptText: args.promptText } : {}),
        ...(args.policy === 'none' || args.policy === 'accept' || args.policy === 'dismiss'
          ? { policy: { action: args.policy } }
          : {}),
      }),
    })), 'cdp: cdp_dialog tool')

    // 25. cdp_upload (plan05)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_upload',
      description: 'Bind absolute host files onto the page file input (selector mode) or into an open file chooser '
        + '(chooser:true), verifying input.files afterwards. Paths must be absolute and inside the allowed roots '
        + '(working directory, downloads dir, configured uploadRoots); refuses with dialog-open while a dialog is pending.',
      parameters: {
        files: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'Absolute host paths to bind (max 10 per call).',
        },
        selector: { type: 'string', description: 'CSS selector of the file input (set mode; omit with chooser:true).' },
        targetId: { type: 'string', description: 'Target id (defaults to active tab).' },
        chooser: { type: 'boolean', description: 'Wait for an open file chooser instead of selecting by selector.' },
        timeoutMs: { type: 'number', description: 'Chooser wait budget in milliseconds (500-30000, default 5000).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            targetId: { type: 'string', required: true },
            mode: { type: 'string', enum: ['set', 'chooser'] as const, required: true },
            files: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  size: { type: 'integer', required: true },
                },
              },
            },
            matched: { type: 'integer', required: true },
            bound: { type: 'boolean', required: true },
            input: {
              type: 'object',
              description: 'Live DOM evidence; present only when bound is true.',
              additionalProperties: false,
              properties: {
                tag: { type: 'string', required: true },
                accept: { type: 'string' },
                multiple: { type: 'boolean', required: true },
                verified: { type: 'boolean', required: true },
                fileList: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
            error: {
              type: 'object',
              description: 'Present only when ok is false.',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: val.ok
            ? `Bound ${String(val.files.length)} file(s) to <${val.input?.tag ?? 'input'}> in ${val.targetId === '' ? '<no tab>' : val.targetId}`
              + ` (${val.input?.verified === true ? 'verified' : 'unverified'}`
              + `${val.input !== undefined && val.input.fileList.length > 0 ? `: ${val.input.fileList.join(', ')}` : ''}).`
            : `cdp_upload failed [${val.error?.code ?? 'unknown'}]: ${val.error?.message ?? 'unknown error'}`,
        }],
      },
      execute: async (args) => await service.upload({
        files: Array.isArray(args.files)
          ? args.files.filter((entry): entry is string => typeof entry === 'string')
          : [],
        ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
        ...(typeof args.targetId === 'string' ? { targetId: args.targetId } : {}),
        ...(typeof args.chooser === 'boolean' ? { chooser: args.chooser } : {}),
        ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
      }),
    })), 'cdp: cdp_upload tool')

    // 26. cdp_text (plan02)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_text',
      description: 'Read the visible text of the element a locator resolves to, asserting the locator resolved '
        + 'unambiguously. Locator priority: css > aria-label > role+name > text (text ladder: aria-label, '
        + 'role+name, tag+text, innerText). Not-found, ambiguity (>1 match without nth), and hidden elements '
        + 'FAIL with reason + candidate evidence — never a guessed element. '
        + 'plan08: pass a snapshot `ref` to read that exact element (strategy \'ref\'; a re-rendered page '
        + 'answers stale-ref instead of a guessed match).',
      parameters: {
        css: { type: 'string', description: 'CSS selector; bypasses the text ladder, matches within scope.' },
        ariaLabel: { type: 'string', description: 'Match the aria-label attribute (normalized comparison).' },
        role: { type: 'string', description: 'ARIA role to match (requires name), e.g. button, link, textbox.' },
        name: { type: 'string', description: 'Accessible name; only used together with role.' },
        text: { type: 'string', description: 'Visible text resolved through the ladder aria-label > role+name > tag+text > innerText.' },
        textMatch: { type: 'string', enum: ['exact', 'contains'] as const, description: 'How text compares (default exact).' },
        nth: { type: 'integer', description: '0-based candidate index; REQUIRED when more than one element matches.' },
        scope: { type: 'string', description: 'CSS selector bounding the whole search.' },
        // plan08: snapshot ref path — replaces the locator ladder when present.
        ref: { type: 'string', description: 'Snapshot ref from cdp_snapshot; reads that exact element (other locator params ignored).' },
        targetId: { type: 'string', description: 'Target id (defaults to active tab).' },
        timeoutMs: { type: 'number', description: 'Poll until resolved+visible within this budget (default 0 = single attempt, max 30000).' },
        maxChars: { type: 'integer', description: 'Maximum characters of returned text (default 2000, max 4000).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            matched: { type: 'integer', required: true },
            strategy: { type: 'string', required: true },
            candidates: { ...LOCATOR_CANDIDATES_SCHEMA, required: true },
            waitedMs: { type: 'number', required: true },
            target: LOCATOR_TARGET_SCHEMA,
            actionability: LOCATOR_ACTIONABILITY_SCHEMA,
            text: { type: 'string' },
            truncated: { type: 'boolean' },
            reason: { type: 'string' },
            warning: { type: 'string' },
            targetId: { type: 'string' },
            url: { type: 'string' },
            // plan08: ref provenance on the ref path.
            ref: { type: 'string', description: 'The snapshot ref that was resolved.' },
            staleRef: { type: 'boolean', description: 'True when the failure was a stale-ref refusal.' },
          },
        },
        render: (_args, val) => [{ type: 'text', text: renderCdpText(val) }],
      },
      execute: async (args) => {
        // plan08: a snapshot ref replaces the ladder — host-side resolution
        // against a fresh document (strategy:'ref' in the answer below).
        if (typeof args.ref === 'string') {
          return await service.readTextByRef(args.ref, {
            ...(typeof args.targetId === 'string' ? { targetId: args.targetId } : {}),
            ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
            ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
          })
        }
        const spec = locatorSpecFromArgs(args)
        const invalid = validateLocatorSpec(spec)
        if (invalid !== undefined) {
          // Structural failures never touch the page: reason in-band, no round trip.
          return { ok: false, matched: 0, strategy: 'none', candidates: [], waitedMs: 0, reason: invalid }
        }
        return await service.readText(spec, {
          ...(typeof args.targetId === 'string' ? { targetId: args.targetId } : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
          ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
        })
      },
    })), 'cdp: cdp_text tool')

    // 27. cdp_expect (plan02)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_expect',
      description: 'Assert a page condition with a locator: exists, visible, enabled, textEquals, textContains, '
        + 'or urlMatches (page URL regex, locator ignored). Polls until it passes or timeoutMs elapses '
        + '(default 0 = single attempt). A failing assertion returns ok:false with reason + candidates — '
        + 'expected failures are data, not errors. '
        + 'plan08: pass a snapshot `ref` to assert against that exact element (strategy \'ref\'; '
        + 'a re-rendered page answers stale-ref).',
      parameters: {
        check: { type: 'string', enum: EXPECT_CHECKS, required: true, description: 'The assertion to run.' },
        expected: { type: 'string', description: 'Required for textEquals/textContains (expected text) and urlMatches (a regex); ignored by the other checks.' },
        css: { type: 'string', description: 'CSS selector; bypasses the text ladder, matches within scope.' },
        ariaLabel: { type: 'string', description: 'Match the aria-label attribute (normalized comparison).' },
        role: { type: 'string', description: 'ARIA role to match (requires name), e.g. button, link, textbox.' },
        name: { type: 'string', description: 'Accessible name; only used together with role.' },
        text: { type: 'string', description: 'Visible text resolved through the ladder aria-label > role+name > tag+text > innerText.' },
        textMatch: { type: 'string', enum: ['exact', 'contains'] as const, description: 'How text compares (default exact).' },
        nth: { type: 'integer', description: '0-based candidate index; REQUIRED when more than one element matches.' },
        scope: { type: 'string', description: 'CSS selector bounding the whole search.' },
        // plan08: snapshot ref path — replaces the locator when present (urlMatches still ignores it).
        ref: { type: 'string', description: 'Snapshot ref from cdp_snapshot; asserts against that exact element (other locator params ignored).' },
        targetId: { type: 'string', description: 'Target id (defaults to active tab).' },
        timeoutMs: { type: 'number', description: 'Poll until the assertion passes within this budget (default 0 = single attempt, max 30000).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            check: { type: 'string', required: true },
            passed: { type: 'boolean', required: true },
            matched: { type: 'integer', required: true },
            strategy: { type: 'string', required: true },
            candidates: { ...LOCATOR_CANDIDATES_SCHEMA, required: true },
            waitedMs: { type: 'number', required: true },
            target: LOCATOR_TARGET_SCHEMA,
            actionability: LOCATOR_ACTIONABILITY_SCHEMA,
            expected: { type: 'string' },
            actual: { type: 'string' },
            reason: { type: 'string' },
            // plan08-fix-ref-rename: the ref resolved through node identity; the
            // assertion ran on the element that is still there.
            warning: { type: 'string', description: 'ref-target-renamed note when the ref matched by node id after a name change.' },
            targetId: { type: 'string' },
            url: { type: 'string' },
            // plan08: ref provenance on the ref path.
            ref: { type: 'string', description: 'The snapshot ref that was resolved.' },
            staleRef: { type: 'boolean', description: 'True when the failure was a stale-ref refusal.' },
          },
        },
        render: (_args, val) => [{ type: 'text', text: renderCdpExpect(val) }],
      },
      execute: async (args) => {
        // plan08: a snapshot ref replaces the locator; urlMatches keeps its own
        // URL-only path (it asserts no element, so the ref is ignored there).
        if (typeof args.ref === 'string' && args.check !== 'urlMatches') {
          // plan08: the ref IS the locator (valid by construction), so only the
          // check name and the expected-text requirement need validating here —
          // validateExpectOptions itself demands a LocatorSpec and stays untouched.
          const check = args.check as ExpectCheck
          const knownCheck
            = check === 'exists' || check === 'visible' || check === 'enabled'
              || check === 'textEquals' || check === 'textContains' || check === 'urlMatches'
          const invalidRef = !knownCheck
            ? `unknown check: ${String(args.check)} (expected exists|visible|enabled|textEquals|textContains|urlMatches)`
            : (check === 'textEquals' || check === 'textContains') && typeof args.expected !== 'string'
              ? `${check} requires expected (string)`
              : undefined
          if (invalidRef !== undefined) {
            // Missing expected etc.: reason in-band, no round trip.
            return {
              ok: false,
              check: args.check as ExpectCheck,
              passed: false,
              matched: 0,
              strategy: 'none',
              candidates: [],
              waitedMs: 0,
              reason: invalidRef,
              ref: args.ref,
              staleRef: false,
            }
          }
          return await service.expectCheckByRef(args.ref, {
            check: args.check as ExpectCheck,
            ...(typeof args.expected === 'string' ? { expected: args.expected } : {}),
            ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
            ...(typeof args.targetId === 'string' ? { targetId: args.targetId } : {}),
          })
        }
        const spec = locatorSpecFromArgs(args)
        const invalid = validateExpectOptions(args.check, spec, args.expected)
        if (invalid !== undefined) {
          // Missing expected, bad locator, or bad regex: reason in-band, no round trip.
          return {
            ok: false,
            check: args.check as ExpectCheck,
            passed: false,
            matched: 0,
            strategy: 'none',
            candidates: [],
            waitedMs: 0,
            reason: invalid,
          }
        }
        return await service.expectCheck({
          check: args.check as ExpectCheck,
          spec,
          ...(typeof args.expected === 'string' ? { expected: args.expected } : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
          ...(typeof args.targetId === 'string' ? { targetId: args.targetId } : {}),
        })
      },
    })), 'cdp: cdp_expect tool')

    // 28. cdp_endpoints (plan04)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_endpoints',
      description: 'Discover and report browser debug endpoints: probes each configured loopback port\'s '
        + '/json/version, merges the answer with the live connection pool, and shows which endpoint is '
        + 'active, which are attached/parked, their socket health after a reconnect, and WHICH PROFILE '
        + 'each one runs on (\'assistant\', a throwaway dsh-cdp-*, or unknown for a foreign browser).',
      parameters: {
        ports: { type: 'string', description: 'Comma-separated loopback ports to probe, e.g. "9222,9333" (default: configured discovery ports).' },
        timeoutMs: { type: 'number', description: 'Per-port probe timeout in milliseconds (default 500).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            endpoints: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  port: { type: 'integer', required: true },
                  reachable: { type: 'boolean', required: true, description: 'True when /json/version answered on this port.' },
                  attached: { type: 'boolean', required: true, description: 'True when this endpoint is pooled with a live socket.' },
                  active: { type: 'boolean', required: true, description: 'True for the endpoint cdp_* calls target.' },
                  state: { type: 'string', required: true, description: 'unreachable | unattached | connected | degraded | reattaching | closed.' },
                  endpoint: { type: 'string', required: true, description: 'WebSocket debugger URL; empty when unreachable.' },
                  browser: { type: 'string', required: true, description: '/json/version Browser value; empty when unknown.' },
                  browserId: { type: 'string', required: true, description: 'Browser GUID carved from the ws URL; empty when unknown.' },
                  // plan13-profile: the profile column — the answer to "which Google profile is that?".
                  profile: { type: 'string', required: true, description: "Profile identity (e.g. 'assistant', 'dsh-cdp-XXXXXX', 'external'); empty when the port exposes none." },
                  kind: { type: 'string', required: true, enum: ['user', 'dsh'], description: "dsh = launched by DSH (its profile identity is known); user = somebody else's browser." },
                  connectionId: { type: 'string', required: true, description: 'Pool id (ep-<port>); empty when not attached.' },
                  targets: { type: 'integer', required: true, description: 'Live tracked target count; 0 when unknown.' },
                  error: { type: 'string', required: true, description: 'Failure note; empty when healthy.' },
                },
              },
            },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Endpoints (${String(val.endpoints.length)}):`
            + val.endpoints.map(row => `\n${row.active ? '*' : ' '} ${row.connectionId === '' ? '        ' : row.connectionId} `
              + `port=${String(row.port)} profile=${row.profile === '' ? '(unknown)' : row.profile} kind=${row.kind} `
              + `${row.state} targets=${String(row.targets)} `
              + `${row.browser !== '' ? row.browser : (row.endpoint !== '' ? row.endpoint : row.error)}`).join(''),
        }],
      },
      execute: async (args) => {
        // plan04: ports ride as a CSV string — scalar schema, no array ambiguity.
        const ports = typeof args.ports === 'string' && args.ports.trim() !== ''
          ? args.ports.split(',').map(part => Number(part.trim()))
            .filter(port => Number.isInteger(port) && port >= 1 && port <= 65_535)
          : undefined
        const endpoints = await service.endpointInventory({
          ...(ports !== undefined ? { ports } : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
        })
        return { ok: true, endpoints }
      },
    })), 'cdp: cdp_endpoints tool')

    // 29. cdp_contexts (plan04)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_contexts',
      description: 'Manage isolated browser contexts in the active browser: list contexts with their live '
        + 'target counts, create a fresh context (separate cookies/storage, no second browser), open a tab '
        + 'inside one, or dispose a context (closes its tabs, wipes its storage).',
      parameters: {
        action: { type: 'string', description: "'list' (default), 'create', 'open', or 'dispose'." },
        contextId: { type: 'string', description: "Target context; required for 'open'/'dispose' unless the default context is meant (empty string)." },
        url: { type: 'string', description: "With action:'open', the initial URL of the new tab (required)." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            contexts: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  contextId: { type: 'string', required: true, description: "browserContextId; '' for the default context." },
                  isDefault: { type: 'boolean', required: true },
                  targets: { type: 'integer', required: true },
                },
              },
            },
            contextId: { type: 'string', description: "Present after action:'create' — the new context's id." },
            targetId: { type: 'string', description: "Present after action:'open' — the created tab." },
            closed: { type: 'integer', description: "Present after action:'dispose' — how many targets it held." },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Contexts after ${val.action}:`
            + val.contexts.map(row => `\n${row.isDefault ? '[default]' : row.contextId} targets=${String(row.targets)}`).join('')
            + (val.contextId !== undefined ? `\nCreated ${val.contextId}` : '')
            + (val.targetId !== undefined ? `\nOpened tab ${val.targetId}` : '')
            + (val.closed !== undefined ? `\nDisposed (closed ${String(val.closed)} tabs)` : ''),
        }],
      },
      execute: async (args) => {
        const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'list'
        const contextId = typeof args.contextId === 'string' ? args.contextId : ''
        const url = typeof args.url === 'string' ? args.url : ''
        // plan04: unknown action is a usage error — the harness wraps the throw.
        if (action !== 'list' && action !== 'create' && action !== 'open' && action !== 'dispose') {
          throw new Error(`cdp: cdp_contexts unknown action '${action}' (expected list|create|open|dispose)`)
        }
        if (action === 'create') {
          const created = await service.createContext()
          return { ok: true, action, contexts: await service.listContexts(), contextId: created.contextId }
        }
        if (action === 'open') {
          if (url === '') throw new Error("cdp: cdp_contexts action 'open' requires url")
          const opened = await service.openContextTab(contextId, url)
          return { ok: true, action, contexts: await service.listContexts(), targetId: opened.targetId }
        }
        if (action === 'dispose') {
          const disposed = await service.disposeContext(contextId)
          return { ok: true, action, contexts: await service.listContexts(), closed: disposed.closed }
        }
        return { ok: true, action, contexts: await service.listContexts() }
      },
    })), 'cdp: cdp_contexts tool')

    // 30. cdp_fill (plan02 Faz 2)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_fill',
      description: 'Fill a form field through the locator DSL: resolve the element (css > aria-label > role+name > '
        + 'text ladder), write through the native value setter + input/change events (React/Vue-safe), select the '
        + 'matching <option>, or insert into contenteditable — then read the value back to prove it stuck. A '
        + 'framework that reverts the write triggers a focused Input.insertText fallback (fallbackUsed:true); a '
        + 'second failure reports the expected/actual diff — never a silent swallow. File inputs refuse.',
      parameters: {
        css: { type: 'string', description: 'CSS selector; bypasses the text ladder, matches within scope.' },
        ariaLabel: { type: 'string', description: 'Match the aria-label attribute (normalized comparison).' },
        role: { type: 'string', description: 'ARIA role to match (requires name), e.g. button, link, textbox.' },
        name: { type: 'string', description: 'Accessible name; only used together with role.' },
        text: { type: 'string', description: 'Visible text resolved through the ladder aria-label > role+name > tag+text > innerText.' },
        textMatch: { type: 'string', enum: ['exact', 'contains'] as const, description: 'How text compares (default exact).' },
        nth: { type: 'integer', description: '0-based candidate index; REQUIRED when more than one element matches.' },
        scope: { type: 'string', description: 'CSS selector bounding the whole search.' },
        value: { type: 'string', required: true, description: 'Value to write into the element.' },
        clear: { type: 'boolean', description: 'Replace the current value (default true); false appends.' },
        verify: { type: 'boolean', description: 'Read the value back after writing (default true).' },
        timeoutMs: { type: 'number', description: 'Resolve + write budget in ms (default 5000, max 30000).' },
        targetId: { type: 'string', description: 'Target id (defaults to active tab).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', enum: ['fill'], required: true },
            length: { type: 'integer', required: true },
            matched: { type: 'integer' },
            strategy: { type: 'string' },
            candidates: LOCATOR_CANDIDATES_SCHEMA,
            target: LOCATOR_TARGET_SCHEMA,
            actionability: LOCATOR_ACTIONABILITY_SCHEMA,
            post: FILL_POST_SCHEMA,
            fallbackUsed: { type: 'boolean', description: 'True when Input.insertText was needed after a reverted write.' },
            targetId: { type: 'string' },
            url: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (args, val) => [{
          type: 'text',
          text: renderFill(val, typeof args.value === 'string' ? args.value : undefined),
        }],
      },
      execute: async (args) => {
        const spec = locatorSpecFromArgs(args)
        // Structural failures never touch the page: reason in-band, no round trip.
        const invalid = validateFillArgs(spec, args.value)
        if (invalid !== undefined) {
          return { ok: false, action: 'fill' as const, length: typeof args.value === 'string' ? args.value.length : 0, reason: invalid }
        }
        const targetId = typeof args.targetId === 'string' ? args.targetId : undefined
        // plan05: manual dialog guard (fill is not part of dialog.ts's guarded list).
        return await service.guardPageDialog(targetId, async () => await service.fill(spec, args.value, {
          clear: args.clear !== false,
          verify: args.verify !== false,
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
          ...(targetId !== undefined ? { targetId } : {}),
        }))
      },
    })), 'cdp: cdp_fill tool')

    // 31. cdp_find (plan08 §4.2)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_find',
      description: 'Locate elements by ref/selector/aria-label/role/text and return the chosen one\'s ref with a FRESH rect '
        + 'plus actionability (visible/inViewport/enabled/hitTarget). Honest discovery: 0 matches answers ok:false with a '
        + 'reason instead of an empty swallow, multiple matches answer with candidates + a warning (use nth to pick). '
        + 'Boxes are measured at action time — never stored from an earlier snapshot.',
      parameters: {
        targetId: { type: 'string', description: 'Target id (defaults to the active tab).' },
        ref: { type: 'string', description: 'Exact snapshot reference to resolve (role|name|ordinal, #n-disambiguated).' },
        selector: { type: 'string', description: 'CSS selector (scoped when scope is given).' },
        // plan08-fix (T6 §3.8): cdp_click/cdp_text name the same idea `css`;
        // accept it as an alias instead of charging discovery cost.
        css: { type: 'string', description: 'Alias of selector (same argument name as cdp_click/cdp_text).' },
        ariaLabel: { type: 'string', description: 'Exact aria-label / accessible-name match.' },
        role: { type: 'string', description: 'ARIA role to match; combined with text/ariaLabel.' },
        text: { type: 'string', description: 'Accessible-name substring match (display-normalized, bidi-safe).' },
        scope: { type: 'string', description: 'CSS selector limiting the search to one subtree.' },
        nth: { type: 'number', description: '0-based candidate index (default 0).' },
        timeoutMs: { type: 'number', description: 'Re-probe window while waiting for the element (default 0 = single probe).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            matched: { type: 'integer', required: true, description: 'How many elements matched the query.' },
            targetId: { type: 'string', required: true },
            url: { type: 'string', required: true },
            warnings: {
              type: 'array',
              items: { type: 'string' },
              required: true,
              description: 'Honest caution lines: nth shown, scope/selector missed, stale candidates, frame-local chosen.',
            },
            reason: { type: 'string', description: 'Single-line failure detail when ok is false.' },
            chosen: {
              type: 'object',
              description: 'Fresh measurement of the chosen candidate (present when ok is true).',
              additionalProperties: false,
              properties: {
                ref: { type: 'string', required: true, description: 'Woven ref, byte-identical to cdp_snapshot.' },
                role: { type: 'string', required: true },
                name: { type: 'string', required: true, description: 'Display-normalized (bidi controls hidden).' },
                rawName: { type: 'string', required: true, description: 'Raw woven name exactly as the ref embeds it.' },
                box: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number', required: true },
                    y: { type: 'number', required: true },
                    width: { type: 'number', required: true },
                    height: { type: 'number', required: true },
                  },
                },
                visible: { type: 'boolean', required: true },
                inViewport: { type: 'boolean', required: true },
                frameLocal: { type: 'boolean', required: true },
              },
            },
            actionable: {
              type: 'object',
              description: 'Actionability of the chosen node at measurement time.',
              additionalProperties: false,
              properties: {
                connected: { type: 'boolean', required: true },
                visible: { type: 'boolean', required: true },
                inViewport: { type: 'boolean', required: true },
                enabled: { type: 'boolean', required: true },
                hitTarget: { type: 'boolean', required: true },
                coveredBy: { type: 'string', description: 'What covers the centre; absent when the hit test passed.' },
              },
            },
            candidates: {
              type: 'array',
              description: 'Up to 10 fresh-measured candidates in document order.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ref: { type: 'string', required: true },
                  role: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  visible: { type: 'boolean', required: true },
                  box: {
                    type: 'object',
                    required: true,
                    additionalProperties: false,
                    properties: {
                      x: { type: 'number', required: true },
                      y: { type: 'number', required: true },
                      width: { type: 'number', required: true },
                      height: { type: 'number', required: true },
                    },
                  },
                },
              },
            },
          },
        },
        render: (args, val) => {
          if (!val.ok) {
            return [{
              type: 'text',
              text: `No match (matched=${String(val.matched)}): ${val.reason ?? val.warnings.join('; ')}`
                + (val.warnings.length > 1 ? `\nWarnings:\n${val.warnings.map(line => `- ${line}`).join('\n')}` : ''),
            }]
          }
          const chosen = val.chosen
          const actionable = val.actionable
          if (chosen === undefined || actionable === undefined) {
            return [{ type: 'text', text: `Find answered ok without a chosen node (matched=${String(val.matched)})` }]
          }
          const nth = typeof args.nth === 'number' && Number.isFinite(args.nth) && args.nth > 0 ? Math.trunc(args.nth) : 0
          // plan14: shared with cdp_locate — one wording for "covered by X"
          // and "outside the viewport" across both tools.
          const failures = hitTestFailures({
            visible: actionable.visible,
            inViewport: actionable.inViewport,
            hitTarget: actionable.hitTarget,
            ...(actionable.coveredBy !== undefined ? { coveredBy: actionable.coveredBy } : {}),
          })
          // `disabled` stays here: it is cdp_find's own axis, not a hit-test one.
          if (!actionable.enabled) failures.splice(1, 0, 'disabled')
          const box = chosen.box
          return [{
            type: 'text',
            // plan08-fix (T3 F2): the ref prints raw inside quotes, and the
            // ordinal marker no longer borrows `#` (models used to glue the
            // render's `#1`/`@` onto the ref and every consumer said stale).
            text: `Found ${String(val.matched)} match(es). match ${String(nth + 1)}: "${chosen.ref}" [${chosen.role}] `
              + `box(${String(box.x)},${String(box.y)},${String(box.width)}x${String(box.height)}) `
              + `visible=${String(chosen.visible)} inViewport=${String(chosen.inViewport)}`
              + (chosen.frameLocal ? ' frameLocal=true' : '')
              + (failures.length === 0
                ? ' — actionable.'
                : ` — NOT actionable: ${failures.join('; ')}.`)
              + (val.warnings.length > 0 ? `\nWarnings:\n${val.warnings.map(line => `- ${line}`).join('\n')}` : ''),
          }]
        },
      },
      execute: async (args) => {
        return await service.find({
          ...(typeof args.targetId === 'string' && args.targetId !== '' ? { targetId: args.targetId } : {}),
          ...(typeof args.ref === 'string' && args.ref !== '' ? { ref: args.ref } : {}),
          ...(typeof args.selector === 'string' && args.selector !== ''
            ? { selector: args.selector }
            : typeof args.css === 'string' && args.css !== '' ? { selector: args.css } : {}),
          ...(typeof args.ariaLabel === 'string' && args.ariaLabel !== '' ? { ariaLabel: args.ariaLabel } : {}),
          ...(typeof args.role === 'string' && args.role !== '' ? { role: args.role } : {}),
          ...(typeof args.text === 'string' && args.text !== '' ? { text: args.text } : {}),
          ...(typeof args.scope === 'string' && args.scope !== '' ? { scope: args.scope } : {}),
          ...(typeof args.nth === 'number' ? { nth: args.nth } : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
        })
      },
    })), 'cdp: cdp_find tool')

    // 32. cdp_extract (plan08 §4.3)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_extract',
      description: 'Project structured data out of the current page with a JSON spec — {"kind":"page"} for page fields '
        + '(title/url/h1/lang/description/openDialog), {"kind":"list"} for a filtered collection (from: role/selector/ariaLabel/withinRole, '
        + 'where: nameMatches/visibleOnly, fields: name|role|value|text|href|checked|box|count|attr:<name>), {"kind":"field"} for one value. '
        + 'Honest by construction: a broken spec answers ok:false + error, an empty result answers data:[] + missing, and complete=false '
        + 'whenever missing/truncatedFields/limit cut the answer. Data rows are measured fresh at action time.',
      parameters: {
        targetId: { type: 'string', description: 'Target id (defaults to the active tab).' },
        spec: {
          type: 'string',
          required: true,
          description: 'JSON projection spec, e.g. {"kind":"list","from":{"role":"link"},"fields":{"name":"name","href":"href"},"limit":50}.',
        },
        timeoutMs: { type: 'number', description: 'Wait window for the slice to appear (default 0 = single probe).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            kind: { type: 'string', description: 'The projection shape that answered (page|list|field).' },
            targetId: { type: 'string' },
            url: { type: 'string' },
            title: { type: 'string', description: 'Document title at answer time.' },
            data: {
              type: 'array',
              description: 'Projected rows — ALWAYS an array on success (empty means nothing matched, never "missing".).',
              // plan08: rows are open key/value maps (field names come from the
              // spec), so openness is explicit here: additionalProperties: true.
              items: { type: 'object', additionalProperties: true },
            },
            count: { type: 'integer', description: 'Rows emitted after limit.' },
            complete: { type: 'boolean', description: 'False whenever missing/truncatedFields/limit cut the answer.' },
            missing: { type: 'array', items: { type: 'string' }, description: 'Why anything could not be answered.' },
            truncatedFields: { type: 'array', items: { type: 'string' }, description: 'Row keys cut at the 160-char text limit.' },
            warnings: { type: 'array', items: { type: 'string' } },
            source: {
              type: 'object',
              additionalProperties: false,
              description: 'Where the data came from.',
              properties: {
                nodes: { type: 'integer', required: true, description: 'Candidates resolved fresh.' },
                totalNodes: { type: 'integer', required: true, description: 'Nodes in the fresh document.' },
              },
            },
            limitApplied: { type: 'boolean', description: 'True when spec.limit capped a larger match set.' },
            error: { type: 'string', description: 'Spec/validation failure detail when ok is false.' },
          },
        },
        render: (_args, val) => {
          if (!val.ok) {
            return [{ type: 'text', text: `Extract failed: ${val.error ?? 'unknown error'}` }]
          }
          const json = JSON.stringify(val.data ?? [])
          const body = json.length > 4000 ? `${json.slice(0, 4000)}…` : json
          const lines = [
            `Extracted ${String(val.count ?? 0)} row(s) (${val.complete === true ? 'COMPLETE' : 'COMPLETE=false'})`
            + ` from ${String(val.source?.nodes ?? 0)} of ${String(val.source?.totalNodes ?? 0)} nodes:`,
            body,
          ]
          for (const missing of val.missing ?? []) lines.push(`missing: ${missing}`)
          for (const warning of val.warnings ?? []) lines.push(`warning: ${warning}`)
          for (const field of val.truncatedFields ?? []) lines.push(`truncated: ${field}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: async (args) => {
        return await service.extract({
          spec: typeof args.spec === 'string' ? args.spec : '',
          ...(typeof args.targetId === 'string' && args.targetId !== '' ? { targetId: args.targetId } : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
        })
      },
    })), 'cdp: cdp_extract tool')

    // 33. cdp_stealth (plan07)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_stealth',
      description: 'Inspect or switch the stealth profile that drives every layer of the browser story at once — the '
        + 'JS patches, the User-Agent/Sec-CH-UA*/Accept-Language headers, and the launch flags (G9/G3/G4/G26 '
        + 'coherence). action "status" reports the active profile, every built-in profile, the cross-layer coherence '
        + 'verdict, and any layer warnings; action "apply" activates a profile and re-registers the whole story on '
        + 'the page (new or refreshed documents pick it up). Diagnosis and story-keeping: it aligns the browser\'s '
        + 'reported surface with a coherent story and reports divergence.',
      parameters: {
        action: { type: 'string', enum: ['status', 'apply', 'list'] as const, description: "'status' (default), 'apply' (switch profile), or 'list' (profiles only, no page contact)." },
        profile: { type: 'string', description: "Profile id (windows-chrome|macos-chrome|linux-chrome|windows-edge); required for action 'apply'." },
        targetId: { type: 'string', description: 'Page session to register on; defaults to the active tab.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            profile: { type: 'string', required: true, description: 'Active profile id.' },
            profiles: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  locale: { type: 'string', required: true },
                  platform: { type: 'string', required: true, description: 'UA-CH platform.' },
                  userAgent: { type: 'string', required: true },
                },
              },
            },
            applied: { type: 'boolean', required: true, description: 'Stealth script registered on the active page session.' },
            coherence: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                js: { type: 'boolean', required: true },
                headers: { type: 'boolean', required: true },
                launch: { type: 'boolean', required: true },
              },
            },
            warnings: { type: 'array', required: true, items: { type: 'string' }, description: 'One entry per layer that could not be applied.' },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Stealth profile: ${val.profile} (applied: ${String(val.applied)})`
            + `\nCoherence — JS: ${String(val.coherence.js)} · headers: ${String(val.coherence.headers)} · launch: ${String(val.coherence.launch)}`
            + (val.warnings.length > 0 ? `\nWarnings:\n- ${val.warnings.join('\n- ')}` : '\nWarnings: none')
            + `\nProfiles: ${val.profiles.map(row => row.name).join(', ')}`,
        }],
      },
      execute: async (args) => {
        // plan07: the parameter enum narrows to status|apply|list — only an
        // ABSENT argument falls back to 'status' (a bad runtime value still
        // reaches the guard below, which throws with the expected list).
        const action = typeof args.action === 'string' ? args.action : 'status'
        if (action !== 'status' && action !== 'apply' && action !== 'list') {
          throw new Error(`cdp: cdp_stealth unknown action '${action}' (expected status|apply|list)`)
        }
        const targetId = typeof args.targetId === 'string' ? args.targetId : undefined
        // plan07: map the readonly service envelope onto fresh mutable objects —
        // the output schema's array types are mutable (EOPT-safe).
        const toOutput = (status: StealthStatusResult) => ({
          ok: true,
          action,
          profile: status.profile,
          profiles: status.profiles.map(row => ({ name: row.name, locale: row.locale, platform: row.platform, userAgent: row.userAgent })),
          applied: status.applied,
          coherence: { js: status.coherence.js, headers: status.coherence.headers, launch: status.coherence.launch },
          warnings: [...status.warnings],
        })
        if (action === 'apply') {
          const profile = typeof args.profile === 'string' ? args.profile : ''
          if (profile === '') {
            throw new Error("cdp: cdp_stealth action 'apply' requires profile (windows-chrome|macos-chrome|linux-chrome|windows-edge)")
          }
          return toOutput(await service.stealthApply(profile, targetId))
        }
        return toOutput(service.stealthStatus())
      },
    })), 'cdp: cdp_stealth tool')

    // 34. cdp_fingerprint (plan07)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_fingerprint',
      description: 'Probe the page once and report how coherent the browser story is: compares the navigator '
        + 'surface (webdriver, UA, platform, languages, UA-CH, plugins, screen vs window, chrome extras, fonts, '
        + 'connection, device numbers, automation variables) against the active stealth profile, then classifies '
        + 'every divergence into ordered why-blocked reasons (A11: critical → low, each with layer + evidence). '
        + 'Diagnosis only — it classifies why a page would reject automation; it changes no page state.',
      parameters: {
        targetId: { type: 'string', description: 'Page to probe; defaults to the active tab.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            profile: { type: 'string', required: true },
            coherent: { type: 'boolean', required: true, description: 'True when every check passed.' },
            checks: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  ok: { type: 'boolean', required: true },
                  expected: { type: 'string', required: true },
                  actual: { type: 'string', required: true },
                },
              },
            },
            whyBlocked: {
              type: 'array',
              required: true,
              description: 'A11 classification, ordered critical → low.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  code: { type: 'string', required: true },
                  severity: { type: 'string', required: true, description: 'critical|high|medium|low' },
                  layer: { type: 'string', required: true, description: 'js|dom|header|behavior' },
                  message: { type: 'string', required: true },
                  evidence: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, val) => [{
          type: 'text',
          text: `Fingerprint vs profile ${val.profile}: ${val.coherent ? 'coherent' : 'DIVERGED'}`
            + `\nChecks: ${String(val.checks.filter(check => check.ok).length)}/${String(val.checks.length)} ok`
            + val.checks.filter(check => !check.ok)
              .map(check => `\n  x ${check.id}: expected ${check.expected} — got ${check.actual}`)
              .join('')
            + (val.whyBlocked.length > 0
              ? `\nWhy blocked:\n${val.whyBlocked.map(reason => `[${reason.severity}/${reason.layer}] ${reason.code}: ${reason.message} (${reason.evidence})`).join('\n')}`
              : '\nWhy blocked: none — no known tells detected.'),
        }],
      },
      execute: async (args) => {
        const targetId = typeof args.targetId === 'string' ? args.targetId : undefined
        const result = await service.fingerprint(targetId)
        // plan07: fresh mutable objects for the output schema (EOPT-safe).
        return {
          ok: true,
          profile: result.profile,
          coherent: result.coherent,
          checks: result.checks.map(check => ({ id: check.id, ok: check.ok, expected: check.expected, actual: check.actual })),
          whyBlocked: result.whyBlocked.map(reason => ({
            code: reason.code,
            severity: reason.severity,
            layer: reason.layer,
            message: reason.message,
            evidence: reason.evidence,
          })),
        }
      },
    })), 'cdp: cdp_fingerprint tool')
    // 35. cdp_captcha (plan11 §3.1 — tool count 34 → 35, deliberate)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_captcha',
      description: 'Detect, drive, and read first-party verification challenges. '
        + 'action "scan" (Katman A) classifies every first-party candidate (checkbox, slider, image-select, form-field, '
        + 'delayed-confirm cover, multi-step chain, in-frame challenge, fake-success decoy, dynamic target, visible honeypot) '
        + 'and attaches deep-DOM evidence to each: getBoundingClientRect → scrollIntoView → FRESH re-measure → '
        + 'elementFromPoint hit-test, plus overlay and trap inventories and a third-party verdict. '
        + 'action "drag" (Katman B) performs a real CDP press-move-release slider gesture from a READ track geometry '
        + '(K4 approach path, overshoot + pull-back, a fresh re-measure before mouseup) and PROVES delivery by reading '
        + 'the value back — a dispatched gesture is never reported as success. '
        + 'action "verify" reads the solution state in one call: aria-checked, data-solved/data-confirmed, slider value '
        + 'vs data-target, badge text, and the page\'s own wrongClick/decoy/honeypot counters (a counter the page does not '
        + 'publish is omitted, never invented). '
        + 'A third-party provider (reCAPTCHA/hCaptcha/Turnstile/Cloudflare) is reported alongside the candidates '
        + '(thirdParty.verdict) and the walk continues with same-origin candidates. An empty scan answers '
        + 'candidates: [] with a reason, never a silent [].',
      parameters: {
        action: { type: 'string', enum: ['scan', 'drag', 'verify'] as const, description: 'scan = detect + deep DOM + third-party verdict; drag = human-like slider gesture; verify = read the solution state.' },
        targetId: { type: 'string', description: 'Target id (defaults to the active tab).' },
        // Locator DSL (plan02) — drag only. The SAME spec builder as cdp_click/cdp_fill.
        ref: { type: 'string', description: 'drag only: snapshot ref from cdp_snapshot addressing the slider.' },
        css: { type: 'string', description: 'drag only: CSS selector for the track (also used to pick the thumb).' },
        ariaLabel: { type: 'string', description: 'drag only: match the aria-label attribute (normalized comparison).' },
        role: { type: 'string', description: 'drag only: ARIA role to match (requires name).' },
        name: { type: 'string', description: 'drag only: accessible name; only used together with role.' },
        text: { type: 'string', description: 'drag only: visible text resolved through the locator ladder.' },
        textMatch: { type: 'string', enum: ['exact', 'contains'] as const, description: 'drag only: how text compares (default exact).' },
        nth: { type: 'integer', description: 'drag only: 0-based candidate index; required when more than one element matches.' },
        scope: { type: 'string', description: 'drag only: CSS selector bounding the whole search.' },
        thumbSelector: { type: 'string', description: 'drag only: explicit thumb selector inside the track (default: the first thumb-like child).' },
        targetPct: { type: 'number', description: 'drag only: target percent 0..100; read from the track\'s data-target when omitted.' },
        steps: { type: 'integer', description: 'drag only: press-move-release sample count (clamped 4..200, default 24).' },
        approach: { type: 'boolean', description: 'drag only: emit the K4 approach path before pressing (default true).' },
        overshoot: { type: 'boolean', description: 'drag only: overshoot the target and pull back before releasing (default true).' },
        timeoutMs: { type: 'number', description: 'Re-probe window in ms; each action applies its own default when omitted.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true, description: 'Which action produced this envelope.' },
            found: { type: 'integer', description: 'scan: candidates found (0 ⇒ ok:false + reason).' },
            targetId: { type: 'string' },
            url: { type: 'string' },
            reason: { type: 'string', description: 'Failure line when ok is false — never a success phrase.' },
            warnings: { type: 'array', items: { type: 'string' }, description: 'Honest caution lines (drift, truncation, unavailable metrics).' },
            candidates: {
              type: 'array',
              description: 'scan: classified candidates in document order.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: {
                    type: 'string',
                    required: true,
                    enum: ['checkbox', 'slider', 'image-select', 'form-field', 'delayed-confirm', 'multi-step', 'iframe-internal', 'decoy', 'dynamic-target', 'visible-honeypot', 'unknown'],
                  },
                  selector: { type: 'string', required: true },
                  tag: { type: 'string', required: true },
                  id: { type: 'string', required: true },
                  role: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  rect: {
                    type: 'object', required: true, additionalProperties: false,
                    properties: {
                      x: { type: 'number', required: true },
                      y: { type: 'number', required: true },
                      width: { type: 'number', required: true },
                      height: { type: 'number', required: true },
                    },
                  },
                  visible: { type: 'boolean', required: true },
                  inViewport: { type: 'boolean', required: true },
                  hitTest: { type: 'string', required: true, enum: ['pass', 'not-visible', 'not-in-viewport', 'covered', 'pointer-events-blocked'] },
                  hitIsTarget: { type: 'boolean', required: true },
                  blockedBy: { type: 'string', required: true, description: 'Topmost element at the centre when the hit test failed.' },
                  frame: { type: 'string', required: true },
                  evidence: { type: 'array', required: true, items: { type: 'string' }, description: 'Signature rules that fired.' },
                  driftPx: { type: 'number', required: true, description: 'Pixels the box moved across the scroll/re-measure round trip.' },
                  /* plan11-fix-scan-rect: `rect` is a VIEWPORT (client) coordinate, so the scroll
                     offset it is valid at is part of the contract. A value the page is not on —
                     or scrollRestored:false — means the box is STALE: re-measure before aiming
                     at it. Both optional: an older page script omits them. */
                  measuredAtScrollY: { type: 'number', description: 'The `scrollY` this rect is valid at; ≠ the page current offset ⇒ re-measure before clicking.' },
                  scrollRestored: { type: 'boolean', description: 'False when the scan could not put the page back where it found it — the box is only valid at measuredAtScrollY.' },
                  dataTarget: { type: 'string' },
                },
              },
            },
            overlays: {
              type: 'array',
              description: 'scan: fixed/sticky/absolute layers and cover signatures, highest z-index first.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  selector: { type: 'string', required: true },
                  tag: { type: 'string', required: true },
                  id: { type: 'string', required: true },
                  position: { type: 'string', required: true },
                  zIndex: { type: 'string', required: true },
                  rect: {
                    type: 'object', required: true, additionalProperties: false,
                    properties: {
                      x: { type: 'number', required: true },
                      y: { type: 'number', required: true },
                      width: { type: 'number', required: true },
                      height: { type: 'number', required: true },
                    },
                  },
                  source: { type: 'string', required: true, enum: ['signature', 'computed'] },
                  blocking: { type: 'boolean', required: true, description: 'True when it currently blocks a candidate.' },
                },
              },
            },
            honeypots: {
              type: 'array',
              description: 'scan: trap fields. "visible-honeypot" is the one a naive invisible-input scan misses.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, enum: ['hidden-trap', 'visible-honeypot'] },
                  selector: { type: 'string', required: true },
                  id: { type: 'string', required: true },
                  tag: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  rect: {
                    type: 'object', required: true, additionalProperties: false,
                    properties: {
                      x: { type: 'number', required: true },
                      y: { type: 'number', required: true },
                      width: { type: 'number', required: true },
                      height: { type: 'number', required: true },
                    },
                  },
                  rules: { type: 'array', required: true, items: { type: 'string' } },
                  reasons: { type: 'array', required: true, items: { type: 'string' } },
                  focusable: { type: 'boolean', required: true },
                },
              },
            },
            thirdParty: {
              type: 'object',
              description: 'scan: third-party verdict. third-party-present ⇒ reported alongside candidates (same-origin walk).',
              additionalProperties: false,
              properties: {
                verdict: { type: 'string', required: true, enum: ['first-party', 'third-party-present'] },
                iframes: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      src: { type: 'string', required: true },
                      id: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      accessible: { type: 'boolean', required: true },
                      origin: { type: 'string', required: true, enum: ['first-party', 'third-party', 'about', 'data', 'unknown'] },
                      host: { type: 'string' },
                    },
                  },
                },
                providers: { type: 'array', required: true, items: { type: 'string' }, description: 'Recognised provider hosts.' },
                reason: { type: 'string' },
              },
            },
            /* drag */
            delivered: { type: 'boolean', description: 'drag: true only when the read-back REACHED the requested percent (within the 1.5% tolerance) AND something observable changed; a gesture that moved ~0px is false with a reason.' },
            startX: { type: 'number', description: 'drag: press point X (fresh thumb centre).' },
            startY: { type: 'number', description: 'drag: press point Y.' },
            targetX: { type: 'number', description: 'drag: release point X (recomputed from a fresh rect).' },
            targetY: { type: 'number', description: 'drag: release point Y.' },
            finalValue: { type: 'number', description: 'drag: percent read back from the thumb AFTER the release.' },
            expectedValue: { type: 'number', description: 'drag: percent the geometry asked for.' },
            beforeValue: { type: 'number', description: 'drag: percent read back BEFORE the press.' },
            matched: { type: 'boolean', description: 'drag: the read-back landed within the 1.5% tolerance of the requested percent. Accuracy only — a `matched:true` with a collapsed gesture is still delivered:false.' },
            verifiedBy: {
              type: 'string',
              enum: ['value-moved', 'state-changed', 'both', 'none'] as const,
              description: 'drag: WHICH independent observation proved delivery. "value-moved" alone means the thumb moved '
                + 'but the page published no completion-state change to confirm it — treat that as unverified.',
            },
            stateDiffs: {
              type: 'array',
              items: { type: 'string' },
              description: 'drag: the page own state differences (data-done: 0 → 1, …). Empty means no change OR no published state; verifiedBy disambiguates.',
            },
            deltaMs: { type: 'integer', description: 'drag: gesture duration per the injected clock.' },
            attempts: { type: 'integer', description: 'drag: gestures dispatched (1 on success; this tool never blind-retries).' },
            /* verify */
            solved: { type: 'boolean', description: 'verify: at least one solution signal reads solved.' },
            signals: {
              type: 'object',
              additionalProperties: false,
              description: 'verify: every signal the page exposed; an absent key means "no source", never a default.',
              properties: {
                ariaChecked: { type: 'array', items: { type: 'string' } },
                dataSolved: { type: 'array', items: { type: 'string' } },
                dataConfirmed: { type: 'array', items: { type: 'string' } },
                sliders: { type: 'array', items: { type: 'string' } },
                badges: { type: 'array', items: { type: 'string' } },
                flags: { type: 'array', items: { type: 'string' }, description: 'The page\'s own solution flags, e.g. chain=true.' },
              },
            },
            wrongClicks: { type: 'integer', description: 'verify: wrong-target presses, when the page counts them.' },
            decoyClicks: { type: 'integer', description: 'verify: fake-success-trap presses, when the page counts them.' },
            honeypotHit: { type: 'boolean', description: 'verify: a trap field was filled, when the page tracks it.' },
            solvedAt: { type: 'integer', description: 'verify: newest solution timestamp the page recorded.' },
          },
        },
        render: (_args, val) => renderCaptcha(val),
      },
      execute: async (args) => {
        const action = typeof args.action === 'string' ? args.action : 'scan'
        if (action !== 'scan' && action !== 'drag' && action !== 'verify') {
          throw new Error(`cdp: cdp_captcha unknown action '${action}' (expected scan|drag|verify)`)
        }
        const spec = locatorSpecFromArgs({
          ...(typeof args.css === 'string' ? { css: args.css } : {}),
          ...(typeof args.ariaLabel === 'string' ? { ariaLabel: args.ariaLabel } : {}),
          ...(typeof args.role === 'string' ? { role: args.role } : {}),
          ...(typeof args.name === 'string' ? { name: args.name } : {}),
          ...(typeof args.text === 'string' ? { text: args.text } : {}),
          ...(typeof args.textMatch === 'string' ? { textMatch: args.textMatch } : {}),
          ...(typeof args.nth === 'number' ? { nth: args.nth } : {}),
          ...(typeof args.scope === 'string' ? { scope: args.scope } : {}),
        })
        const hasSpec = Object.keys(spec).length > 0
        const ref = typeof args.ref === 'string' && args.ref !== '' ? args.ref : undefined
        if (hasSpec && ref !== undefined) {
          return { ok: false, action, reason: 'pass either ref or a locator, not both' } as never
        }
        return await service.captcha({
          action,
          ...(typeof args.targetId === 'string' && args.targetId !== '' ? { targetId: args.targetId } : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
          ...(hasSpec ? { spec } : {}),
          ...(ref !== undefined ? { ref } : {}),
          ...(typeof args.thumbSelector === 'string' && args.thumbSelector !== '' ? { thumbSelector: args.thumbSelector } : {}),
          ...(typeof args.targetPct === 'number' ? { targetPct: args.targetPct } : {}),
          ...(typeof args.steps === 'number' ? { steps: args.steps } : {}),
          ...(typeof args.approach === 'boolean' ? { approach: args.approach } : {}),
          ...(typeof args.overshoot === 'boolean' ? { overshoot: args.overshoot } : {}),
        })
      },
    })), 'cdp: cdp_captcha tool')

    // 36. cdp_locate (plan14 — the visual loop's missing query)
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_locate',
      description: 'Ask "what is AT this point?" — document.elementFromPoint(x,y) identified and described: '
        + 'tag/id/classes/role/ariaLabel/short text, a FRESH viewport rect, interactive yes/no, inViewport, '
        + 'coveredBy (the occluder when something sits on top, same field name and meaning as cdp_find), '
        + 'position/z-index, and a short ancestry chain (kapsam) that names the component the point sits in. '
        + 'This is a PROBE, never a click: the visual loop is cdp_screenshot (selector|clip + rects:true + '
        + 'annotate:true + inline:true) → the model names a point → cdp_locate(x,y) VERIFIES what is there → '
        + 'cdp_click(x,y). Splitting look and act is what makes a wrong aim recoverable: an empty point answers '
        + 'ok:false + reason + a `nearest` element with its distance, so the model corrects itself instead of '
        + 'clicking a void. Never invent data — a point with no element is data, not an exception.',
      parameters: {
        x: { type: 'number', required: true, description: 'Viewport CSS x of the point (the coordinate cdp_click takes).' },
        y: { type: 'number', required: true, description: 'Viewport CSS y of the point.' },
        targetId: { type: 'string', description: 'Target id (defaults to the active tab).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true, description: 'True only when a node was identified at the point.' },
            x: { type: 'number', required: true, description: 'The probed x, echoed back.' },
            y: { type: 'number', required: true, description: 'The probed y, echoed back.' },
            targetId: { type: 'string', required: true },
            url: { type: 'string', required: true },
            warnings: {
              type: 'array',
              items: { type: 'string' },
              required: true,
              description: 'Honest caution lines: point off-viewport, covered by an occluder, capped nearest sweep, truncated probe.',
            },
            reason: { type: 'string', description: 'Single-line failure detail when ok is false.' },
            viewport: {
              type: 'object',
              description: 'Viewport size in CSS pixels at probe time — the pixel↔CSS conversion the visual loop needs.',
              additionalProperties: false,
              properties: {
                width: { type: 'number', required: true },
                height: { type: 'number', required: true },
              },
            },
            node: {
              type: 'object',
              description: 'The element at the point (present when ok is true).',
              additionalProperties: false,
              properties: {
                selector: { type: 'string', required: true, description: 'tag#id.class1.class2 — the same shape ancestry uses.' },
                tag: { type: 'string', required: true },
                id: { type: 'string', required: true },
                classes: { type: 'array', items: { type: 'string' }, required: true },
                role: { type: 'string', required: true, description: 'Explicit role, else the implicit tag role, else empty.' },
                ariaLabel: { type: 'string', required: true },
                text: { type: 'string', required: true, description: 'Visible text, whitespace-collapsed and short.' },
                rect: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number', required: true },
                    y: { type: 'number', required: true },
                    width: { type: 'number', required: true },
                    height: { type: 'number', required: true },
                  },
                },
                interactive: { type: 'boolean', required: true },
                inViewport: { type: 'boolean', required: true },
                coveredBy: { type: 'string', description: 'The occluder on top; absent when the hit test passed.' },
                zIndex: { type: 'string', required: true, description: "Computed z-index ('' when auto)." },
                position: { type: 'string', required: true, description: "Computed position ('' when static)." },
                ancestry: { type: 'array', items: { type: 'string' }, required: true, description: 'Outermost-first, last entry is the node, ≤4 entries.' },
                byBox: { type: 'boolean', required: true, description: 'True when the node was identified by its box (no hit test at that point).' },
              },
            },
            nearest: {
              type: 'object',
              description: 'Closest element to an empty point — the aim correction (present when ok is false and the page had any box).',
              additionalProperties: false,
              properties: {
                selector: { type: 'string', required: true },
                tag: { type: 'string', required: true },
                id: { type: 'string', required: true },
                distance: { type: 'number', required: true, description: 'CSS pixels from the point to the nearest box corner (0 = inside).' },
                rect: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number', required: true },
                    y: { type: 'number', required: true },
                    width: { type: 'number', required: true },
                    height: { type: 'number', required: true },
                  },
                },
              },
            },
          },
        },
        render: (_args, val) => [{ type: 'text', text: renderLocate(val) }],
      },
      execute: async (args) => {
        return await service.locate({
          x: args.x,
          y: args.y,
          ...(typeof args.targetId === 'string' && args.targetId !== '' ? { targetId: args.targetId } : {}),
        })
      },
    })), 'cdp: cdp_locate tool')
  })
}
