# Agent Note: New Session always starts a chat, and row actions survive touch

Status: implemented

English | [中文](2026-10-14-new-session-blank-reuse-and-touch-actions.zh.md)

## Problem

Two failures reached the operator from the same browser tree, both reported as "the button randomly does nothing".

New Session adopted the blank Session already on screen. The adoption rule exists to stop repeated clicks from piling up empty chats, but it was applied to the explicit action too: clicking New Session while sitting in a blank chat re-opened that same chat, so nothing on screen changed. A second path did nothing at all: the target Workspace was resolved from whatever the Workspace and Session feeds held, and a click that arrived before those feeds reported `ready` found no Workspace, took the empty branch, and cleared the view.

The row actions (`+` on a Workspace row, `...` beside it) were revealed by `:hover` alone. On a pointer without hover, the first tap on the row enters its hover state and activates whatever sits under the finger, so the tap that uncovered `+` opened the Workspace's recent Session instead of starting a new one; the second tap worked. Which button appeared to work depended only on timing.

## Decision

`connectWorkspace` takes an optional `excludeSession`, and the explicit New Session flow passes the Session it is displaying. Reuse still applies to every other blank member of the Workspace, so the junk-avoidance stays intact; only the chat already on screen is never adopted. `openWorkspace` keeps its unfiltered reuse for navigation paths.

`startSession` waits for both list feeds when they are not yet `ready` instead of resolving a target from a partial snapshot. The synchronous fast path is preserved when the feeds are ready, so the empty-deployment branch still clears immediately.

`Rows.module.css` keeps `.rowActions` visible under `@media (hover: none)`, together with the timestamp the hover rule hides. Coarse-pointer devices get the buttons without a hover step to uncover them.

## Alternatives considered

**Always create a Session and never reuse blanks.** Simplest reading of the button, and it removes the rule entirely — but then every workspace visit and every navigation mints an empty Session, which is the accumulation the reuse rule was written to prevent.

**Keep the adoption rule and scroll/highlight the adopted row instead.** Gives the click a visible effect without creating a Chat, but the operator asked for a new Session; a highlight on a row they are already looking at does not read as one.

**Reveal row actions on first tap only (a second-tap affordance).** Keeps the visual density and costs a tap on every touch interaction with no visual cue that the first tap is a reveal.

**Put the touch rule behind a viewport-width media query.** Width does not identify input: a narrow desktop window has hover, and a wide tablet does not.

## Consequences

- The blank-adoption rule is now asymmetric by caller: an explicit New Session never adopts the open Session, navigation still does. Both paths are pinned by tests.
- A click that arrives before the feeds are ready is deferred rather than dropped; a deployment whose feeds never become ready leaves that click pending, which matches the rest of the view, where nothing is addressable yet.
- The `@media (hover: none)` rule shows the action buttons permanently on coarse pointers, so a touch user sees up to two 16px glyphs per row that a mouse user sees on hover.
- Session favorites, landed in the same change, reuse the row-action container this rule makes tappable.

## Related

- [Session favorites](../feature/2026-10-14-session-favorites.md) adds the star toggle inside the same action area.
