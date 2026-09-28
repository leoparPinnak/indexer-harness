# Agent Note：WebSocket 沙箱帧流——shellbox 面板的可观测传输

Status: implemented

[English](2026-09-23-ws-sandbox-frame-stream.md) | 中文

## 问题

shellbox 面板把 `GET /api/server/sandbox/stream` 的 MJPEG multipart 画进一个 `<img>`，这种传输恰好隐藏了面板必须据以行动的事实：MJPEG `<img>` 在连接结束时不触发任何错误事件，于是死掉的流把画面冻结在最后一帧、没有任何可据以重连的信号；而中途离开的查看者让路由把响应头写进一个套接字早已消失的响应——这是一次位于任何 `try` 之外的写入，其未捕获异常会杀死 web 服务器进程。[shellbox-stream-liveness](2026-09-22-shellbox-stream-liveness.zh.md) 中的重连决策修复了 helper 与 Deamon 两侧、并把该路由自身的失败移入保护之内，但面板自己的传输仍然失明。

## 决策

- `packages/bundle/deamon/src/sandbox.ts` 从 web 服务器的 upgrade 钩子提供 `STREAM_WS_PATH = '/api/server/sandbox/ws'`：`registerUpgrade(route)` 经 `handleUpgrade` 把每条连接交给 `WebSocketServer({ noServer: true })`，插件的 dispose 注销该路由并终止路由仍持有的每个客户端套接字。
- upgrade 首先通过连接服务的源检查：`connection.requestRejection(req)` 返回 `401` 或 `403` 时由 `rejectUpgrade` 在任何握手头之前写回答复，其余回答放行，因此跨站 WebSocket 劫持永远到不了握手。
- 面板经共享的 `buildStreamQuery` 组合 `?session=…&instance=…&target=…&fps=…`，使套接字、状态轮询与尺寸上报指向同一目标。
- 守护进程的 MJPEG multipart 由共享的 `createMultipartFrameParser` 切成完整 JPEG；每个 JPEG 作为一条二进制消息、经喂入 `SandboxController.stream` 的 `ControllerSink` 适配器离开，长度字段无法续上分帧的部件被丢弃，而不会让后续流失去同步。
- `MAX_FRAME_BUFFER_BYTES`（16 MiB）限制单个缓冲帧，`WS_BACKPRESSURE_BYTES`（2 MiB）让 `sendFrame` 丢帧而非排在慢查看者身后，因此每个查看者的内存保持有界。
- 每次关闭都说明其原因——`1013` 表示尚无法确保守护进程（正在启动或不可用：重连可能成功），`1011` 表示源在流中结束或 helper 停止——面板以既有的重试阶梯应答两者。
- `SandboxBody.tsx` 以该查询打开 `ws(s)://<origin>/api/server/sandbox/ws`，每收到一条二进制消息就换掉图像的对象 URL 并撤销上一个，把 `close`/`error` 收敛进连接阶梯——两次间隔两秒的三次尝试——之后才是带手动重试的失败提示；状态轮询看门狗在同一 `cacheBuster` 通道上保留其四秒停滞检测与逐级上升的重连阶梯，而一个清理函数负责卸载、目标与会话切换以及手动重试，取消任何待处理的重试计时器。
- `GET /api/server/sandbox/stream` 保留其管道式 HTTP 行为（由自身 spec 钉住），面板则从套接字读帧。

## 考虑过的替代方案

**只加固 MJPEG 管道并保留 `<img>`。** 被拒：保护让进程不再死，但面板仍无法观察一条已经停止的流——MJPEG `<img>` 在连接结束时不触发错误——于是用户看到的冻结画面依旧，每次重连都是一次面板无法归因的 URL 重请求。失败即事件的传输才是修复；保护作为其下的纵深防御保留。

## 后果

- 停止的流变成面板据以行动的事件：关闭携带可重试或终止性原因，阶梯发起重连，失败提示提供手动重试，而不是一帧冻结画面。
- 中途离开的查看者带不走 web 服务器：响应头写入、守护进程响应错误与响应头之后的代理错误都位于路由的保护之内。
- 每个查看者的内存受帧上限与背压丢弃约束；慢查看者丢帧，而不是让队列增长。
- 面板如今依赖可升级的同源连接，解码失败的帧与任何其他图像失败一样落回同一阶梯。

## 测试

- `packages/bundle/deamon/tests/sandbox-routes.spec.ts` 经真实 bridge 服务器钉住 upgrade 分发（接受的握手、被拒的普通请求与源检查）、二进制帧投递、任意分块切分下的重组、不可续分帧部件的丢弃、无法启动的 helper、以可重试关闭收场的守护进程失败、以 `1011` 关闭的守护进程流死亡、dispose 注销路由并关闭查看者、守护进程应答前离开的查看者之后服务器继续服务，以及 HTTP 管道对等（状态、内容类型、multipart 分帧、JPEG 魔数）。
- `packages/client/ui-sandbox-view/tests/sandbox-body.client.spec.tsx` 钉住套接字打开与帧绘制、失败提示前的连接阶梯、把图像失败与套接字失败折进同一个重试窗口、由会话/目标/实例形成的查询形状、看门狗把重连阶梯按在其延迟窗口内、手动重试清掉待处理的重连计时器、卸载时取消待处理的重连，以及停止与尺寸上报契约。
- 线协议记载于 `packages/bundle/deamon/sandbox/PROTOCOL.md`；面板传输记载于双语 `packages/client/ui-sandbox-view/README.md`。
