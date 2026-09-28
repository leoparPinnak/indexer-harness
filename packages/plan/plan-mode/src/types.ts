/**
 * Pure types of the plan domain: the ONE home of the `plan` projection-key
 * declaration, free of this package's host-side value imports (cordis,
 * dsh-tools, dsh-agent). Two namespace projections serve it — `./types` for
 * host consumers and `./client` for client aggregates — with zero content
 * duplication.
 *
 * @module @deepseek-ai/dsh-plan-mode/types
 */

import type { CommandId } from '@deepseek-ai/dsh-commands/brand'

/**
 * The plan projection's wire value. `active` is the logged state in force
 * (the last `plan/mode`, inactive before the first); `pending` is true while
 * a logged `/plan` selection targets a state other than `active`, has not
 * failed through its paired `command/done`, and no later `plan/mode` event has
 * recorded that state. Capability absence (plan-mode not composed) is the
 * key's absence, never a value.
 */
export interface PlanProjection {
  active: boolean
  pending: boolean
  /**
   * The newest plan presented for review, or null when none was presented in
   * this log. Rendering surfaces (the Plan tab) read it from here rather than
   * re-reading the raw tool call, so a fork or restore shows the same plan.
   */
  presented: PlanPresentation | null
  /**
   * Every plan presented in this log, newest first, capped for the wire while
   * the log keeps them all. The first entry is {@link presented}; the rest are
   * the session's plan history, in presentation order.
   */
  history: readonly PlanPresentation[]
}

/** One plan presented through the exit tool, as carried by its tool call. */
export interface PlanPresentation {
  /** The complete plan markdown the model presented. */
  plan: string
  /** The plan's first markdown heading, absent when the plan has none. */
  title: string | null
  /** Unix epoch milliseconds of the tool call that presented the plan. */
  at: number
}

/** Host state used to derive {@link PlanProjection}. */
export interface PlanUnitState {
  /** Logged plan mode. */
  active: boolean
  /** The selection's target mode; null when no selection is outstanding. */
  wanted: boolean | null
  /** The latest plan command awaiting its paired settlement. */
  running: { commandId: CommandId; wanted: boolean } | null
  /** Active state recorded by the latest `request/header`, or null. */
  activeAtLastHeader: boolean | null
  /** Every presented plan, oldest first; the last entry is the newest. */
  presented: readonly PlanPresentation[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host plan-mode fold state. */
    plan: PlanUnitState
  }
  interface SessionProjectionMap {
    /** Plan collaboration state folded from the plan command lifecycle and `plan/mode` events. */
    plan: PlanProjection
  }
}
