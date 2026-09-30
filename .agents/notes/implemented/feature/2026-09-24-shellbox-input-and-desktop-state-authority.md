# Agent Note: Shellbox input and desktop-state authority

Status: implemented

English | [中文](2026-09-24-shellbox-input-and-desktop-state-authority.zh.md)

## Problem

The sandbox tab drew frames but carried nothing back. The desktop could be watched and never driven, and neither the model nor the reader could see which windows it held or what had changed since the last look. The pane's routes also reached the host's own desktop, so a viewer could have typed into the real session rather than only into the private one.

## Decision

The helper takes a second job beside the frame stream: its spool directory accepts typed input commands, and it writes a `.state` document naming the desktop's visible windows. Every input event the browser sends becomes a message posted to a target window on the private desktop; the helper never calls `SendInput`, `keybd_event`, or `mouse_event`, so the path cannot reach a window on another desktop. `input char` inserts exact text through `EM_REPLACESEL` for a text control and posts `WM_CHAR` elsewhere, because a posted `WM_KEYDOWN` carries no character and a text control ignores an injected `WM_CHAR` (both measured; `AttachThreadInput` is refused across desktops, so the target thread's own key state cannot be seeded). The host exposes five routes — input, windows, window focus, window close, and the change ring — on both its in-process and daemon surfaces, refusing input aimed at the host's own desktop with 403 and answering an absent helper with 409 instead of 404, so a client tells an idle helper from an unmounted route. The pane gives its toolbar an input switch that converts rendered pixels into frame pixels and batches captured events (40 ms trailing move, 60 events per batch, release-all on focus loss), lists the desktop's windows with focus and close actions, and derives its unreviewed-change badge from the ring cursor kept per session in `localStorage`, while the model's own acknowledgement stays a session cursor.

## Alternatives considered

**Synthetic system input.** `SendInput` reaches the desktop the Windows session treats as active, which is the host's own whenever the helper runs on a hidden one; message posting is the only mechanism scoped to the target desktop.

**`WM_CHAR` for every text insertion.** Measured against a raw Win32 `EDIT` and a WinForms `TextBox`: both ignore an injected `WM_CHAR`, so exact text would have been lost. The ordinal class-name test that selects `EM_REPLACESEL` came from that measurement, and ordinal comparison is required because this deployment's Turkish culture makes a case-insensitive `-match` answer false for `'Edit'` against `'EDIT'`.

**A model-visible session event per window fact.** The ring already carries the committed change batches; a per-window event would duplicate the log and turn every poll into a model-visible write.

## Consequences

The helper's input grammar, its `.state` document, and the five routes are the frozen surface in `protop/shellbox/deamon/sandbox/PROTOCOL.md`; the deamon and client package READMEs carry the consumer side. Input reaches a window's message queue only: a program that reads hardware state directly sees nothing, and a secure-desktop prompt cannot be answered. Both measured limits — key state cannot be seeded across desktops, and a text control ignores an injected `WM_CHAR` — are pinned by the helper's proof harness rather than assumed. This decision extends [shellbox bundle extraction](../architecture/2026-09-24-shellbox-bundle-extraction.md) and [deamon rename and persistent desktop](../simplification/2026-09-24-deamon-rename-and-persistent-desktop.md), whose surfaces now number six with the window actions and the change ring; the stream notes ([liveness](../bug-fix/2026-09-22-shellbox-stream-liveness.md), [WebSocket frames](../bug-fix/2026-09-23-ws-sandbox-frame-stream.md)) keep their own decisions and are not superseded.
