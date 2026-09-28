# Agent Note: Windowed compaction summarization with per-session compaction modes and context budget

Status: implemented

## Problem

Shrinking a model's context window broke compaction: the one-shot summarizer sent the whole compactable region plus its instruction envelope in a single call, and on small windows that call itself overflowed. The overflow surfaced to the user as `Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.`, with root causes of a summarizer call that does not fit the window and a shrink validation failure. Nothing in the UI showed where auto-compaction would trigger or which strategy would summarize, and none of it was adjustable per session.

## Decision

### Windowed map-reduce pipeline

The compaction-basic default summarizer packs the compactable region into whole-message windows under the target model's declared `contextWindow` minus the generation cap, routed tool schemas, the system head, and the instruction framing. Each window is checkpointed by one map call whose instruction identifies the call as one section of a longer conversation; map outputs are framed as tagged partial checkpoints. Merge rounds consolidate partials until one group remains, and the final call produces the summary. A span that fits one window keeps the legacy one-shot call, with its prompt and framing byte-stable. One message larger than the window budget and partial checkpoints that cannot consolidate into one summary fail loud with named limits. Every map and intermediate merge call is recorded in `compaction/summary.intermediateCalls` with its stage (`window` or `merge`), raw output, and resolved provider/model.

### Per-session compaction mode and trigger point

`compaction/mode` is a whole-value-replace session event: summarizer target (`conversation` model or a dedicated `provider`/`model`) plus optional `contextBudgetTokens`, `thresholdTokens`, and `maxTokens` overrides. The single write path is `setCompactionMode` in `@deepseek-ai/dsh-compaction`, exposed at the `session.setCompactionMode` Remote. Reads fold `compaction/mode` and `request/context` into the `compactionPolicy` session projection, whose view resolves the effective budget (`contextBudgetTokens` override or the routed model's declared capacity), trigger point (`thresholdTokens` override or `thresholdRatio` of the budget), and summarization output cap (`maxTokens` override or the backend's configured `maxTokens`). Both automatic pressure compaction and the manual `Sıkıştır` action read the same per-session mode; the default mode summarizes with the conversation model. The `contextPressure` projection prices occupancy against the effective budget, so the context meter's denominator is the session budget when one is set. The model-capacity tuning pane in `ui-model-selection` is superseded by the per-session budget; the per-model default `contextWindow` moves to the models settings page, and the deployment default for the compaction cap is editable on the General settings page (`compaction-basic.maxTokens`).

### Chat visibility

A windowed run is visible while it runs: the map stage appends `compaction/windows`, and the chat compaction marker folds `status` (`running`, `landed`, `failed`) and `windows` from the correlated lifecycle events. A running windowed marker reads "Pencereli özetleme çalışıyor ({windows} pencere)"; the landed marker keeps the window count.

## Alternatives considered

**Keep one-shot summarization and only enlarge the retry headroom.** This leaves the overflow class intact: any region bigger than the window still fails, and the failure is exactly the one users hit after shrinking their window.

**Shrink the summary prompt or summary budget to fit.** The prompt already fits ordinary windows; compressing it trades summary fidelity for no safety gain on very small windows, where the region itself is the problem.

**A per-session window-token override (window size for packing).** Rejected in favor of budget and trigger-point controls: the packing width is a property of the target model's real window, while what the user wants to govern is where compaction starts and how much context the session may hold.

**Command-line `/compact` arguments for the mode write.** The permission-presets command precedent was weighed against the `model/selection` Remote precedent. The write is a form-shaped, silent, whole-value selection like model selection, so it ships as `session.setCompactionMode`; the compact command keeps running compaction now.

**A settings-level default context window only.** Kept as well, not instead: the settings value seeds new sessions, and the per-session budget is the live knob. Neither alone covers both needs.

## Consequences

Windowed summarization costs one map call per window plus merge rounds, and each map call replays the system head and routed tool schemas to keep the provider prefix cache warm; compaction-basic's Model Experience section prices this. `compaction/summary` grows by `intermediateCalls` records and `compaction/windows` enters the durable log, which is additive to the session format and does not bump `SESSION_FORMAT_VERSION`. The one-shot path is byte-stable, so recorded snapshots of ordinary compaction output do not move. An intermediate repair of a `resolveCallWithInfo` typecheck error silently replaced the documented unsupported-effort rejection with a fallback; this change restores the rejection, which the llm service suite and the session-models suite pin.

## Testing

The compaction-basic windowed suite pins multi-window map and single-merge runs, intermediate merge rounds, the convergence failure, the oversized-message failure, one-shot stability, the `compaction/windows` notice, and dedicated-mode routing. The mode suite pins the vocabulary guard and whole-value writes; the policy-projection suite pins the fold and the effective budget and trigger point; the token-meter suite pins the budget denominator. The session-controller suite pins the write, the guard rejection at the wire, and the shared not-found path. The chat node suite pins the running, landed, and failed phases with their window counts on both the automatic and manual paths.
