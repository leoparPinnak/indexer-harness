# Agent Note: Compaction gates on provider-anchored pressure

Status: implemented

English | [中文](2026-10-15-provider-anchored-compaction-gating.zh.md)

## Problem

Providers rejected requests with `input token count exceeds the maximum number of tokens allowed 1048576` while every in-app figure read far below the limit: the context meter showed roughly 600K tokens and compaction recorded `giren 63803` against the same route's 1M ceiling. Two measurement facts produced the gap.

The fixed 4-characters-per-token heuristic systematically underprices JSON tool schemas, code, and non-Latin text — the token-meter's own projection notes record that as an intentional display-only trade ("a user-facing reference, not a billing or gating input"). And the meter kept ONE provider anchor per session: the moment the request envelope changed — a model switch, which these sessions do constantly — the anchor was dropped and the whole measurement fell back to the heuristic, silently discarding the provider's real count. Compaction then gated on that measurement against real-unit thresholds (the routed model's declared capacity times `thresholdRatio`), and the summarizer sized its replay windows with the same heuristic, so both the trigger point and the summarizer request could overshoot the provider's hard ceiling. A summarizer route with no declared capacity was worse: the window budget became unbounded and one call carried everything.

## Decision

- The token meter keeps one provider anchor per request envelope (four at most, evicted oldest-first). A model switch no longer costs the anchor: each route's provider-reported count survives until that route's own next call replaces it, and an envelope with no captured anchor measures on the heuristic as before.
- `compaction-basic` gates through a new policy field `estimateSafetyFactor` (default `1.5`, validated `>= 1`). A measurement on a provider usage baseline (`baseline.kind === 'usage'`) is the provider's own count and gates as it stands; a heuristic one is trusted at the factor before it meets a real-unit threshold.
- The summarizer prices the tool schemas, system head, instruction, and packed messages at the same factor before subtracting them from `contextWindow − maxTokens`, and a summarizer route that declares no context capacity refuses to condense with `TargetPressureConfigError` naming the route instead of sending one unbounded window.

## Alternatives considered

**Inflate the displayed figures too (fix the estimator's densities).** The projections document their heuristic as a display reference; pricing only the gating paths keeps the display and its recorded snapshot sidecars stable while the gate stays conservative. A density-aware estimator is the deeper fix and needs a recorded-session pass.

**Reserve a flat margin instead of a factor.** A constant reserve cannot know how far the heuristic sits from this tokenizer's real count; the factor scales with the content actually being priced.

**Count tokens through the provider before every request.** Adapters expose no count endpoint, and a preflight round-trip would double request latency; the provider's own usage from the previous call is the exact figure already available.

## Consequences

- Automatic compaction fires earlier on heuristic measurements (when `estimate × factor` crosses the threshold), which is the intended direction: the request that would cross the real ceiling happens after compaction, not before it. Provider-anchored measurements gate unchanged.
- Per-route anchors cost one bounded map per session and keep the fold O(surface).
- `SummaryConfig` carries the factor so fallback summarizer routes price identically to the primary one.
- The compaction rows' `giren`/`çıkan` figures keep their recorded values — they ride the session events, not a recomputation — so no recorded-session sidecar moves.

## Related

- The [token-meter README](../../../../packages/llm/token-meter/README.md) owns the anchor semantics; the [compaction-basic README](../../../../packages/compaction/compaction-basic/README.md) owns the policy field and the fail-loud capacity rule.