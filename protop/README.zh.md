# protop/ — 提取的原型与提取路线图

[English](README.md) | 中文

本树停放从工作区提取而未删除的产品功能。它位于仓库根目录，落在每个 pnpm workspace glob 之外：下面的各棵树默认不构建、不测试，也不挂载进任何 profile。它们在此冻结，直到第二次生命——而第二次生命的起点，是把停放的树改造成干净的独立组合包。

## 归档：shellbox（2026-09-30）

产品的隔离私有 Windows 桌面功能（“Shellbox”）已彻底停用，并以三棵保留原有身份的树移到这里：

| 移入 | 原位置 | 身份 |
|---|---|---|
| `shellbox/deamon/` | `packages/bundle/deamon` | `@deepseek-ai/dsh-deamon` |
| `shellbox/ui-sandbox-view/` | `packages/client/ui-sandbox-view` | `@deepseek-ai/dsh-client-ui-sandbox-view` |
| `shellbox/gui-motor/` | `benchmarks/gui-motor` | （基准，不是包） |

冻结表面原样保留：`sandbox/PROTOCOL.md` 线格式、`shellbox_launch` / `shellbox_state` / `shellbox_input` 三份 schema，以及两行的 `cordis.patch.yml`（宿主 `deamon` + 客户端 `ui-sandbox-view`）。

账册链接：

- 决策：`.agents/notes/implemented/simplification/2026-09-30-shellbox-retired-to-protop.md`
- 重建提案：`.agents/notes/proposed/feature/2026-09-30-shellbox-standalone-plugin-rebuild.md`
- 保留日志词汇：`packages/session/session-persistence/src/retained-log-vocabulary.ts`

## 根因（为何离开）

对照 `~/.dsh/logs/dsh-web.log` 证实的五个来源：

1. `launch=` 经嵌套 `-Command "..."` 层传递 PowerShell 主体；引号与反引号搅碎 C# 编译（几十条 `Add-Type SOURCE_CODE_ERROR`）。
2. 请求的私有桌面无声回落到用户真实的 `Default` 桌面（`natural=4417x2429` 泄漏）——隔离窗口显示的是真实屏幕。
3. 目标/视口数学接受退化目标（`314x50`）并振荡。
4. 辅助守护进程焊死在固定端口 4005；任何占用该端口的本地服务都会饿死每次桌面尝试（我们自己的 boot-smoke 正是如此——教训已记：绝不占 4005）。
5. 安装的构建陈旧（9 月 23 日）；9 月 24 日的持久桌面修复从未发布——好些“bug”其实属于旧构建。

## 提取路线图（下一次照做）

1. **画足迹图。** 扫描包名、路由路径、提示段 id、工具名、事件类型与 UI id。清单出来之前不下刀。
2. **切断生命周期。** profile 模板元组、包依赖、测试花名册 pin、README/翻译对、tsconfig 路径与工程引用、生成目录。
3. **重新生成机器所有的文档。** 永远不要手改：`pnpm run gen-tsconfig-paths gen-config-catalog gen-persistence-catalog gen-tool-catalog gen-module-graph gen-scoped-events gen-client-catalog gen-session-format-catalog`——然后 `pnpm run verify-md-links` 列出坏链。
4. **保护持久数据。** 删除退役事件名会让旧会话日志变成孤儿（读取路径拒绝未知且无标记的事件）。把类型合并声明留在读取守卫旁边——见 `retained-log-vocabulary.ts`。
5. **上线切换。** 先静音（`cordis.patch.yml` 里的 `disabled: true` 行），再去掉 profile manifest 条目，然后从新代码树重启。验证：对旧路由的无副作用请求返回 404；日志无启动行；UI 无标签页（截图）。
6. **保留账册。** 一份 `implemented/simplification` 笔记（决策），计划第二次生命时加一份 `proposed/feature` 笔记，以及本文件的一节。

## 重新整合（带一个回来）

完整配方见上述提案笔记。短版：把三棵树重建为一个独立的 `@deepseek-ai/dsh-shellbox` 组合包，反向应用本路线图（**不要**加回随附模板——验收路径是 `dsh plugin add`），把保留词汇交给新主人，并首先用钉住的测试关掉五个根因。