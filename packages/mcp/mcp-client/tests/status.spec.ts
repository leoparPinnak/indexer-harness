import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  McpStatusRegistry,
  appendStatusLog,
  mcpStatusRegistry,
  resolveStatusLogPath,
  type McpStatus,
} from '@deepseek-ai/dsh-mcp-client/src/status.ts'

function status(overrides: Partial<McpStatus> = {}): McpStatus {
  return {
    serverName: 'rea',
    scope: 'global',
    state: 'connecting',
    at: 1_000,
    toolCount: 0,
    toolNames: [],
    ...overrides,
  }
}

describe('McpStatusRegistry', () => {
  it('records one entry per (scope, serverName) and lists them stably', () => {
    const registry = new McpStatusRegistry()
    registry.record(status({ state: 'connecting' }))
    registry.record(status({ serverName: 'web', state: 'connected', toolCount: 2, toolNames: ['mcp__web__a', 'mcp__web__b'] }))
    registry.record(status({ scope: 'preset', state: 'connected', toolCount: 1, toolNames: ['mcp__rea__a'] }))

    const listed = registry.list()
    expect(listed.map((entry) => [entry.scope, entry.serverName])).toEqual([
      ['global', 'rea'],
      ['global', 'web'],
      ['preset', 'rea'],
    ])
  })

  it('replaces the entry when the same instance records again', () => {
    const registry = new McpStatusRegistry()
    registry.record(status({ state: 'connecting' }))
    registry.record(status({ state: 'connected', toolCount: 1, toolNames: ['mcp__rea__a'] }))

    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.state).toBe('connected')
    expect(registry.list()[0]?.toolCount).toBe(1)
  })

  it('notifies subscribers with the sorted snapshot on record and remove', () => {
    const registry = new McpStatusRegistry()
    const seen: Array<readonly McpStatus[]> = []
    const unsubscribe = registry.subscribe((snapshot) => void seen.push(snapshot))

    registry.record(status({ serverName: 'web' }))
    registry.record(status())
    registry.remove('global', 'web')
    unsubscribe()
    registry.record(status({ state: 'stopped' }))

    expect(seen.map((snapshot) => snapshot.map((entry) => entry.serverName))).toEqual([
      ['web'],
      ['rea', 'web'],
      ['rea'],
    ])
  })

  it('removing an absent entry notifies nobody', () => {
    const registry = new McpStatusRegistry()
    let notifications = 0
    registry.subscribe(() => void (notifications += 1))

    registry.remove('global', 'missing')

    expect(notifications).toBe(0)
  })

  it('clear drops entries and unsubscribes every listener', () => {
    const registry = new McpStatusRegistry()
    let notifications = 0
    registry.subscribe(() => void (notifications += 1))
    registry.record(status())
    expect(notifications).toBe(1)

    registry.clear()
    registry.record(status())

    expect(registry.list()).toHaveLength(1)
    expect(notifications).toBe(1)
  })
})

describe('resolveStatusLogPath', () => {
  const savedHome = process.env.DSH_HOME

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  })

  it('resolves the configured path against the working directory', () => {
    expect(resolveStatusLogPath('logs/custom.jsonl')).toBe(path.resolve('logs/custom.jsonl'))
  })

  it('keeps file logging off until a path is configured', () => {
    process.env.DSH_HOME = '/harness-home'
    expect(resolveStatusLogPath(undefined)).toBeUndefined()
    expect(resolveStatusLogPath('')).toBeUndefined()
  })
})

describe('appendStatusLog', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'dsh-mcp-status-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('creates the log directory and appends one JSON line per transition', () => {
    const logPath = path.join(directory, 'nested', 'mcp-status.jsonl')

    expect(appendStatusLog(logPath, status())).toBe(true)
    expect(appendStatusLog(logPath, status({ state: 'connected', toolCount: 1, toolNames: ['mcp__rea__a'] }))).toBe(true)

    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ serverName: 'rea', state: 'connecting' })
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ state: 'connected', toolNames: ['mcp__rea__a'] })
    expect(existsSync(path.dirname(logPath))).toBe(true)
  })

  it('reports false instead of throwing when the filesystem refuses the write', () => {
    const blocker = path.join(directory, 'blocker')
    writeFileSync(blocker, 'not a directory')

    expect(appendStatusLog(path.join(blocker, 'child', 'log.jsonl'), status())).toBe(false)
  })
})

describe('mcpStatusRegistry', () => {
  it('is the process-wide registry shared by mcp-client instances', () => {
    expect(mcpStatusRegistry).toBeInstanceOf(McpStatusRegistry)
  })
})