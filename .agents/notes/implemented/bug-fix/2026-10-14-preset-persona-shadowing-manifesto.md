# Agent Note: The user-request manifesto reaches standard and ptc preset sessions

Status: implemented

English | [中文](2026-10-14-preset-persona-shadowing-manifesto.zh.md)

## Problem

The [user-request manifesto](../feature/2026-10-13-user-request-supremacy-manifesto.md) was deployed to the four bundle `personaPrefix` values and to the `cordis` preset, and the note claimed every shipped deployment persona carried it. The `standard` and `ptc` presets mount their own persona row whose prefix was the bare role sentence, and a preset persona row shadows the deployment persona entirely — so every session on those presets, which includes the Web GUI's default composition, assembled a system prompt whose persona was one line with no request-execution or reporting sections.

The gap was proven from the operator's model-gateway transcript logs: a standard-preset request carried an 11,014-character system prompt containing no manifesto heading, while cordis-preset requests in the same hour carried 34 KB prompts with the full block. The feature note's own sentence — the manifesto "also applies to every session whose preset does not shadow the persona" — named the condition without closing it.

## Decision

The `standard` and `ptc` preset persona rows carry the same manifesto block the bundles carry, transplanted byte-identically from `packages/bundle/web-app/cordis.patch.yml` (2,492 characters) immediately after the role sentence, with the scalar switched from folded (`>-`) to literal (`|-`) so the paragraph breaks survive assembly. A preset that shadows the deployment persona now ships the text it shadows with.

## Alternatives considered

**Delete the persona rows from `standard` and `ptc` so the deployment persona applies.** Removing the row stops the shadowing, but the row is the only way a preset owns its identity: a preset copied to another deployment keeps its persona instead of inheriting whatever that deployment's bundles carry, and the persona plugin exists for exactly that trade.

**Extend the persona plugin with a merge-with-deployment option.** A second assembly path (deployment prefix plus preset prefix) complicates the section model that shadowing keeps single-owner, and the feature note already accepted text duplication across files as the cost of that model.

**Move the manifesto into a plugin-owned `system-prompt` section.** Rejected by the feature note: sections are ordered and shadowable, and deployment role and behavior belong in the persona.

## Consequences

- The manifesto text now exists in seven files by construction — four bundle patches, the `cordis`, `standard`, and `ptc` preset persona rows — and a future edit must move all seven.
- Standard and ptc sessions assemble a prompt roughly 2.4 KB larger than before; the GUI default composition is the main beneficiary.
- `snapshots/web/schedule-catalog/system-prompt.expected.md` stays untouched per its owner note (authored sidecar, no runnable comparison in this tree); the raw-composition snapshots pin the bundle persona and were already correct.
- `sdk-minimal` keeps its bare, environment-selected persona unchanged.
- The verification path is the same evidence that exposed the gap: a new standard-preset session's outgoing request, read from the gateway transcript, contains the request-execution heading after the role sentence.

## Related

- [The user-request manifesto in every deployment persona](../feature/2026-10-13-user-request-supremacy-manifesto.md) owns the text and its precedence rules; this note closes its deployment gap.
