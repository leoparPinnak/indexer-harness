import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '../src/config.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
})

/**
 * Session-affinity wire behaviour: a profile states the switch pi-ai cannot
 * infer for an anonymous openai-completions gateway (its detection answers as
 * though the endpoint were OpenAI itself, where the feature is off), and only
 * then does the request carry the session id downstream session routing keys
 * on. Untouched routes must keep sending none of the shapes.
 */
describe('session affinity headers', () => {
  /** Drain one request to the mock under the given compat, and read its wire headers. */
  async function requestHeaders(
    compat: PiAiProviderProfile['compat'],
    options: { withSessionId?: boolean; modelCompat?: PiAiProviderProfile['compat']; parentSessionId?: string } = {},
  ): Promise<IncomingMessage['headers']> {
    const server = await mockServer([{ events: textEvents }])
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: server.url,
          models: [{
            id: 'gw-model',
            ...(options.modelCompat === undefined ? {} : { compat: options.modelCompat }),
          }],
          ...(compat === undefined ? {} : { compat }),
        },
      }),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
    })
    for await (const _chunk of adapter.stream({
      provider: 'acme-gateway',
      model: 'gw-model',
      messages: [],
      ...(options.withSessionId === false ? {} : { sessionId: 'session-for-pi' as never }),
      ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId as never }),
    })) { /* drain */ }
    return server.headers[0] ?? {}
  }

  /** The session id in every shape pi-ai knows, asserted absent together. */
  function expectNoAffinity(headers: IncomingMessage['headers']): void {
    expect(headers['x-session-id']).toBeUndefined()
    expect(headers.session_id).toBeUndefined()
    expect(headers['x-client-request-id']).toBeUndefined()
    expect(headers['x-session-affinity']).toBeUndefined()
  }

  it('sends none without the opt-in, keeping every shape of the id off the wire', async () => {
    expectNoAffinity(await requestHeaders(undefined))
  })

  it('sends only x-session-id in the openrouter format', async () => {
    const headers = await requestHeaders({ sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' })
    expect(headers['x-session-id']).toBe('session-for-pi')
    expect(headers.session_id).toBeUndefined()
    expect(headers['x-client-request-id']).toBeUndefined()
    expect(headers['x-session-affinity']).toBeUndefined()
  })

  it('sends session_id and the affinity pair in the openai format', async () => {
    const headers = await requestHeaders({ sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openai' })
    expect(headers.session_id).toBe('session-for-pi')
    expect(headers['x-client-request-id']).toBe('session-for-pi')
    expect(headers['x-session-affinity']).toBe('session-for-pi')
    expect(headers['x-session-id']).toBeUndefined()
  })

  it('sends the affinity pair without session_id in the openai-nosession format', async () => {
    const headers = await requestHeaders({ sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openai-nosession' })
    expect(headers['x-client-request-id']).toBe('session-for-pi')
    expect(headers['x-session-affinity']).toBe('session-for-pi')
    expect(headers.session_id).toBeUndefined()
    expect(headers['x-session-id']).toBeUndefined()
  })

  it('sends nothing when the request carries no session id, opt-in aside', async () => {
    expectNoAffinity(await requestHeaders(
      { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' },
      { withSessionId: false },
    ))
  })

  it('lets the model compat win over the route per field', async () => {
    const headers = await requestHeaders(
      { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openai' },
      { modelCompat: { sessionAffinityFormat: 'openrouter' } },
    )
    expect(headers['x-session-id']).toBe('session-for-pi')
    expect(headers.session_id).toBeUndefined()
    expect(headers['x-client-request-id']).toBeUndefined()
    expect(headers['x-session-affinity']).toBeUndefined()
  })

  it('carries the parent-session link only on affinity-enabled routes', async () => {
    const headers = await requestHeaders(
      { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' },
      { parentSessionId: 'session-parent' },
    )
    expect(headers['x-session-id']).toBe('session-for-pi')
    expect(headers['x-parent-session-id']).toBe('session-parent')
  })

  it('keeps the parent-session link off routes without affinity', async () => {
    const headers = await requestHeaders(undefined, { parentSessionId: 'session-parent' })
    expect(headers['x-parent-session-id']).toBeUndefined()
    expectNoAffinity(headers)
  })
})
