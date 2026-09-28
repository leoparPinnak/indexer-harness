/**
 * Auto-push: a per-session toggle the composer dashboard owns, a tool that turns
 * a finished request into one commit and one push with a Turkish description, and
 * the system-prompt policy that tells the model when to call it.
 *
 * The gate matters more than the mechanics: nothing here pushes while the toggle
 * is off, and a request that changed nothing does not push either — the counter
 * and the history are meant to mean "the user agreed to publish this", not "the
 * model said something".
 *
 * @module @deepseek-ai/dsh-autopush
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { AutoPushProjection, AutoPushUnitState, PushRecord } from './types.ts'
import { internals } from './git.ts'
import type { GitRunner } from './git.ts'
import {
  MAX_PROJECT_RECORDS,
  formatProjectHistoryPrompt,
  formatPushDate,
  readProjectHistory,
  recordProjectHistory,
  type ProjectPushRecord,
} from './project-history.ts'
import { inspectGitWorkspace } from './git-status.ts'
export type * from './types.ts'
export type * from './project-history.ts'
export type * from './git-status.ts'
export { formatProjectHistoryPrompt, formatPushDate, readProjectHistory, recordProjectHistory } from './project-history.ts'
export { inspectGitWorkspace } from './git-status.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    autoPush: AutoPushController
  }
}

/** The model-facing tool's name. */
export const PUSH_CHANGES = 'push_changes'

/** The slash command's name. */
export const AUTOPUSH_COMMAND = 'autopush'

/** Deployment-owned auto-push settings. */
export interface AutoPushConfig {
  /** Remote the push goes to. */
  remote: string
  /** Branch the push goes to. */
  branch: string
}

/**
 * Validate deployment-owned auto-push settings.
 * @param config - raw plugin config.
 * @returns a detached validated config.
 */
export function resolveConfig(config: AutoPushConfig): AutoPushConfig {
  const remote = (config as Partial<AutoPushConfig>).remote
  const branch = (config as Partial<AutoPushConfig>).branch
  if (typeof remote !== 'string' || remote.trim() === '') {
    throw new Error('AutoPushConfig needs a non-empty `remote`')
  }
  if (typeof branch !== 'string' || branch.trim() === '') {
    throw new Error('AutoPushConfig needs a non-empty `branch`')
  }
  const unknown = Object.keys(config).filter(key => key !== 'remote' && key !== 'branch')
  if (unknown.length > 0) {
    throw new Error(`AutoPushConfig has unknown key(s) ${unknown.join(', ')} — config is { remote, branch }`)
  }
  return { remote, branch }
}

const pushRecordSchema: ZodType<PushRecord> = zod.object({
  at: zod.number(),
  message: zod.string(),
  sha: zod.string(),
  files: zod.number(),
  remote: zod.string(),
  branch: zod.string(),
}).strict()

const projectPushRecordSchema: ZodType<ProjectPushRecord> = zod.object({
  sha: zod.string(),
  at: zod.number(),
  date: zod.string().optional(),
  message: zod.string(),
  files: zod.number(),
  remote: zod.string(),
  branch: zod.string(),
  sessionId: zod.string().optional(),
}).strict()

const autoPushStateSchema: ZodType<AutoPushUnitState> = zod.object({
  enabled: zod.boolean(),
  count: zod.number(),
  history: zod.array(pushRecordSchema),
  projectHistory: zod.array(projectPushRecordSchema),
}).strict()

/** Wire payload schema of the `autopush` projection. */
const autoPushProjectionSchema: ZodType<AutoPushProjection> = zod.object({
  enabled: zod.boolean(),
  count: zod.number(),
  lastAt: zod.number().nullable(),
  history: zod.array(pushRecordSchema),
  projectHistory: zod.array(projectPushRecordSchema),
})

/** Projection of the logged toggle and the recorded pushes. */
export const autoPushProjectionDefinition = {
  key: 'autopush',
  stateVersion: 1,
  stateSchema: autoPushStateSchema,
  init: (header) => {
    const cwd = header.cwd
    const projectHistory = cwd !== undefined ? (readProjectHistory(cwd)?.records ?? []) : []
    return { enabled: false, count: 0, history: [], projectHistory }
  },
  apply: (state, event) => {
    if (event.type === 'autopush/mode') {
      return event.data.enabled === state.enabled ? state : { ...state, enabled: event.data.enabled }
    }
    if (event.type === 'autopush/push') {
      const record: PushRecord = {
        at: event.data.at,
        message: event.data.message,
        sha: event.data.sha,
        files: event.data.files,
        remote: event.data.remote,
        branch: event.data.branch,
      }
      const projectRecord: ProjectPushRecord = {
        sha: event.data.sha,
        at: event.data.at,
        date: formatPushDate(event.data.at),
        message: event.data.message,
        files: event.data.files,
        remote: event.data.remote,
        branch: event.data.branch,
      }
      const existingProject = state.projectHistory ?? []
      const projectHistory = existingProject[0]?.sha === projectRecord.sha
        ? existingProject
        : [projectRecord, ...existingProject].slice(0, MAX_PROJECT_RECORDS)

      return {
        ...state,
        count: state.count + 1,
        history: [record, ...state.history].slice(0, 50),
        projectHistory,
      }
    }
    return state
  },
  wire: {
    viewSchema: autoPushProjectionSchema,
    view: state => ({
      enabled: state.enabled,
      count: state.count,
      lastAt: state.history[0]?.at ?? null,
      history: state.history,
      projectHistory: state.projectHistory ?? [],
    }),
  },
} satisfies ProjectionDefinition<'autopush', AutoPushUnitState>

/** What one `push_changes` call did. */
export interface PushOutcome {
  /** True only when this call reached the remote. */
  readonly pushed: boolean
  /** Short commit id that went out; empty when nothing was pushed. */
  readonly sha: string
  /** Files the commit carried. */
  readonly files: number
  /** Files that already awaited a push when no new commit was made. */
  readonly pending: number
  /** Human-readable result line. */
  readonly detail: string
}

/**
 * Turn a finished request into one commit and one push.
 * @param git - the runner to use.
 * @param cwd - the session workspace.
 * @param message - the commit's Turkish description.
 * @param config - validated auto-push settings.
 * @returns what happened; a refusal throws.
 */
export async function pushWorkspace(
  git: GitRunner,
  cwd: string,
  message: string,
  config: AutoPushConfig,
): Promise<PushOutcome> {
  const status = await git(['status', '--porcelain'], cwd)
  if (status.code !== 0) {
    if (status.stderr.toLowerCase().includes('not a git repository')) {
      throw new Error(`git status failed: not a git repository (${cwd} dizininde .git bulunamadı). Lütfen önce depoyu oluşturun veya ask_user_question ile kullanıcıya danışın.`)
    }
    throw new Error(`git status failed: ${status.stderr.trim()}`)
  }
  const changed = status.stdout.split('\n').filter(line => line.trim() !== '').length

  if (changed === 0) {
    // Nothing to commit: the only useful push is one that carries commits the
    // remote does not have yet. An already-synced branch is a no-op, and a no-op
    // must not move the counter.
    const ahead = await git(['rev-list', '--count', 'HEAD', `^${config.remote}/${config.branch}`], cwd)
    if (ahead.code === 0 && ahead.stdout.trim() === '0') {
      return { pushed: false, sha: '', files: 0, pending: 0, detail: 'Pushlanacak değişiklik yok.' }
    }
    const pending = Number.parseInt(ahead.stdout.trim(), 10)
    const push = await git(['push', config.remote, config.branch], cwd)
    if (push.code !== 0) throw new Error(`git push failed: ${push.stderr.trim()}`)
    const head = await git(['rev-parse', '--short', 'HEAD'], cwd)
    return {
      pushed: true,
      sha: head.stdout.trim(),
      files: 0,
      pending: Number.isNaN(pending) ? 0 : pending,
      detail: `Bekleyen commit'ler gönderildi: ${config.remote}/${config.branch}.`,
    }
  }

  const add = await git(['add', '--all'], cwd)
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`)
  const commit = await git(['commit', '-m', message], cwd)
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`)

  const push = await git(['push', config.remote, config.branch], cwd)
  if (push.code !== 0) {
    const head = await git(['rev-parse', '--short', 'HEAD'], cwd)
    const sha = head.code === 0 ? head.stdout.trim() : ''
    // The commit stays; only the publication failed, so the reader can retry.
    throw new Error(`commit oluştu ama push başarısız (HEAD: ${sha}): ${push.stderr.trim()}. Sorunu giderdikten sonra push_changes çağrısını tekrar deneyin.`)
  }
  const head = await git(['rev-parse', '--short', 'HEAD'], cwd)
  return {
    pushed: true,
    sha: head.stdout.trim(),
    files: changed,
    pending: 0,
    detail: `${String(changed)} dosya commit'lendi ve ${config.remote}/${config.branch} dalına gönderildi.`,
  }
}

/** The policy text the model reads when auto-push is on and the workspace is a configured git repository. */
export const READY_POLICY = 'Auto-push is ON for this session. When you have actually finished the request and its checks pass, '
  + 'determine whether the work is push-worthy according to the Decision Guide below. '
  + 'If it is push-worthy, do NOT call push_changes silently. First finish delivering your response to the user, '
  + 'then offer a proposal (similar to plan mode / interactive confirmation) asking whether to push to GitHub, '
  + 'clearly stating the concrete reasons. Call `push_changes` ONLY after the user approves.\n\n'
  + '### PUSH DECISION GUIDE (Pushlanabilirlik Kılavuzu)\n'
  + 'A change is push-worthy when ALL of the following criteria are met:\n'
  + '1. Completed Milestone: The requested feature, bugfix, or architectural task is fully implemented (not left in a half-finished or broken state).\n'
  + '2. Checks Passed: Relevant unit tests, typechecks, or build verifications have been run and passed without errors.\n'
  + '3. Stable & Meaningful State: The workspace is in a clean, working condition suitable as a Git commit milestone (not temporary scratch files or unfinished exploratory edits).\n'
  + 'Do NOT offer to push during investigation, while still drafting or debugging, when tests fail, or for trivial conversational turns without code changes.\n\n'
  + '### PROPOSAL & APPROVAL FLOW\n'
  + 'When the work reaches a push-worthy state:\n'
  + '1. Complete your explanatory reply to the user.\n'
  + '2. Present the push proposal using `ask_user_question` (or clear interactive choice) with:\n'
  + '   - header: "Git Push Onayı"\n'
  + '   - question: "Yapılan geliştirme Git\'e pushlanmaya değer bir seviyeye ulaştı. GitHub\'a pushlansın mı?"\n'
  + '   - detail: The concrete reasons (what was completed, which tests passed, why it is a stable milestone).\n'
  + '   - options: [{"label": "Pushla (Önerilen)", "description": "Değişiklikleri commit edip GitHub\'a gönderir."}, {"label": "Şimdilik Beklet", "description": "Değişiklikler yerelde kalır, push yapılmaz."}]\n'
  + '3. When the user confirms (via selection or in chat), immediately call `push_changes` with a concise Turkish commit message.\n'
  + '4. Always publish through `push_changes`, never by running `git push` directly in the shell. If push_changes fails after creating a commit, resolve the blocker and call push_changes again.'

/** Backwards-compatible alias for {@link READY_POLICY}. */
export const POLICY = READY_POLICY

/**
 * Format the uninitialized Git policy text instructing the model to ask the user
 * via `ask_user_question` before fulfilling the request.
 * @param remote - The configured remote name.
 * @param branch - The configured branch name.
 * @returns The policy directive string.
 */
export function formatUninitializedGitPolicy(remote: string, branch: string): string {
  return 'Auto-push is ON for this session, but this workspace is NOT a Git repository yet (`.git` is missing).\n'
    + 'CRITICAL REQUIREMENT: Before fulfilling the user\'s request, writing code, or running tasks, you MUST immediately call `ask_user_question` '
    + 'to ask whether the user wants to initialize Git and create a GitHub repository for this project:\n'
    + '- id: "github_repo_setup"\n'
    + '- header: "GitHub Depo Kurulumu"\n'
    + '- question: "Bu projede henüz bir Git deposu bulunmuyor. Auto-push için yeni bir GitHub deposu oluşturulsun mu?"\n'
    + '- options: [\n'
    + '    {\n'
    + '      "label": "Direkt Pushla (Model Başlığı Belirlesin) (Recommended)",\n'
    + '      "description": "Model proje içeriğine uygun bir repo adı seçer, Git başlatır ve GitHub reposunu oluşturup bağlar."\n'
    + '    },\n'
    + '    {\n'
    + '      "label": "Hayır / Vazgeç",\n'
    + '      "description": "GitHub reposu oluşturulmaz, auto-push devre dışı kalır."\n'
    + '    }\n'
    + '  ]\n'
    + '- In the question or detail, inform the user that they may also type a custom repository name into the custom answer field.\n'
    + '\nHOW TO HANDLE THE USER\'S ANSWER:\n'
    + '1. If the user selects "Direkt Pushla (Model Başlığı Belirlesin) (Recommended)":\n'
    + '   - Analyze the workspace and user request to pick a clean, kebab-case GitHub repository name (e.g. "my-project").\n'
    + `   - Initialize Git (\`git init\`), set branch to ${branch} (\`git branch -M ${branch}\`).\n`
    + `   - Create the private GitHub repository with GitHub CLI: \`gh repo create <repo-name> --source=. --remote=${remote} --private\`.\n`
    + '   - Then proceed to fulfill the user\'s request, test/verify, and finally call `push_changes` with a Turkish description.\n'
    + '2. If the user typed a custom repository name (in the `custom` answer field):\n'
    + `   - Initialize Git (\`git init\`), set branch to ${branch} (\`git branch -M ${branch}\`).\n`
    + `   - Create the private GitHub repository with GitHub CLI: \`gh repo create <custom-name> --source=. --remote=${remote} --private\`.\n`
    + '   - Then proceed with the user\'s request and call `push_changes` upon completion.\n'
    + '3. If the user selects "Hayır / Vazgeç" or skips the question:\n'
    + '   - Do NOT initialize Git or create a GitHub repo. Answer the user\'s request normally without calling `push_changes`.'
}

/**
 * Format the policy when Git is initialized but the configured remote is missing.
 * @param remote - The configured remote name.
 * @param branch - The configured branch name.
 * @returns The policy directive string.
 */
export function formatNoRemoteGitPolicy(remote: string, branch: string): string {
  return `Auto-push is ON for this session, but the Git repository has no \`${remote}\` remote configured.\n`
    + 'CRITICAL REQUIREMENT: Before fulfilling the user\'s request, you MUST immediately call `ask_user_question` '
    + `to ask whether to create and link a GitHub repository as the \`${remote}\` remote:\n`
    + '- id: "github_remote_setup"\n'
    + '- header: "GitHub Remote Kurulumu"\n'
    + `- question: "Git deposunda \\"${remote}\\" bağlantısı bulunmuyor. GitHub'da repo oluşturulup bağlansın mı?"\n`
    + '- options: [\n'
    + '    {\n'
    + '      "label": "Direkt Pushla (Model Başlığı Belirlesin) (Recommended)",\n'
    + '      "description": "Model uygun bir repo adı seçer ve GitHub reposunu oluşturup remote olarak ekler."\n'
    + '    },\n'
    + '    {\n'
    + '      "label": "Hayır / Vazgeç",\n'
    + '      "description": "Uzak depo bağlanmaz, auto-push devre dışı kalır."\n'
    + '    }\n'
    + '  ]\n'
    + '- Inform the user that they can also type a custom repository name into the custom answer field.\n'
    + `If confirmed, create the GitHub repository with \`gh repo create <name> --source=. --remote=${remote} --private\`, set branch to \`${branch}\` (\`git branch -M ${branch}\`), fulfill the request, and call \`push_changes\` upon completion.`
}

/**
 * `ctx.autoPush`: owns the logged toggle and the one tool that publishes work.
 *
 * The service reads and writes session state only; the projection unit owns the
 * fold, and the composer dashboard owns the button.
 */
export class AutoPushController extends Service {
  static inject = ['systemPrompt', 'sessionProjections', 'tools']

  /** Validated deployment settings. */
  private readonly config: AutoPushConfig

  /**
   * @param ctx - host context carrying the prompt, projection, and tool registries.
   * @param config - validated {@link AutoPushConfig}.
   */
  constructor(ctx: Context, config: AutoPushConfig) {
    super(ctx, 'autoPush')
    this.config = resolveConfig(config)

    ctx.systemPrompt.section({
      name: 'autopush:policy',
      order: ctx.systemPrompt.getSectionOrder('AUTOPUSH_POLICY'),
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        const enabled = this.enabled(agent.session)
        const cwd = agent.session.header.cwd
        const historyText = cwd !== undefined ? formatProjectHistoryPrompt(cwd) : ''
        if (enabled) {
          let policyText = READY_POLICY
          const agents = ctx.get('agents')
          const isRoot = agents === undefined || agents.roots().includes(agent)
          if (cwd !== undefined && isRoot) {
            const gitStatus = inspectGitWorkspace(cwd, this.config.remote)
            if (gitStatus === 'uninitialized') {
              policyText = formatUninitializedGitPolicy(this.config.remote, this.config.branch)
            } else if (gitStatus === 'no-remote') {
              policyText = formatNoRemoteGitPolicy(this.config.remote, this.config.branch)
            }
          }
          return historyText !== '' ? `${policyText}\n\n${historyText}` : policyText
        }
        return historyText
      },
    })

    ctx.sessionProjections.register(autoPushProjectionDefinition)

    // The command child activates only when a command registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-autopush'),
        name: AUTOPUSH_COMMAND,
        description: 'Turn automatic push on or off for this session',
        input: { hint: '[on|off]' },
        handler: ({ agent, rawInput }) => {
          const request = rawInput.trim().toLowerCase()
          if (request !== '' && request !== 'on' && request !== 'off') {
            return { kind: 'error', text: 'Use /autopush, /autopush on, or /autopush off.' }
          }
          const wanted = request !== 'off'
          if (wanted) {
            return this.set(agent.session, true) === 'committed'
              ? { kind: 'success', text: 'Oto-push açık. İstek tamamlandığında push_changes çağrılacak.' }
              : { kind: 'success', text: 'Oto-push zaten açık.' }
          }
          return this.set(agent.session, false) === 'committed'
            ? { kind: 'success', text: 'Oto-push kapalı.' }
            : { kind: 'success', text: 'Oto-push zaten kapalı.' }
        },
      })
    })

    ctx.tools.register(defineTool({
      name: PUSH_CHANGES,
      description: 'Publish the session workspace: commit every change with the given TURKISH description and push it. '
        + 'Call this when the user approves your push proposal after a push-worthy milestone is reached and checks pass. '
        + 'It is refused while auto-push is off.',
      parameters: {
        message: { type: 'string', required: true, description: 'Short Turkish description of what changed, used as the commit message.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pushed: { type: 'boolean', required: true },
            sha: { type: 'string', required: true },
            files: { type: 'number', required: true },
            detail: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.pushed
          ? `Push tamam: ${value.sha} (${String(value.files)} dosya). ${value.detail}`
          : value.detail }],
      },
      execute: async (args, exec) => {
        const agent: Agent | undefined = exec.agent
        if (agent === undefined) throw new Error(`${PUSH_CHANGES} requires a calling agent (there is no session to publish)`)
        const outcome = await this.push(agent.session, args.message)
        return { pushed: outcome.pushed, sha: outcome.sha, files: outcome.files, detail: outcome.detail }
      },
    }))
  }

  /**
   * Read the logged toggle for one session.
   * @param session - the session to read.
   * @returns whether auto-push is on.
   */
  enabled(session: Session): boolean {
    return this.state(session).enabled
  }

  /**
   * Select whether auto-push is on. The change is logged immediately: unlike a
   * narrated mode, nothing queues it behind a turn boundary.
   * @param session - the session to switch.
   * @param enabled - the requested state.
   * @returns what happened.
   */
  set(session: Session, enabled: boolean): 'committed' | 'noop' {
    if (this.state(session).enabled === enabled) return 'noop'
    session.append('autopush/mode', { enabled })
    return 'committed'
  }

  /**
   * Publish the workspace, recording the push in the session log on success.
   * @param session - the session whose workspace is published.
   * @param message - the commit's Turkish description.
   * @returns what happened.
   */
  async push(session: Session, message: string): Promise<PushOutcome> {
    // Input first, environment second: an empty description is the caller's
    // mistake whatever this session's workspace turns out to be.
    const description = message.trim()
    if (description === '') throw new Error(`${PUSH_CHANGES} needs a non-empty Turkish description`)
    if (!this.enabled(session)) {
      throw new Error(`${PUSH_CHANGES} is refused while auto-push is off; the user turns it on from the composer`)
    }
    const cwd = session.header.cwd
    if (cwd === undefined) throw new Error(`${PUSH_CHANGES} needs a session workspace, and this session has no cwd`)
    const outcome = await pushWorkspace(internals.git, cwd, description, this.config)
    if (outcome.pushed) {
      let finalMessage = description
      if (outcome.pending > 0) {
        const commitMsg = await internals.git(['log', '-1', '--format=%s'], cwd)
        if (commitMsg.code === 0 && commitMsg.stdout.trim() !== '') {
          finalMessage = commitMsg.stdout.trim()
        }
      }
      const now = Date.now()
      session.append('autopush/push', {
        at: now,
        message: finalMessage,
        sha: outcome.sha,
        files: outcome.files,
        remote: this.config.remote,
        branch: this.config.branch,
      })
      recordProjectHistory(cwd, {
        sha: outcome.sha,
        at: now,
        date: formatPushDate(now),
        message: finalMessage,
        files: outcome.files,
        remote: this.config.remote,
        branch: this.config.branch,
        sessionId: session.id,
      })
    }
    return outcome
  }

  /** Read the projected state or fail at the first access. */
  private state(session: Session): AutoPushUnitState {
    const state = this.ctx.sessionProjections.stateOf(session, 'autopush')
    if (state === undefined) throw new Error('autopush requires the autopush session projection')
    return state
  }
}

export default AutoPushController
