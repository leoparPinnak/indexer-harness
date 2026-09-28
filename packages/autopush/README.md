---
description: "The autopush group map: one gated publishing feature per session, with a logged toggle, a /autopush command, a push_changes tool, and the projection the composer dashboard reads."
kind: "package-group"
---

# packages/autopush

English | [中文](README.zh.md)

## Summary

The autopush group owns gated publishing for one session: a logged toggle, the `/autopush` command, the `push_changes` tool that commits the workspace with a Turkish description and pushes it, and the `autopush` projection the composer dashboard reads. Nothing publishes while the gate is off. The group composes existing seams rather than owning a new one: a system-prompt section, logged events folded by a projection unit, and the command registry.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`autopush`](autopush/README.md) | The logged toggle, the policy section, the `/autopush` command, the `push_changes` tool, and the `autopush` projection | `ctx.autoPush` |

-----

<a id="related-documentation"></a>
## Related documentation

- [System prompts subsystem](../../docs/subsystems/system-prompt.md) — the section registry that renders the `autopush:policy` text while the gate is on.
- [Human commands subsystem](../../docs/subsystems/commands.md) — the registry the `/autopush` command registers into.
- [Session projections subsystem](../../docs/subsystems/session-projection.md) — the projection seam the `autopush` unit folds the logged toggle and pushes through.
- [Session persistence subsystem](../../docs/subsystems/persistence.md) — how the `autopush/mode` and `autopush/push` events are made durable.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-autopush) — the accepted `dsh-autopush` config fields.
- [Bilingual documentation policy](../../docs/i18n/README.md) — the pairing rules every document in this group follows.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
