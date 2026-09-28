# Auto-Push

English | [中文](autopush.zh.md)

Auto-push is a per-session publishing gate owned by [dsh-autopush](../../packages/autopush/autopush/README.md) (`ctx.autoPush`, `AutoPushController`): while the gate is on, the package contributes the `autopush:policy` system-prompt section and accepts the `push_changes` tool, which commits the session workspace with the caller's Turkish description and pushes it to the configured remote and branch. The gate is the contract — nothing publishes while it is off, and a request with nothing to publish records no push. The [group map](../../packages/autopush/README.md) lists the package, and the [package README](../../packages/autopush/autopush/README.md) owns the model-experience and limitation detail.

Source: [`packages/autopush/autopush/src/index.ts`](../../packages/autopush/autopush/src/index.ts)

## Logged state and recovery

`autopush/mode` (`{ enabled: boolean }`) is a log-only, whole-value-replace [session event](session.md): durable and replayable, never in the model transcript. `autopush/push` carries one completed push and is log-only and append-only. The `autopush` projection folds both into `{ enabled, count, lastAt, history }`: `count` counts every push in the log, `lastAt` is the newest push time, and `history` holds the newest records first, capped at 50 on the wire while the log keeps every one. Resume, fork, and compaction recover the state by folding the log, so the instruction the model was given is the toggle a restored session reports. The complete declarations are in the [persistence catalog](../persistence-catalog.md).

## The gate, the command, and the tool

The `/autopush` command registers only when a command registry is composed. Bare `/autopush` and `/autopush on` select enabled, the exact argument `off` selects disabled, and any other argument is rejected without a state change. A change appends `autopush/mode` immediately — no turn boundary queues it — and repeating the logged value is a no-op. The `push_changes` tool stays registered while the gate is off, where execution is refused rather than publishing anywhere; while the gate is on, a dirty workspace is committed with the caller's Turkish description and pushed, and a clean workspace pushes only commits the remote does not have yet. A push that fails after its commit leaves the commit in place for a later call, an empty description is rejected before any git command, and a session without a workspace fails.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-autopush'
  config:
    remote: origin
    branch: master
```

Both fields are required and any other key fails at plugin load. The push target is deployment-fixed: `remote` and `branch` cannot be changed per session or per call. The generated [configuration catalog](../config-catalog.md#deepseek-aidsh-autopush) is the exhaustive source for the accepted fields.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxautopush--autopushcontroller"></a>

### `ctx.autoPush` — `AutoPushController`

`ctx.autoPush`: owns the logged toggle and the one tool that publishes work.

The service reads and writes session state only; the projection unit owns the fold, and the composer dashboard owns the button.

```ts cordis-catalog
/**
 * Read the logged toggle for one session.
 * @param session - the session to read.
 * @returns whether auto-push is on.
 */
enabled(session: Session): boolean

/**
 * Select whether auto-push is on. The change is logged immediately: unlike a
 * narrated mode, nothing queues it behind a turn boundary.
 * @param session - the session to switch.
 * @param enabled - the requested state.
 * @returns what happened.
 */
set(session: Session, enabled: boolean): 'committed' | 'noop'

/**
 * Publish the workspace, recording the push in the session log on success.
 * @param session - the session whose workspace is published.
 * @param message - the commit's Turkish description.
 * @returns what happened.
 */
async push(session: Session, message: string): Promise<PushOutcome>
```

Types: [Session](session.md)

Source: [`packages/autopush/autopush/src/index.ts`](../../packages/autopush/autopush/src/index.ts)
<!-- END GENERATED cordis-surface -->
