---
description: "The tool-result spill policy: how deployments keep oversized plain-text tool results out of the model's context with a preview and a retrievable spill file."
kind: "package-reference"
---

# @deepseek-ai/dsh-spill-policy

English | [中文](README.zh.md)

## Summary

Mount this package when oversized plain-text tool results should stay out of model context. Results above their applicable budget — `maxInlineBytes`, or the tool's `toolLimits` row — become a totals receipt, a bounded head/tail preview, and a `[budget notice]`, while the full text remains available through the configured spill backend. Spill failures leave the original result visible, and omitting `maxInlineBytes` disables the policy. The same budget bounds durable `run_code` sub-call log copies without changing the value returned to the program.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the policy alongside a spill backend to cap how much of a tool's plain-text result the model sees. The cap applies to final results after the tool has run; results the policy leaves alone still pass through unchanged.

### Minimal configuration

Load the policy with a `maxInlineBytes` budget, in UTF-8 bytes, and a spill backend:

```yaml
- name: '@deepseek-ai/dsh-spill-local'
- name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
```

| Field | Default | Meaning |
|---|---|---|
| `maxInlineBytes` | omitted | Default model-facing context cap for a plain-text result, in UTF-8 bytes; omitted disables the policy entirely |
| `toolLimits` | `{ read: 'skip' }` | Per-tool retain rows merged over the shipped defaults: a non-negative byte budget, or `'skip'` to keep that tool's model-facing result inline |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-spill-policy) is the exhaustive source for every accepted field. A negative or fractional cap or row fails plugin load rather than corrupting per-call behavior.

### What the model sees

An oversized plain-text result is replaced by an envelope plus a notice inside the same budget, so the whole replacement never exceeds the applicable budget:

```text
spill: { chars: 1600, bytes: 1600 }
<retained head>
[truncated after 200 bytes]
<retained tail>

[budget notice] (Omitted N bytes. Full formatted result stored at: /…/session-…/…-web_fetch.txt. Use read with offset/limit, or grep this path to search within it.)
```

The receipt row preserves the totals the bounded preview cannot show, the truncation marker states the budget that cut the result, and the `[budget notice]` prefix marks the outcome as a budget decision rather than a tool failure. When no preview bytes fit (a tiny budget or a long locator), the receipt and the notice are returned alone; if even that would exceed the budget, the policy keeps the original inline result — a within-cap replacement is always smaller than the original. The full text stays available in the spill file, and a successful replacement changes only the model-facing copy, never the canonical programmatic result.

### Per-tool retain rows

`toolLimits` refines the global cap per tool: a numeric row replaces `maxInlineBytes` for that tool's model-facing result, and `'skip'` keeps it inline without spilling. The shipped defaults carry `read: 'skip'`, so the documented `read → spill → read again` loop guard is data a deployment can retune instead of a hard-coded name check. Rows never enable the policy on their own — omitting `maxInlineBytes` still disables everything — and a numeric row also retunes that tool's durable log copy, while a `'skip'` row does not (a log copy is not model context, so the log arm stays bounded).

### Budget durability

Every persistence attempt feeds two state machines. A thrash detector reports one artifact being spilled three times in a row — the spill-side signal that a file or tool output is too large for the context window — with a warning that suggests reading in smaller chunks or starting a fresh session. A circuit breaker opens after three consecutive `saveText` failures, logs one clear error, and then keeps oversized results inline for the rest of the session: a failing backend costs one message instead of one failed write per oversized result. Both degrade best-effort, so a spill problem never changes a tool call's outcome.

### Which results are affected

The policy shapes only final, accepted, plain-text results. Results at or below the applicable budget, results containing any non-text block, nested composite calls, results whose row says `'skip'` (`read` by default), blocked decisions, and accepted value replacements all pass through unchanged. Provider-level truncation that already happened (for example `web-fetch-http.maxBodyChars`) cannot be recovered here — the spill file holds what the tool actually returned.

### Best-effort failure behavior

A missing session owner, a missing `ctx.spillStore` backend, or a `saveText` rejection logs a warning and returns the original result. Three consecutive rejections open the circuit breaker, which logs one clear error and keeps later results inline without further save attempts. A spill failure never turns a successful call into an error and never hides the inline result.

### The durable log copy

The same per-tool budget also bounds the session-log copy of each `run_code` sub-call result: the program still receives the complete value, only the log's copy is replaced with the envelope and locator. `read` sub-call results are bounded here too, since a log copy is not model context — a `'skip'` row only governs what the model sees.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the policy; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The policy is deliberately narrow: it only decides **when** and **at what budget** to spill and composes the envelope and the notice. It registers no service, owns no storage, and owns no preview mechanics — `TextRetainer` from `dsh-output-retention` builds the head/tail preview. Two invariants shape the code: the model-facing replacement never exceeds the applicable budget (the envelope rows' and the notice's byte cost are reserved out of the budget first), and a spill failure never changes the tool call's outcome.

### The two arms

A `tools/post-execute` waterfall listener (registered with `prepend`, delegating via `next()`) bounds the model-facing result; a `tools/ptc-dispatch-log` listener bounds the durable log copy of each `run_code` sub-call. Both share one replacement helper so the two projections are byte-identical. The post-execute arm consults the per-tool rows — the shipped `read: 'skip'` row avoids a read → spill → read loop — while the dispatch-log arm bounds `read` sub-calls because a log copy is not model context.

<a id="shared-notice-ownership"></a>
### Shared notice ownership

The browser-safe `@deepseek-ai/dsh-spill-policy/notice` entry owns both `formatSpillNotice(omitted, ref)`, used by the producer, and `hasSpillNotice(text)`, used by presentation consumers. Formatting and recognition share the notice delimiters; omission validation uses the existing `describeOmitted` formatter rather than a second copy of its prose. Recognition accepts a complete final notice after a preview or by itself, in the tagged `[budget notice] (…)` spelling and in the untagged spelling recorded by earlier releases, so sessions persisted before the tag keep their presentation. It reads recorded text without rewriting it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` validation, the per-tool row resolution, the two waterfall listeners, the shared replacement helper |
| [`src/notice.ts`](src/notice.ts) | Browser-safe notice formatting and recognition, published as `./notice` |
| [`src/envelope.ts`](src/envelope.ts) | Head/tail envelope rows: the totals receipt, the truncation marker, published as `./envelope` |
| [`src/resilience.ts`](src/resilience.ts) | The thrash detector and persist circuit breaker state machines |
| [`src/types.ts`](src/types.ts) | `SpillPolicyExec`: the minimal structural view of a tool execution the policy reads for the owning session id |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Failure modes

Best-effort degradation applies to both arms: no session owner, no backend, a save rejection, an open circuit breaker, or no within-cap replacement logs a warning and keeps the original content. Load-time validation rejects a negative or fractional `maxInlineBytes` and any `toolLimits` row that is neither a non-negative integer nor `'skip'`, so a bad config fails the deployment, not every oversized call.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Spill storage service](../spill/README.md) — the `saveText` contract behind the policy's replacement.
- [dsh-spill-local](../spill-local/README.md) — the local backend that stores the spilled text.
- [dsh-output-retention](../../util/output-retention/README.md) — the preview mechanics (`TextRetainer`) the policy composes.
- [Tool output spill decision](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) — the capability boundary and design rationale.

-----

<a id="model-experience"></a>
## Model Experience

### Oversized plain-text result

#### What the model sees

Results at or below the applicable budget, nested results, results whose row says `'skip'` (`read` by default), blocked decisions, and results containing non-text blocks are unchanged. An oversized plain-text model-facing result becomes an envelope — a `spill: { chars, bytes }` receipt, the retained head, a `[truncated after <budget> bytes]` marker, and the retained tail — followed by `[budget notice] (Omitted <bytes> bytes. Full formatted result stored at: <locator>. <retrievalHint>)`; a storage or ownership failure, or an already-open circuit breaker, leaves the original result visible.

#### Token effect

A successful replacement is at most the applicable budget in UTF-8 bytes and remains in history until compaction; the full spill text is not resent to the model. A repeated spill of one artifact or three consecutive save failures are reported through host warnings, not through the result text.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the policy cannot help. They are current package constraints.

- **Text recognition cannot authenticate output** — a tool can print the same notice text; `hasSpillNotice` identifies a text convention, not proof that the policy saved a result.
- **Only final plain-text results are spillable** — mixed-content results, blocked feedback, and results whose row says `'skip'` (`read` by default) pass through; provider truncation or tool-owned retention that happened earlier cannot be recovered here.
- **The envelope has a floor** — the receipt row, the truncation marker, and the notice must all fit the budget, so a budget below that floor (or a long locator) leaves the oversized original inline after the backend has already saved an unreferenced spill.
- **The circuit breaker is sticky and out-of-band** — once open it keeps results inline until the plugin reloads, and thrash detection reports through host warnings rather than the result text.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions. It is explicitly non-authoritative.

#### Future: earlier spill

The policy only sees final formatted text, so content already capped by a provider or held only as runtime artifacts (for example bash streams or subagent rollouts) stays out of reach; tool-owned early spill through `ctx.spillStore` is deferred.

</details>
