/**
 * @deepseek-ai/dsh-cdp/net/proxy — Local HTTP/HTTPS Interception Proxy.
 * Binds on loopback and intercepts HTTP and HTTPS traffic (via CONNECT and dynamic SNI
 * certificates signed by the local CA). Forwards traffic to remote destinations and
 * records requests and responses into {@link CaptureStore} with full redaction and bounds.
 *
 * @module @deepseek-ai/dsh-cdp/net/proxy
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { TLSSocket } from 'node:tls'
import type { Socket } from 'node:net'
import { CertificateAuthority } from './ca.ts'
import type { CaptureStore } from './capture.ts'

/**
 * Options for configuring {@link CdpProxy}.
 */
export interface CdpProxyOptions {
  /** Port to bind on loopback. Pass 0 for an ephemeral port in tests. */
  readonly port: number
  /** CaptureStore to record intercepted traffic into. */
  readonly store: CaptureStore
  /** Optional pre-configured CertificateAuthority. */
  readonly ca?: CertificateAuthority | undefined
}

/**
 * Read request or response stream as raw Uint8Array buffer.
 * @param stream - readable stream.
 * @returns collected bytes.
 */
async function collectStreamBytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * Local HTTP/HTTPS Proxy server with automated traffic recording.
 */
export class CdpProxy {
  private readonly requestedPort: number
  private readonly store: CaptureStore
  private readonly ca: CertificateAuthority
  private server: Server | undefined
  private activePort = 0
  private readonly sockets = new Set<Socket>()

  constructor(options: CdpProxyOptions) {
    this.requestedPort = options.port
    this.store = options.store
    this.ca = options.ca ?? new CertificateAuthority()
  }

  /** The bound TCP port after start. */
  get port(): number {
    return this.activePort
  }

  /** The Certificate Authority used by this proxy. */
  get certificateAuthority(): CertificateAuthority {
    return this.ca
  }

  /** Whether the proxy is currently listening. */
  get isListening(): boolean {
    return this.server?.listening ?? false
  }

  /**
   * Start the proxy listener on loopback.
   */
  async start(): Promise<void> {
    if (this.server !== undefined) return

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void this.handlePlainHttp(req, res)
    })

    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket)
      socket.on('close', () => { this.sockets.delete(socket) })
    })

    server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
      this.handleConnect(req, clientSocket, head)
    })

    await new Promise<void>((resolve, reject) => {
      server.listen(this.requestedPort, '127.0.0.1', () => {
        const addr = server.address()
        if (typeof addr === 'object' && addr !== null) {
          this.activePort = addr.port
        }
        resolve()
      })
      server.on('error', reject)
    })

    this.server = server
  }

  /**
   * Forward plain HTTP requests and record the exchange.
   */
  private async handlePlainHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now()
    const targetUrl = req.url ?? '/'
    const method = req.method ?? 'GET'

    let targetParsed: URL
    try {
      targetParsed = new URL(targetUrl)
    } catch {
      res.statusCode = 400
      res.end('Bad Request')
      return
    }

    const requestHeaders = Object.entries(req.headers).map(([k, v]) => ({
      name: k,
      value: Array.isArray(v) ? v.join(', ') : (v ?? ''),
    }))

    const reqBody = await collectStreamBytes(req)
    const requestFinishedAt = Date.now()

    const proxyReq = httpRequest(targetParsed, {
      method,
      headers: req.headers,
    }, (upstreamRes) => {
      void (async () => {
        const resStartedAt = Date.now()
        res.statusCode = upstreamRes.statusCode ?? 200
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (v !== undefined) res.setHeader(k, v)
        }

        const resBody = await collectStreamBytes(upstreamRes)
        const resFinishedAt = Date.now()
        res.end(resBody)

        const responseHeaders = Object.entries(upstreamRes.headers).map(([k, v]) => ({
          name: k,
          value: Array.isArray(v) ? v.join(', ') : (v ?? ''),
        }))

        this.store.add({
          flowId: `flow-http-${String(Date.now())}`,
          request: {
            method,
            url: targetUrl,
            httpVersion: req.httpVersion,
            headers: requestHeaders,
            body: reqBody,
            startedAt,
            finishedAt: requestFinishedAt,
          },
          response: {
            status: upstreamRes.statusCode ?? 200,
            statusText: upstreamRes.statusMessage ?? '',
            headers: responseHeaders,
            body: resBody,
            mimeType: (upstreamRes.headers['content-type'] ?? 'application/octet-stream').split(';')[0]?.trim() ?? 'application/octet-stream',
            startedAt: resStartedAt,
            finishedAt: resFinishedAt,
          },
        })
      })()
    })

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.statusCode = 502
        res.end(`Bad Gateway: ${err.message}`)
      }
    })

    proxyReq.end(reqBody)
  }

  /**
   * Handle HTTPS CONNECT tunnel and TLS termination using dynamic leaf certificates.
   */
  private handleConnect(req: IncomingMessage, clientSocket: Socket, _head: Buffer): void {
    const authority = req.url ?? ''
    const [hostname, rawPort] = authority.split(':')
    const targetPort = Number.parseInt(rawPort ?? '443', 10)

    if (hostname === undefined || hostname.length === 0) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      clientSocket.destroy()
      return
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    // Generate or reuse dynamic leaf certificate for this hostname
    const cert = this.ca.generateLeafCert(hostname)

    const tlsSocket = new TLSSocket(clientSocket, {
      isServer: true,
      cert: cert.certPem,
      key: cert.keyPem,
    })

    this.sockets.add(tlsSocket)
    tlsSocket.on('close', () => { this.sockets.delete(tlsSocket) })

    // Build internal HTTP server to parse decrypted HTTP requests inside the TLS tunnel
    const internalServer = createServer((intReq: IncomingMessage, intRes: ServerResponse) => {
      void (async () => {
        const startedAt = Date.now()
        const path = intReq.url ?? '/'
        const fullUrl = `https://${hostname}:${String(targetPort)}${path}`
        const method = intReq.method ?? 'GET'

        const requestHeaders = Object.entries(intReq.headers).map(([k, v]) => ({
          name: k,
          value: Array.isArray(v) ? v.join(', ') : (v ?? ''),
        }))

        const reqBody = await collectStreamBytes(intReq)
        const reqFinishedAt = Date.now()

        const upstream = httpsRequest(fullUrl, {
          method,
          headers: intReq.headers,
          rejectUnauthorized: false,
        }, (upRes) => {
          void (async () => {
            const resStartedAt = Date.now()
            intRes.statusCode = upRes.statusCode ?? 200
            for (const [k, v] of Object.entries(upRes.headers)) {
              if (v !== undefined) intRes.setHeader(k, v)
            }

            const resBody = await collectStreamBytes(upRes)
            const resFinishedAt = Date.now()
            intRes.end(resBody)

            const responseHeaders = Object.entries(upRes.headers).map(([k, v]) => ({
              name: k,
              value: Array.isArray(v) ? v.join(', ') : (v ?? ''),
            }))

            this.store.add({
              flowId: `flow-https-${String(Date.now())}`,
              request: {
                method,
                url: fullUrl,
                httpVersion: intReq.httpVersion,
                headers: requestHeaders,
                body: reqBody,
                startedAt,
                finishedAt: reqFinishedAt,
              },
              response: {
                status: upRes.statusCode ?? 200,
                statusText: upRes.statusMessage ?? '',
                headers: responseHeaders,
                body: resBody,
                mimeType: (upRes.headers['content-type'] ?? 'application/octet-stream').split(';')[0]?.trim() ?? 'application/octet-stream',
                startedAt: resStartedAt,
                finishedAt: resFinishedAt,
              },
            })
          })()
        })

        upstream.on('error', (err) => {
          if (!intRes.headersSent) {
            intRes.statusCode = 502
            intRes.end(`Bad Gateway: ${err.message}`)
          }
        })

        upstream.end(reqBody)
      })()
    })

    internalServer.emit('connection', tlsSocket)
  }

  /**
   * Stop the proxy server and close all active sockets.
   */
  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy()
    }
    this.sockets.clear()

    if (this.server !== undefined) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => { resolve() })
      })
      this.server = undefined
    }
  }
}
