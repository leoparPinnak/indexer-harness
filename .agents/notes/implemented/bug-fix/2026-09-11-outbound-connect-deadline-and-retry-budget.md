# Agent Note: Own the outbound connect deadline and widen the default retry budget

Status: implemented

English | [中文](2026-09-11-outbound-connect-deadline-and-retry-budget.zh.md)

## Problem

A model request whose TCP SYN is never answered waits out undici's ten-second connect timeout, and only then does the retry policy schedule another attempt. Five attempts therefore spent about 66 seconds before the turn failed, and each attempt held the turn for a full ten seconds. On a path that drops the occasional SYN — measured on the reporting machine as connects to `api.deepseek.com` (CloudFront edge 3.173.21.63) ranging from 0.06 s to 9.2 s, with ICMP clean and other CloudFront origins answering in milliseconds — the harness could not recover, and the deadline it waited on was not addressable by any deployment.

undici's connect timeout belongs to the dispatcher. `dsh-http-proxy` owned the global dispatcher but installed nothing when the launch environment named no proxy, so a direct process ran on Node's built-in dispatcher with undici's own default and no way to shorten it.

## Decision

`dsh-http-proxy` installs a dispatcher for every policy, including the one that proxies nothing, and every dispatcher and pool it builds carries `connect: { timeout: connectTimeoutMs }`. `DSH_CONNECT_TIMEOUT_MS` resolves that deadline from the launcher's environment snapshot; the default is 4000 ms, and an unusable value fails the launch instead of being reported and skipped the way a proxy URL is, because no other tool can have meant this name.

Four seconds admits one SYN retransmission on Windows, whose initial RTO is three seconds, and ends a connection that will not be established about two and a half times sooner than undici's default; a handshake on a working path completes in milliseconds.

`DEFAULT_MAX_RETRIES` rises from 5 to 8. Each attempt is now bounded by the transport deadline, so eight attempts spend a patience budget of the same order as the previous five while giving the request more independent chances to cross a lossy path, and the first recovery arrives sooner.

The retry notice's delay label states that the value is planned — `重试延迟（计划）`, `Retry delay (planned)`, `Yeniden deneme gecikmesi (planlanan)`. The row prints the scheduled backoff before the wait, and readers were taking it for time already elapsed.

## Alternatives considered

**A request-level deadline in the provider adapter.** Rejected: a deadline around `fetch` resolves with the response headers, so a large inline body uploading over a slow uplink would be aborted as though the connection had failed. Only the dispatcher's connect timeout bounds connect and TLS alone.

**Shorten the deadline only when the environment names a proxy.** Rejected: the reported stalls happened on a direct path, which is exactly the case that installed no dispatcher.

**Keep undici's default deadline and retry more often.** Rejected: it leaves every lost SYN worth ten seconds of stalled request, which is the wait being removed.

**Raise `maxRetries` without bounding the attempt.** Rejected: more attempts at ten seconds each is a longer stall, not better recovery.

## Consequences

- Every `dsh` process installs a dispatcher, so `getGlobalDispatcher()` is no longer Node's built-in object on a path that proxies nothing. That case still leaves the environment untouched, and `proxyRouteFor` still reports a direct route.
- A connect deadline below the path's round trip turns reachable origins into failures. `DSH_CONNECT_TIMEOUT_MS` raises it; the package README states the trade-off.
- A hard-down provider now costs about 78 seconds of retries before the turn fails, against about 66 seconds with the previous pair of defaults.
- The label change is client-owned copy, so it reaches the GUI only through a rebuilt client bundle.

## Testing

`packages/util/http-proxy/tests/install.spec.ts` pins the direct-path install, enforcement of the configured deadline against a routed-nowhere address (TEST-NET-1), the resolution default, accepted values, and load-time rejection of the rest. `packages/llm/llm/tests/retry-policy.spec.ts` and `packages/llm/llm/tests/service.spec.ts` pin the new retry default, and `apps/web/tests/shipped-composition.e2e.ts` and `apps/web/tests/smoke-real.e2e.ts` pin it as the shipped profile's policy. `packages/client/ui-chat/tests/chat-branch-tails.client.spec.tsx` pins the localized label.
