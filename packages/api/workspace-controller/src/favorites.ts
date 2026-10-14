/** Session favorites: one small JSON document kept beside the stored Sessions. */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Where the favorites document lives, supplied by the deployment composition. */
export interface SessionFavoritesOptions {
  /** Absolute path of the JSON document; its directory is created on first write. */
  readonly file: string
}

/**
 * Ordered Session favorites persisted as `{"sessionIds": [...]}`.
 *
 * The document is a plain JSON file inside the deployment's Sessions directory,
 * so the list lives with the Sessions it names and stays legible from outside
 * the harness. A missing document reads as empty; a malformed one fails loud
 * instead of silently discarding the operator's list. Writes are serialized and
 * atomic, so a toggle never leaves a half-written file behind.
 */
export class SessionFavorites {
  private readonly file: string
  /** Tail of the write chain: one read-modify-write cycle at a time. */
  private pending: Promise<unknown> = Promise.resolve()

  /** @param options - document location. */
  constructor(options: SessionFavoritesOptions) {
    this.file = options.file
  }

  /**
   * Read the recorded favorites.
   * @returns Session ids in the order the operator starred them.
   */
  read(): Promise<readonly SessionId[]> {
    return this.ordered()
  }

  /**
   * Star or unstar one Session.
   * @param sessionId - Session to toggle.
   * @param favorite - true appends the Session to the order, false removes it.
   * @returns the complete favorites order after the write.
   */
  set(sessionId: SessionId, favorite: boolean): Promise<readonly SessionId[]> {
    const cycle = this.pending.then(async () => {
      const current = await this.ordered()
      // Starring an already starred Session keeps its position: the mark is a
      // set membership, and a re-read of a stale row must not reorder the list.
      const next = favorite
        ? current.includes(sessionId) ? [...current] : [...current, sessionId]
        : current.filter(id => id !== sessionId)
      if (!sameOrder(current, next)) await this.write(next)
      return next
    })
    // A failed cycle must not poison the chain for the next toggle.
    this.pending = cycle.catch(() => undefined)
    return cycle
  }

  private async ordered(): Promise<readonly SessionId[]> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const ids = readSessionIds(raw, this.file)
    return ids.map(id => SessionId(id))
  }

  private async write(sessionIds: readonly SessionId[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFileAtomic(this.file, `${JSON.stringify({ sessionIds }, null, 2)}\n`, { mode: 0o600 })
  }
}

/**
 * Parse one favorites document.
 * @param raw - complete file content.
 * @param file - path named in the failure message.
 * @returns the recorded ids as written.
 */
function readSessionIds(raw: string, file: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`session favorites: ${file} is not valid JSON`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`session favorites: ${file} must contain a JSON object`)
  }
  const ids: unknown = Reflect.get(parsed, 'sessionIds')
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
    throw new Error(`session favorites: ${file} must carry a "sessionIds" array of strings`)
  }
  return ids as string[]
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}
