/**
 * Plan 10 §5.4 — DownloadManager against a fake DownloadConnection:
 * allowAndName arming, GUID→filename rename, the auto-name suffix loop,
 * explicit renameTo hard-errors, cancel/timeout outcomes, legacy Page.*
 * event fallback, and dispose rejecting a pending wait.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DownloadManager, type DownloadConnection } from '../src/download.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cdp-dl-'))
  roots.push(root)
  return root
}

function fakeConnection() {
  const listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>()
  const sent: Array<{ method: string, params: Record<string, unknown> | undefined }> = []
  const connection: DownloadConnection = {
    send: (method, params) => {
      sent.push({ method, params })
      return Promise.resolve({})
    },
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const remaining = (listeners.get(event) ?? []).filter(candidate => candidate !== listener)
        if (remaining.length === 0) listeners.delete(event)
        else listeners.set(event, remaining)
      }
    },
  }
  const emit = (event: string, params: Record<string, unknown>): void => {
    for (const listener of listeners.get(event) ?? []) listener(params)
  }
  const subscribed = (): string[] => [...listeners.keys()]
  return { connection, sent, emit, subscribed }
}

const tick = () => new Promise(resolve => { setTimeout(resolve, 0) })

function begin(emit: (event: string, params: Record<string, unknown>) => void, guid: string, name: string): void {
  emit('Browser.downloadWillBegin', { guid, url: `https://example.com/${name}`, suggestedFilename: name })
}

function progress(
  emit: (event: string, params: Record<string, unknown>) => void,
  guid: string,
  receivedBytes: number,
  state: string,
): void {
  emit('Browser.downloadProgress', { guid, receivedBytes, totalBytes: receivedBytes, state })
}

describe('plan10: DownloadManager', () => {
  it('subscribes both Browser.* and legacy Page.* download events at construction', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    new DownloadManager(fake.connection, root)
    expect(fake.subscribed()).toEqual(expect.arrayContaining([
      'Browser.downloadWillBegin',
      'Browser.downloadProgress',
      'Page.downloadWillBegin',
      'Page.downloadProgress',
    ]))
  })

  it('arms allowAndName and renames a GUID file to the suggested filename', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    const manager = new DownloadManager(fake.connection, root)

    const armPromise = manager.arm({ timeoutMs: 5000 })
    await tick()
    expect(fake.sent).toEqual([{
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allowAndName', downloadPath: root, eventsEnabled: true },
    }])

    begin(fake.emit, 'guid-1', 'report.pdf')
    await writeFile(join(root, 'guid-1'), 'hello')
    progress(fake.emit, 'guid-1', 5, 'in-progress')
    progress(fake.emit, 'guid-1', 5, 'completed')

    const outcome = await armPromise
    expect(outcome).toMatchObject({ ok: true, state: 'completed', guid: 'guid-1', path: 'report.pdf', bytes: 5 })
    expect(existsSync(join(root, 'report.pdf'))).toBe(true)
    expect(existsSync(join(root, 'guid-1'))).toBe(false)
    await manager.dispose()
  })

  it('takes a free suffix when the suggested filename already exists', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    const manager = new DownloadManager(fake.connection, root)
    await writeFile(join(root, 'report.pdf'), 'old')

    const armPromise = manager.arm({ timeoutMs: 5000 })
    await tick()
    begin(fake.emit, 'guid-2', 'report.pdf')
    await writeFile(join(root, 'guid-2'), 'new')
    progress(fake.emit, 'guid-2', 3, 'completed')

    const outcome = await armPromise
    expect(outcome.ok).toBe(true)
    expect(outcome.path).toBe('report (1).pdf')
    await manager.dispose()
  })

  it('hard-errors when an explicit renameTo is already occupied', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    const manager = new DownloadManager(fake.connection, root)
    await writeFile(join(root, 'chosen.pdf'), 'taken')

    const armPromise = manager.arm({ timeoutMs: 5000, renameTo: 'chosen.pdf' })
    await tick()
    begin(fake.emit, 'guid-3', 'other.pdf')
    await writeFile(join(root, 'guid-3'), 'payload')
    progress(fake.emit, 'guid-3', 7, 'completed')

    const outcome = await armPromise
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('cdp: destination exists:')
    expect((await import('node:fs')).readFileSync(join(root, 'chosen.pdf'), 'utf8')).toBe('taken')
    await manager.dispose()
  })

  it('rejects a renameTo that escapes the root before waiting', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    const manager = new DownloadManager(fake.connection, root)
    await expect(manager.arm({ timeoutMs: 100, renameTo: '../evil.pdf' })).rejects.toThrow('cdp: invalid filename')
    await manager.dispose()
  })

  it('resolves ok:false with the cancel reason when the download is canceled', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    const manager = new DownloadManager(fake.connection, root)

    const armPromise = manager.arm({ timeoutMs: 5000 })
    await tick()
    begin(fake.emit, 'guid-4', 'gone.pdf')
    progress(fake.emit, 'guid-4', 1, 'canceled')

    const outcome = await armPromise
    expect(outcome.ok).toBe(false)
    expect(outcome.state).toBe('canceled')
    expect(outcome.error).toContain('canceled')
    await manager.dispose()
  })

  it('rejects with the start timeout when no download begins', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    const manager = new DownloadManager(fake.connection, root)
    await expect(manager.arm({ timeoutMs: 40 })).rejects.toThrow('cdp: download: no download began within 40ms')
    await manager.dispose()
  })

  it('refuses a second concurrent wait', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    const manager = new DownloadManager(fake.connection, root)
    const first = manager.arm({ timeoutMs: 5000 })
    await tick()
    await expect(manager.arm({ timeoutMs: 5000 })).rejects.toThrow(
      'cdp: download: another download wait is already active',
    )
    await manager.dispose()
    await expect(first).rejects.toThrow('interrupted')
  })

  it('dispose rejects a pending wait and is idempotent', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    const manager = new DownloadManager(fake.connection, root)
    const pending = manager.arm({ timeoutMs: 5000 })
    await tick()
    await manager.dispose()
    await manager.dispose()
    await expect(pending).rejects.toThrow('cdp: download: interrupted — the service stopped')
    await expect(manager.arm()).rejects.toThrow('cdp: download: manager disposed')
    expect(fake.subscribed()).toHaveLength(0)
  })

  it('completes from the legacy Page.* event fallback', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    const manager = new DownloadManager(fake.connection, root)

    const armPromise = manager.arm({ timeoutMs: 5000 })
    await tick()
    fake.emit('Page.downloadWillBegin', { guid: 'guid-5', url: 'https://example.com/legacy.bin', suggestedFilename: 'legacy.bin' })
    await writeFile(join(root, 'guid-5'), 'legacy')
    fake.emit('Page.downloadProgress', { guid: 'guid-5', receivedBytes: 6, totalBytes: 6, state: 'completed' })

    const outcome = await armPromise
    expect(outcome.ok).toBe(true)
    expect(outcome.path).toBe('legacy.bin')
    await manager.dispose()
  })

  it('keeps receivedBytes monotonic and orders status newest first', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    const manager = new DownloadManager(fake.connection, root)

    const armPromise = manager.arm({ timeoutMs: 5000 })
    await tick()
    begin(fake.emit, 'guid-6', 'mono.txt')
    await writeFile(join(root, 'guid-6'), 'x'.repeat(10))
    progress(fake.emit, 'guid-6', 10, 'in-progress')
    progress(fake.emit, 'guid-6', 3, 'in-progress') // regression must not shrink
    progress(fake.emit, 'guid-6', 3, 'completed')
    const outcome = await armPromise
    expect(outcome.bytes).toBe(10)

    begin(fake.emit, 'guid-7', 'newer.txt')
    const statuses = manager.status()
    expect(statuses[0]?.guid).toBe('guid-7')
    expect(statuses[0]?.state).toBe('in-progress')
    await manager.dispose()
  })

  it('reports a completion whose file never landed as an error outcome', async () => {
    const root = await makeRoot()
    const fake = fakeConnection()
    const manager = new DownloadManager(fake.connection, root)

    const armPromise = manager.arm({ timeoutMs: 5000 })
    await tick()
    begin(fake.emit, 'guid-8', 'phantom.pdf')
    progress(fake.emit, 'guid-8', 0, 'completed') // no file on disk

    const outcome = await armPromise
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('completed file not found')
    await manager.dispose()
  })
})
