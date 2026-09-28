/**
 * @deepseek-ai/dsh-cdp — the tab lease desk. `TabLockRegistry` hands out one
 * TTL lease per target key so parallel writers (two subagents driving the same
 * tab) queue instead of interleaving input garble. The clock is injected (`now`),
 * no timer runs: an expired lease is simply dead at the next acquire and a
 * forgotten lock cannot stick past its TTL. Plain data only — one input always
 * yields one output.
 * @module @deepseek-ai/dsh-cdp/tab-lock
 */

/** One granted lease over a target key. */
export interface TabLease {
  readonly lockId: string
  readonly targetKey: string
  readonly holder: string
  /** Epoch ms the lease dies at; past this the key yields silently. */
  readonly lockedUntil: number
}

/** Acquire outcome; `lock-held` is in-band data, not a throw. */
export type TabLockAcquire =
  | { readonly ok: true; readonly lease: TabLease }
  | {
    readonly ok: false
    readonly reason: 'lock-held'
    readonly holder: string
    readonly lockedUntil: number
  }

/** Release outcome; `unknown-lock` fires for foreign and already-dead ids alike. */
export type TabLockRelease =
  | { readonly ok: true; readonly released: TabLease }
  | { readonly ok: false; readonly reason: 'unknown-lock' | 'not-holder' }

/** Clamp bounds of one lease lifetime: 1s floor, 300s ceiling. */
export const MIN_LOCK_TTL_MS = 1_000
export const MAX_LOCK_TTL_MS = 300_000

/** Clamp a requested TTL into the supported window. */
export function clampLockTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return 60_000
  return Math.min(MAX_LOCK_TTL_MS, Math.max(MIN_LOCK_TTL_MS, Math.floor(ttlMs)))
}

/** The lease desk: one live lease per target key, expiring without timers. */
export class TabLockRegistry {
  #leases = new Map<string, TabLease>()
  #byLockId = new Map<string, string>()
  #seq = 0

  /**
   * Take the lease on `targetKey`, or answer `lock-held` with the current
   * holder. A lease whose `lockedUntil` has passed yields silently — the dead
   * holder is never blamed and never blocks.
   */
  acquire(targetKey: string, holder: string, ttlMs: number, now: number): TabLockAcquire {
    const held = this.#leases.get(targetKey)
    if (held !== undefined && held.lockedUntil > now) {
      return { ok: false, reason: 'lock-held', holder: held.holder, lockedUntil: held.lockedUntil }
    }
    if (held !== undefined) this.#forget(held)
    this.#seq += 1
    const lease: TabLease = {
      lockId: `lock-${String(this.#seq)}`,
      targetKey,
      holder,
      lockedUntil: now + clampLockTtl(ttlMs),
    }
    this.#leases.set(targetKey, lease)
    this.#byLockId.set(lease.lockId, targetKey)
    return { ok: true, lease }
  }

  /**
   * Give the lease back. `holder`, when given, must match the owner — an
   * unlock by a bystander answers `not-holder`. An unknown or already-released
   * id answers `unknown-lock` (double-unlock is honest data, not an error).
   */
  release(lockId: string, holder: string | undefined, now: number): TabLockRelease {
    const targetKey = this.#byLockId.get(lockId)
    if (targetKey === undefined) return { ok: false, reason: 'unknown-lock' }
    const held = this.#leases.get(targetKey)
    if (held === undefined || held.lockId !== lockId) return { ok: false, reason: 'unknown-lock' }
    if (holder !== undefined && holder.length > 0 && held.holder !== holder) {
      return { ok: false, reason: 'not-holder' }
    }
    this.#forget(held)
    // An expired lease still releases cleanly: the table must not leak rows.
    void now
    return { ok: true, released: held }
  }

  /** The live lease on `targetKey`, or undefined when free/expired. */
  inspect(targetKey: string, now: number): TabLease | undefined {
    const held = this.#leases.get(targetKey)
    return held !== undefined && held.lockedUntil > now ? held : undefined
  }

  /** Purge dead leases; returns how many keys were freed. */
  sweep(now: number): number {
    let swept = 0
    for (const lease of [...this.#leases.values()]) {
      if (lease.lockedUntil <= now) {
        this.#forget(lease)
        swept += 1
      }
    }
    return swept
  }

  #forget(lease: TabLease): void {
    this.#leases.delete(lease.targetKey)
    this.#byLockId.delete(lease.lockId)
  }
}