/**
 * The git commands the push tool runs, behind one injectable runner so the tool
 * is exercisable without a repository.
 *
 * @module @deepseek-ai/dsh-autopush/git
 */

import { execFile } from 'node:child_process'

/** One finished git invocation. */
export interface GitResult {
  /** Process exit code; `0` is success. */
  readonly code: number
  /** Standard output, with the trailing newline kept. */
  readonly stdout: string
  /** Standard error, with the trailing newline kept. */
  readonly stderr: string
}

/**
 * Run one git command in a directory.
 * @param args - arguments after the program name.
 * @param cwd - directory to run in.
 * @returns the exit code and both streams.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>

/**
 * Run git as a child process.
 *
 * `execFile` is used rather than a shell so a Turkish commit message reaches git
 * as one argument, whatever quoting the platform would otherwise apply.
 * @param args - arguments after the program name.
 * @param cwd - directory to run in.
 * @returns the exit code and both streams.
 */
export const execGit: GitRunner = async (args, cwd) => new Promise<GitResult>((resolve, reject) => {
  execFile('git', [...args], { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error !== null && error.code === undefined) {
      // A missing git binary or a spawn failure, not a git exit code.
      reject(new Error(`could not run git: ${error.message}`))
      return
    }
    resolve({
      code: typeof error?.code === 'number' ? error.code : 0,
      stdout,
      stderr,
    })
  })
})

/** Test hooks; production never replaces these. */
export const internals: { git: GitRunner } = { git: execGit }
