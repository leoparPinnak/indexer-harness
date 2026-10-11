/**
 * Operator RESUME client dispatch shape: the Session binding calls the remote
 * with exactly `request {sessionId}` — the typert gateway's descriptor wraps
 * one request field — and mirrors the Host's `{resumed}` verdict verbatim.
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { Session } from '../src/client/sessions/session.ts'

describe('Session.resume dispatch', () => {
  it('calls session.resume with request {sessionId} and mirrors the verdict', async () => {
    const resume = vi.fn(async () => ({ ok: true as const, value: { resumed: true } }))
    const session = new Session(SessionId('resume-dispatch'), { session: { resume } } as never)

    await expect(session.resume()).resolves.toEqual({ ok: true, value: { resumed: true } })
    expect(resume).toHaveBeenCalledWith({ sessionId: 'resume-dispatch' })
  })

  it('mirrors an honest Host refusal without filing promptError', async () => {
    const resume = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'session/resume-no-checkpoint', message: 'no completed model request' },
    }))
    const session = new Session(SessionId('resume-refusal'), { session: { resume } } as never)

    const result = await session.resume()
    expect(result.ok).toBe(false)
    // The resume affordance owns its failure display; the error strip keeps
    // exactly one owner (stop/prompt), so nothing lands in promptError.
    // oxlint-disable-next-line typescript/no-explicit-any -- snapshot access for the assertion
    expect((session as any).promptError).toBeNull()
  })
})
