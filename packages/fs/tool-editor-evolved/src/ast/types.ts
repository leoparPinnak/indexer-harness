/**
 * Public contract of the AST rewrite layer.
 *
 * The layer is a pure text-in/text-out seam: it never touches the filesystem,
 * so the hashline core stays the single writer. Selection, matching and
 * substitution all run over the TypeScript compiler AST (no new dependency).
 * @module @deepseek-ai/dsh-tool-editor-evolved/ast/types
 */

/** One rewrite op: an AST pattern plus a substitution template (OMP ast_edit shape). */
export interface AstRewriteOp {
  /** AST pattern; matches structure, not text. `$A` binds one node, `$$$ARGS` binds a list. */
  pat: string
  /** Replacement template; `$A`/`$$$NAME` substitute the bound source text. Empty deletes. */
  out: string
}

/** A file handed to the tool (the caller owns reading/writing). */
export interface AstRewriteFile {
  path: string
  text: string
}

/** Diagnostics are 1-based lines/columns, 0-based offsets — repo read-window convention. */
export interface AstDiagnostic {
  message: string
  line: number
  column: number
  offset: number
  length: number
}

/** Auto-repair report attached to a successful parse repair. */
export interface RepairReport {
  /** Repair strategies tried until the parse went clean. */
  attempts: number
  /** 1-based inclusive line span the applied repair touched. */
  regionLines: [number, number]
  /** Name of the strategy that produced the clean parse. */
  strategy: string
  /** `Edit auto-repair applied (attempts=…, regionLines=…)` — OMP @0xa71729d report shape. */
  message: string
}

/** Per-file outcome of one `AstRewriteTool.rewrite` call. */
export interface AstRewriteFileResult {
  path: string
  /** `false` only when the caller disabled `failOnParseError` and the file stayed unparseable. */
  applied: boolean
  changed: boolean
  /** Number of non-overlapping op matches applied to this file. */
  matches: number
  /** Rewritten text when `changed`; absent otherwise (and preview text under `dryRun`). */
  text?: string
  /** Present when a parse error was auto-repaired before rewriting. */
  repair?: RepairReport
  /** Present when the file was skipped because parsing failed and `failOnParseError` is off. */
  skipped?: string
}

/** Result of one multi-file rewrite call. */
export interface AstRewriteResult {
  dryRun: boolean
  files: AstRewriteFileResult[]
}

/** Knobs for a rewrite call; constructor defaults may supply any of them. */
export interface AstRewriteOptions {
  /**
   * Default `true`: an unrepairable parse error throws `AstParseError`.
   * `false` downgrades to a skipped-file result (no rewrite on a broken tree).
   */
  failOnParseError?: boolean
  /** Default `false`: compute the rewrite and return previews without committing `applied`. */
  dryRun?: boolean
  /** Default {@link DEFAULT_MAX_FILES}: files per call; excess throws `MAX_FILES` before any work. */
  maxFiles?: number
}

/** A language backend selected by file path. */
export interface AstProvider {
  readonly id: string
  /** Whether this backend claims the path (extension-based). */
  matchesPath(path: string): boolean
  /**
   * Apply `ops` to one text, reparsing between ops.
   * `path` selects the ScriptKind (tsx vs ts vs js) for pattern and file parses.
   * Throws `AstRewriteError` with codes `PARSE_ERROR`, `BAD_PATTERN`,
   * `UNSUPPORTED_PATTERN` for authoring failures.
   */
  rewrite(
    path: string,
    text: string,
    ops: readonly AstRewriteOp[],
    options: { failOnParseError: boolean },
  ): {
    text: string
    matches: number
    repair?: RepairReport
    /** Present with `failed: true` when parsing failed and `failOnParseError` is off. */
    failed?: { diagnostics: AstDiagnostic[] }
  }
}

/** Stable error codes surfaced by the AST layer. */
export type AstRewriteErrorCode =
  | 'PARSE_ERROR'
  | 'BAD_PATTERN'
  | 'UNSUPPORTED_PATTERN'
  | 'UNSUPPORTED_LANGUAGE'
  | 'MAX_FILES'

/** Error type thrown by the AST layer; `code` is machine-readable. */
export class AstRewriteError extends Error {
  /** Stable machine-readable code classifying why the rewrite failed. */
  readonly code: AstRewriteErrorCode
  /** Parser diagnostics captured at throw time; empty when none applied. */
  readonly diagnostics: readonly AstDiagnostic[]

  constructor(code: AstRewriteErrorCode, message: string, diagnostics: readonly AstDiagnostic[] = []) {
    super(message)
    this.name = 'AstRewriteError'
    this.code = code
    this.diagnostics = diagnostics
  }
}

/** Files per rewrite call before `MAX_FILES` rejects the whole call. */
export const DEFAULT_MAX_FILES = 20
