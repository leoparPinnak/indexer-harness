/**
 * Scripted stdio peer for the transport tests. It speaks the helper protocol
 * but never echoes request payloads: results are fixed markers, and only the
 * approval flow repeats `params.app`, which the protocol contract requires.
 *
 * Methods:
 *   ready    - unsolicited unknown-id message, then `{ served: 'stub' }`
 *   fails    - `{ error: 'stub refuses' }`
 *   approve  - approvalRequest until `meta['x-oai-cua-approved-app']` matches
 *   hang     - never responds (client timeout must fire)
 *   garbage  - one invalid JSON line (client protocol error path)
 *   die      - stderr note, then exit code 7 (client exit error path)
 */

let buffer = ''
const send = (line) => process.stdout.write(`${line}\n`)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const raw = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (raw.trim() === '') continue
    let request
    try {
      request = JSON.parse(raw)
    } catch {
      process.stderr.write('stub: unparsable request\n')
      continue
    }
    const { id, method, params, meta } = request
    switch (method) {
      case 'ready': {
        send(JSON.stringify({ id: 987654, ok: true, result: { unsolicited: true } }))
        send(JSON.stringify({ id, ok: true, result: { served: 'stub' } }))
        break
      }
      case 'fails': {
        send(JSON.stringify({ id, error: 'stub refuses' }))
        break
      }
      case 'approve': {
        const approved =
          typeof meta === 'object' &&
          meta !== null &&
          typeof meta['x-oai-cua-approved-app'] === 'string' &&
          meta['x-oai-cua-approved-app'] === params.app
        if (approved) send(JSON.stringify({ id, ok: true, result: { launched: params.app } }))
        else send(JSON.stringify({ id, approvalRequest: { app: params.app, displayName: 'Stub App', riskLevel: 'low' } }))
        break
      }
      case 'hang': {
        break
      }
      case 'garbage': {
        process.stdout.write('this is not json\n')
        break
      }
      case 'die': {
        process.stderr.write('stub crashing now\n')
        setTimeout(() => process.exit(7), 10)
        break
      }
      default: {
        send(JSON.stringify({ id, error: `unknown method: ${method}` }))
      }
    }
  }
})
