# Agent Note: Session favorites as a document beside the stored Sessions

Status: implemented

English | [中文](2026-10-14-session-favorites.zh.md)

## Problem

A Workspace tree grows the way a chat history grows: the Sessions an operator returns to every day end up scattered between one-off chats, and the only way back to them is scrolling a grouped list. The browser had no way to keep a Session reachable, and no place that remembered such a choice across browsers, because every list the sidebar renders is derived from Host state.

## Decision

Favorites are one JSON document, `{"sessionIds": [...]}` in star order, written beside the Sessions it names: the Web bundle points the required `favoritesFile` config field of `workspace-controller` at `sessions/favorites.json` inside `$DSH_HOME`, so the list survives with the Sessions and stays legible from outside the harness.

The Host owns it: `SessionFavorites` serializes read-modify-write cycles and writes through `writeFileAtomic`, and the existing `ctx.remote.workspace` namespace gained `listFavorites` and `setFavorite`, both answering the complete order. The Client carries that order in the snapshot it already publishes (`favoriteSessionIds` beside `archivedSessionIds`), reads the document once at boot and again after a carrier reconnect, and installs each toggle echo. The sidebar renders it as a pinned section above the Workspace groups, hidden while empty, plus a star toggle on every Session row. Opening a favorite navigates to that Session through the same path as a normal row: the document is a list of ids, never a copy of a conversation.

## Alternatives considered

**Keep the list in the browser (localStorage or a Client-only store).** Removes the Host work entirely, but the list dies with the browser profile, is invisible to the other Clients of the same deployment, and would be the only durable sidebar state that does not live on the Host.

**Store it in a settings section.** The settings file already has a Remote surface and needs no new methods, but it is not the Sessions directory the operator asked for and favorites are not a product setting a deployment configures.

**A new package with its own Remote namespace.** Clean ownership, and the pattern exists — but `workspace-controller` already owns Session-level navigation state (the archive set) and the sidebar already receives its snapshot, so a second namespace and a second bundle row would buy no separation: the pinned section needs both lists side by side.

**Ride the `workspace/follow` stream with a `favorites` increment.** Keeps every Client in step without a reload, at the cost of a new frame type, a new increment branch, and a stream protocol change for state that changes on an explicit click by the single operator in front of the browser.

**Delete ids whose Session is gone, at read time.** Keeps the document exact, but turns a list read into a Session-store query and makes an accidental Session deletion destructive to a deliberate choice.

## Consequences

- The document is deployment-global and outside the Workspace stream: another Client's toggle appears here on the next boot or carrier reconnect. The README records this as a known limitation.
- A malformed document fails loud with its path in the message; an absent one reads as empty. A deployment that moves its Sessions elsewhere must name the file, because there is no default.
- Ids whose Session no longer exists stay in the file and are skipped by the UI, so the operator can unstar them or let them be.
- Opening a favorite is navigation only: no Session is created, forked, or copied, and nothing enters a Session log.
- Favorites are operator UI state. No prompt, tool schema, or session event changes, so no request bytes and no cache prefix move.

## Related

- [New Session always starts a chat, and row actions survive touch](../bug-fix/2026-10-14-new-session-blank-reuse-and-touch-actions.md) lands the star toggle in an action area that is also reachable without hover.
