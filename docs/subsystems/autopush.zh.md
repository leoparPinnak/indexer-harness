# 自动推送

[English](autopush.md) | 中文

自动推送是由 [dsh-autopush](../../packages/autopush/autopush/README.zh.md)（`ctx.autoPush`、`AutoPushController`）拥有的按会话生效的发布门控：门控打开时，本包贡献 `autopush:policy` 系统提示词段落并接受 `push_changes` 工具，后者按调用方给出的土耳其语说明提交会话工作区，并推送到配置的远端与分支。门控就是约定——关闭时不会发布，无事可发布的一次请求不记录任何推送。[组映射](../../packages/autopush/README.zh.md)列出了该包，[包 README](../../packages/autopush/autopush/README.zh.md) 拥有模型体验与限制细节。

来源：[`packages/autopush/autopush/src/index.ts`](../../packages/autopush/autopush/src/index.ts)

## 已记录状态与恢复

`autopush/mode`（`{ enabled: boolean }`）是一条仅记日志、整值替换的[会话事件](session.zh.md)：可持久化、可回放，绝不进入模型记录。`autopush/push` 携带一次已完成的推送，同样仅记日志、仅追加。`autopush` 投影把两者折叠为 `{ enabled, count, lastAt, history }`：`count` 统计日志中的每一次推送，`lastAt` 是最新推送时间，`history` 按最新在前排列，协议上最多 50 条而日志保留每一次。恢复、fork 与压缩（compaction）都通过折叠日志复原状态，因此模型被给予的指令就是恢复后的会话所报告的开关。完整声明见[持久化目录](../persistence-catalog.zh.md)。

## 门控、命令与工具

`/autopush` 命令只在组合了命令注册表时注册。不带参数的 `/autopush` 与 `/autopush on` 选择开启，恰好为 `off` 的参数选择关闭，其他参数一律被拒绝且不改变状态。状态变更会立即追加 `autopush/mode`——不会被轮次边界排队——重复已记录的值是空操作。`push_changes` 工具在门控关闭时仍保持注册，此时执行会被拒绝而不会发布到任何地方；门控打开时，有改动的工作区会按调用方的土耳其语说明提交并推送，干净的工作区只推送远端尚未拥有的提交。提交已完成而推送失败时，提交会留在原处供后续调用发布；空说明在任何 git 命令之前被拒绝；没有工作区的会话会失败。

## 配置

```yaml
- name: '@deepseek-ai/dsh-autopush'
  config:
    remote: origin
    branch: master
```

两个字段都必填，任何其他键都会在插件加载时失败。推送目标是部署固定的：`remote` 与 `branch` 不能按会话或按调用更改。生成的[配置目录](../config-catalog.zh.md#deepseek-aidsh-autopush)完整列出了受支持的字段。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Session](session.zh.md)

Source: [`packages/autopush/autopush/src/index.ts`](../../packages/autopush/autopush/src/index.ts)
<!-- END GENERATED cordis-surface -->
