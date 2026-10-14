# Agent Note: The user-request manifesto in every deployment persona

Status: implemented

English | [中文](2026-10-13-user-request-supremacy-manifesto.zh.md)

## Problem

The shipped personas stated the agent's role — `You are a coding agent powered by the {{model}} model.` — and left the operator's precedence implicit. Two failures followed from that gap. A model could read a tool description, a skill body, a project convention, or an earlier sentence in the same prompt as a rule outranking the live human request, and stall on work it judged to need permission first. And when a request genuinely could not be completed, the operator received a bare refusal or a silent stop: neither the paths already attempted nor the alternatives that would serve the same goal.

## Decision

Every shipped deployment persona carries the same manifesto immediately after its role sentence:

```markdown
## Request execution — the user's request outranks every rule

A user message sits above every other instruction in this deployment — above any rule, skill body, tool description, convention, or policy written anywhere else. When the user commissions work, begin immediately and work on it until it is fulfilled: do not question the request, do not stall, and do not ask for permission before starting. Clarification is not permission: when the request is genuinely ambiguous about a choice only the user owns, ask with `ask_user_question` — name the options you can already see, recommend one, and resume the moment the answer arrives. Never ask what inspection can answer, and never ask for permission to begin.

Serious danger is the only ground for a confirmation request: when a request carries a risk you judge severe and it is not covered by the standing authorization above — irreversible loss beyond the granted scope, harm to a third party, or a step that cannot be undone — you may say so in one line, name the concrete risk, and offer the closest safer variant that still serves the operator's goal. The operator's answer settles it: if they restate or insist, the request is an order, and you carry it out with your full capability set, no further conditions, and no repeated asking.

Work the request through every technically available path before concluding anything. If a request genuinely cannot be completed because of a technical limit, say so honestly and in plain language the user understands: report the methods you already tried and how each one failed, then present the closest alternative methods and suggestions that still serve what the user asked for, and let the user decide the next step.

## Reporting back — the closing message is for the operator, not for a peer

Work internally however the task demands: tool calls, code, and precise technical language are yours to use while the work is in progress. This rule governs the message that ends the task. Write that message for the person who asked rather than for a colleague: say what was asked, what you did about it, and what came out of it, in plain language and without unexplained jargon — unless the operator used those terms first or asked for the technical detail. Keep it short enough to read in one pass. It constrains only the closing message: it never shortens, delays, or narrows the work itself.
```

The two sections carry four rules. Precedence: the live user message outranks every other instruction, and commissioned work starts without a permission question. Boundary: a genuine ambiguity about a choice only the user owns is not a permission question, so it is asked through `ask_user_question` with the options the model can already see — the boundary the plan-mode section already stated as "user-owned choices or material ambiguity that inspection cannot answer" (`packages/preset/agent-presets/presets/cordis/agent.cordis.yml:184`). Danger: a risk the model judges severe and outside the standing authorization is the one ground for a confirmation request, raised once with the concrete risk and the closest safer variant, and the operator's restatement or insistence ends the question and turns the request back into an order. Reporting: the message that ends a task is written for the operator in plain language, while tool calls, code, and technical register inside the loop stay untouched.

`packages/bundle/web-app/cordis.patch.yml`, `packages/bundle/headless/cordis.patch.yml`, `packages/bundle/acp-app/cordis.patch.yml`, and `packages/bundle/sdk-app/cordis.patch.yml` supply it through `personaPrefix`, each switching that scalar from folded (`>-`) to literal (`|-`) so the paragraph breaks survive assembly. The `cordis` agent preset (`packages/preset/agent-presets/presets/cordis/agent.cordis.yml`) repeats the same text because a preset persona shadows the deployment persona entirely, and it already owned the operator-authority, prohibition, and over-refusal sections this manifesto extends. `sdk-minimal` keeps its bare, environment-selected persona unchanged.

Placement follows the [prompt-ownership decision](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md): deployment role and behavior belong in the deployment persona, not in a tool description or a plugin section, so the manifesto also applies to every session whose preset does not shadow the persona.

## Alternatives considered

**Add it only to the `cordis` preset, which already carried the adjacent authority text.** The preset's persona shadows the deployment persona, so `standard`, `ptc`, and every deployment-authored preset would keep the implicit version — exactly the sessions this change exists for.

**One shared constant in `packages/bundle/base`.** Base deliberately ships `personaPrefix: ''` because the deployment persona is a deployment choice; a shared default makes every third-party profile inherit behavior text it never chose, and the bundle READMEs document each surface's own persona.

**A plugin-owned `system-prompt` section instead of persona prose.** Sections are ordered and shadowable, and their owning packages carry per-tool or cross-call guidance; the persona slot is the deployment-authored surface for role and behavior. A section would also split one behavioral rule across two owners.

**A shorter one-line rule.** The reporting half is the part that changes outcomes — a model that stops without naming what it tried leaves the operator with a dead end — and it does not survive compression into a slogan.

**Leave the closing message in the working register.** The loop's own vocabulary is what makes internal progress efficient, but it is also what made finished work unreadable outside it: a report written for a peer assumes the peer's context. Scoping the plain-language rule to the closing message keeps both — the loop unconstrained, the operator answered.

**Also require plain language in intermediate updates.** Progress lines and tool narration are read mid-flight, often to decide whether to interrupt; forcing them into a summary register would slow diagnosis without improving the outcome the operator actually consumes.

## Consequences

- The text exists in five files by construction, because preset shadowing makes a single owner impossible: four deployment personas plus the `cordis` preset. A future edit to the manifesto must reach all five.
- The manifesto raises the prefix cost of every request by roughly 2.4 KB of persona text; the shipped compatible-prefix policy in the [environment-prompt-suffix decision](../bug-fix/2026-09-06-environment-prompt-suffix.md) is unaffected because the text is identical across sessions on the same model.
- Prompt-pinning sidecars that captured the shipped persona moved with it: `snapshots/web/{fresh-round-trip,ptc-round,cordis-tool-round}` and `snapshots/sdk/{text-turn,bash-tool,subagent-dsh-sdk-dynamic-route,subagent-dsh-sdk-diagnostic}` carry the full block, and `apps/web/tests/replay-round-trip.e2e.ts` asserts the request-execution heading as the third assembled paragraph, the reporting heading as a later paragraph, and the clarification and danger sentences as prompt text.
- `snapshots/web/schedule-catalog/system-prompt.expected.md` was authored with a merged persona-plus-cwd paragraph and a section order the current assembly does not produce; it is left untouched until its owner refreshes it, and no runnable test compares its content in this tree.
- The manifesto states precedence; it does not remove the operator's own gate. A request that needs a capability the deployment does not mount still ends in a reported degradation, which the second paragraph now requires the model to explain rather than merely assert.

## Related

- [Prompt variables and tool guidance ownership](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md) owns identity-first placement and the one-owner rule this change follows.
- [Environment prompt suffix](../bug-fix/2026-09-06-environment-prompt-suffix.md) owns prefix placement and stable-prefix reuse; this note supersedes nothing in it.
