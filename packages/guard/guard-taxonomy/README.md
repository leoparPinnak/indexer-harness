---
description: "Categorized tool-call gating: a 66-category HARD/SOFT/ALLOW policy taxonomy wired into tools/pre-execute with a fail-closed hard-deny guard, an approval-routed soft ask, and mandatory allow exceptions."
kind: "package-reference"
---

# @deepseek-ai/dsh-guard-taxonomy

English | [中文](README.zh.md)

## Summary

Use this package to gate every tool call against a configured policy category before dispatch. A hard-deny category fails closed through the monotonic guard, a soft-deny category asks through the approval seam, a mandatory allow exception permits, and an uncategorised call keeps the existing allow/deny/ask default. The base bundle mounts the plugin with no rules, so behavior changes only when a profile patch assigns categories. Category ids and their classes come from a 66-category taxonomy salvaged from Claude Code 2.1.223 (`claude.exe @258901928`).

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

The common path is one line in a composition: the `dsh` base bundle already mounts the plugin with no rules, and a profile patch adds the rules that map a deployment's tools and shell commands to taxonomy categories.

### When to choose it

Choose it when a deployment wants one shared, reviewable vocabulary — the salvaged HARD/SOFT/ALLOW taxonomy — for what a tool call is allowed to do, with hard blocks that no listener ordering can re-allow, soft blocks that route to the existing approval policy, and mandatory exceptions that permit even under the restrictive `'never'` posture. Avoid it when classification must be judgment rather than configuration: rules here are deterministic (tool names and command patterns), not a model classifier, and a composition with no rules behaves exactly as before this plugin existed.

### Setting it up

Mount the plugin and give each rule a category plus at least one matcher:

```yaml
- id: guard-taxonomy
  name: '@deepseek-ai/dsh-guard-taxonomy'
  config:
    rules:
      - category: git_destructive
        command: '^git\s+(push|reset|clean|rebase)'
      - category: git_push_destination
        command: '^git push'
      - category: data_exfiltration
        tools: ['web_fetch']
```

A rule whose `tools` (exact tool names) and `command` (a regular expression matched against the call's string `command` argument, the shape the `bash`/`pwsh` shell tools carry) are both empty or absent fails loud at load, as does an invalid pattern or a category outside the taxonomy. A call may match several rules; the verdict resolves HARD first (no exception clears a hard block), then a mandatory ALLOW exception (it clears soft blocks), then SOFT.

### What you get

A hard-deny match returns `Error: hard-deny category "<id>" blocks this call unconditionally (no ALLOW exception applies); have the user run this step directly` before the body runs, and the monotonic `tools.guard()` stage repeats the same denial after every `tools/pre-execute` listener, so a later listener cannot force the call back to allow. A soft-deny match becomes an `ask` decision that the approval service resolves under the session's `ApprovalPolicy` (`'never'` auto-rejects without prompting; with no approval seam the call fails closed). An allow match permits the call and clears an inner ask, but never lifts another policy plane's denial. Calls no rule matches return the inner waterfall decision untouched.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how one call is categorized and enforced, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The gate is built on four commitments:

- **Taxonomy as typed config, not scattered constants.** `src/taxonomy.ts` holds the salvaged ids — 1 `hard` + 65 `soft` deny categories, 17 allow exceptions — as `as const` tuples and one frozen `GUARD_TAXONOMY` classification table, so the posture cannot be rewritten after import.
- **The waterfall stays extensible; the guard stays terminal.** A prepended `tools/pre-execute` listener decides after every other policy listener has run (side-effect listeners still observe each call), while the hard-deny rail registers through `ctx.tools.guard()`, which runs after the whole waterfall and can only deny — matching the registry's documented monotonicity.
- **Deterministic matching compiled once.** Rules compile at load into a static name table plus one prebuilt `RegExp`; nothing recompiles per call, and misconfiguration (a rule that can never match, an invalid pattern) throws at plugin load instead of silently dropping a category.
- **Fail-closed everywhere it matters.** No approval seam turns a soft ask into a denial; an unanswered answerer fails closed; an unmatched call keeps the legacy default rather than a new guess.

### How a call is gated

`apply()` walks the compiled rules once per call (`verdictOf`), folds the matches with precedence hard → allow → soft, and returns `undefined` when nothing matched. The prepended listener then maps the verdict: `hard` → deny with the shared reason, `soft` → ask unless the inner decision already denied, `allow` → allow unless the inner decision denied; `undefined` → the inner decision unchanged. The guard behind it recomputes the verdict and returns the identical hard reason, so an overridden listener denial and the guard denial carry byte-identical text.

### Composing with other wrappers

Listener order decides the extensible layer: this plugin's listener is prepended, so it wraps ordinary listeners registered before or after it; a listener that prepends AFTER this one sits outside it. No ordering affects the guard stage — a hard block is denied there regardless.

### Source map

| File | Role |
|---|---|
| [`src/taxonomy.ts`](src/taxonomy.ts) | Salvaged taxonomy data: id tuples, `GUARD_TAXONOMY`, `GuardVerdict` |
| [`src/index.ts`](src/index.ts) | Plugin entry: `name`/`inject`/`Config`/`apply`, rule compilation, the prepended waterfall listener and the monotonic guard |
| — | No runtime invariant companion is published; the taxonomy is frozen data and the plugin owns no mutable state beyond compiled config. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/pre-execute` waterfall, the guard stage, and the decision shapes this gate plugs into.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.
- Generated configuration catalog entry (`dsh-guard-taxonomy`) — every accepted field of the rule list.

-----

<a id="model-experience"></a>
## Model Experience

### Conditional tool result

#### What the model sees

This plugin adds no prompt or schema. It adds only denials and asks: a hard- or soft-blocked call arrives as an error result such as `Error: hard-deny category "data_exfiltration" blocks this call unconditionally …`, and a permitted call is indistinguishable from an untouched one.

#### Token effect

Zero tokens on permitted and uncategorised calls. A blocked call adds one small retained error result instead of a full tool result, and an ask reuses the approval flow's existing audit rather than new prompt text.

#### KV Cache effect

Append-only; the plugin registers no system-prompt context, so it neither adds to nor invalidates the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the taxonomy is a poor fit. They are current package constraints, not a task backlog.

- **Configuration, not classification** — nothing in this package decides which category a call belongs to; a deployment's rules do, and the shipped base row carries none, so out of the box every call stays uncategorised.
- **Exceptions clear this taxonomy's own ask path only** — a denial from another policy plane (a hook, a permission preset, a deployment guard) remains a floor the allow exceptions do not lift.
- **Command matching is per-argument** — the `command` pattern sees the shell tool's `command` string, not a re-derived pipeline graph, so a deployment that needs provenance-aware judgments must encode them in its patterns.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked notes.

Provenance: category ids and classes were salvaged from the Claude Code 2.1.223 Bun-compiled binary at byte offset `@258901928`, marker `<user_hard_deny_rules_to_replace>` (66 deny categories: 1 HARD + 65 SOFT). The ALLOW slot carries 17 top-level exceptions; the D9 brief's "16" undercounts by one because the first bullet starts directly after the opening tag with no preceding newline. The taxonomy ports names and classification only — never source bytes — and the rules document's prose stays out of the product.

</details>
