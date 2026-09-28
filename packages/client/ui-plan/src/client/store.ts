/**
 * The Plan tab's opened-plan marker. The Slot registry owns the instance (one
 * per Session), so a reader switching sidebar tabs — which unmounts the body —
 * keeps the mark, and a plan carried by a remount is not announced as new.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Which presented plan the reader has opened, addressed by presentation time. */
interface PlanTabState {
  /** `at` of the newest plan the reader opened, or null before the first one. */
  seenAt: number | null
}

type PlanTabActions = {
  /** Record the plan presented at `at` as opened. */
  markSeen: (state: PlanTabState, at: number) => void
}

/**
 * Declare the Plan tab's opened-plan marker.
 * @returns a non-persisted store handle whose instance is owned by the Slot registry.
 */
export function createPlanTabStore(): EngineStoreHandle<PlanTabState, PlanTabActions> {
  return defineStore({
    init: (): PlanTabState => ({ seenAt: null }),
    actions: {
      markSeen: (state, at) => { state.seenAt = at },
    },
  })
}
