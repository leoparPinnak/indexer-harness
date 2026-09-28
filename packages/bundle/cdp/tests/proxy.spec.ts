/**
 * Unit tests for CdpProxy: ephemeral loopback binding, plain HTTP request interception,
 * exchange recording into CaptureStore, and safe socket disposal.
 */

import { createServer, request, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CdpProxy } from '../src/net/proxy.ts'
import { CaptureStore } from '../src/net/capture.ts'

describe('CdpProxy', () => {
  let targetServer: Server
  let targetPort: number
  let store: CaptureStore
  let proxy: CdpProxy

  beforeEach(async () => {
    store = new CaptureStore({
      limits: {
        maxBodyBytesPerMessage: 1024,
        maxTotalBodyBytes: 10240,
        maxExchanges: 10,
        maxHeadersPerMessage: 10,
      },
    })

    // Create a local upstream HTTP server on port 0
    targetServer = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ greeting: 'hello from target' }))
    })

    await new Promise<void>((resolve) => {
      targetServer.listen(0, '127.0.0.1', () => {
        const addr = targetServer.address()
        if (typeof addr === 'object' && addr !== null) {
          targetPort = addr.port
        }
        resolve()
      })
    })

    // Start proxy on port 0
    proxy = new CdpProxy({
      port: 0,
      store,
    })
    await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
    await new Promise<void>((resolve) => {
      targetServer.close(() => { resolve() })
    })
  })

  it('binds to an ephemeral port and reports listening', () => {
    expect(proxy.port).toBeGreaterThan(0)
    expect(proxy.isListening).toBe(true)
  })

  it('intercepts plain HTTP requests, forwards to target, and records into CaptureStore', async () => {
    const targetUrl = `http://127.0.0.1:${String(targetPort)}/api/test`

    const responseData = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(targetUrl, {
        host: '127.0.0.1',
        port: proxy.port,
        path: targetUrl,
        headers: {
          'x-custom-test': 'my-value',
        },
      }, (res) => {
        void (async () => {
          const chunks: Buffer[] = []
          for await (const chunk of res) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
          }
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        })()
      })
      req.on('error', reject)
      req.end()
    })

    expect(responseData.status).toBe(200)
    expect(responseData.body).toContain('hello from target')

    // Verify exchange was recorded in CaptureStore
    const captured = store.list()
    expect(captured.length).toBe(1)
    expect(captured[0]?.request.url).toBe(targetUrl)
    expect(captured[0]?.response.status).toBe(200)
  })
})
