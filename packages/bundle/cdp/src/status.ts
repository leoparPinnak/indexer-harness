/**
 * @deepseek-ai/dsh-cdp — the CDP bundle's status surface. It owns the local
 * state read that `GET /api/server/cdp/status` and the `cdp_status` model tool
 * both answer with, plus the two registrations themselves. A later phase adds a
 * mirror beside `readCdpStatus` for the case where the state lives in a separate
 * process, forwarded to before falling back to its own local path.
 * @module @deepseek-ai/dsh-cdp/status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { CdpStatusResponse } from './types.ts'

// The package's own manifest is the single source of the reported version, so
// the wire value cannot drift from what is installed (`./package.json` is an
// export of this package; the relative path resolves from both `src/` and the
// bundled `lib/`).
const { version: CDP_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Path of the status route, shared with the `ui-cdp-view` browser pane. */
export const CDP_STATUS_PATH = '/api/server/cdp/status'

/**
 * plan01: the one description both `cdp_status` registrations use, so the
 * service-backed tool and the standalone status surface cannot drift.
 */
export const CDP_STATUS_DESCRIPTION = 'Report the CDP browser-control extension state: installed bundle version, live browser targets, proxy listener status, '
  + 'the connection state, the active target, the known open tabs, and the live viewport once one has been probed. '
  + 'Call it before driving a browser to check whether the extension is available.'

/**
 * plan01: the status fields the shared render reads. It matches the
 * schema-inferred tool value: the four original fields are required, every
 * enriched field optional, so a minimal payload still renders.
 */
export interface CdpStatusSurface {
  /** Always `true` on a successful read. */
  readonly ok: boolean
  /** Version of the installed bundle. */
  readonly version: string
  /** Live browser target count. */
  readonly targets: number
  /** Proxy listener state. */
  readonly proxy: { readonly active: boolean }
  /** The socket's own state; absent only for schema-shape values. */
  readonly connectionState?: string
  /** Cached tab inventory rows. */
  readonly openTabs?: ReadonlyArray<{ readonly targetId?: string; readonly title?: string; readonly url?: string }>
  /** Attached WebSocket endpoint. */
  readonly endpoint?: string
  /** Default resolution target. */
  readonly activeTargetId?: string
  /** plan13-profile: the active browser's profile identity. */
  readonly profile?: string
  /** Live viewport observation once one has been probed. */
  readonly viewport?: {
    readonly width?: number
    readonly height?: number
    readonly deviceScaleFactor?: number
    readonly source?: string
  }
}

/**
 * plan01: the single output schema both `cdp_status` registrations use. The
 * original four fields keep `required: true`; every enriched field is
 * optional, so the old payload still validates and old consumers see only
 * additive keys.
 */
export const CDP_STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    version: { type: 'string', required: true },
    targets: { type: 'integer', required: true },
    proxy: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: { active: { type: 'boolean', required: true } },
    },
    connectionState: { type: 'string', enum: ['disconnected', 'connecting', 'connected', 'closed'] },
    openTabs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: { type: 'string' },
          title: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
    endpoint: { type: 'string' },
    activeTargetId: { type: 'string' },
    // plan13-profile: which profile the active browser runs on (additive, and
    // only present while an endpoint is attached — the untouched disconnected
    // payload still validates unchanged).
    profile: {
      type: 'string',
      description: "Active browser profile identity: a named profile (e.g. 'assistant'), 'ephemeral' for a throwaway launch, or 'external' for a browser DSH attached to but did not launch.",
    },
    // plan03: page-tab count and resolution evidence (additive, both optional;
    // declared here because status() returns them under additionalProperties:false).
    // plan08: 'ref' joins the union for element provenance in ref-tool results;
    // enum always mirrors CdpResolutionVia in types.ts exactly.
    pages: { type: 'integer' },
    resolvedBy: { type: 'string', enum: ['explicit', 'active', 'single-page', 'created', 'ref'] as const },
    // plan06: live viewport (additive); absent until the first probe. The four
    // observation fields stay required-when-present, exactly as plan06 pinned them.
    viewport: {
      type: 'object',
      description: 'Live CSS viewport observation once one has been probed.',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        deviceScaleFactor: { type: 'number', required: true },
        source: { type: 'string', required: true },
      },
    },
  },
} satisfies ValueSchemaSpec

/**
 * plan01: the single `cdp_status` render. The first line is byte-identical to
 * the original render — plan06's conditional `; viewport … css @dpr… (source)`
 * suffix included — and the plan01 lines (`state`, `endpoint`, `active`,
 * tab inventory) follow only when at least one of them exists, so a
 * disconnected extension with no tabs still renders exactly the old text.
 * @param value - the status payload to render.
 * @returns the tool card text.
 */
export function renderCdpStatus(value: CdpStatusSurface): string {
  const viewport = value.viewport
  const hasViewport = viewport !== undefined
    && typeof viewport.width === 'number'
    && typeof viewport.height === 'number'
    && typeof viewport.deviceScaleFactor === 'number'
    && typeof viewport.source === 'string'
  const firstLine = `CDP ${value.version}: ${String(value.targets)} target(s), proxy active: ${String(value.proxy.active)}`
    // plan06: same sentence plus the observed viewport when it exists.
    + (hasViewport
      ? `; viewport ${String(viewport?.width)}x${String(viewport?.height)} css @dpr${String(viewport?.deviceScaleFactor)} (${String(viewport?.source)})`
      : '')
    + '.'
  const lines = [firstLine]

  const tabs = value.openTabs ?? []
  // `state disconnected` only rides along when something else on line two
  // exists; the bare disconnected payload keeps rendering exactly line one.
  const showState = value.connectionState !== undefined
    && (value.connectionState !== 'disconnected'
      || value.endpoint !== undefined
      || value.activeTargetId !== undefined
      || value.profile !== undefined
      || tabs.length > 0)
  const head: string[] = []
  if (value.endpoint !== undefined) head.push(`endpoint ${value.endpoint}`)
  if (showState) head.push(`state ${value.connectionState}`)
  // plan13-profile: the profile answer is additive and rides on line two, so a
  // disconnected payload that never attached still renders exactly the old text.
  if (value.profile !== undefined) head.push(`profile ${value.profile}`)
  if (value.activeTargetId !== undefined) head.push(`active ${value.activeTargetId}`)
  if (head.length > 0) lines.push(head.join(' · '))
  if (tabs.length > 0) {
    lines.push(`${String(tabs.length)} page tab(s):`)
    for (const tab of tabs) {
      lines.push(`  [page] ${tab.title === undefined || tab.title === '' ? 'Untitled' : tab.title} - ${tab.url ?? ''} (${tab.targetId ?? '?'})`)
    }
  }
  return lines.join('\n')
}

/**
 * Read the CDP extension's state in this process.
 * @returns the status payload both the route and the tool answer with.
 */
export function readCdpStatus(): CdpStatusResponse {
  return {
    ok: true,
    version: CDP_VERSION,
    targets: 0,
    proxy: { active: false },
    connectionState: 'disconnected',
    openTabs: [],
  }
}

/**
 * Answer a request with JSON.
 * @param res - the response to write.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Register `GET /api/server/cdp/status` on the Web server. The registration is
 * a fiber effect, so disposing the `cdp` row removes the route.
 * @param ctx - plugin context carrying the `webServer` service.
 */
export function registerCdpStatusRoute(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_STATUS_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      respondJson(res, 200, readCdpStatus())
    },
  }), 'cdp: GET /api/server/cdp/status')
}

/**
 * Register the model-facing `cdp_status` tool when the `tools` registry is
 * present, so a profile without that registry still gets the status route.
 *
 * plan01 §5.6: intentionally NOT mounted today — `registerCdpTools` already
 * registers `cdp_status` against the live `CdpService`, and mounting this one
 * too would register the same name twice. It exists for a service-less
 * profile and answers {@link readCdpStatus}; sharing the description, schema,
 * and render with the live tool keeps the two registrations from drifting.
 * @param ctx - plugin context.
 */
export function registerCdpStatusTool(ctx: Context): void {
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'cdp_status',
      description: CDP_STATUS_DESCRIPTION,
      parameters: {},
      output: {
        schema: CDP_STATUS_OUTPUT_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: renderCdpStatus(value),
        }],
      },
      execute: () => Promise.resolve(readCdpStatus()),
    })), 'cdp: cdp_status tool')
  })
}
