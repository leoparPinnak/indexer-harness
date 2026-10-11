---
description: "Web GUI 的浏览器与 Host 之间的协议层：Remote RPC、带重连的事件流投递、精确 Fetch 路由、/api HTTP 桥与浏览器信任栅栏。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

## 概述

本包承载浏览器到 Host 的 Remote 调用、精确 Fetch 响应与 connection generation。Client 插件挂载 `ctx.connection`，其中包含当前页面的 loopback 状态、通用 RPC、当前 generation 及其 Host 信息、可观察的恢复状态、立即重连命令，以及单一 generation source 的注册点。source 报告 ready 后 generation 才可见；source 结束、失败、被撤回或显式 stop 都会清空它，再由 `ConnectionController` 执行重试策略。

## 目录

- [使用本包](#use-this-package)
- [浏览器认证与请求信任](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

浏览器通过 HTTP POST 执行 Remote 一元调用；API Gateway 自己拥有 `/api/remote.mux` WebSocket 及其逻辑流。由 shell 持有的组合通过 `connection.rpc.open` 提供等价的 Remote 流，不打开 WebSocket。Host half 始终提供与载体无关的 RPC 注册表和精确 `GET`/`HEAD`/`POST` 路由注册表。存在 Web 载体时，它还持有唯一 `/api` route、Fetch bridge、请求准入与 Host/Origin 校验；由 shell 持有的载体则直接分派共享 Fetch handler。每条精确路由会在 bridge 读取任何字节前声明缓冲或流式请求体处理方式。Typert Gateway 认领生成的 Remote endpoint，功能包注册 Session 日志下载、原始文件上传等非 JSON 响应，未认领的请求返回 404。Loopback hostname 判定只供浏览器侧当前页面状态使用，留在包内。浏览器原始请求体传输由 [`dsh-client-file-upload`](../file-upload/README.zh.md) 提供。

-----

<a id="browser-authentication-and-request-trust"></a>
## 浏览器认证与请求信任

每个 Host RPC 方法与 WebSocket 流都无需凭据即可访问：今天没有浏览器登录。`dsh-web-app` 打印并打开不带 query 令牌的普通根 URL；`frontend-static` 把根路径与 index 请求交给 `ctx.connection.authorizeIndex`，只要请求通过 Host/Origin fence 就直接提供 `index.html`。`HostConnectionService.requestRejection` 在 fence 之后询问准入接缝，不再返回 401；通过 fence 的请求直接分发。静态资源保持公开。直接打开干净的根 URL（`http://127.0.0.1:4005/`）即可——不存在 `?token=...` 往返，也不签发会话 cookie。

唯一的准入判定位于 `src/admission.ts` 的 `admissionRejection`，它就是为未来登录闸门预留的挂载点。共享 `/api` 载体经 `requestRejection` 询问它，前端 index 委托经 `authorizeIndex` 询问它；今天它无条件放行。登录机制是刻意延后的：需要时，闸门在 `admissionRejection` 返回 401，即可同时拒绝 API 与 index 请求，无需改动任何载体代码，`authenticatedUrl` 届时也可以再次发放带令牌的 URL。本包不再读取任何凭据——启动令牌交换、签名且绑定 authority 的 cookie、`client-connection/browser-session` grant 记录与 `cookieMaxAgeDays` 均已移除。

准入之前，每个请求仍经过 `src/api-request-trust.ts`。其 `Host` 必须是 loopback，或与 `trustedHosts` 条目匹配：带端口的 `host:port` 精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化。若附带 `Origin`，它必须等于该 Host；`sec-fetch-site: cross-site` 一律拒绝。畸形配置 authority 会让插件加载失败。这些检查防御 DNS rebinding 与跨站浏览器请求，绝不建立身份。Host/Origin 校验失败返回 403；通过 fence 的请求不需要任何凭据。`dsh web --host 0.0.0.0` 仍不受支持。决策记录：[浏览器请求信任](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)与[浏览器令牌认证](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md)；后一条记录了本次发布撤除的机制。

<a id="connection-generation"></a>
## Connection generation

API Gateway Client 把内部 `$events` 逻辑流注册为唯一 generation source，与有无 `$on` 订阅无关。Host 在 API Remotes source factory 同步挂好所有增量 listener 后，先发送唯一 `{ type: 'ready', clientId, host: { home } }` 项，再发送事件。`ConnectionController` 仅在收到该 ready 项后发布 generation 并调用 `onConnected`，因此 baseline 不会跑在增量 listener 前面。

`$events` 结束、Remote 流报错、收到非 ready 首项或畸形事件项，都会使当前 generation 失效。默认情况下，挂起的握手在 3 秒后记录 Host 响应缓慢告警，在 15 秒后记录就绪超时并中止，包含等待物理 socket 的时间。取消后，source 必须停止投递、释放资源并结束，替换 source 才能启动；已取消 source 迟到的 ready 不能发布 generation。浏览器报告网络可用时，Controller 发布 `connecting`，并在 500ms、1s、2s、4s、8s 与 10s 上限内采用 50%–100% 抖动重试，达到终档后继续尝试直到恢复。每次重试都要求 Gateway 替换一次物理 WebSocket，再重开 `$events`。[持续恢复决策](../../../.agents/notes/implemented/bug-fix/2026-09-05-continuous-client-recovery.zh.md)规定握手期限与重试策略。

`ctx.connection.reconnect()` 会中断活动工作、重置序列，并立即开始 retry 1。浏览器 `offline` 会中断活动工作、发布 `disconnected` 并暂停自动尝试；下一次 `online` 转换会重置序列并从 500ms 档开始。只有 ready 项会发布 `connected`。Gateway mux 不拥有独立重试调度。

可通过 Host Connection 行的 `config.recovery` 覆盖重试上限、增长因子或握手告警与取消时间；[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-client-connection)列出接受的字段。Host 校验这些值，并将其注入所提供的每个页面。Client 在提供 Connection 前校验启动数据，并在 Gateway 启动循环时采用这些默认值；显式传给 `start()` 的时序覆盖优先。增长因子必须是至少为一的有限数。若就绪、失败、取消或硬期限先于告警发生，该告警会被取消。修改 Host 恢复配置后需重新加载页面。


<a id="model-experience"></a>
## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **缓冲型 `/api` 路由会把每个请求体保留在内存里**：`maxRequestBodyBytes`（默认 300 MiB，按默认 200 MiB 图片总量上限经 base64 膨胀加信封余量得出）限制普通图片与 RPC 信封。显式启用的流式路由接收带背压的分块并绕过总量上限；路由实现负责持久化、取消与存储配额。
- **Web 应用没有登录**：凡是通过 Host/Origin fence 的请求都无凭据放行，因此任何能访问该 HTTP 端口的一方都拥有完整访问权；`src/admission.ts` 中的准入接缝正是未来登录闸门关闭这一缺口的挂载点。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`src/admission.ts`（`admissionRejection`）是唯一的延后登录挂载点：`requestRejection` 与 `authorizeIndex` 已把它的拒绝结果转发给 API 载体、已注册的 channel 路由与 index 响应，未来登录闸门只需改动这一个函数。既有的令牌/cookie 机制（`BrowserAuth`、`client-connection/browser-session` grant 记录与 `cookieMaxAgeDays`）已移除；`src/api-request-trust.ts` 中的 Host/Origin fence 保持不变。

</details>

**运行时不变式：** 不发布伴生入口。Connection 不读取任何凭据记录；准入是 `src/admission.ts` 处的一次同步进程内判定。流与重连的时序及 rpcId 往返约束由行为规范直接验证，路由注册与 dispose（资源释放）的对称性由 webserver 伴生入口审计。
