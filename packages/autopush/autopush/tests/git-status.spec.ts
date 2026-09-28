/**
 * Tests for Git workspace inspection and uninitialized repository auto-push policy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AutoPushController, {
  formatNoRemoteGitPolicy,
  formatUninitializedGitPolicy,
  inspectGitWorkspace,
  READY_POLICY,
} from '../src/index.ts'

const CONFIG = { remote: 'origin', branch: 'master' }

describe('inspectGitWorkspace', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-git-status-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns uninitialized when .git does not exist', () => {
    expect(inspectGitWorkspace(tempDir, 'origin')).toBe('uninitialized')
  })

  it('returns no-remote when .git exists as a directory but has no config file', () => {
    mkdirSync(join(tempDir, '.git'))
    expect(inspectGitWorkspace(tempDir, 'origin')).toBe('no-remote')
  })

  it('returns no-remote when .git/config exists but lacks the specified remote', () => {
    mkdirSync(join(tempDir, '.git'))
    writeFileSync(join(tempDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8')
    expect(inspectGitWorkspace(tempDir, 'origin')).toBe('no-remote')
  })

  it('returns ready when .git/config contains the specified remote', () => {
    mkdirSync(join(tempDir, '.git'))
    const configContent = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = https://github.com/example/repo.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
`
    writeFileSync(join(tempDir, '.git', 'config'), configContent, 'utf8')
    expect(inspectGitWorkspace(tempDir, 'origin')).toBe('ready')
  })

  it('respects a custom remote name', () => {
    mkdirSync(join(tempDir, '.git'))
    const configContent = `[remote "upstream"]
\turl = https://github.com/example/repo.git
`
    writeFileSync(join(tempDir, '.git', 'config'), configContent, 'utf8')
    expect(inspectGitWorkspace(tempDir, 'origin')).toBe('no-remote')
    expect(inspectGitWorkspace(tempDir, 'upstream')).toBe('ready')
  })

  it('resolves worktree or submodule .git files with gitdir pointers', () => {
    const realGitDir = join(tempDir, 'real-git-dir')
    mkdirSync(realGitDir)
    writeFileSync(join(realGitDir, 'config'), '[remote "origin"]\n\turl = test\n', 'utf8')

    const worktreeDir = join(tempDir, 'worktree')
    mkdirSync(worktreeDir)
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${realGitDir}\n`, 'utf8')

    expect(inspectGitWorkspace(worktreeDir, 'origin')).toBe('ready')
  })
})

describe('uninitialized repository auto-push prompt policy', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-git-policy-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('renders uninitialized git policy when .git is absent and auto-push is on', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AutoPushController, CONFIG)

    const session = ctx.sessions.create(undefined, { meta: { cwd: tempDir } })
    const agent = { session }

    // Toggle OFF -> no policy
    const promptOff = renderPrompt(await ctx.systemPrompt.assemble({ agent } as never))
    expect(promptOff).not.toContain('Auto-push is ON')

    // Toggle ON -> uninitialized policy
    ctx.autoPush.set(session, true)
    const promptOn = renderPrompt(await ctx.systemPrompt.assemble({ agent } as never))
    expect(promptOn).toContain('Auto-push is ON for this session, but this workspace is NOT a Git repository yet')
    expect(promptOn).toContain('ask_user_question')
    expect(promptOn).toContain('Direkt Pushla (Model Başlığı Belirlesin)')
    expect(promptOn).toContain('gh repo create')
  })

  it('renders no-remote policy when .git exists without remote', async () => {
    mkdirSync(join(tempDir, '.git'))
    writeFileSync(join(tempDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AutoPushController, CONFIG)

    const session = ctx.sessions.create(undefined, { meta: { cwd: tempDir } })
    const agent = { session }

    ctx.autoPush.set(session, true)
    const promptOn = renderPrompt(await ctx.systemPrompt.assemble({ agent } as never))
    expect(promptOn).toContain('Auto-push is ON for this session, but the Git repository has no `origin` remote configured')
    expect(promptOn).toContain('ask_user_question')
  })

  it('renders standard ready policy when .git and remote are present', async () => {
    mkdirSync(join(tempDir, '.git'))
    writeFileSync(join(tempDir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:org/repo.git\n', 'utf8')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AutoPushController, CONFIG)

    const session = ctx.sessions.create(undefined, { meta: { cwd: tempDir } })
    const agent = { session }

    ctx.autoPush.set(session, true)
    const promptOn = renderPrompt(await ctx.systemPrompt.assemble({ agent } as never))
    expect(promptOn).toContain('Auto-push is ON for this session. When you have actually finished the request')
    expect(promptOn).not.toContain('NOT a Git repository yet')
  })

  it('format helpers produce non-empty policy strings', () => {
    expect(formatUninitializedGitPolicy('origin', 'master')).toContain('github_repo_setup')
    expect(formatNoRemoteGitPolicy('origin', 'master')).toContain('github_remote_setup')
    expect(READY_POLICY).toContain('push_changes')
  })
})
