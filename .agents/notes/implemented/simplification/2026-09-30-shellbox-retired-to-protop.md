# Agent Note: Shellbox retired from the product into protop/shellbox

Status: implemented

English | [中文](2026-09-30-shellbox-retired-to-protop.zh.md)

## Problem

Shellbox — the isolated private Windows desktop streamed into the Web GUI — lived as the `@deepseek-ai/dsh-deamon` bundle glued into the shipped `web` profile. On the operator's machine it kept misbehaving: injected PowerShell lost its quoting, a requested private desktop silently fell back to the user's real `Default` desktop, the viewport/target math oscillated into degenerate targets, a local service on the helper's fixed port 4005 starved every desktop, and a stale installed build amplified all of it. The feature was also believed to be separable all along ("it should have been a plugin anyway"), and continued presence in the product surface kept re-earning attention the feature's maturity does not deserve.

## Decision

The whole feature leaves the product workspace and parks as a prototype:

- `packages/bundle/deamon` (npm `@deepseek-ai/dsh-deamon`) → `protop/shellbox/deamon/`
- `packages/client/ui-sandbox-view` (npm `@deepseek-ai/dsh-client-ui-sandbox-view`) → `protop/shellbox/ui-sandbox-view/`
- `benchmarks/gui-motor` → `protop/shellbox/gui-motor/`

`protop/` is outside every pnpm workspace glob, so the three trees build and test nothing by default; `protop/README.md` records the extraction map and the reuse steps. Package names, the frozen `sandbox/PROTOCOL.md` wire, and the `shellbox-*` tool schemas are preserved verbatim for a future clean re-add.

Product wiring follows the feature out: the shipped `web` profile template is `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`, the browser roster and CLI in-box list lose their deamon entries, the cdp/ipc-pipe/bundle READMEs stop citing the feature, and every generated catalog is regenerated without it. The model-visible surfaces leave with the bundle: the `app:shellbox-surface` and `app:shellbox-changes` prompt sections, the `shellbox_launch`/`shellbox_state`/`shellbox_input` tools, and the bundled `shellbox` skill no longer reach any prompt or tool catalog.

Two retired durable-record names stay readable through `packages/session/session-persistence/src/retained-log-vocabulary.ts`: pre-retirement session logs contain `shellbox/change` and `shellbox/ack` events committed without `ignorable`, and the read path refuses logs whose types are unknown and unmarked. The retention file declares them as type merges with no producer, so existing corpora keep interpreting while the refusal guard keeps its meaning for genuinely foreign logs.

On the live installation the feature was switched off the same day it was retired, first by a `disabled: true` row patch and then by the slimmed profile manifest, and the web was restarted from the post-retirement tree.

## Retirement map

| Was | Is |
|---|---|
| `packages/bundle/deamon` | `protop/shellbox/deamon` |
| `packages/client/ui-sandbox-view` | `protop/shellbox/ui-sandbox-view` |
| `benchmarks/gui-motor` | `protop/shellbox/gui-motor` |
| `web` template tuple (3 bundles) | `web` template tuple (2 bundles) |
| `shellbox/change`, `shellbox/ack` producers | `retained-log-vocabulary.ts` declarations (no producer) |
| model surfaces (2 prompt sections, 3 tools, 1 skill) | preserved in the prototype only |

## Alternatives considered

- **Ship it disabled behind a feature flag** — rejected: the coupling (bundle rows, prompt sections, catalog rows, helper port reservations) stays load-bearing code, and the persona keeps advertising a capability the operator wants gone from his face.
- **Delete the implementation outright** — rejected: the D8 dual-backend GUI motor, the frozen wire contract, and the helper fixtures are expensive to re-derive; the operator wants the work parked and documented, not destroyed.
- **Fix the defects in place and keep shipping** — rejected: the operator's standing instruction is deactivation and extraction; defect repair belongs to the rebuild, seeded from the diagnosis recorded in `protop/README.md`.
- **Let `shellbox/*` leave the event vocabulary** — rejected: the read path would refuse every pre-retirement log that touched the feature (see the decision above).
- **Retro-fit `ignorable: true` onto historical `shellbox/*` events in the log corpus** — rejected: the classification is semantically right, but mutating an operator's chat archives with a one-shot rewriter is a corpus migration this change does not need once declarations are retained.

## Consequences

The product gives up the isolated-desktop capability entirely until a rebuild lands; nothing in the model's prompt, tools, or the sidebar mentions Shellbox anymore. The suite loses the in-tree Shellbox specs (they live on beside the prototype, runnable when someone adopts it). Generated catalogs shrink, and the `web` profile's layer story is two bundles deep.

What it buys: the operator's harness stops spending attention on a half-mature feature, the frozen surface stops accruing accidental changes, and the extraction method in `protop/README.md` is a rehearsal for the other separations the operator wants later. Reintroduction is a proposal, not a revert: [the standalone-plugin rebuild](../../proposed/feature/2026-09-30-shellbox-standalone-plugin-rebuild.md) owns that path.