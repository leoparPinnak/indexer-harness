// @vitest-environment jsdom
/**
 * The CDP tab body: the host's status route rendered as availability, version,
 * live target count, and proxy state, with the loading, failure, and retry paths
 * the reader can reach.
 *
 * The route is read with plain `fetch`, so the cases here stub that global and
 * pin the states a reader sees: the loading line before any answer, the failure
 * notice plus its retry control when the answer is refused, failing, or
 * malformed, the fields printed verbatim when it validates, and the retry that
 * re-runs the read. Two more cases pin what a late answer must not do: an answer
 * or a failure that lands after unmount updates nothing.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CDP_STATUS_URL, CdpBody, parseCdpStatus } from '../src/client/CdpBody.tsx'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en): string => en[key]
const props = { t } as unknown as Parameters<typeof CdpBody>[0]

/** The validated body of a healthy status route. */
const status = {
  ok: true,
  version: '1.3.0',
  targets: 2,
  proxy: { active: true },
}

/** One route answer as `fetch` hands it to the body. */
function answer(body: unknown, ok = true): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok, status: ok ? 200 : 500, json: async () => body }
}

/** A promise whose settlement the case controls. */
interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

/**
 * Build one externally settled promise.
 * @returns the promise plus its settle functions.
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Let every pending microtask and timer callback settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('CDP status validation', () => {
  it('rejects every answer whose fields are not the declared types', () => {
    expect(parseCdpStatus('nope')).toBeUndefined()
    expect(parseCdpStatus(null)).toBeUndefined()
    expect(parseCdpStatus({ ok: 'yes', version: '1.3.0', targets: 0, proxy: { active: true } })).toBeUndefined()
    expect(parseCdpStatus({ ok: true, version: 7, targets: 0, proxy: { active: true } })).toBeUndefined()
    expect(parseCdpStatus({ ok: true, version: '1.3.0', targets: '2', proxy: { active: true } })).toBeUndefined()
    expect(parseCdpStatus({ ok: true, version: '1.3.0', targets: 1.5, proxy: { active: true } })).toBeUndefined()
    expect(parseCdpStatus({ ok: true, version: '1.3.0', targets: 0, proxy: null })).toBeUndefined()
    expect(parseCdpStatus({ ok: true, version: '1.3.0', targets: 0, proxy: { active: 'yes' } })).toBeUndefined()
  })

  it('keeps the declared fields of a valid answer and drops the rest', () => {
    expect(parseCdpStatus({ ...status, extra: 'ignored' })).toEqual(status)
    expect(parseCdpStatus({ ...status, targets: 0 })).toEqual({ ...status, targets: 0 })
  })
})

describe('CDP tab body', () => {
  it('shows the loading line until the status route answers', () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    render(<CdpBody {...props} />)
    expect(screen.getByText(en['status.loading'])).toBeDefined()
    expect(fetchMock).toHaveBeenCalledWith(CDP_STATUS_URL)
  })

  it('prints availability, version, target count, and proxy state', async () => {
    fetchMock.mockResolvedValue(answer(status))
    render(<CdpBody {...props} />)
    expect(await screen.findByText(en['status.ok'])).toBeDefined()
    expect(screen.getByText('1.3.0')).toBeDefined()
    expect(screen.getByText('2')).toBeDefined()
    expect(screen.getByText(en['field.targets'])).toBeDefined()
    expect(screen.getByText(en['value.active'])).toBeDefined()
  })

  it('reports an unavailable extension, zero targets, and an inactive proxy', async () => {
    fetchMock.mockResolvedValue(answer({ ...status, ok: false, targets: 0, proxy: { active: false } }))
    render(<CdpBody {...props} />)
    expect(await screen.findByText(en['status.unavailable'])).toBeDefined()
    expect(screen.getByText('0')).toBeDefined()
    expect(screen.getByText(en['value.inactive'])).toBeDefined()
  })

  it('fails a refused answer and retries into the status', async () => {
    fetchMock.mockResolvedValueOnce(answer(status, false))
    fetchMock.mockResolvedValue(answer(status))
    render(<CdpBody {...props} />)
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText(en['status.error'])).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en['action.retry'] }))
    expect(await screen.findByText(en['status.ok'])).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails a malformed answer and retries into the status', async () => {
    fetchMock.mockResolvedValueOnce(answer({ ok: true }))
    fetchMock.mockResolvedValue(answer(status))
    render(<CdpBody {...props} />)
    expect(await screen.findByRole('alert')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en['action.retry'] }))
    expect(await screen.findByText(en['status.ok'])).toBeDefined()
  })

  it('fails a rejected read and retries into the status', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    fetchMock.mockResolvedValue(answer(status))
    render(<CdpBody {...props} />)
    expect(await screen.findByRole('alert')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en['action.retry'] }))
    expect(await screen.findByText(en['status.ok'])).toBeDefined()
  })

  it('ignores a status that arrives after the tab unmounts', async () => {
    const body = deferred<unknown>()
    fetchMock.mockReturnValue(Promise.resolve({ ok: true, status: 200, json: () => body.promise }))
    const view = render(<CdpBody {...props} />)
    view.unmount()
    body.resolve(status)
    await flush()
    expect(screen.queryByText(en['status.ok'])).toBeNull()
  })

  it('ignores a failure that arrives after the tab unmounts', async () => {
    const response = deferred<never>()
    fetchMock.mockReturnValue(response.promise)
    const view = render(<CdpBody {...props} />)
    view.unmount()
    response.reject(new Error('offline'))
    await flush()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
