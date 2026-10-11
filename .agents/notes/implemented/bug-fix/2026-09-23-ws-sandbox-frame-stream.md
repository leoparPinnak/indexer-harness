# Agent Note: WebSocket sandbox frame stream — an observable transport for the shellbox pane

Status: implemented

English | [中文](2026-09-23-ws-sandbox-frame-stream.zh.md)

## Problem

The shellbox pane drew `GET /api/server/sandbox/stream` MJPEG multipart into an `<img>`, a transport that hides exactly the facts the pane must act on: an MJPEG `<img>` fires no error when its connection ends, so a dead stream froze the picture on its last frame with nothing to reconnect on, and a viewer that left mid-request left the route writing headers into a response whose socket was already gone — a write outside any `try` whose uncaught exception kills the web server process. The reconnect decision in [shellbox-stream-liveness](2026-09-22-shellbox-stream-liveness.md) repaired the helper and Deamon sides and moved the route's own failures inside guards, but the pane's transport stayed blind.

## Decision

- `protop/shellbox/deamon/src/sandbox.ts` serves `STREAM_WS_PATH = '/api/server/sandbox/ws'` from the web server's upgrade hook: `registerUpgrade(route)` hands each connection to a `WebSocketServer({ noServer: true })` through `handleUpgrade`, and the plugin's dispose unregisters the route and terminates every client socket the route still owns.
- The upgrade passes the connection service's origin gate first: `connection.requestRejection(req)` answering `401` or `403` is written back by `rejectUpgrade` before any handshake header, and any other answer proceeds, so a cross-site WebSocket hijack never reaches the handshake.
- The pane composes `?session=…&instance=…&target=…&fps=…` through the shared `buildStreamQuery`, so the socket, the status poll, and the size report all name the same target.
- The daemon's MJPEG multipart is cut into complete JPEGs by the shared `createMultipartFrameParser`; each JPEG leaves as one binary message through the `ControllerSink` adapter feeding `SandboxController.stream`, and a part whose length field cannot resume framing is dropped instead of desynchronizing what follows.
- `MAX_FRAME_BUFFER_BYTES` (16 MiB) caps one buffered frame and `WS_BACKPRESSURE_BYTES` (2 MiB) makes `sendFrame` drop rather than queue behind a slow viewer, so memory per viewer stays bounded.
- Every close states its cause — `1013` while the daemon cannot be ensured (starting or unavailable: a reconnect may succeed) and `1011` when the source ends mid-stream or the helper stops — and the pane answers both with its existing retry ladder.
- `SandboxBody.tsx` opens `ws(s)://<origin>/api/server/sandbox/ws` with that query, swaps the image's object URL on each binary message and revokes the previous one, and settles `close`/`error` into the connect ladder — three attempts two seconds apart — before the failure notice with its manual retry; the status-poll watchdog keeps its four-second stall detection and escalating reconnect ladder on the same `cacheBuster` channel, and one cleanup owns unmount, target and session switches, and manual retries, cancelling any pending retry timer.
- `GET /api/server/sandbox/stream` keeps its piped HTTP behavior, pinned by its own spec, while the pane reads frames from the socket.

## Alternatives considered

**Guard the MJPEG pipe and keep the `<img>`.** Rejected: the guards stop the process from dying, but the pane still cannot observe a stream that stopped — an MJPEG `<img>` fires no error when its connection ends — so the frozen picture survives and each reconnect is a URL re-request the pane cannot attribute. A transport whose failure is an event is the fix; the guards stay as the defense beneath it.

## Consequences

- A stream that stops becomes an event the pane answers: the close carries a retryable or terminal cause, the ladder reconnects, and the failure notice offers manual retry instead of a frozen frame.
- A viewer that leaves mid-request cannot take the web server with it: the header write, the daemon response error, and the post-header proxy error all sit inside the route's guard.
- Memory per viewer is bounded by the frame cap and the backpressure drop; a slow viewer loses frames instead of growing a queue.
- The pane now depends on an upgrade-capable same-origin connection, and a frame that fails to decode falls through to the same ladder as any other image failure.

## Testing

- `protop/shellbox/deamon/tests/sandbox-routes.spec.ts` pins the upgrade dispatch through a real bridge server (accepted handshake, a rejected plain request, and the origin gate), binary frame delivery, reassembly across arbitrary chunk splits, unresumable-part drops, a helper that cannot start, daemon failure closing retryably, a daemon stream death closing with `1011`, dispose unregistering the route and closing viewers, a viewer leaving before the daemon answers with the server still serving afterwards, and HTTP pipe parity (status, content type, multipart framing, JPEG magic).
- `protop/shellbox/ui-sandbox-view/tests/sandbox-body.client.spec.tsx` pins socket open and frame painting, the connect ladder before the failure notice, one retry window collapsing image and socket failures, query shapes from session, target, and instance, the watchdog holding the reconnect ladder inside its delay window, a manual retry clearing the pending reconnect timer, teardown cancelling a pending reconnect, and the stop and size-report contracts.
- The wire contract lives in `protop/shellbox/deamon/sandbox/PROTOCOL.md`; the pane's transport is documented in the bilingual `protop/shellbox/ui-sandbox-view/README.md`.
