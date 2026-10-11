---
description: "The named-pipe gateway dsh runs instead of a loopback HTTP hop: framed request/response messages over a Windows named pipe or unix socket, a sha256 key-digest handshake, 64 KiB/512 KiB caps, a 2 s default budget, and one listener per home."
kind: "package-reference"
---

# @deepseek-ai/dsh-ipc-pipe

English | [中文](README.zh.md)

## Summary

Move a message between two processes on one machine over a named pipe instead of a loopback HTTP round trip. Mount the server where the work happens, let callers connect with the shared home key, and every exchange arrives framed, size-capped, and timed. The handshake refuses a peer that does not hold the key, and a lock refuses a second listener on the same endpoint. It carries bytes only: no TLS, no cross-machine transport, no browser surface.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The common path: a host bridge mounts the client and its helper daemon mounts the server, so commands and events cross as pipe frames while the browser keeps its HTTP and WebSocket faces.

### When to choose it

Choose this gateway for a same-machine hop between two dsh processes when the messages deserve a budget, a size cap, and an authenticated peer; a caller's transport option selects it (`pipe`, the default) over the legacy loopback path (`http`, retired in D9). Reach for HTTP instead when a browser or an external tool is the caller — the pipe endpoint is private to one home and never binds a TCP port.

### Minimal configuration

This package is a library, not a plugin: it takes no `cordis.yml` row, and every choice arrives as an option or an environment variable of the caller.

| Field | Default | Meaning |
|---|---|---|
| `seed` | the DSH home | Digest seed naming the endpoint (`dsh-gateway-<homehash16>`); a spec passes its own coordinate |
| `DSH_GATEWAY_PATH` | platform endpoint | Pin the endpoint path instead of deriving it |
| `DSH_GATEWAY_KEY` | `$DSH_HOME/ipc/dsh-gateway-<hash>.key` | Handshake key override; the file is created on first use |
| `timeoutMs` | `2000` | Default per-request budget in milliseconds; a request may ask for its own |
| `halfCloseToleranceMs` | `30000` | How long a half-closed peer still receives answers |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One frame is `[u32 total][header JSON][0x0A][body]`: a big-endian byte count, a single-line envelope, a newline, then the raw body the envelope describes. Because `JSON.stringify` never emits a raw newline, the reader recovers the header before it buffers a body, so it can refuse an oversized frame the moment its type is known. Caps are hard: a `req` frame past 64 KiB or a `res`/`chunk` frame past 512 KiB closes the connection with an explicit `PAYLOAD_TOO_LARGE` error rather than a truncated message.

A client proves itself in the first frame: `hello` carries `sha256(key)` and the protocol generation, and a mismatch is logged, answered with `AUTH_FAILED`, and closed before any request is accepted. Both peers derive the key from the same coordinates — `$DSH_HOME/ipc/dsh-gateway-<hash>.key`, created under `wx` on first use, or the `DSH_GATEWAY_KEY` override — so a home that never wrote one still agrees with its peer.

The server answers in one of two shapes. A handler that sets headers and ends sends one buffered `res` frame carrying the whole body; a handler that flushes or writes first opens a stream, and the peer reads `chunk` frames until `end`. That second shape is what lets the Deamon's multipart JPEG feed cross the pipe byte for byte. When a reader goes away it sends `abort`, which ends the response and lets the handler's own `close` listener detach it — the same release an HTTP client disconnect produced.

A single-instance lock beside the endpoint (`<home>/ipc/dsh-gateway-<hash>.lock`, contents `{pid, startedAt}`) refuses a second mount while the holder lives and is stolen when the pid is gone, so two daemons never share one pipe name. A socket file left by a crashed run is removed only after the lock proved no live holder remains. A peer that sends its FIN keeps the writable side for `halfCloseToleranceMs`: an answer computed after the FIN still lands, and only an answer that never comes loses the connection.

### Source map

| File | Role |
|---|---|
| `src/coords.ts` | Endpoint, lock, and key derivation; constant-time digest comparison |
| `src/protocol.ts` | Frame grammar, caps, budgets, and the incremental reader |
| `src/server.ts` | Listener, lock, handshake, request routing, and response frames |
| `src/client.ts` | Connection, handshake, buffered requests, streams, and aborts |
| `src/errors.ts` | The typed failure vocabulary every refusal carries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-deamon](../../../protop/shellbox/deamon/README.md) — the bridge and helper daemon that speak over this gateway
- [dsh-host-webserver](../../host/webserver/README.md) — the HTTP face that stays for the browser
- [Development](../../../docs/development.md) — contributor workflow and the check lanes

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- One endpoint per home and per seed: two processes on one machine share one connection target, and a fan-out from one server to several readers of the same stream is not modelled — each reader opens its own connection.
- The transport is local only. A Windows named pipe or a unix domain socket has no cross-machine form, and nothing here negotiates TLS.
- Caps are hard failures by design: a request over 64 KiB or a response chunk over 512 KiB closes the connection, so a caller with a bigger payload must chunk it above this layer.
- `deamon.transport: 'http'` still serves the legacy loopback path alongside the pipe until D9 removes it; a peer that cannot mount the gateway falls back to that path and logs the downgrade.
- The key file is plaintext on disk (mode `0600`) beside the endpoint. A deployment wanting an externally managed secret sets `DSH_GATEWAY_KEY` instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The wire format is exercised by `packages/ipc/ipc-pipe/tests/ipc-pipe.spec.ts`: handshake success and refusal, both size caps, the request budget, single-instance competition, half-close tolerance, and a stream that survives a reader leaving. The Deamon side pins the same transport through `packages/bundle/deamon/tests/deamon.spec.ts` and `sandbox-routes.spec.ts`.

The endpoint name follows the Hermes `control_socket.py` shape (`\\.\pipe\dsh-gateway-<homehash16>` with a unix socket fallback), but the code is written from scratch; the digest handshake follows the OMP `omp-daemon` pattern. Frames carry `timeoutMs` so the server arms the same budget the caller did, clamped to 100 ms..60 s.

</details>
