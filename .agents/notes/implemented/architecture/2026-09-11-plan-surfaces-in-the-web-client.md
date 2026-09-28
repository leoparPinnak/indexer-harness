# Agent Note: Plan state in the Web client: the Plan tab, the model's offer, and the intent cards

Status: implemented

English | [中文](2026-09-11-plan-surfaces-in-the-web-client.zh.md)

## Problem

Plan mode had one way in — the `/plan` command — and little to look at afterwards. A presented plan was reachable only through the review card of the turn that produced it and through the tab's single current pane, so a reader could not see how many plans a session had produced or return to an earlier one. Nothing let the model ask for planning when a request warranted it.

The one offer that existed asked with English option labels the Web client rendered verbatim, so a reader working in another language could not act on the card without translating the asker's words. A written reply to that offer was discarded, which made the offer read as declined and lost what the user had typed.

## Decision

**History is a fold, not a second store.** `plan-mode` folds every presented plan into `PlanProjection.presented`, oldest first and capped at fifty, and the view returns the newest as `presented` alongside the newest-first `history`; the projection's `stateVersion` moves to 5 because the state changed shape. The Plan tab gains current and history panes, the history pane carrying a count badge and one title-and-date row per plan, the current pane an apply action that leaves plan mode, and the tab a marker while the newest presentation is unseen.

**The model may offer planning.** `enter_plan_mode` lets a running agent ask whether to plan before implementing, carrying its reason as the question detail. The tool is available outside plan mode only, and an accepted offer enters plan mode through the service, so an open turn queues the switch exactly as `/plan` does. A reply that arrives as free text is not a refusal: it reaches the model as the user's own words, because dismissal is the card's route to "let me say it instead".

**A question intent renders its own copy.** A request may declare `plan-review` or `plan-offer`; the Web client narrows it to that intent and renders a decision card whose strip and verbs come from its own locale dictionary, answering with the asker's option labels verbatim so the wire encoding never changes. The review card keeps the asker's option descriptions as tooltips and the offer card does not: those descriptions are written in the language the asker writes prompts in, while the card is read in the reader's. A request that declares neither intent, or an intent this build does not know, still renders through the generic question flow.

**A pending offer is classified.** Session rows name `plan-offer` beside `approval`, `plan-review`, and `question`, so the sidebar states what a waiting session waits for.

## Alternatives considered

**Keep the offer on the generic question flow.** Rejected: the generic flow labels its buttons with the asker's own text, which is what made the offer unusable for a reader in another language.

**Show earlier plans inside the review card's own turn.** Rejected: that card belongs to the turn that presented the plan, and an earlier plan outlives it — which is the reason the tab tracks history at all.

**Translate the asker's option labels in the client.** Rejected: a label is the answer encoding, so it crosses the wire verbatim, and the locale-owned copy rule keeps product text in dictionaries rather than in translated data.

**Treat a written reply as a refusal.** Rejected: it dropped the user's words and reported a decision they had not made.

**Retain every presented plan.** Rejected: a session may present plans for hours, and the projection is rebuilt from the log it folds; the newest fifty bound what the view holds.

## Consequences

- `PlanProjection` accumulates one entry per presented plan for the session's lifetime; the cap bounds the view, not the fold.
- An unknown or unrenderable intent costs nothing: the generic flow keeps the request answerable, which is what the client's position downstream of a wire boundary requires.
- The offer card's accessible name is the asker's question text, so assistive technology reads the model's words even though the visible copy is the reader's.
- `enter_plan_mode` appears in the tool catalog and in every composition that mounts plan mode.

## Testing

`packages/plan/plan-mode/tests/projection.spec.ts` pins the history fold, including its cap and its newest-first order, and `plan-mode.spec.ts` pins the offer's behaviors — the accepted and declined paths, free text reaching the model, the plan-mode-only guard, and the assembled catalog listing the tool. `packages/client/ui-user-questions/tests/plan-presentations.client.spec.tsx` pins both narrowings and both cards, including a Turkish offer card answering with the asker's labels. `packages/client/ui-workspace/tests/tree.client.spec.ts` and `rows.client.spec.tsx` pin the `plan-offer` classification and its row label.
