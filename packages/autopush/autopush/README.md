---
description: "Gated auto-push for one session: the logged toggle the composer dock and /autopush command write, the push_changes tool that commits with a Turkish description and pushes, and the autopush projection its dashboard reads."
kind: "package-reference"
---

# @deepseek-ai/dsh-autopush

English | [中文](README.zh.md)

## Summary

Auto-push is a per-session gate. The `/autopush on|off` command and the composer chip write one logged whole-value toggle; while it is on, the package contributes the `autopush:policy` system-prompt section and accepts `push_changes`, which commits the session workspace with the caller's Turkish description and pushes it to the configured remote and branch. The `autopush` session projection folds the toggle and every recorded push into `{ enabled, count, lastAt, history }` for the composer dashboard. Nothing pushes while the gate is off, and a call with nothing to publish records no push.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with `remote` and `branch` configured. Every session starts with the gate off, and the toggle is read from the session log rather than from host memory, so a resumed or forked session recovers the state it had.

### Minimal configuration

Both fields are required, and any other key fails at load.

```yaml
- name: '@deepseek-ai/dsh-autopush'
  config:
    remote: origin
    branch: master
```

| Field | Default | Meaning |
|---|---|---|
| `remote` | required | Remote the push goes to |
| `branch` | required | Branch the push goes to |

An empty `remote` or `branch` fails at load with an `AutoPushConfig` error naming the field, and an extra key fails with `AutoPushConfig has unknown key(s) <keys> — config is { remote, branch }`.

### Turning the gate on and off

Type `/autopush`, `/autopush on`, or `/autopush off`; a bare `/autopush` means on, and any other argument returns `Use /autopush, /autopush on, or /autopush off.` The command succeeds with `Oto-push açık. İstek tamamlandığında push_changes çağrılacak.`, `Oto-push zaten açık.`, `Oto-push kapalı.`, or `Oto-push zaten kapalı.` A change appends `autopush/mode` immediately, and a request that repeats the logged value returns `noop` without an event.

The browser chip in [`dsh-client-ui-autopush`](../../client/ui-autopush/README.md) runs these same two command lines, so the logged toggle has one writer.

### What one push does

`push_changes({ message })` runs `git status --porcelain` in the session workspace. When auto-push is on, the model evaluates whether work is push-worthy according to the push decision guide, delivers its answer, and offers a push proposal to the user before calling `push_changes` upon confirmation. With a dirty tree it runs `git add --all`, then `git commit -m <message>`, then `git push <remote> <branch>`, and records `autopush/push` on success. With a clean tree it pushes only committed work the remote lacks: `git rev-list --count HEAD ^<remote>/<branch>` non-zero drives one `git push`, while a count of `0` returns `Pushlanacak değişiklik yok.` and records nothing.

A failed step fails the call with the git stderr. A push that fails after its commit reports `commit oluştu ama push başarısız (HEAD: <sha>): <stderr>. Sorunu giderdikten sonra push_changes çağrısını tekrar deneyin.` and leaves the commit in place, so a later call publishes it. An empty description is rejected before any git command with `push_changes needs a non-empty Turkish description`, and a call while the gate is off is rejected with `push_changes is refused while auto-push is off; the user turns it on from the composer`. A session with no `cwd` fails with `push_changes needs a session workspace, and this session has no cwd`.

### The dashboard projection

The `autopush` projection key carries `{ enabled, count, lastAt, history }`. `count` counts every push in the log, `lastAt` is the newest push time or `null`, and `history` is newest first, capped at 50 records; the log keeps every push. Capability absence is the key's absence.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Auto-push is a product package rather than a capability seam: the state, the policy text, the command, the tool, and the projection live in one plugin. The durable stance is two log-only events, `autopush/mode` (whole-value replace) and `autopush/push` (append-only), so the instruction the model reads and the toggle the reader clicks are the same value replayed from the log.

The controller injects `systemPrompt`, `sessionProjections`, and `tools`. The command child activates only under `ctx.inject(['commands'])`, so a composition without a command registry still registers the prompt section, the projection, and the tool. The tool is refused while the gate is off, and `push()` checks the description before the gate and the workspace so an empty argument fails as the caller's mistake.

Git access goes through the injectable `GitRunner` in `src/git.ts`; production uses `execFile` rather than a shell so a Turkish commit message reaches git as one argument.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `resolveConfig`, `pushWorkspace`, the `ctx.autoPush` service, the `autopush:policy` section, the `/autopush` command, the `push_changes` tool |
| [`src/types.ts`](src/types.ts) | The two `SessionEventMap` members and the `autopush` projection declarations |
| [`src/git-status.ts`](src/git-status.ts) | Workspace Git initialization and remote presence inspection |
| [`src/git.ts`](src/git.ts) | The injectable `GitRunner` and the `execFile` implementation |
| [`src/client.ts`](src/client.ts) | Client-namespace re-export of the types outlet |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-client-ui-autopush](../../client/ui-autopush/README.md) — the composer chip and dashboard that read this package's projection and dispatch its command.
- [session projection](../../session/session-projection/README.md) — the registry that folds the two logged events into the wire view.

-----

<a id="model-experience"></a>
## Model Experience

### Auto-push policy system prompt

#### What the model sees

While the session's gate is on, the model sees this package's exact policy text at first-party prompt order 510; while the gate is off the `autopush:policy` section contributes no text, and a request with no agent contributes none either.

##### Policy text

```markdown
Auto-push is ON for this session. When you have actually finished the request and its checks pass, call `push_changes` once with a short TURKISH description of what changed. Do not push mid-conversation, while still investigating, or on a half-finished change: the counter and history must mean "the user agreed to publish this". If there is nothing new to publish, the tool says so and changes nothing.
```

#### Token effect

The section is registered in every assembly but renders empty while the gate is off, so it costs no tokens then; while the gate is on it adds the fixed policy text to every request.

#### KV Cache effect

The text is stable while the gate stays on; turning it on or off changes the system prompt from first-party order 510 onward.

### Push tool

#### What the model sees

`push_changes` is registered in both states. Its arguments are one required string, `message`, described as a short Turkish description used as the commit message, and its result is `{ pushed, sha, files, detail }`. The tool is refused with `push_changes is refused while auto-push is off; the user turns it on from the composer` while the gate is off, so the result of an off-state call is an error rather than a push.

#### Token effect

The tool schema is in the request catalog whenever tools are assembled, and each call adds one tool call plus one result to conversation history.

#### KV Cache effect

The schema does not change when the gate is toggled, so the tool catalog part of the prefix is stable; calls and results extend the conversation after the prefix.

### Human command

#### What the model sees

`/autopush on` and `/autopush off` stay outside model history. The command appends `autopush/mode` and returns its terminal text to the reader; it contributes no user message and no model context.

#### Token effect

The command adds no tokens to any request.

#### KV Cache effect

Toggling the gate changes the `autopush:policy` section from first-party order 510 onward, which changes the request prefix; the command text itself never enters a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **The gate is per session** — each session folds its own `autopush/mode`, so turning it on in one session leaves every other session off.
- **The wire history is capped at 50** — the log keeps every recorded push, but the projection's `history` carries only the newest 50 records.
- **A failed push keeps its commit** — the commit stays in the workspace and the next call publishes it; the tool reports the failure instead of rolling back.
- **The push target is deployment-fixed** — `remote` and `branch` come from plugin config and cannot be changed per session or per call.
- **A missing workspace fails the call** — a session with no `cwd` cannot publish, and the tool reports that instead of publishing somewhere else.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The durable facts are the two logged events; the projection fold is driven by `SessionProjectionRegistry`, and the git outcomes are pinned by the injected `GitRunner`.
