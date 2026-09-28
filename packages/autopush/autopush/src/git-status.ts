/**
 * Inspect a workspace directory to determine its Git and remote configuration status.
 *
 * Used by auto-push to decide whether the workspace is ready for normal publishing,
 * or whether the model must first prompt the user to initialize a Git repository
 * and link a GitHub remote.
 *
 * @module @deepseek-ai/dsh-autopush/git-status
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** Status of Git initialization in a workspace directory. */
export type GitWorkspaceStatus =
  | 'uninitialized'
  | 'no-remote'
  | 'ready'

/**
 * Determine whether a workspace has an initialized Git repository and the specified remote configured.
 *
 * @param cwd - The workspace directory to inspect.
 * @param remote - The required remote name (e.g. 'origin').
 * @returns 'uninitialized' if `.git` does not exist, 'no-remote' if `.git` exists but the remote is missing, or 'ready'.
 */
export function inspectGitWorkspace(cwd: string, remote = 'origin'): GitWorkspaceStatus {
  const gitPath = join(cwd, '.git')
  if (!existsSync(gitPath)) {
    return 'uninitialized'
  }

  try {
    let configPath: string
    const stat = statSync(gitPath)
    if (stat.isDirectory()) {
      configPath = join(gitPath, 'config')
    } else if (stat.isFile()) {
      // Git worktree or submodule pointer (`gitdir: <path>`)
      const pointer = readFileSync(gitPath, 'utf8')
      const match = pointer.match(/^gitdir:\s*(.+)$/m)
      if (match === null || match[1] === undefined) {
        return 'uninitialized'
      }
      const rawDir = match[1].trim()
      const actualGitDir = isAbsolute(rawDir) ? rawDir : resolve(cwd, rawDir)
      configPath = join(actualGitDir, 'config')
    } else {
      return 'uninitialized'
    }

    if (!existsSync(configPath)) {
      return 'no-remote'
    }

    const configContent = readFileSync(configPath, 'utf8')
    const remotePattern = new RegExp(`\\[remote\\s+["']${remote}["']\\]`, 'i')
    if (remotePattern.test(configContent)) {
      return 'ready'
    }
    return 'no-remote'
  } catch {
    return 'uninitialized'
  }
}
