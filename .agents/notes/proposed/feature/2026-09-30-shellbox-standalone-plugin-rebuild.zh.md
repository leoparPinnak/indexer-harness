# Agent Note：Shellbox 重建为独立插件

Status: proposed

[English](2026-09-30-shellbox-standalone-plugin-rebuild.md) | 中文

## 问题

Shellbox 已从产品退役至 `protop/shellbox/`（[DSH v2 退役记录](../../implemented/simplification/2026-10-01-shellbox-retired-to-protop.zh.md)；同一功能已于 2026-09-30 在同一方案下离开 DSH v3），但仍带着真实缺陷：嵌入的 PowerShell 经 `-Command` 层丢失引号转义、私有桌面会无声退化为用户真实的 `Default` 桌面、视口/目标数学接受退化目标并振荡、且没有任何机制为辅助进程的固定端口抵抗无关本地服务。操作者希望该能力最终回来——干净地、并且如“它本来就应该是个插件”那样——而不重新缠死产品。

## 提案

把 Shellbox 重建为单一独立组合包 `@deepseek-ai/dsh-shellbox`，由停放的树（`protop/shellbox/deamon`、`ui-sandbox-view`）组装，可对任意 profile 执行 `dsh plugin --profile <name> add` 安装，且不被任何随发行模板点名。具体为：

- **一个组合包，两行**：宿主行（路由、辅助管理器、工具、skill、提示段）与 `ui-sandbox-view` 客户端行——正是停放的 `cordis.patch.yml` 已表达的形态——采用新的包名。
- **缺陷播种**：`protop/README.md` 中记录的诊断成为第一个里程碑——以临时文件或 `-EncodedCommand` 取代嵌套 `-Command` 传递引号、以显式失败取代 `Default` 回落、目标数学加上钳制/去重——各配一条钉住的规格测试。
- **端口纪律**：辅助守护进程获取其端口（或取 `DEAMON_PORT`）；系统内不得有别的东西占用它，冒烟工具也必须拒绝该端口。
- **协议保全**：`sandbox/PROTOCOL.md` 与工具 schema 冻结不动；重建把它们当作让重新引入变便宜的兼容性契约。
- **Persona 诚实**：`app:shellbox-surface` 段只回到挂载了该组合包的 profile（停放的 `surfaceContext` 门控已经提供了这一点），产品不再擅自宣扬该能力。

## 曾考虑的替代方案

- **把树搬回去重新发货** —— 不采纳：那等于复活退役前的缠结加原始缺陷，正是退役要阻止的结局。
- **以全新架构重建（自有采集栈，去掉 PowerShell 辅助）** —— 诱人但推迟：辅助进程的冻结线协议是昂贵且有效的一部分；新传输层可以作为叠在此提案之上的另一份提案。

## 验收标准

- 对空白 profile 执行 `dsh plugin --profile <name> add` 能挂载两行；`--dump-config` 可见；移除插件后路由、工具、skill、提示段与侧栏标签页一并无残留地消失。
- 三类已诊断缺陷各有钉住的回归测试，修复前会失败。
- 两个无关本地服务可以占用任意端口（包括旧的硬编码 4005）的同时 Shellbox 桌面仍能启动。
- 产品树的随发行模板依然不点名任何 Shellbox 包。

## 风险

- 原型停放期间会偏离核心 API（注册表惯用法、事件信封）；重建预算必须吸收一次重构。
- 若 Windows 采集行为在脚下变迁，冻结协议恐化石为负债。
- 留存的 `shellbox/*` 词汇（见退役记录）必须随将来取代它的迁移一起搬走，否则老语料会损坏。