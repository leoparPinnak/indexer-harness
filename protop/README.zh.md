# protop/ —— 提取出来的原型与提取路线图

[English](README.md) | 中文

本树停放从工作区提取出来、而不是删除的产品功能。它位于仓库根目录，处在每个 pnpm workspace glob 之外：下方各树默认不构建、不测试，也不挂进任何 profile。它们在此冻结，直到第二次生命来临——那始于把一棵停放的树变成干净的独立包。

## 存档：shellbox（2026-10-01）

产品的隔离私有 Windows 桌面功能（“Shellbox”）已被完全停用，并以两棵保有各自身份的树移入此处：

| 移入 | 曾在 | 身份 |
|---|---|---|
| `shellbox/deamon/` | `packages/bundle/deamon` | `@deepseek-ai/dsh-deamon` |
| `shellbox/ui-sandbox-view/` | `packages/client/ui-sandbox-view` | `@deepseek-ai/dsh-client-ui-sandbox-view` |

（同一功能已于 2026-09-30 离开 DSH v3 代码树；那次提取还停放了第三棵树 `benchmarks/gui-motor`，DSH v2 不携带它。）

冻结表面原样保留：`sandbox/PROTOCOL.md` 线协议、`shellbox_launch` / `shellbox_state` / `shellbox_input` schema，以及两行的 `cordis.patch.yml`（宿主 `deamon` + 客户端 `ui-sandbox-view`）。

台账链接：

- 决策：`.agents/notes/implemented/simplification/2026-10-01-shellbox-retired-to-protop.zh.md`
- 重建提案：`.agents/notes/proposed/feature/2026-09-30-shellbox-standalone-plugin-rebuild.zh.md`
- 留存日志词汇：`packages/session/session-persistence/src/retained-log-vocabulary.ts`

## 根因（它为何离开）

五条来源在 DSH v3 提取期间对着操作者的 `~/.dsh/logs/dsh-web.log` 得到证实，并作为常设诊断承接：

1. `launch=` 经嵌套 `-Command "..."` 层传递 PowerShell 体；引号与反引号撕碎了 C# 编译（几十次 `Add-Type SOURCE_CODE_ERROR`）。
2. 请求的私有桌面无声回落到用户真实的 `Default` 桌面（`natural=4417x2429` 泄漏）——隔离窗口显示的是真实屏幕。
3. 目标/视口数学接受退化目标（`314x50`）并振荡。
4. 辅助守护进程焊死在固定端口 4005；任何占用该端口的本地服务都会饿死每次桌面尝试（我们自己的 boot-smoke 就干过这事——教训已归档：绝不抢占 4005）。
5. 安装构建是陈旧的（9 月 23 日）；9 月 24 日的持久桌面修复从未发货——若干“bug”其实属于旧构建。

## 提取路线图（给下一批的方法）

1. **绘制足迹。** 扫描仓库里的包名、路由路径、prompt 段 id、工具名、事件类型与 UI id。清单未齐，不下刀。
2. **切断生命周期。** profile 模板元组、包依赖、测试花名册钉子、README/翻译对、tsconfig 路径与工程引用、生成的目录。
3. **重新生成机器所有的文档。** 永不手改：`pnpm run gen-tsconfig-paths gen-config-catalog gen-persistence-catalog gen-tool-catalog gen-module-graph gen-scoped-events gen-client-catalog gen-session-format-catalog` ——然后 `pnpm run verify-md-links` 会列出任何断链。
4. **保护持久数据。** 删除退役事件名会让旧会话日志成为孤儿（读取路径拒绝未知且无标记的事件）。把类型合并声明留在读取守卫旁边——参见 `retained-log-vocabulary.ts`。
5. **线上切换。** 先静音（`cordis.patch.yml` 中 `disabled: true` 行），再移除 profile manifest 条目，然后从新代码树重启。验证：对旧路由的无副作用请求回答 404；日志中无启动行；UI 中无标签页（截图）。
6. **保留台账。** 一篇 `implemented/simplification` 注记（决策），有二次生命计划时一篇 `proposed/feature` 注记，以及这里的一节。

## 重新整合（带回一个）

完整配方在上面点名的提案注记里。短版：把停放的树重建为单一独立包 `@deepseek-ai/dsh-shellbox`，逆向执行本路线图（绝不把它加回随发行模板——`dsh plugin add` 就是验收路径），把留存词汇交给新主人，并先用钉住的测试关闭五条根因。