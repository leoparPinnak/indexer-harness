/**
 * CDP extension state shared by the status route and the `cdp_status` tool.
 * This file contains types only; runtime constants live beside their owners.
 *
 * @module
 */

/** Proxy listener state reported by `GET /api/server/cdp/status`. */
export interface CdpProxyStatus {
  /** Whether the extension's HTTP proxy listener currently accepts connections. */
  readonly active: boolean
}

/**
 * plan01: the connection's own lifecycle state as `cdp_status` reports it.
 * Read live from {@link CdpConnection.state}; `disconnected` also covers a
 * service that has never opened a browser endpoint.
 */
export type CdpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'closed'

/** plan01: one row of the cached tab inventory `openTabs` reports. */
export interface CdpTabBrief {
  /** Stable target id of the page. */
  readonly targetId: string
  /** Last known document title; may be empty before one is read. */
  readonly title: string
  /** Last known page URL. */
  readonly url: string
}

/**
 * Live viewport observation (plan 06). `width`/`height` are CSS pixels;
 * `source` distinguishes an explicit `cdp_viewport` override, a live window
 * read, and the all-failed probe (`unavailable`, never invented dimensions).
 */
export interface CdpViewportStatus {
  /** Observed viewport width in CSS pixels; `0` when unavailable. */
  readonly width: number
  /** Observed viewport height in CSS pixels; `0` when unavailable. */
  readonly height: number
  /** Observed device pixel ratio. */
  readonly deviceScaleFactor: number
  /** Where the observation came from. */
  readonly source: 'override' | 'live-window' | 'unavailable'
}

/**
 * Current CDP extension state. Every field reports what this process observes
 * now: zero targets before a browser endpoint is attached, and an inactive
 * proxy before the proxy phase lands.
 */
export interface CdpStatusResponse {
  /** Always `true` on a successful read. */
  readonly ok: true
  /** Version of the installed `@deepseek-ai/dsh-cdp` bundle. */
  readonly version: string
  /** Live browser targets the extension currently controls. */
  readonly targets: number
  /** Proxy listener state. */
  readonly proxy: CdpProxyStatus
  /**
   * plan01: the socket's own state, read live from the connection. Always
   * present: `disconnected` before any endpoint has been attached.
   */
  readonly connectionState: CdpConnectionState
  /**
   * plan01: brief rows of every known `page` target — the cached tab
   * inventory. Always present (empty before any endpoint has been attached).
   */
  openTabs: CdpTabBrief[]
  /**
   * plan01: the WebSocket endpoint the extension is attached to; absent
   * before a browser endpoint is attached.
   */
  readonly endpoint?: string
  /**
   * plan01: the target calls resolve to by default; absent when none is active.
   */
  readonly activeTargetId?: string
  /** plan06: live viewport once one has been probed; absent before the first probe. */
  readonly viewport?: CdpViewportStatus
  /**
   * plan03: how many `page` targets the registry tracks. Present only while a
   * connection exists, so the untouched disconnected payload keeps its shape.
   */
  readonly pages?: number
  /**
   * plan03: how the current `activeTargetId` was last proven by
   * `getPageSession` (`explicit` id, browser `active`, the `single-page`
   * default, or a `created` fallback); absent before the first resolution.
   */
  readonly resolvedBy?: CdpResolutionVia
  /**
   * plan04: per-endpoint pool state — every attached browser with its socket
   * health, target/session counts, and reconnect tally. Absent while the pool
   * reports nothing, so an untouched payload keeps its stable shape.
   */
  readonly connections?: CdpConnectionBrief[]
  /**
   * plan13-profile: pool connection id of the ACTIVE endpoint (`ep-<port>`); absent
   * when no endpoint is attached.
   */
  readonly activeConnectionId?: string
  /**
   * plan13-profile: the ACTIVE browser's profile identity — the named profile
   * the user signed into (`assistant`), the literal `ephemeral` for a
   * throwaway `cdp_open` launch, or `external` for a browser DSH attached to
   * but did not launch. Present only while an endpoint is attached, so the
   * untouched disconnected payload keeps its stable shape.
   */
  readonly profile?: string
}

/**
 * plan03: the evidence `CdpService.getPageSession` records for a resolution —
 * which rule proved the tab the call actually ran on.
 */
export type CdpResolutionVia = 'explicit' | 'active' | 'single-page' | 'created'
// plan08: the ref path resolves ELEMENTS, not tabs — ref-tool results echo
// `resolvedBy: 'ref'` for element provenance. The tab verdicts above are
// unchanged; status().resolvedBy never reports 'ref'.
| 'ref'

/**
 * plan01: the enriched payload `statusLive()` answers with. It is the same
 * shape as {@link CdpStatusResponse} today — the async surface exists so
 * later probes can join without changing the route or tool contract.
 */
export type CdpStatusDetail = CdpStatusResponse

/**
 * plan04: one pooled browser connection as `connections[]` reports it —
 * the per-endpoint view `GET /api/server/cdp/connections` and `cdp_endpoints`
 * render (pool.ts keeps the live record; this is the wire shape).
 */
export interface CdpConnectionBrief {
  /** Stable pool id, e.g. `ep-9333`. */
  readonly connectionId: string
  /** WebSocket debugger URL of the endpoint. */
  readonly endpoint: string
  /** Loopback debug port parsed from the endpoint URL (0 when absent). */
  readonly port: number
  /** Socket health: `connected`, `degraded`, `reattaching`, or `closed`. */
  readonly state: 'connected' | 'degraded' | 'reattaching' | 'closed'
  /** True for the endpoint `cdp_*` calls target when `connectionId` is omitted. */
  readonly active: boolean
  /** Tracked target count this endpoint reports. */
  readonly targets: number
  /** Live page sessions bound to this endpoint (post-reconnect: rebuilt count). */
  readonly sessions: number
  /** Successful reconnects observed since attach. */
  readonly reconnects: number
  /** Restorable/last-known active target id; absent when none. */
  readonly activeTargetId?: string
  /** Last failure text (close code / reconnect error); absent when healthy. */
  readonly lastError?: string
}
