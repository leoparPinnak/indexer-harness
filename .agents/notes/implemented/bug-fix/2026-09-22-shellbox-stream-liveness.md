# Agent Note: Shellbox stream liveness — reconnect, proxy hardening

Status: implemented

English | [中文](2026-09-22-shellbox-stream-liveness.zh.md)

## Problem

A Shellbox viewer that worked at startup froze permanently after a while: the sidebar image stopped updating while the instance list, the status endpoint, and the model tools all kept working. Three defects combined into that symptom:

- The live server still served the committed `HTTP 307` redirect for `GET /api/server/sandbox/stream`, while the working tree already carried a half-finished pipe proxy (no value import for `http`, so the new code could not even run; the old `307` test still asserted the redirect). A browser `<img>` follows a redirect once and never re-requests, so every mid-stream break was permanent.
- The pane never re-requested the stream on its own. An MJPEG `<img>` fires no error when its connection ends mid-stream; it freezes on the last frame.
- The pipe proxy attached no `error` listener to the daemon response, so a daemon dying mid-stream was an unhandled response error — an uncaught exception in the web server process.

## Decision

- `SandboxBody.tsx` tracks liveness through the one-second `/api/server/sandbox/status` poll: once the measured frame rate has been zero for four seconds it re-requests the stream URL, backing off from one second to fifteen, and a recovered stream resets the ladder. A stream URL that fails outright is retried three times two seconds apart before the load notice appears.
- The pane's frames arrive over a WebSocket socket rather than the MJPEG `<img>`; the watchdog and ladder above operate on that socket's `cacheBuster` channel, and the transport decision is recorded in [ws-sandbox-frame-stream](2026-09-23-ws-sandbox-frame-stream.md).
- The `/stream` bridge pipes the daemon response and destroys the viewer response on any daemon response error, and destroys the viewer response when the proxy request fails after headers were sent.
- The helper drops a failing frame and rebuilds its capture surface from a clean slate instead of exiting: the command poll, target tracking, capture, and encode run inside a `try`, while the stdout write stays outside it so a closed pipe still ends an orphaned helper.
- `DEAMON_DISCOVERY_FILE` overrides the Deamon discovery path so specs own their coordinates; `startDeamon` no longer overwrites the live Deamon's discovery file during a test run, and the Deamon `/status` response no longer invents a `session-<id>` instance id when none was requested.

## Alternatives considered

**Keep the 307 redirect and fix reconnect only in the pane.** Rejected: the redirect forces a second connection the pane cannot observe, and `<img>` redirect handling on multipart streams is inconsistent across browsers. Piping keeps one observable connection through the host.

**Reconnect on a fixed interval instead of measured frames.** Rejected after measurement: a fixed poll re-requests even a healthy stream and respawns helpers needlessly. The measured frame rate is already published by the status poll, so the watchdog costs no new traffic.

## Consequences

- A dead stream recovers on its own within seconds: the pane re-requests, the daemon restarts the helper on the same desktop, and the picture returns without user action.
- A daemon dying mid-stream ends the viewer response instead of crashing the web server.
- Test runs no longer touch `~/.dsh/deamon.json`.

## Testing

- `packages/bundle/deamon/tests/sandbox-routes.spec.ts` pins piped frames through a real bridge server (status, content type, multipart framing, JPEG magic), survival of a mid-stream Deamon death with the bridge still answering afterwards, the 502/503 fallbacks, and the helper staying alive after the last viewer leaves.
- `packages/bundle/deamon/tests/deamon.spec.ts` and the routes spec isolate Deamon discovery through `DEAMON_DISCOVERY_FILE`.
- `packages/client/ui-sandbox-view/tests/sandbox-body.client.spec.tsx` pins the retry ladder before the failure notice, the manual retry after it, the watchdog reconnect on zero measured frames, and the quiet steady state once frames flow again.

## Appendix: server log terminal (same session)

While verifying the log file on the live machine it stayed empty despite traffic: the web composition registers no console exporter, so `ctx.logger` traffic only reaches the 1000-message memory buffer and never the process streams a stdout tee could catch. `packages/bundle/web-app/src/server-log.ts` therefore mirrors both channels into `$DSH_HOME/logs/dsh-web.log` (5MB rotation, single backup, crash-safe synchronous appends, silent disable on disk failure): a write-through tee over the console streams plus a `ctx.logger.exporter()` registration, served as newest-last lines at `GET /api/server/logs` with `POST /api/server/logs/clear`. A live probe then showed daemon relay lines still missing: the manager drained the daemon child's stderr but never its stdout, leaving relay output in an unread pipe that would stall the daemon once full; it now forwards stdout lines through the log. The settings Server Logs section (`packages/client/ui-server-logs/`, `settings.section` order 90) renders that tail newest-first with live refresh, substring filter, and clear. Pinned by `packages/bundle/web-app/tests/server-log.spec.ts`, `packages/bundle/deamon/tests/deamon.spec.ts`, and `packages/client/ui-server-logs/tests/server-logs.client.spec.tsx`.
