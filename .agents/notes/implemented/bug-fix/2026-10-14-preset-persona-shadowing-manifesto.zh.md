# Agent Note: 用户请求宣言到达 standard 与 ptc preset 会话

Status: implemented

[English](2026-10-14-preset-persona-shadowing-manifesto.md) | 中文

## 问题

[用户请求宣言](../feature/2026-10-13-user-request-supremacy-manifesto.zh.md)部署到了四份 bundle 的 `personaPrefix` 与 `cordis` preset，其笔记声称每一份交付的部署 persona 都携带它。而 `standard` 与 `ptc` preset 自己挂载的 persona 行，其 prefix 只是光秃的职责句；preset 的 persona 行会整体遮蔽部署 persona——因此这两个 preset 上的每个会话（包括 Web GUI 的默认组合）组装出的系统提示词里，persona 只有一行，没有任何请求执行或如实报告段落。

该缺口由操作者的模型网关转录日志证实：一个 standard preset 请求携带 11,014 字符、不含任何宣言标题的系统提示词，而同一小时的 cordis preset 请求携带含完整文本块的 34 KB 提示词。特性笔记自己的句子——宣言「同样适用于任何其 preset 未遮蔽 persona 的会话」——点出了这个条件，却没有关闭它。

## 决策

`standard` 与 `ptc` preset 的 persona 行在职责句之后携带与 bundle 相同的宣言文本块，从 `packages/bundle/web-app/cordis.patch.yml` 逐字节移植（2,492 字符），并把标量从折叠式（`>-`）改为字面式（`|-`），使段落分隔在组装后仍然保留。遮蔽部署 persona 的 preset，现在随身携带它所遮蔽的文本。

## 曾考虑的替代方案

**从 `standard` 与 `ptc` 中删除 persona 行，让部署 persona 生效。** 删除该行可以停止遮蔽，但这一行是 preset 拥有自身身份的唯一途径：被复制到其他部署的 preset 保留自己的 persona，而不是继承那个部署的 bundle 所携带的内容；persona 插件正是为这一权衡而存在。

**为 persona 插件扩展一个与部署 persona 合并的选项。** 第二条组装路径（部署 prefix 加 preset prefix）会让遮蔽保持单一归属的段落模型复杂化，而特性笔记已经接受文本跨文件重复作为该模型的代价。

**把宣言移入插件拥有的 `system-prompt` 段落。** 已被特性笔记拒绝：段落有顺序且可被遮蔽，部署角色与行为属于 persona。

## 后果

- 宣言文本现在在构造上存在于七个文件——四份 bundle patch，加上 `cordis`、`standard` 与 `ptc` preset 的 persona 行——未来的修改必须触及全部七处。
- standard 与 ptc 会话组装出的提示词比之前大约 2.4 KB；GUI 默认组合是主要受益者。
- `snapshots/web/schedule-catalog/system-prompt.expected.md` 依照其归属笔记保持未动（手写的侧车文件，本树中没有可运行的比较）；raw 组合的快照固定的是 bundle persona，本来就正确。
- `sdk-minimal` 保持其由环境选择的精简 persona 不变。
- 验证路径与暴露缺口的证据相同：从网关转录读取一个新的 standard preset 会话的外发请求，在职责句之后包含请求执行标题。

## 相关

- [每份部署 persona 中的用户请求宣言](../feature/2026-10-13-user-request-supremacy-manifesto.zh.md) 拥有文本及其优先顺序规则；本笔记关闭它的部署缺口。
