/**
 * Best-effort parse auto-repair for TS/TSX/JS regions (OMP @0xa71729d shape).
 *
 * Each strategy proposes one small text edit; the proposal is only accepted
 * when a fresh parse comes back completely clean. Every attempt is counted and
 * the applied repair reports the line region it touched, so callers can show
 * `Edit auto-repair applied (attempts=…, regionLines=…)`.
 * @module @deepseek-ai/dsh-tool-editor-evolved/ast/repair
 */

import type { RepairReport } from './types.ts'

/** Outcome of a successful repair: the clean text plus its report. */
export interface ParseRepairOutcome {
  text: string
  report: RepairReport
}

interface ScanState {
  open: string[]
  /** `'string' | 'template' | 'block-comment'` when EOF lands inside them, else undefined. */
  unterminated: 'sq' | 'dq' | 'template' | 'block-comment' | undefined
}

/**
 * Scan ignoring brackets inside strings/comments (no regex-literal grammar —
 * a wrong guess is harmless because the reparse gate rejects bad proposals).
 */
function scan(text: string): ScanState {
  const open: string[] = []
  let unterminated: ScanState['unterminated']
  let i = 0
  const closer: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  while (i < text.length) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2)
      i = nl === -1 ? text.length : nl + 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) {
        unterminated = 'block-comment'
        break
      }
      i = end + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      let closed = false
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === c) {
          closed = true
          break
        }
        // Template literals may span lines; quoted strings stop at the newline.
        if (c !== '`' && text[j] === '\n') break
        j++
      }
      if (!closed) {
        unterminated = c === "'" ? 'sq' : c === '"' ? 'dq' : 'template'
        break
      }
      i = j + 1
      continue
    }
    if (c in closer) open.push(c)
    else if (c === ')' || c === ']' || c === '}') {
      const want = (Object.keys(closer) as string[]).find(k => closer[k] === c)
      if (want && open[open.length - 1] === want) open.pop()
    }
    i++
  }
  return { open, unterminated }
}

/** 1-based line number of an offset. */
function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

/** Strategy 1: terminate whatever is open at EOF (quote, comment, brackets). */
function closeAtEof(text: string): { text: string; region: [number, number] } | undefined {
  const state = scan(text)
  let suffix = ''
  if (state.unterminated === 'sq') suffix = "'"
  else if (state.unterminated === 'dq') suffix = '"'
  else if (state.unterminated === 'template') suffix = '`'
  else if (state.unterminated === 'block-comment') suffix = '*/'
  suffix += [...state.open].reverse().map(c => ({ '(': ')', '[': ']', '{': '}' })[c]!).join('')
  if (suffix === '') return undefined
  const line = lineOf(text, text.length)
  return { text: text + suffix, region: [line, line] }
}

/** Strategy 2: drop the final line (truncated/incomplete tail). */
function dropLastLine(text: string): { text: string; region: [number, number] } | undefined {
  const nl = text.lastIndexOf('\n')
  if (nl === -1) return undefined
  const line = lineOf(text, text.length)
  return { text: text.slice(0, nl + 1), region: [line, line] }
}

const STRATEGIES: Array<{
  name: string
  propose: (text: string) => { text: string; region: [number, number] } | undefined
}> = [
  { name: 'close-at-eof', propose: closeAtEof },
  { name: 'truncate-last-line', propose: dropLastLine },
]

/**
 * Try each strategy until `parsesClean` accepts the proposal.
 * Returns `undefined` when every proposal still fails to parse.
 */
export function attemptParseRepair(
  text: string,
  parsesClean: (candidate: string) => boolean,
): ParseRepairOutcome | undefined {
  let attempts = 0
  for (const strategy of STRATEGIES) {
    attempts++
    const proposal = strategy.propose(text)
    if (!proposal) continue
    if (!parsesClean(proposal.text)) continue
    const regionLines = proposal.region
    return {
      text: proposal.text,
      report: {
        attempts,
        regionLines,
        strategy: strategy.name,
        message: `Edit auto-repair applied (attempts=${attempts}, regionLines=${regionLines[0]}-${regionLines[1]})`,
      },
    }
  }
  return undefined
}
