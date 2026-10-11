// A row that applies and stays: no injects, no side effects, so a loader
// group can mount it without a host composition around it — the shape a
// group-update retry test needs to observe the retry rather than the row.
export const name = 'idle'

export function apply() {}
