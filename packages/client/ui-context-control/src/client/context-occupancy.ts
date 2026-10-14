import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Context usage rendered by the composer context meter. */
export interface ContextOccupancy {
  percent: number
  usedTokens: number
  contextWindow: number
}

/**
 * Resolve bounded display occupancy from independently updated pressure fields.
 * @param pressure - latest token-meter projection.
 * @param fallbackContextWindow - capacity from the model catalog for the
 * session's current model, used until a request records the route capacity.
 * @returns occupancy, or null until a capacity is known.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
  fallbackContextWindow?: number,
): ContextOccupancy | null {
  if (pressure === undefined) return null
  const contextWindow = pressure.contextWindow ?? fallbackContextWindow
  if (contextWindow === undefined) return null
  // No provider-reported sample yet (the fold never unsets one): a session that
  // has not sent a request honestly sits at zero instead of hiding the meter.
  const usedTokens = pressure.projectedTokens ?? pressure.pressureTokens ?? 0
  return {
    percent: Math.min(100, Math.round(usedTokens / contextWindow * 100)),
    usedTokens,
    contextWindow,
  }
}
