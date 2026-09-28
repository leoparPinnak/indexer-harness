# Agent Note：DEAMON 是组合包标识，桌面存活到显式停止

Status: implemented

[English](2026-09-24-deamon-rename-and-persistent-desktop.md) | 中文

## 问题

Shellbox 组合包带着第二个身份：npm 包、目录、宿主行 id、daemon 源文件、发现文件、日志前缀与 profile 标记全部拼写 `shellbox`/`ShellboxDaemon`，而系统呈现给操作者的名字是 DEAMON，于是每读一处 manifest、日志行或 dump-config 标记都要把一个名字映射到另一个。

最后一个观看者离开后 30 秒回收 helper 的闲置停止与产品预期相抵触：操作者打开一次桌面，就期望这个普通桌面一直留在那里直到他关掉它，而每次关闭侧栏标签都会悄悄结束该会话的桌面。

## 决策

- 组合包身份处处都是 DEAMON：`packages/bundle/deamon` 处的包 `@deepseek-ai/dsh-deamon`、宿主行 `id: deamon`、源文件 `src/deamon.ts` 与 `src/deamon-manager.ts`、类 `DeamonManager`/`DeamonHandle`、环境变量 `DEAMON_PORT` 与 `DEAMON_DISCOVERY_FILE`、发现文件 `deamon.json`、健康检查 `service: 'deamon'`、日志前缀 `[deamon]`，以及 dump-config 标记 `# == @deepseek-ai/dsh-deamon`。
- Shellbox 保留为功能与表面名：`dsh-shellbox`/`dsh-sb-<session>` 桌面名、`shellbox_launch` 工具、`shellbox` skill、`app:shellbox-surface` 提示段、`ShellboxDock` 标签、`/api/server/shellbox/launch` 路由别名、冻结的 `/api/server/sandbox/*` 线协议与 `shellbox-profiles` 浏览器配置目录都不动。
- 闲置停止已被删除：`internals.idleStopMs`、闲置计时器以及 `stream()`、`launch()`、`stop()`、`settleChild()` 里的武装/解除调用点全部删除，最后一个查看者关闭后 helper 继续采集；`publish()` 在没有客户端连接时本来就丢帧，因此那条路径上再无其他变化。
- 桌面现在只经显式动作结束：`POST /api/server/sandbox/stop`、实例终止、管理器的关停清扫，或服务器关停；helper 崩溃仍会在同一桌面上重启 helper 并重新拉起 shell。
- 首次启动无需额外步骤即显示普通桌面：`sandbox-host.ps1` 在采集开始前先在私有桌面上启动 `explorer.exe`，因此面板画出的第一帧是桌面外壳，而不是空表面。

## 备选方案

**只改名、保留闲置停止。** 否决：操作者契约是存活到显式关停；回收计时器在产品没有保活通道的情况下无法满足它，而一旦持久化成为规则，计时器横跨四个方法的武装/解除簿记就是可删代码。

**把回收器搬进插件。** 在移除决策阶段被否决：桌面功能不想要单独的生命周期属主——启动 helper 的控制器就是停止它的那一个，且只响应显式命令。

## 后果

- 桌面存活期间即使没有查看者也持续满帧率采集，这是整个桌面生命周期内接受的持续 CPU 成本。
- 桌面与其 helper 跨会话累积，直到显式停止或服务器关停清扫它们；清扫仍是遗忘时的兜底。
- `POST /api/server/sandbox/stop` 与服务器关停按钮现在是健康桌面仅有的结束方式，GUI 停止按钮与路由契约因此更有分量。
- [stream-liveness](../bug-fix/2026-09-22-shellbox-stream-liveness.zh.md) 曾拥有闲置宽限决策；本注记取代该部分，其重连与代理决策保持不变。[shellbox-bundle-extraction](../architecture/2026-09-24-shellbox-bundle-extraction.zh.md) 继续拥有抽取决策，其标识已就地更新。

## 测试

- `packages/bundle/deamon/tests/sandbox-routes.spec.ts` 用 `keeps the helper alive after the last viewer leaves` 替换闲置回收用例：给查看者开流、关闭它、等待越过旧窗口的测试替代值（2.5 秒），断言 `isActive()` 仍为真；其余路由钉住不变。
- `packages/bundle/deamon/tests/deamon.spec.ts` 钉住 `service: 'deamon'`、`deamon.json` 发现文件、`DEAMON_DISCOVERY_FILE` 隔离，以及经 `DeamonManager` 的 `deamon stdout:` 中继行。
- `packages/bundle/deamon/tests/loader-composition.spec.ts` 以行 id `deamon` 启动随附补丁，`verify-config-catalog` 钉住 `# == @deepseek-ai/dsh-deamon` 一节，`profile.spec.ts` 与 `built-bin.e2e.ts` 断言 `web` profile 模板元组与 dump-config 标记。
