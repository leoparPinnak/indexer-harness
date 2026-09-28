# Agent Note：Shellbox 以 @deepseek-ai/dsh-deamon 组合包发布

Status: implemented

[English](2026-09-24-shellbox-bundle-extraction.md) | 中文

## 问题

Shellbox——显示在右侧边栏的隔离私有 Windows 桌面——原本在 `packages/bundle/web-app` 内部组合：它的宿主桥路由、helper 守护进程、采集辅助进程、`shellbox_launch` 工具、内置 skill 与提示段都是 web-app 的补丁行，四个 spec 文件也住在 `packages/bundle/web-app/tests/` 下。想要该功能的接收方只能整体拿走 web-app，没有受支持的路径把功能单独加进已经挂载基础层的 profile，使用手册也只是 web-app README 里的散文，而不是随它记录的插件一同发布。

## 决策

- `packages/bundle/deamon`（npm 名 `@deepseek-ai/dsh-deamon`，与根同版本，`type: module`）是该功能的唯一归属：`src/index.ts`（插件外壳与 `app:shellbox-surface` 提示段）、`src/sandbox.ts`（十二条冻结的 `/api/server/sandbox/*` 路由与 `/api/server/sandbox/ws` 升级）、`src/deamon.ts` 与 `src/deamon-manager.ts`、`sandbox/sandbox-host.ps1` 及 `sandbox/PROTOCOL.md`、位于 `assets/shellbox.md` 的 skill 正文、四个 spec 文件，以及本包自己的 `cordis.patch.yml`。
- 抽取之后 web-app 不再持有任何 shellbox 知识：没有补丁行、没有依赖、没有源码或测试文件；`packages/bundle/web-app/cordis.patch.yml` 不会再点名该功能。
- 组合包的补丁承载宿主行（`id: deamon`，其 `config` 重述 `surfaceContext: true`，因为补丁会整体替换目标行的 `config`）与 `ui-sandbox-view` 客户端行，两行点名的每个包都是本组合包自己的依赖——这正是组合包自引用行规则的要求。
- 随附的 web profile 模板列出 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-deamon`，全新 web profile 无需额外步骤即可启动该功能；桌面 profile 通过 `dsh plugin` 按需添加，记在包 README 的“已知限制与延期工作”一节。
- 交付走 profile 组合包机制：接收方用 `dsh plugin --profile <name> add <spec>` 安装 `pnpm pack` 产出的 tarball（或注册表名、路径），`dsh --profile web --dump-config` 会把挂载的层标记为 `# == @deepseek-ai/dsh-deamon`。
- 不存在“系统提示里的插件列表”通道，因此手册随插件经四个载体发布：内置 `shellbox` skill 承载读自包旁 `assets/shellbox.md` 的完整指南，裁剪后的 `app:shellbox-surface` 段为模型定向并以加载该 skill 的指示收尾，`shellbox_launch` 工具描述承载启动概要，双语 README 服务维护者与接收方。
- Host 半边对 `@deepseek-ai/dsh-client-connection` 做仅类型导入（devDependency 加 tsconfig 项目引用）以解析 `ctx.connection`；组合 spec 的 Loader 模块映射为客户端行提供空 apply 模块，因为 Host 程序不能导入纯 Client 包的源码（TS6307）。

## 备选方案

**把功能留在 web-app 内并发布一份拷出流程。** 拒绝：接收方仍然继承整个 web-app，拷出的文件无法与它们所修补的 profile 层同版本演进，web-app 的每次改动都会重新打开功能归属问题。profile 层组合包正是仓库已经在版本化、跑门禁并整体安装的分发单元。

## 后果

- 接收方增加的是一个完整、带版本的功能层，而不是 fork web-app；全新安装从同一个 profile 模板获得同一层。
- skill 正文、提示段、工具描述与 README 可能各自漂移；loader-composition spec 启动随附的补丁并钉住该段文本及其 `surfaceContext: false` 分支，使“定向到手册”的交接持续被断言。
- 引用这些文件的所有活跃 Agent Note 都点名组合包的路径。

## 测试

- `packages/bundle/deamon/tests/loader-composition.spec.ts` 通过真实 Loader 启动随附的 `cordis.patch.yml`：每一行都到达已启动状态，十二条冻结路由与查看者升级挂载成功，该段位于 `getSectionOrder('WEB_SURFACE') + 5`，其文本保留定向事实，而组合出的 `surfaceContext: false` 会让该段不出现。
- `packages/bundle/deamon/tests/skill.spec.ts` 钉住内置手册的注册、正文来源与列表面貌；`packages/bundle/deamon/tests/sandbox-routes.spec.ts` 钉住路由契约；`packages/bundle/deamon/tests/deamon.spec.ts` 钉住 Deamon 生命周期与发现隔离。
