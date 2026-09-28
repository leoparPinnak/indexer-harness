import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AutoPushController, {
  formatProjectHistoryPrompt,
  formatPushDate,
  readProjectHistory,
  recordProjectHistory,
} from '../src/index.ts'
import { internals } from '../src/git.ts'
import type { GitResult, GitRunner } from '../src/git.ts'

const CONFIG = { remote: 'origin', branch: 'master' }

function result(code: number, stdout = '', stderr = ''): GitResult {
  return { code, stdout, stderr }
}

function fakeGit(answers: Record<string, GitResult>): GitRunner {
  return async (args) => {
    const entry = answers[args[0] ?? '']
    return entry ?? result(0)
  }
}

describe('project-level auto-push history', () => {
  it('formats dates consistently', () => {
    const ts = new Date(2026, 8, 16, 14, 30).getTime()
    expect(formatPushDate(ts)).toMatch(/16\.09\.2026 14:30/)
  })

  it('reads null when history file does not exist or is invalid JSON', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-autopush-test-'))
    try {
      expect(readProjectHistory(tempDir)).toBeNull()

      mkdirSync(join(tempDir, '.dsh'), { recursive: true })
      writeFileSync(join(tempDir, '.dsh/autopush-history.json'), 'invalid json!', 'utf8')
      expect(readProjectHistory(tempDir)).toBeNull()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('records pushes, prepends newest first, and limits record count', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-autopush-test-'))
    try {
      recordProjectHistory(tempDir, {
        sha: 'sha1',
        at: 1000,
        date: '01.01.2026 10:00',
        message: 'ilk commit',
        files: 2,
        remote: 'origin',
        branch: 'master',
      })

      const read1 = readProjectHistory(tempDir)
      expect(read1).not.toBeNull()
      expect(read1?.records).toHaveLength(1)
      expect(read1?.records[0]?.sha).toBe('sha1')

      recordProjectHistory(tempDir, {
        sha: 'sha2',
        at: 2000,
        date: '01.01.2026 11:00',
        message: 'ikinci commit',
        files: 5,
        remote: 'origin',
        branch: 'master',
      })

      const read2 = readProjectHistory(tempDir)
      expect(read2?.records).toHaveLength(2)
      expect(read2?.records[0]?.sha).toBe('sha2')
      expect(read2?.records[1]?.sha).toBe('sha1')
      expect(read2?.updatedAt).toBe(2000)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('formats prompt text with limited records', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-autopush-test-'))
    try {
      expect(formatProjectHistoryPrompt(tempDir)).toBe('')

      recordProjectHistory(tempDir, {
        sha: 'a1b2c3d',
        at: 1000,
        date: '11.09.2026 10:00',
        message: 'Giriş ekranı tamamlandı',
        files: 3,
        remote: 'origin',
        branch: 'master',
      })

      const text = formatProjectHistoryPrompt(tempDir)
      expect(text).toContain('Project auto-push history (.dsh/autopush-history.json):')
      expect(text).toContain('[a1b2c3d] (11.09.2026 10:00): Giriş ekranı tamamlandı')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('integrates project history into system prompt and records push upon success', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-autopush-test-'))
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt, { personaPrefix: '' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(AutoPushController, CONFIG)

      const session = ctx.sessions.create(undefined, { meta: { cwd: tempDir } })
      const agent = { session }

      // 1. Initial state: toggle OFF, no history -> prompt empty
      const promptInitial = renderPrompt(await ctx.systemPrompt.assemble({ agent } as never))
      expect(promptInitial).not.toContain('Auto-push is ON')
      expect(promptInitial).not.toContain('Project auto-push history')

      // 2. Enable toggle, still no project history -> shows POLICY only
      ctx.autoPush.set(session, true)
      const promptEnabledNoHistory = renderPrompt(await ctx.systemPrompt.assemble({ agent } as never))
      expect(promptEnabledNoHistory).toContain('Auto-push is ON for this session')
      expect(promptEnabledNoHistory).not.toContain('Project auto-push history')

      // 3. Perform a push -> should write .dsh/autopush-history.json
      internals.git = fakeGit({ status: result(0, ' M a.ts\n'), 'rev-parse': result(0, 'commit123\n') })
      const pushResult = await ctx.autoPush.push(session, 'özellik tamamlandı')
      expect(pushResult.pushed).toBe(true)

      const historyOnDisk = readProjectHistory(tempDir)
      expect(historyOnDisk?.records).toHaveLength(1)
      expect(historyOnDisk?.records[0]?.sha).toBe('commit123')
      expect(historyOnDisk?.records[0]?.message).toBe('özellik tamamlandı')

      // 4. While toggle is ON, prompt has BOTH policy and project history
      const promptWithHistory = renderPrompt(await ctx.systemPrompt.assemble({ agent } as never))
      expect(promptWithHistory).toContain('Auto-push is ON for this session')
      expect(promptWithHistory).toContain('Project auto-push history (.dsh/autopush-history.json):')
      expect(promptWithHistory).toContain('[commit123]')
      expect(promptWithHistory).toContain('özellik tamamlandı')

      // 5. If toggle is turned OFF, project history is still visible to the model!
      ctx.autoPush.set(session, false)
      const promptOffWithHistory = renderPrompt(await ctx.systemPrompt.assemble({ agent } as never))
      expect(promptOffWithHistory).not.toContain('Auto-push is ON for this session')
      expect(promptOffWithHistory).toContain('Project auto-push history (.dsh/autopush-history.json):')
      expect(promptOffWithHistory).toContain('[commit123]')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
