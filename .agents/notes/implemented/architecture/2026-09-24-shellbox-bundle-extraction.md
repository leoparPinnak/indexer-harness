# Agent Note: Shellbox ships as the @deepseek-ai/dsh-deamon bundle

Status: implemented

English | [中文](2026-09-24-shellbox-bundle-extraction.zh.md)

## Problem

Shellbox — the isolated private Windows desktop shown in the right Sidebar — was composed inside `packages/bundle/web-app`: its host bridge routes, helper daemon, capture helper, `shellbox_launch` tool, bundled skill, and prompt section were web-app patch rows, and its four spec files lived under `packages/bundle/web-app/tests/`. A recipient who wanted the feature had to take all of web-app, no supported path added the feature alone to a profile that already mounts the base layers, and the usage manual existed only as prose in web-app's README rather than shipping with the plugin it documents.

## Decision

- `protop/shellbox/deamon` (npm name `@deepseek-ai/dsh-deamon`, versioned with the root, `type: module`) is the feature's single owner: `src/index.ts` (plugin shell and the `app:shellbox-surface` prompt section), `src/sandbox.ts` (the twelve frozen `/api/server/sandbox/*` routes and the `/api/server/sandbox/ws` upgrade), `src/deamon.ts` and `src/deamon-manager.ts`, `sandbox/sandbox-host.ps1` with `sandbox/PROTOCOL.md`, the skill body at `assets/shellbox.md`, the four spec files, and the package's own `cordis.patch.yml`.
- web-app carries no shellbox knowledge after the extraction: no patch row, no dependency, no source or test file; `packages/bundle/web-app/cordis.patch.yml` never names the feature again.
- The bundle's patch carries the host row (`id: deamon`, whose `config` restates `surfaceContext: true` because a patch replaces the targeted row's whole config) and the `ui-sandbox-view` client row, and every package either row names is a dependency of this bundle itself, which the bundle self-row rule requires.
- The `web` profile template named the bundle when this shipped; the [2026-09-30 retirement](../simplification/2026-09-30-shellbox-retired-to-protop.md) removed the feature from the shipped templates again, so a fresh profile boots without it; desktop profiles add it on demand through `dsh plugin`, recorded under the package README's Known Limitations.
- Hand-off uses the profile bundle mechanism: a recipient installs the `pnpm pack` tarball (or a registry name or path) with `dsh plugin --profile <name> add <spec>`, and `dsh --profile web --dump-config` marks the mounted layer `# == @deepseek-ai/dsh-deamon`.
- No "plugin list in the system prompt" channel exists, so the manual ships with the plugin through four surfaces: the bundled `shellbox` skill carries the full guide read from `assets/shellbox.md` beside the package, the trimmed `app:shellbox-surface` section orients the model and ends with the instruction to load that skill, the `shellbox_launch` tool description carries the launch synopsis, and the bilingual README serves maintainers and recipients.
- The Host half type-imports `@deepseek-ai/dsh-client-connection` (a devDependency with a tsconfig project reference) so `ctx.connection` resolves; the composition spec's Loader module map supplies the client row an empty-apply module because a Host program cannot import a plain Client package's sources (TS6307).

## Alternatives considered

**Keep the feature inside web-app and publish a copy-out procedure.** Rejected: the recipient still inherits all of web-app, the copied files cannot be versioned with the profile layers they patch, and every web-app change would re-open where the feature lives. A profile-layer bundle is the distribution unit the repository already versions, gates, and installs as one unit.

## Consequences

- A recipient adds one complete, versioned feature layer instead of forking web-app, and fresh installs get the same layer from the profile template.
- The skill body, prompt section, tool description, and README can drift apart; the loader-composition spec boots the shipped patch and pins the section text and its `surfaceContext: false` arm, so the orientation-to-manual hand-off stays asserted.
- Every active Agent Note that references these files names the bundle's paths.

## Testing

- `protop/shellbox/deamon/tests/loader-composition.spec.ts` boots the shipped `cordis.patch.yml` through a real Loader: every row reaches booted state, the twelve frozen routes and the viewer upgrade mount, the section sits at `getSectionOrder('WEB_SURFACE') + 5`, its text keeps the orientation facts, and a composed `surfaceContext: false` keeps the section out.
- `protop/shellbox/deamon/tests/skill.spec.ts` pins the bundled manual's registration, body source, and list face; `protop/shellbox/deamon/tests/sandbox-routes.spec.ts` pins the route contracts; `protop/shellbox/deamon/tests/deamon.spec.ts` pins Deamon lifecycle and discovery isolation.
