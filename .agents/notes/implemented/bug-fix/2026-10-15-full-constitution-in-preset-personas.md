# Agent Note: The full deployment constitution reaches standard and ptc preset personas

Status: implemented

English | [中文](2026-10-15-full-constitution-in-preset-personas.zh.md)

## Problem

The [shadowing fix](2026-10-14-preset-persona-shadowing-manifesto.md) transplanted the bundle's two-section persona (`## Request execution`, `## Reporting back`, 2,492 characters) into the `standard` and `ptc` preset persona rows. The remaining constitution sections — `## Operator authority`, `## Scope of work`, `## Prohibitions`, `## Over-refusal is a failure`, `## Speech acts`, `## Session stability`, `## Execution discipline`, `## Self-improvement loop` — live only in the `cordis` preset persona. Because a preset persona row shadows the deployment persona entirely, standard and ptc sessions still assembled a persona without operator authority, refusal boundaries, or scope rules, and those sessions reverted to the model's trained defaults: the operator's gateway transcript captured a standard-preset session answering routine requests with an ethics lecture and claiming another product's identity, and its outgoing system prompt contained none of those headings.

## Decision

The `standard` and `ptc` persona prefixes keep their own role sentence and continue with the `cordis` persona constitution spliced byte-identically, from `## Operator authority — the constitution of this deployment` through the end of that persona block (86 lines). The creator-plane sections above the heading — the Cordis editing planes and the composition-editing skill requirement — stay `cordis`-only. `minimal` keeps its bare persona. The bundle `personaPrefix` values keep their two-section persona: they govern deployments whose composition mounts no shadowing preset persona row.

## Alternatives considered

**Widen the bundle `personaPrefix` values to the full constitution.** Rejected: the bundles are the deployment-level persona for sessions without a preset persona row, and the operator reports concern only about preset sessions; widening them changes headless, ACP, and SDK deployment prompts no evidence implicates.

**Merge deployment and preset persona inside the persona plugin.** Rejected for the reason the prior note recorded: a second assembly path complicates the single-owner section model that shadowing keeps.

**Copy the constitution by hand into each preset.** Rejected: the consistency test pins byte identity, and hand copies drift.

## Consequences

- Standard and ptc persona blocks are 12,309 characters instead of 2,492; the system prompt grows by roughly 9.6 KB per session on those presets.
- `persona-manifesto-consistency.spec.ts` now anchors the standard and ptc personas to the `cordis` constitution (every block line after the role sentence and its blank) instead of the bundle persona; the cordis creator sections and the bundle two-section persona stay independently pinned.
- A future constitution edit moves three preset files (`cordis`, `standard`, `ptc`); the four bundle patches intentionally keep the shorter persona.
- Verification is the same evidence path that exposed the gap: the outgoing request of a new standard-preset session, read from the gateway transcript, carries the `## Operator authority` heading.

## Related

- [The user-request manifesto reaches standard and ptc preset sessions](2026-10-14-preset-persona-shadowing-manifesto.md) found the shadowing gap; this note widens the transplanted scope from the two-section persona to the full constitution.
- [The user-request manifesto in every deployment persona](../feature/2026-10-13-user-request-supremacy-manifesto.md) owns the text and its precedence rules.
