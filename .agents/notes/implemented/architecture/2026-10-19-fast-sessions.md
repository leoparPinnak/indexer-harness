# Agent Note: Fast Sessions — a scratch chat per Session folder

Status: implemented

English | [中文](2026-10-19-fast-sessions.zh.md)

## Problem

The Web surface has exactly one way to start a chat: pick a Workspace, then talk inside it. A Workspace is a directory the operator already owns, so an exploratory question — "read this attachment", "try this snippet", "look at this error" — had to borrow a real project directory, and whatever the agent wrote there landed among that project's files. The alternative, a Session created with a bare `cwd` and no Workspace, is not usable: the conversation skeleton treats a Workspace-less Session as unstarted, so the composer renders disabled behind the "Choose workspace to start" placeholder.

## Decision

**A Fast Session is an ordinary Session that owns a folder the Host created for it.** `session.createFast` mints the Session id, creates `<fastRoot>/<sessionId>`, creates a Workspace over that folder, creates the Session with the Workspace's canonical path, and attaches it. Nothing else about it differs: same Agent, same log, same persistence, same `session/…` events. The user-visible difference is only where its working directory lives and how the sidebar groups it.

**The Fast Session root is deployment policy, not a constant.** `SessionController` takes `fastSessionRoot`, defaulting to `dsh_fast_sessions` inside the OS temporary directory, and reports it through `session.fastSessionRoot`. `SessionCommandController.createFast` receives the resolved root per call rather than holding it as constructor state: the root is deployment input, and threading it as a parameter keeps the command controller free of a second hosting concept.

**A Fast Session must own a Workspace.** Every Web surface — composer, file tree, open-in-app, deliverables — resolves the Session's directory through its owning Workspace, never through the header's `cwd`. Creating the folder without a Workspace produced a chat whose composer was disabled, which the first implementation showed: the folder appeared, the Session opened, and the operator could not type. Creating the Workspace over the folder is what makes the Session an ordinary, usable one, and it costs one durable registry record per Fast Session.

**The Workspace title is supplied by the client.** UI copy is locale-owned ([decision](2026-08-23-locale-owned-client-ui-copy.md)), so the Host stores the title as data and never invents a label: the sidebar's Quick Session button passes `t('session.fast')` through `uiWorkspace.startSession`'s sibling `startFastSession(title)`. A caller that omits it falls back to the folder name, which is the registry's own default.

**The sidebar owns the grouping.** Sessions under the root are pinned into their own section under Favorites and removed from the Workspace groups: `deriveGroups` skips any Session whose `cwd` and any Workspace whose `path` sits under the root, and `deriveFastSessions` lists exactly those Sessions newest first. Both take the root as a value; an unanswered `session.fastSessionRoot` read (the empty string) classifies nothing and leaves the region in its ordinary shape, so a deployment or transport without the verb behaves exactly as before.

## Consequences

A Fast Session folder is created eagerly, on the button press, and never removed: deleting the Session log or the Workspace record leaves the folder, and the folder outlives the Workspace that owns it. Scratch folders are exactly the kind of residue a temp directory is allowed to hold, so no reaper was added; a deployment that needs one can point `fastSessionRoot` at a directory with its own lifecycle.

Each Fast Session adds one Workspace record to the durable registry, and those records are hidden from the sidebar groups and from the Workspace picker by path, not by a marker. A deployment that renames or moves the Fast Session root after creating Fast Sessions would therefore show their Workspaces again as ordinary groups; the root is meant to be stable.

## Alternatives considered

**A Session with no Workspace.** Simplest Host-side change, and it produced a chat the operator could not type into. Relaxing the conversation skeleton's "no owning Workspace" rule instead would have made every Session whose Workspace was deleted silently chattable, which is a product decision about Workspace deletion, not about scratch chats.

**One shared Workspace for every Fast Session.** Would have kept the registry small, but a shared Workspace forces a shared `cwd`, and the per-Session folder is the feature: an agent writing into a shared scratch directory mixes every chat's files together.

**Reusing `session.create` with `cwd`.** The client cannot create the folder first: the folder is named by the Session id, which the Host mints. Pre-allocating the id on the client would have duplicated the Host's id format in the browser and left `mkdir` outside the transaction that creates the Session.
