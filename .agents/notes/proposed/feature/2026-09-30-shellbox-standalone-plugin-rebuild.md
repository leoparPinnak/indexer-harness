# Agent Note: Shellbox rebuilt as a standalone plugin

Status: proposed

English | [中文](2026-09-30-shellbox-standalone-plugin-rebuild.zh.md)

## Problem

Shellbox was retired from the product into `protop/shellbox/` ([the DSH v2 retirement note](../../implemented/simplification/2026-10-01-shellbox-retired-to-protop.md); the same feature left DSH v3 on 2026-09-30 under the identical plan) while still carrying real defects: embedded PowerShell loses quoting through `-Command` layers, a private desktop can silently degrade to the user's real `Default` desktop, the viewport/target math accepts degenerate targets and oscillates, and nothing reserves the helper's fixed port against unrelated local services. The operator wants the capability back — eventually, cleanly, and as "a plugin like it always should have been" — without re-tangling the product.

## Proposal

Rebuild Shellbox as one standalone bundle, `@deepseek-ai/dsh-shellbox`, assembled from the parked trees (`protop/shellbox/deamon`, `ui-sandbox-view`) and installable into any profile with `dsh plugin --profile <name> add`, with no shipped template naming it. Concretely:

- **One bundle, two rows**: a host row (routes, helper manager, tools, skill, prompt sections) and the `ui-sandbox-view` client row, exactly as the parked `cordis.patch.yml` already expresses, under the new package name.
- **Defect seeding**: the diagnosis recorded in `protop/README.md` becomes the first milestone — quoting by temp-file or `-EncodedCommand` instead of nested `-Command`, loud failure instead of `Default` fallback, clamped/de-duplicated target math — each with a pinned spec.
- **Port discipline**: the helper daemon acquires its port (or takes `DEAMON_PORT`); nothing else in the system may claim it, and the boot-smoke tooling must refuse that port.
- **Protocol preservation**: `sandbox/PROTOCOL.md` and the tool schemas stay frozen; the rebuild treats them as the compatibility contract that makes re-add cheap.
- **Persona honesty**: the `app:shellbox-surface` section returns only for profiles that mount the bundle (the parked `surfaceContext` gate already provides this), so the product never re-advertises the capability uninvited.

## Alternatives considered

- **Just move the trees back and re-ship** — rejected: that recreates the retired tangle plus the original defects, which is the outcome the retirement existed to prevent.
- **Rebuild on a fresh architecture (own capture stack, no PowerShell helper)** — tempting but deferred: the helper's frozen wire is the expensive part that works; a new transport can be a later proposal layered on this one.

## Acceptance criteria

- `dsh plugin --profile <name> add` on a bare profile mounts both rows; `--dump-config` shows them; removing the plugin removes routes, tools, skill, prompt sections, and the sidebar tab with no residue.
- The three diagnosed defect classes have pinned regressions that fail before the fix.
- Two unrelated local services may run on any ports, including the old hard-coded 4005, while a Shellbox desktop still starts.
- The product tree's shipped templates still name no Shellbox package.

## Risks

- The prototype drifts from core APIs while parked (registry idioms, event envelopes); the rebuild budget must absorb a re-base.
- The frozen protocol may ossify into a liability if Windows capture behavior shifts underneath it.
- The retained `shellbox/*` vocabulary (see the retirement note) must move with whatever migration eventually replaces it, or old corpora break.