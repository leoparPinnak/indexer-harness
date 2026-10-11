# protop/ — extracted prototypes and the extraction roadmap

English | [中文](README.zh.md)

This tree parks product features that were extracted from the workspace instead
of deleted. Sitting at the repository root, it is outside every pnpm workspace
glob: the trees below build and test nothing by default and mount into no
profile. They stay frozen here until a second life — which begins by turning a
parked tree into a clean standalone package.

## Archive: shellbox (2026-10-01)

The product's isolated private Windows desktop feature ("Shellbox") was fully
deactivated and moved here as two trees that keep their identities:

| Moved | Was | Identity |
|---|---|---|
| `shellbox/deamon/` | `packages/bundle/deamon` | `@deepseek-ai/dsh-deamon` |
| `shellbox/ui-sandbox-view/` | `packages/client/ui-sandbox-view` | `@deepseek-ai/dsh-client-ui-sandbox-view` |

(The same feature left the DSH v3 tree on 2026-09-30; that extraction parked a
third tree, `benchmarks/gui-motor`, which DSH v2 does not carry.)

Frozen surfaces stay verbatim: the `sandbox/PROTOCOL.md` wire format, the
`shellbox_launch` / `shellbox_state` / `shellbox_input` schemas, and the two-row
`cordis.patch.yml` (host `deamon` + client `ui-sandbox-view`).

Ledger links:

- Decision: `.agents/notes/implemented/simplification/2026-10-01-shellbox-retired-to-protop.md`
- Rebuild proposal: `.agents/notes/proposed/feature/2026-09-30-shellbox-standalone-plugin-rebuild.md`
- Retained log vocabulary: `packages/session/session-persistence/src/retained-log-vocabulary.ts`

## Root causes (why it left)

Five sources proven against the operator's `~/.dsh/logs/dsh-web.log` during the
DSH v3 extraction and carried as the standing diagnosis:

1. `launch=` carried PowerShell bodies through nested `-Command "..."` layers;
   quotes and backticks shredded the C# compile (dozens of `Add-Type
   SOURCE_CODE_ERROR`).
2. A requested private desktop silently fell back to the user's real `Default`
   desktop (the `natural=4417x2429` leak) — the isolated window showed the real
   screen.
3. Target/viewport math accepted degenerate targets (`314x50`) and oscillated.
4. The helper daemon is welded to fixed port 4005; any local service taking that
   port starves every desktop attempt (our own boot-smoke did exactly that —
   lesson filed: never squat on 4005).
5. The installed build was stale (Sep 23); the Sep 24 persistent-desktop fixes
   had never shipped — several "bugs" belonged to the old build.

## Extraction roadmap (the method for the next ones)

1. **Map the footprint.** Scan the repo for package names, route paths, prompt
   section ids, tool names, event types, and UI ids. No cutting before the list.
2. **Sever the lifecycle.** Profile template tuple, package dependencies, test
   roster pins, README/translation pairs, tsconfig paths and project references,
   generated catalogs.
3. **Regenerate the machine-owned docs.** Never hand-edit: `pnpm run
   gen-tsconfig-paths gen-config-catalog gen-persistence-catalog
   gen-tool-catalog gen-module-graph gen-scoped-events gen-client-catalog
   gen-session-format-catalog` — then `pnpm run verify-md-links` lists any
   broken links.
4. **Protect durable data.** Deleting retired event names orphans old session
   logs (the read path refuses unknown, unmarked events). Leave type-merge
   declarations beside the read guard — see `retained-log-vocabulary.ts`.
5. **Live cutover.** Silence first (`disabled: true` rows in `cordis.patch.yml`),
   then drop the profile manifest entry, then restart from the new tree. Verify:
   a side-effect-free request to an old route answers 404; no startup line in the
   log; no tab in the UI (screenshot).
6. **Keep the ledger.** One `implemented/simplification` note (the decision), a
   `proposed/feature` note when a second life is planned, and a section here.

## Reintegration (bringing one back)

Full recipe in the proposal note named above. Short form: rebuild the parked
trees under one standalone `@deepseek-ai/dsh-shellbox` package, apply this
roadmap in reverse (do NOT re-add it to the shipped template — `dsh plugin add`
is the acceptance path), hand the retained vocabulary to the new owner, and
close the five root causes with pinned tests first.