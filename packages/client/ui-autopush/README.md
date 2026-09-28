---
description: "The Web GUI's composer dock entry for auto-push: a chip that turns the session gate on and off through /autopush, shows the push count and last push time, and a dashboard listing the session's push history."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-autopush

English | [中文](README.zh.md)

## Summary

The browser half of auto-push: one entry in the composer's `conversation.composer.dock` seat, the row under the input bar. The chip runs `/autopush on` or `/autopush off` through `ctx.remote.commands.execute` instead of writing state itself, shows the session's push count and the newest push time as `ss:dd`, and opens a dashboard that lists the session's push history with full local `gg.aa.yyyy ss:dd` timestamps. It reads the host's `autopush` projection, so the state a reader sees is the state the model was given. The toggle, the `autopush:policy` prompt section, and the `push_changes` tool belong to [`dsh-autopush`](../../autopush/autopush/README.md); this package registers nothing model-facing.

## Table of Contents

- [What it registers](#what-it-registers)
- [The chip and the dashboard](#the-chip-and-the-dashboard)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The dock entry** — `ctx.slots.inject('conversation.composer.dock', ...)` registering `PushDock` under id `autopush`, order 10, locale namespace `autopush`.
- **The dictionaries** — the `autopush` namespace with its `zh`, `en`, and `tr` copies.
- **The injected verb** — `setEnabled(enabled)`, which executes `/autopush on` or `/autopush off` on the session and maps a refused execution to one inline error line.

The host half ([`src/index.ts`](src/index.ts)) registers nothing; the whole surface lives in [`src/client/index.ts`](src/client/index.ts), [`src/client/PushDock.tsx`](src/client/PushDock.tsx), and [`src/client/locales.ts`](src/client/locales.ts).

<a id="the-chip-and-the-dashboard"></a>
### The chip and the dashboard

A session whose projection is absent renders nothing. Otherwise the chip shows `⚡ Auto-push`, pressed when the gate is on, with the push count and the newest push time as `ss:dd` beside it, or the namespace's "Nothing pushed yet" line when nothing has been recorded. Clicking the chip requests the opposite state and leaves the chip on the projection's value until the host confirms the change; a refused execution shows its message inline without moving the chip.

The dashboard opens from the count control as a dialog and lists the session state, the count, and the newest push in full local `gg.aa.yyyy ss:dd`, then the history newest first with each record's full timestamp, Turkish message, short commit id, file count, and `<remote>/<branch>`. Escape or the close control closes it. The panel holds no state of its own beyond being open: everything it lists comes from the `autopush` projection.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-autopush](../../autopush/autopush/README.md) — owns the logged toggle, the policy section, and the push tool.
- [ui-conversation](../ui-conversation/README.md) — declares the `conversation.composer.dock` seat.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `/autopush on` or `/autopush off` command line the chip dispatches: `dsh-autopush` owns the model-visible `autopush:policy` section and the `push_changes` tool.

#### KV Cache effect

Turning the gate on or off changes whether the `autopush:policy` section contributes text from first-party order 510 onward, so it changes the request prefix; the chip itself adds no prompt content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **State is host-derived** — the chip never holds a local switch; it shows the logged toggle and waits for the projection to confirm every change.
- **The dashboard lists the session's capped history** — it renders the projection's newest-first records, at most 50, and never reads the log directly.
- **The copy is one namespace** — the chip and dashboard render their own `autopush` namespace and do not reuse the conversation shell's strings.
- **Mounting decides visibility** — the dock entry exists only where the profile mounts this package; the host-side toggle and tool work without it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The dock's only state is whether the panel is open; the toggle, count, and history are the host projection's folded values.
