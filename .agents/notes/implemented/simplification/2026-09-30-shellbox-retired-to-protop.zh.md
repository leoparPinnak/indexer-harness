# Agent Note：Shellbox 从产品退役至 protop/shellbox

Status: implemented

[English](2026-09-30-shellbox-retired-to-protop.md) | 中文

## 问题

Shellbox——串流进 Web GUI 的隔离私有 Windows 桌面——曾以 `@deepseek-ai/dsh-deamon` 组合包的形式粘在随发行的 `web` profile 里。在操作者的机器上它屡屡失常：注入的 PowerShell 引号被搅乱、请求的私有桌面无声回落到用户真实的 `Default` 桌面、视口/目标数学振荡出退化目标、一个占用辅助进程固定端口 4005 的本地服务饿死每个桌面，而陈旧的安装构建又放大了全部症状。操作者认定该功能本就应当可分离（“它本来就应该是个插件”），它继续停留在产品表面上只会继续索取与其成熟度不符的关注。

## 决策

整个功能离开产品工作区，作为原型停放：

- `packages/bundle/deamon`（npm `@deepseek-ai/dsh-deamon`）→ `protop/shellbox/deamon/`
- `packages/client/ui-sandbox-view`（npm `@deepseek-ai/dsh-client-ui-sandbox-view`）→ `protop/shellbox/ui-sandbox-view/`
- `benchmarks/gui-motor` → `protop/shellbox/gui-motor/`

`protop/` 位于每个 pnpm workspace glob 之外，因此三棵树默认不构建也不测试；`protop/README.md` 记录提取地图与复用步骤。包名、冻结的 `sandbox/PROTOCOL.md` 线协议以及 `shellbox-*` 工具 schema 原样保留，供日后干净地重新引入。

产品接线随之而出：随发行的 `web` profile 模板为 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，浏览器花名册与 CLI 内置清单失去 deamon 条目，cdp/ipc-pipe/bundle 的 README 不再援引该功能，每个生成的目录都重新生成并剔除它。模型可见的表面随组合包一起离开：`app:shellbox-surface` 与 `app:shellbox-changes` 提示段、`shellbox_launch`/`shellbox_state`/`shellbox_input` 工具，以及内置的 `shellbox` skill 不再进入任何提示词或工具目录。

两个退役的持久记录名经 `packages/session/session-persistence/src/retained-log-vocabulary.ts` 保持可读：退役前的会话日志含有未带 `ignorable` 标记提交的 `shellbox/change` 与 `shellbox/ack` 事件，而读取路径会拒绝类型未知且无标记的日志。该留存文件以无生产方的类型合并声明它们，于是既有语料依旧可解释，而“未知且不可忽略”的拒绝语义对外来日志保持不变。

线上安装在退役当天即关闭该功能：先以 `disabled: true` 行补丁关停，再以瘦身后的 profile manifest 固化，并从退役后的代码树重启了 web。

## 退役地图

| 曾在 | 现在 |
|---|---|
| `packages/bundle/deamon` | `protop/shellbox/deamon` |
| `packages/client/ui-sandbox-view` | `protop/shellbox/ui-sandbox-view` |
| `benchmarks/gui-motor` | `protop/shellbox/gui-motor` |
| `web` 模板元组（3 个组合包） | `web` 模板元组（2 个组合包） |
| `shellbox/change`、`shellbox/ack` 生产方 | `retained-log-vocabulary.ts` 声明（无生产方） |
| 模型表面（2 提示段、3 工具、1 skill） | 仅保留在原型内 |

## 曾考虑的替代方案

- **以特性开关的形式带病发货** —— 不采纳：耦合（组合包行、提示段、目录行、辅助端口预留）仍是承重代码，persona 也会继续宣扬一项操作者不想再看见的能力。
- **彻底删除实现** —— 不采纳：D8 双后端 GUI 电机、冻结的线协议与辅助进程夹具重新推导代价高昂；操作者要求的是停放并记录，不是销毁。
- **就地修缺陷继续发货** —— 不采纳：操作者的常设指令是停用与提取；缺陷修复属于重建阶段，并以 `protop/README.md` 中记录的诊断为种子。
- **放任 `shellbox/*` 离开事件词汇表** —— 不采纳：读取路径会拒绝每一份碰过该功能的退役前日志（见上文决策）。
- **给历史 `shellbox/*` 事件回填 `ignorable: true`** —— 不采纳：分类语义虽正确，但用一次性改写器篡改操作者的聊天档案属于本次变更并不需要的语料迁移；有了声明留存即可。

## 后果

产品在重建落地前完全让出隔离桌面能力；模型提示词、工具与侧栏不再提及 Shellbox。套件失去树内 Shellbox 规格（它们与原型同在，接纳原型时即可运行）。生成目录缩小，`web` profile 的层次故事只剩两层。

换来的是：操作者的 harness 不再为半成熟功能分神，冻结表面不再积累意外变更，而 `protop/README.md` 里的提取方法是对操作者日后其他拆分工作的预演。重新引入是一份提案而非一次回滚：[独立插件重建](../../proposed/feature/2026-09-30-shellbox-standalone-plugin-rebuild.zh.md)拥有那条路径。