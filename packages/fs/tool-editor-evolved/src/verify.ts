/**
 * Post-write byte verification: the file is read back after a guarded write and compared
 * with the intended content, so a truncated, interleaved, or silently dropped write cannot
 * be reported to the model as a successful edit.
 * @module @deepseek-ai/dsh-tool-editor-evolved/verify
 */

/**
 * Compare the intended patched content with what the file actually holds, byte for byte.
 * @param path - display path used in the error, so the model knows which file to re-read.
 * @param intent - the exact content the write was supposed to persist.
 * @param actual - the content read back from disk after the write.
 * @throws Error when the two differ, in the "Re-read the file and try again" class.
 */
export function verifyPatchedBytes(path: string, intent: string, actual: string): void {
  const intended = Buffer.from(intent, 'utf8')
  const persisted = Buffer.from(actual, 'utf8')
  if (intended.equals(persisted)) return
  const shorter = Math.min(intended.length, persisted.length)
  let divergence = 0
  while (divergence < shorter && intended[divergence] === persisted[divergence]) divergence += 1
  throw new Error(
    `Edit verification failed for ${path}: the file on disk does not match the patched content `
    + `(${persisted.length} bytes persisted, ${intended.length} intended, first difference at byte ${divergence}). `
    + 'Re-read the file and try again.',
  )
}
