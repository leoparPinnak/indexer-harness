/**
 * plan05 upload tests: the host path policy (absolute/disk/roots/escape
 * hatch, separator-boundary comparison), the DOM bind sequence with its
 * read-back verification (selector mode and open-chooser mode), and
 * `CdpService.upload` end-to-end over a stubbed connection — validation
 * codes, the structured dialog-open refusal, chooser timeout, and the
 * happy-path evidence. Temp files only; no socket or browser.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CdpTimeoutError, PageSession, type PageConnection } from '../src/page.ts'
import {
  DEFAULT_MAX_UPLOAD_FILES,
  bindFileInput,
  bindFilePickerFiles,
  readAttribute,
  validateUploadPath,
  type UploadPolicy,
  type UploadSender,
} from '../src/upload.ts'
import { CdpService } from '../src/service.ts'

/** Temp roots this spec created, removed after all cases. */
const roots: string[] = []

/** Create one temp directory registered for cleanup. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cdp-plan05-'))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {})
})

describe('plan05: validateUploadPath policy', () => {
  it('rejects empty and relative paths before touching the disk', async () => {
    const root = await makeRoot()
    const policy: UploadPolicy = { roots: [root], allowAnyPath: false }

    const empty = await validateUploadPath('', policy)
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.code).toBe('file-not-found')

    const relative = await validateUploadPath('a.txt', policy)
    expect(relative.ok).toBe(false)
    if (!relative.ok) {
      expect(relative.code).toBe('path-not-absolute')
      expect(relative.message).toContain('absolute')
    }
  })

  it('reports missing paths and directories as file-not-found', async () => {
    const root = await makeRoot()
    const policy: UploadPolicy = { roots: [root], allowAnyPath: false }

    const missing = await validateUploadPath(join(root, 'nope.txt'), policy)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('file-not-found')

    await mkdir(join(root, 'adir'))
    const directory = await validateUploadPath(join(root, 'adir'), policy)
    expect(directory.ok).toBe(false)
    if (!directory.ok) {
      expect(directory.code).toBe('file-not-found')
      expect(directory.message).toContain('not a regular file')
    }
  })

  it('accepts a file inside a root and returns its realpath brief', async () => {
    const root = await makeRoot()
    const file = join(root, 'hello.txt')
    await writeFile(file, 'hello')
    const policy: UploadPolicy = { roots: [root], allowAnyPath: false }

    const checked = await validateUploadPath(file, policy)
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      expect(checked.file.name).toBe('hello.txt')
      expect(checked.file.size).toBe(5)
      expect(checked.file.path.endsWith(`${sep}hello.txt`)).toBe(true)
    }
  })

  it('forbids paths outside every root, including prefix-sibling roots', async () => {
    const root = await makeRoot()
    const policy: UploadPolicy = { roots: [root], allowAnyPath: false }

    const outside = await makeRoot()
    const outsideFile = join(outside, 'secret.txt')
    await writeFile(outsideFile, 'x')
    const forbidden = await validateUploadPath(outsideFile, policy)
    expect(forbidden.ok).toBe(false)
    if (!forbidden.ok) {
      expect(forbidden.code).toBe('path-forbidden')
      expect(forbidden.message).toContain('outside every allowed root')
    }

    // The separator boundary: `<root>2` shares root's character prefix but is
    // NOT under `root`, so `real.startsWith(root)` alone would wrongly allow it.
    const sibling = `${root}2`
    await mkdir(sibling)
    roots.push(sibling)
    const siblingFile = join(sibling, 'trick.txt')
    await writeFile(siblingFile, 'x')
    const siblingChecked = await validateUploadPath(siblingFile, policy)
    expect(siblingChecked.ok).toBe(false)
    if (!siblingChecked.ok) expect(siblingChecked.code).toBe('path-forbidden')
  })

  it('honors the allowAnyPath escape hatch', async () => {
    const root = await makeRoot()
    const elsewhere = await makeRoot()
    const file = join(elsewhere, 'any.txt')
    await writeFile(file, 'x')

    const checked = await validateUploadPath(file, { roots: [root], allowAnyPath: true })
    expect(checked.ok).toBe(true)
    if (checked.ok) expect(checked.file.name).toBe('any.txt')
  })
})

describe('plan05: readAttribute', () => {
  it('walks the alternating name/value pairs', () => {
    const attrs = ['type', 'file', 'multiple', '', 'accept', '.txt']
    expect(readAttribute(attrs, 'type')).toBe('file')
    expect(readAttribute(attrs, 'multiple')).toBe('')
    expect(readAttribute(attrs, 'accept')).toBe('.txt')
    expect(readAttribute(attrs, 'missing')).toBeUndefined()
    // Odd dangling value must not pair with a following name.
    expect(readAttribute(['only-name'], 'only-name')).toBeUndefined()
  })
})

/** Scripted sender: answers from a table and records every call in order. */
function scriptedSender(handlers: Record<string, unknown>): { send: UploadSender; calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const send: UploadSender = async (method, params) => {
    calls.push({ method, params })
    const value = handlers[method]
    if (value === undefined) throw new Error(`no scripted reply for ${method}`)
    return typeof value === 'function' ? (value as () => unknown)() : value
  }
  return { send, calls }
}

/** The happy-path DOM script for `count` files bound to node 42. */
function happyScript(count: number, attributes: string[] = ['type', 'file', 'multiple', '', 'accept', '.txt']): Record<string, unknown> {
  return {
    'DOM.enable': {},
    'DOM.getDocument': { root: { nodeId: 1 } },
    'DOM.querySelector': { nodeId: 42 },
    'DOM.describeNode': { node: { nodeName: 'INPUT' } },
    'DOM.getAttributes': { attributes },
    'DOM.setFileInputFiles': {},
    'DOM.resolveNode': { object: { objectId: 'obj-1' } },
    'Runtime.callFunctionOn': { result: { value: Array.from({ length: count }, (_, i) => `f${i}.txt`) } },
  }
}

describe('plan05: bindFileInput selector mode', () => {
  it('binds through the full DOM chain and returns read-back evidence', async () => {
    const { send, calls } = scriptedSender(happyScript(1))
    const outcome = await bindFileInput({
      selector: '#file',
      files: [{ path: 'C:\\data\\a.txt', name: 'a.txt', size: 3 }],
      send,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.input).toEqual({
        tag: 'input',
        multiple: true,
        verified: true,
        fileList: ['f0.txt'],
        accept: '.txt',
      })
    }
    expect(calls.map(row => row.method)).toEqual([
      'DOM.enable',
      'DOM.getDocument',
      'DOM.querySelector',
      'DOM.describeNode',
      'DOM.getAttributes',
      'DOM.setFileInputFiles',
      'DOM.resolveNode',
      'Runtime.callFunctionOn',
    ])
    expect(calls[1]?.params).toEqual({ depth: 0 })
    expect(calls[5]?.params).toEqual({ files: ['C:\\data\\a.txt'], nodeId: 42 })
    expect(calls[2]?.params).toEqual({ nodeId: 1, selector: '#file' })
  })

  it('reports no-input when nothing matches and never sets files', async () => {
    const { send, calls } = scriptedSender({
      ...happyScript(1),
      'DOM.querySelector': { nodeId: 0 },
    })
    const outcome = await bindFileInput({ selector: '#ghost', files: [{ path: '/x', name: 'x', size: 1 }], send })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('no-input')
      expect(outcome.message).toContain('#ghost')
    }
    expect(calls.some(row => row.method === 'DOM.setFileInputFiles')).toBe(false)
  })

  it('refuses elements that are not file inputs', async () => {
    const wrongTag = await bindFileInput({
      selector: '#div',
      files: [{ path: '/x', name: 'x', size: 1 }],
      send: scriptedSender({ ...happyScript(1), 'DOM.describeNode': { node: { nodeName: 'DIV' } } }).send,
    })
    expect(wrongTag.ok).toBe(false)
    if (!wrongTag.ok) expect(wrongTag.code).toBe('not-file-input')

    const wrongType = await bindFileInput({
      selector: '#text',
      files: [{ path: '/x', name: 'x', size: 1 }],
      send: scriptedSender({ ...happyScript(1), 'DOM.getAttributes': { attributes: ['type', 'text'] } }).send,
    })
    expect(wrongType.ok).toBe(false)
    if (!wrongType.ok) {
      expect(wrongType.code).toBe('not-file-input')
      expect(wrongType.message).toContain('type="text"')
    }
  })

  it('refuses multiple files on a single-file input', async () => {
    const { send, calls } = scriptedSender(happyScript(2, ['type', 'file', 'accept', '.txt']))
    const outcome = await bindFileInput({
      selector: '#file',
      files: [
        { path: '/x/1', name: '1', size: 1 },
        { path: '/x/2', name: '2', size: 1 },
      ],
      send,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('too-many-files')
    expect(calls.some(row => row.method === 'DOM.setFileInputFiles')).toBe(false)
  })

  it('treats a read-back mismatch as verify-failed with counts', async () => {
    const { send } = scriptedSender({ ...happyScript(1), 'Runtime.callFunctionOn': { result: { value: [] } } })
    const outcome = await bindFileInput({ selector: '#file', files: [{ path: '/x', name: 'x', size: 1 }], send })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('verify-failed')
      expect(outcome.message).toContain('expected 1')
    }
  })

  it('maps protocol failures to dom-error instead of throwing', async () => {
    const broken = scriptedSender(happyScript(1))
    const send: UploadSender = async (method, params) => {
      if (method === 'DOM.getDocument') throw new Error('Protocol error')
      return await broken.send(method, params)
    }
    const outcome = await bindFileInput({ selector: '#file', files: [{ path: '/x', name: 'x', size: 1 }], send })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('dom-error')
      expect(outcome.message).toContain('Protocol error')
    }

    const noRoot = await bindFileInput({
      selector: '#file',
      files: [{ path: '/x', name: 'x', size: 1 }],
      send: scriptedSender({ ...happyScript(1), 'DOM.getDocument': {} }).send,
    })
    expect(noRoot.ok).toBe(false)
    if (!noRoot.ok) expect(noRoot.code).toBe('dom-error')
  })
})

describe('plan05: bindFilePickerFiles chooser mode', () => {
  it('refuses before sending when the chooser carries no backend node', async () => {
    const { send, calls } = scriptedSender(happyScript(1))
    const outcome = await bindFilePickerFiles({ mode: 'selectSingle', backendNodeId: undefined, files: [{ path: '/x', name: 'x', size: 1 }], send })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('no-input')
    expect(calls).toHaveLength(0)
  })

  it('refuses a multi-file request on a selectSingle chooser before sending', async () => {
    const { send, calls } = scriptedSender(happyScript(2))
    const outcome = await bindFilePickerFiles({
      mode: 'selectSingle',
      backendNodeId: 9,
      files: [
        { path: '/x/1', name: '1', size: 1 },
        { path: '/x/2', name: '2', size: 1 },
      ],
      send,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('too-many-files')
    expect(calls).toHaveLength(0)
  })

  it('binds into an open chooser addressed by backendNodeId', async () => {
    const { send, calls } = scriptedSender(happyScript(1, ['type', 'file', 'accept', '.pdf']))
    const outcome = await bindFilePickerFiles({ mode: 'selectMultiple', backendNodeId: 9, files: [{ path: '/x/a.pdf', name: 'a.pdf', size: 2 }], send })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.input).toEqual({
        tag: 'input',
        multiple: true,
        verified: true,
        fileList: ['f0.txt'],
        accept: '.pdf',
      })
    }
    expect(calls.map(row => row.method)).toEqual([
      'DOM.describeNode',
      'DOM.getAttributes',
      'DOM.setFileInputFiles',
      'DOM.resolveNode',
      'Runtime.callFunctionOn',
    ])
    expect(calls[2]?.params).toEqual({ files: ['/x/a.pdf'], backendNodeId: 9 })
    expect(calls[0]?.params).toEqual({ backendNodeId: 9 })
  })
})

/** Minimal TargetInfo the stub registry reports. */
interface StubTarget {
  targetId: string
  type: string
  title: string
  url: string
}

/** Service internals the tests inject directly (private fields by cast). */
interface ServiceInternals {
  connection: unknown
  registry: unknown
  sessions: Map<string, unknown>
}

const SESSION = 'session-1'

/**
 * Build a CdpService whose single target T1 is a real PageSession on a fake
 * event connection, while service commands go through the scripted `send`.
 */
function makeUploadService(script: Record<string, unknown>): {
  service: CdpService
  internals: ServiceInternals
  events: { emit(event: string, params: unknown, sessionId: string | undefined): void }
  commandLog: Array<{ method: string; params: Record<string, unknown>; sessionId: string | undefined }>
} {
  const commandLog: Array<{ method: string; params: Record<string, unknown>; sessionId: string | undefined }> = []
  const listeners = new Map<string, Array<(params: unknown, sessionId: string | undefined) => void>>()
  const eventConnection: PageConnection = {
    send: async () => ({}),
    on: (event, listener) => {
      const registered = listeners.get(event) ?? []
      registered.push(listener)
      listeners.set(event, registered)
      return () => {
        const index = registered.indexOf(listener)
        if (index !== -1) registered.splice(index, 1)
      }
    },
  }
  const page = new PageSession(eventConnection, SESSION)

  const service = new CdpService()
  const internals = service as unknown as ServiceInternals
  internals.sessions.set(SESSION, page)
  const targetInfo: StubTarget[] = [{ targetId: 'T1', type: 'page', title: '', url: '' }]
  internals.registry = {
    targets: () => targetInfo,
    list: async () => {},
    attachedSession: (targetId: string) => (targetId === 'T1' ? SESSION : undefined),
    active: () => targetInfo[0],
    setActive: () => {},
  }
  internals.connection = {
    send: async (method: string, params: Record<string, unknown>, sessionId: string | undefined) => {
      commandLog.push({ method, params, sessionId })
      const value = script[method]
      if (value === undefined) return {}
      return typeof value === 'function' ? (value as () => unknown)() : value
    },
    on: () => () => {},
  }

  return {
    service,
    internals,
    events: {
      emit: (event, params, sessionId) => {
        for (const listener of listeners.get(event) ?? []) listener(params, sessionId)
      },
    },
    commandLog,
  }
}

describe('plan05: CdpService.upload validation', () => {
  it('refuses an empty list, an oversized list, and a missing locator before touching disk', async () => {
    const { service } = makeUploadService({})

    const empty = await service.upload({ files: [] })
    expect(empty.error?.code).toBe('bad-request')

    const many = await service.upload({ files: Array.from({ length: DEFAULT_MAX_UPLOAD_FILES + 1 }, (_, i) => String(i)) })
    expect(many.error?.code).toBe('too-many-files')

    const noLocator = await service.upload({ files: ['whatever'] })
    expect(noLocator.error?.code).toBe('missing-locator')
    expect(noLocator.error?.message).toContain('selector')
  })

  it('propagates path-policy codes', async () => {
    const { service } = makeUploadService({})
    const relative = await service.upload({ files: ['rel.txt'], selector: '#file' })
    expect(relative.error?.code).toBe('path-not-absolute')

    // A real temp file outside cwd/downloads/extra roots is forbidden.
    const outside = await makeRoot()
    const file = join(outside, 'out.txt')
    await writeFile(file, 'x')
    const forbidden = await service.upload({ files: [file], selector: '#file' })
    expect(forbidden.error?.code).toBe('path-forbidden')
    expect(forbidden.files).toHaveLength(0)
  })

  it('fails with no-session when there is no connection or registry', async () => {
    const service = new CdpService()
    // Escape hatch so path validation passes and the session refusal surfaces.
    service.setUploadPolicy({ allowAnyPath: true })
    const root = await makeRoot()
    const file = join(root, 'real.txt')
    await writeFile(file, 'x')
    const result = await service.upload({ files: [file], selector: '#file' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('no-session')
    expect(result.error?.message).toContain('no active browser connection')
  })

  it('reports a structured dialog-open before any DOM command (branch 1 parity)', async () => {
    const { service, events, commandLog } = makeUploadService({})
    const root = await makeRoot()
    const file = join(root, 'in.txt')
    await writeFile(file, 'x')
    service.setUploadPolicy({ roots: [root] })

    events.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Stop', url: 'https://x.test/' }, SESSION)
    const result = await service.upload({ files: [file], selector: '#file' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('dialog-open')
    expect(result.error?.message).toContain('cdp_dialog')
    expect(commandLog).toHaveLength(0)
  })
})

describe('plan05: CdpService.upload binding paths', () => {
  it('binds in selector mode and reports the evidence fields', async () => {
    const { service, commandLog } = makeUploadService(happyScript(1))
    const root = await makeRoot()
    const file = join(root, 'doc.txt')
    await writeFile(file, 'abc')
    service.setUploadPolicy({ roots: [root] })

    const result = await service.upload({ files: [file], selector: '#file', targetId: 'T1' })
    expect(result.ok).toBe(true)
    expect(result.targetId).toBe('T1')
    expect(result.mode).toBe('set')
    expect(result.matched).toBe(1)
    expect(result.bound).toBe(true)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.name).toBe('doc.txt')
    expect(result.input).toMatchObject({ tag: 'input', verified: true, accept: '.txt' })
    expect(result.error).toBeUndefined()

    const setter = commandLog.find(row => row.method === 'DOM.setFileInputFiles')
    expect(setter?.sessionId).toBe(SESSION)
    expect(setter?.params).toMatchObject({ nodeId: 42 })
    expect(Array.isArray(setter?.params.files)).toBe(true)
  })

  it('turns a read-back mismatch into a structured verify-failed', async () => {
    const { service } = makeUploadService({ ...happyScript(1), 'Runtime.callFunctionOn': { result: { value: [] } } })
    const root = await makeRoot()
    const file = join(root, 'doc.txt')
    await writeFile(file, 'abc')
    service.setUploadPolicy({ roots: [root] })

    const result = await service.upload({ files: [file], selector: '#file' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('verify-failed')
    expect(result.mode).toBe('set')
  })

  it('binds into an already-staged chooser in chooser mode', async () => {
    const { service, events, commandLog } = makeUploadService(happyScript(1, ['type', 'file']))
    const root = await makeRoot()
    const file = join(root, 'pick.pdf')
    await writeFile(file, 'x')
    service.setUploadPolicy({ roots: [root] })

    // The chooser opens (staged) before the call, so awaitFileChooser returns at once.
    events.emit('Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 9, frameId: 'f' }, SESSION)
    const result = await service.upload({ files: [file], chooser: true, timeoutMs: 1_000 })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('chooser')
    expect(result.bound).toBe(true)
    expect(result.input).toMatchObject({ tag: 'input', verified: true, multiple: false })

    const intercept = commandLog.filter(row => row.method === 'Page.setInterceptFileChooserDialog')
    expect(intercept.map(row => row.params.enabled)).toEqual([true, false])
    expect(commandLog.some(row => row.method === 'DOM.setFileInputFiles')).toBe(true)
  })

  it('times out with chooser-timeout when no chooser opens', async () => {
    const { service } = makeUploadService({})
    const root = await makeRoot()
    const file = join(root, 'pick.txt')
    await writeFile(file, 'x')
    service.setUploadPolicy({ roots: [root] })

    const started = Date.now()
    const result = await service.upload({ files: [file], chooser: true, timeoutMs: 100 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(450)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('chooser-timeout')
    expect(result.error?.message).toContain('file chooser')
  })

  it('rejects a chooser timeout error object thrown by a stub session (fast path)', async () => {
    // Same code path as above without waiting: a session whose staged chooser
    // never arrives is simulated by injecting a rejecting awaitFileChooser.
    const { service, internals } = makeUploadService({})
    const root = await makeRoot()
    const file = join(root, 'pick.txt')
    await writeFile(file, 'x')
    service.setUploadPolicy({ roots: [root] })
    const page = internals.sessions.get(SESSION) as PageSession
    const original = page.awaitFileChooser.bind(page)
    page.awaitFileChooser = async () => {
      await original(1).catch(() => undefined)
      throw new CdpTimeoutError('file chooser', 1)
    }

    const result = await service.upload({ files: [file], chooser: true, timeoutMs: 100 })
    expect(result.error?.code).toBe('chooser-timeout')
  })
})
