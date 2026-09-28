/**
 * `TargetRegistry` behavior over an in-process fake connection: target listing,
 * attachment bookkeeping, tab-list maintenance from the `Target` lifecycle
 * events, and every documented refusal. No socket, browser, or port is used.
 */

import { describe, expect, it } from 'vitest'
import { CdpTargetError, TargetRegistry, type TargetConnection, type TargetInfo } from '../src/targets.ts'

/** One command the fake connection was asked to send. */
interface SentCommand {
  method: string
  params: Record<string, unknown> | undefined
}

/** In-process stand-in for the CDP connection: records commands, answers from a reply table, emits events. */
interface FakeConnection {
  connection: TargetConnection
  sent: SentCommand[]
  reply(method: string, value: unknown): void
  fail(method: string, error: Error): void
  emit(event: string, params: unknown): void
}

/** Build one fake connection. */
function makeConnection(): FakeConnection {
  const sent: SentCommand[] = []
  const replies = new Map<string, () => Promise<unknown>>()
  const listeners = new Map<string, Array<(params: unknown) => void>>()
  return {
    connection: {
      send: (method, params) => {
        sent.push({ method, params })
        const reply = replies.get(method)
        if (reply === undefined) return Promise.reject(new Error(`no canned reply for ${method}`))
        return reply()
      },
      on: (event, listener) => {
        const registered = listeners.get(event) ?? []
        registered.push(listener)
        listeners.set(event, registered)
        return () => {
          const index = registered.indexOf(listener)
          if (index !== -1) registered.splice(index, 1)
        }
      },
    },
    sent,
    reply: (method, value) => { replies.set(method, () => Promise.resolve(value)) },
    fail: (method, error) => { replies.set(method, () => Promise.reject(error)) },
    emit: (event, params) => { for (const listener of listeners.get(event) ?? []) listener(params) },
  }
}

/** Build one complete `TargetInfo` a browser reply could carry. */
function target(targetId: string, overrides: Partial<TargetInfo> = {}): TargetInfo {
  return { targetId, type: 'page', title: targetId, url: `https://${targetId}.test/`, attached: false, ...overrides }
}

describe('TargetRegistry', () => {
  it('lists the browser targets and tracks them in reply order', async () => {
    const fake = makeConnection()
    fake.reply('Target.getTargets', { targetInfos: [target('a'), target('b')] })
    const registry = new TargetRegistry(fake.connection)

    await expect(registry.list()).resolves.toEqual([target('a'), target('b')])
    expect(registry.targets().map(entry => entry.targetId)).toEqual(['a', 'b'])
    expect(registry.find('a')).toEqual(target('a'))
    expect(registry.find('missing')).toBeUndefined()
    expect(registry.active()).toBeUndefined()
    expect(fake.sent).toEqual([{ method: 'Target.getTargets', params: {} }])
  })

  it('replaces the tracked list and keeps only a still-listed active tab', async () => {
    const fake = makeConnection()
    const registry = new TargetRegistry(fake.connection)
    fake.reply('Target.getTargets', { targetInfos: [target('a'), target('b')] })
    await registry.list()
    registry.setActive('b')
    expect(registry.active()).toEqual(target('b'))

    fake.reply('Target.getTargets', { targetInfos: [target('b'), target('c')] })
    await registry.list()
    expect(registry.targets().map(entry => entry.targetId)).toEqual(['b', 'c'])
    expect(registry.active()).toEqual(target('b'))

    fake.reply('Target.getTargets', { targetInfos: [target('c')] })
    await registry.list()
    expect(registry.active()).toBeUndefined()
  })

  it('refuses a getTargets reply that is not a target list', async () => {
    for (const value of [undefined, 42, {}, { targetInfos: {} }]) {
      const fake = makeConnection()
      fake.reply('Target.getTargets', value)
      const registry = new TargetRegistry(fake.connection)
      await expect(registry.list()).rejects.toBeInstanceOf(CdpTargetError)
    }
  })

  it('refuses a getTargets entry missing a required field', async () => {
    const badEntries: unknown[] = [
      null,
      { ...target('x'), targetId: '' },
      { ...target('x'), type: 7 },
      { ...target('x'), title: 7 },
      { ...target('x'), url: 7 },
      { ...target('x'), attached: 'true' },
    ]
    for (const entry of badEntries) {
      const fake = makeConnection()
      fake.reply('Target.getTargets', { targetInfos: [entry] })
      const registry = new TargetRegistry(fake.connection)
      await expect(registry.list()).rejects.toBeInstanceOf(CdpTargetError)
    }
  })

  it('refuses a target list past the tracked bound', async () => {
    const fake = makeConnection()
    fake.reply('Target.getTargets', { targetInfos: Array.from({ length: 513 }, (_, index) => target(`t${index}`)) })
    const registry = new TargetRegistry(fake.connection)
    await expect(registry.list()).rejects.toBeInstanceOf(CdpTargetError)
  })

  it('refuses to activate a target it does not track', () => {
    const registry = new TargetRegistry(makeConnection().connection)
    expect(() => { registry.setActive('missing') }).toThrow(CdpTargetError)
  })

  it('attaches through a flattened session and reuses it for a second attach', async () => {
    const fake = makeConnection()
    fake.reply('Target.attachToTarget', { sessionId: 'session-1' })
    const registry = new TargetRegistry(fake.connection)

    await expect(registry.attach('a')).resolves.toBe('session-1')
    await expect(registry.attach('a')).resolves.toBe('session-1')
    expect(fake.sent).toEqual([{ method: 'Target.attachToTarget', params: { targetId: 'a', flatten: true } }])
    expect(registry.attachedSession('a')).toBe('session-1')
    expect(registry.attachedSession('b')).toBeUndefined()
  })

  it('refuses an attach reply without a session id', async () => {
    for (const value of [undefined, {}, { sessionId: 7 }, { sessionId: '' }]) {
      const fake = makeConnection()
      fake.reply('Target.attachToTarget', value)
      const registry = new TargetRegistry(fake.connection)
      await expect(registry.attach('a')).rejects.toBeInstanceOf(CdpTargetError)
    }
  })

  it('detaches a tracked session and forgets its bookkeeping', async () => {
    const fake = makeConnection()
    fake.reply('Target.attachToTarget', { sessionId: 'session-1' })
    fake.reply('Target.detachFromTarget', {})
    const registry = new TargetRegistry(fake.connection)

    await registry.attach('a')
    await expect(registry.detach('session-1')).resolves.toBeUndefined()
    expect(fake.sent.map(command => command.method)).toEqual(['Target.attachToTarget', 'Target.detachFromTarget'])
    expect(fake.sent[1]?.params).toEqual({ sessionId: 'session-1' })
    expect(registry.attachedSession('a')).toBeUndefined()
    await expect(registry.detach('session-1')).rejects.toBeInstanceOf(CdpTargetError)
  })

  it('refuses to detach a session it never attached', async () => {
    const fake = makeConnection()
    const registry = new TargetRegistry(fake.connection)
    await expect(registry.detach('nope')).rejects.toBeInstanceOf(CdpTargetError)
    expect(fake.sent).toEqual([])
  })

  it('forgets a closed target only when the browser reports success', async () => {
    const fake = makeConnection()
    fake.reply('Target.getTargets', { targetInfos: [target('a'), target('b')] })
    fake.reply('Target.attachToTarget', { sessionId: 'session-1' })
    const registry = new TargetRegistry(fake.connection)
    await registry.list()
    registry.setActive('a')
    await registry.attach('a')

    fake.reply('Target.closeTarget', { success: false })
    await expect(registry.close('a')).resolves.toBe(false)
    expect(registry.find('a')).toEqual(target('a'))
    expect(registry.attachedSession('a')).toBe('session-1')
    expect(registry.active()).toEqual(target('a'))

    fake.reply('Target.closeTarget', { success: true })
    await expect(registry.close('a')).resolves.toBe(true)
    expect(registry.find('a')).toBeUndefined()
    expect(registry.attachedSession('a')).toBeUndefined()
    expect(registry.active()).toBeUndefined()

    // A target with no attachment never clears the (already cleared) selection.
    await expect(registry.close('b')).resolves.toBe(true)
    expect(registry.targets()).toEqual([])
  })

  it('refuses a closeTarget reply without a boolean success', async () => {
    for (const value of [undefined, {}, { success: 'yes' }]) {
      const fake = makeConnection()
      fake.reply('Target.closeTarget', value)
      const registry = new TargetRegistry(fake.connection)
      await expect(registry.close('a')).rejects.toBeInstanceOf(CdpTargetError)
    }
  })

  it('maintains the tab list from target lifecycle events', () => {
    const fake = makeConnection()
    const registry = new TargetRegistry(fake.connection)

    fake.emit('Target.targetCreated', { targetInfo: target('a') })
    fake.emit('Target.targetInfoChanged', { targetInfo: target('a', { title: 'Renamed', url: 'https://a.test/next' }) })
    fake.emit('Target.targetCreated', { targetInfo: target('b') })
    expect(registry.targets()).toEqual([
      target('a', { title: 'Renamed', url: 'https://a.test/next' }),
      target('b'),
    ])

    fake.emit('Target.targetDestroyed', { targetId: 'a' })
    expect(registry.targets()).toEqual([target('b')])

    // A change for a target the registry has not listed still joins the list.
    fake.emit('Target.targetInfoChanged', { targetInfo: target('c') })
    expect(registry.targets()).toEqual([target('b'), target('c')])
  })

  it('ignores a lifecycle event without the fields it reads', () => {
    const fake = makeConnection()
    const registry = new TargetRegistry(fake.connection)
    fake.emit('Target.targetCreated', { targetInfo: target('a') })

    fake.emit('Target.targetCreated', null)
    fake.emit('Target.targetInfoChanged', {})
    fake.emit('Target.targetDestroyed', null)
    fake.emit('Target.targetDestroyed', { targetId: '' })
    fake.emit('Target.detachedFromTarget', null)
    fake.emit('Target.detachedFromTarget', { sessionId: '' })
    fake.emit('Target.detachedFromTarget', { sessionId: 'unknown-session' })

    expect(registry.targets()).toEqual([target('a')])
    expect(registry.attachedSession('a')).toBeUndefined()
  })

  it('drops an attachment when the browser detaches its session', async () => {
    const fake = makeConnection()
    fake.reply('Target.attachToTarget', { sessionId: 'session-1' })
    const registry = new TargetRegistry(fake.connection)
    await registry.attach('a')

    fake.emit('Target.detachedFromTarget', { sessionId: 'session-1' })
    expect(registry.attachedSession('a')).toBeUndefined()

    // The forgotten session is refused as any other unknown session.
    await expect(registry.detach('session-1')).rejects.toBeInstanceOf(CdpTargetError)
  })

  it('stops tracking and refuses commands after dispose', async () => {
    const fake = makeConnection()
    fake.reply('Target.getTargets', { targetInfos: [target('a')] })
    const registry = new TargetRegistry(fake.connection)
    await registry.list()

    registry.dispose()
    registry.dispose()
    expect(registry.targets()).toEqual([])
    expect(registry.active()).toBeUndefined()
    fake.emit('Target.targetCreated', { targetInfo: target('b') })
    expect(registry.targets()).toEqual([])

    await expect(registry.list()).rejects.toThrow('TargetRegistry is disposed')
    await expect(registry.attach('a')).rejects.toBeInstanceOf(CdpTargetError)
    await expect(registry.detach('session-1')).rejects.toBeInstanceOf(CdpTargetError)
    await expect(registry.close('a')).rejects.toBeInstanceOf(CdpTargetError)
    expect(() => { registry.setActive('a') }).toThrow(CdpTargetError)
    expect(fake.sent).toHaveLength(1)
  })

  it('propagates a protocol error from the connection', async () => {
    const fake = makeConnection()
    fake.fail('Target.getTargets', new Error('cdp: -32601 method not found'))
    const registry = new TargetRegistry(fake.connection)
    await expect(registry.list()).rejects.toThrow('cdp: -32601 method not found')
  })
})
