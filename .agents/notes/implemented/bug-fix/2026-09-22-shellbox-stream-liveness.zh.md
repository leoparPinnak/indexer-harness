# Agent Note：Shellbox 视频流存活——重连、代理加固

Status: implemented

[English](2026-09-22-shellbox-stream-liveness.md) | 中文

## 问题

启动时正常的 Shellbox 观看端在运行一段时间后会永久冻结：侧栏画面停止更新，而实例列表、状态接口与模型工具全部正常。三个缺陷共同造成了这个症状：

- 正在运行的服务器对 `GET /api/server/sandbox/stream` 仍然返回已提交的 `HTTP 307` 重定向，而工作区里已经躺着一个半成品的 pipe 代理（缺 `http` 的值导入，新代码根本跑不起来；旧的 `307` 测试还在断言重定向）。浏览器 `<img>` 只跟随一次重定向，不会重新请求，因此每次中途断流都是永久的。
- 面板从不主动重新请求视频流。MJPEG `<img>` 在连接中途断开时不触发 error，只会冻在最后一帧。
- pipe 代理没有给 daemon 响应挂 `error` 监听，daemon 在流中途死掉就是一个未处理的响应错误——Web 服务器进程里的未捕获异常。

## 决策

- `SandboxBody.tsx` 通过每秒一次的 `/api/server/sandbox/status` 轮询跟踪存活：一旦测得帧率为零超过四秒就重新请求视频流 URL，重试间隔从一秒退避到十五秒；恢复的视频流会重置退避阶梯。直接失败的视频流 URL 会按两秒间隔重试三次，之后才显示加载提示。
- 面板的帧经 WebSocket 套接字而非 MJPEG `<img>` 到达；上述看门狗与阶梯作用于该套接字的 `cacheBuster` 通道，传输决策记载于 [ws-sandbox-frame-stream](2026-09-23-ws-sandbox-frame-stream.zh.md)。
- `/stream` 桥接 pipe daemon 响应，daemon 响应出错就销毁观看者响应；代理请求在已发送响应头之后失败也销毁观看者响应。
- helper 丢掉失败的单帧并从干净状态重建采集面，而不是直接退出：命令轮询、目标跟踪、采集与编码跑在 `try` 里，stdout 写留在 `try` 之外，因此管道关闭仍会终结孤儿 helper。
- `DEAMON_DISCOVERY_FILE` 覆盖 Deamon 发现文件路径，让 spec 拥有自己的坐标；`startDeamon` 在测试运行时不再覆盖线上 Deamon 的发现文件，Deamon `/status` 响应也不再在没有请求 instance 时编造 `session-<id>` instance id。

## 备选方案

**保留 307 重定向，只在面板修重连。** 否决：重定向迫使面板经过面板观察不到的第二条连接，且 `<img>` 对 multipart 流的重定向处理在各浏览器上不一致。pipe 让一条可观测的连接穿过 host。

**按固定间隔重连，不看测得帧率。** 实测后否决：固定轮询连健康的流也会重新请求，白白重启 helper。测得帧率本来就由状态轮询发布，因此看门狗不产生新流量。

## 后果

- 死掉的流几秒内自己恢复：面板重新请求，daemon 在同一桌面上重启 helper，画面自动回来，无需用户操作。
- daemon 在流中途死掉只会终结观看者响应，不会拖垮 Web 服务器。
- 测试运行不再触碰 `~/.dsh/deamon.json`。

## 测试

- `packages/bundle/deamon/tests/sandbox-routes.spec.ts` 通过真实桥接服务器钉住 pipe 帧（状态码、内容类型、multipart 分帧、JPEG 魔数）、流中途 Deamon 死亡后的存活（桥接之后仍能应答）、502/503 回退，以及最后一个观看者离开后 helper 保持存活。
- `packages/bundle/deamon/tests/deamon.spec.ts` 与路由 spec 通过 `DEAMON_DISCOVERY_FILE` 隔离 Deamon 发现。
- `packages/client/ui-sandbox-view/tests/sandbox-body.client.spec.tsx` 钉住失败提示之前的重试阶梯、提示之后的手动重试、测得帧率为零时的看门狗重连，以及帧率恢复后的安静稳态。

## 附录：服务器日志终端（同一会话）

在线上机器验证日志文件时发现它在有流量时仍保持为空：Web 组合从不注册控制台 exporter，因此 `ctx.logger` 流量只进入 1000 条内存缓冲，从不到达 stdout tee 能抓到的进程流。`packages/bundle/web-app/src/server-log.ts` 因此把两个通道都镜像进 `$DSH_HOME/logs/dsh-web.log`（5MB 轮转、单个备份、崩溃安全的同步追加、磁盘故障时静默停用）：控制台流上的写穿透 tee 加一个 `ctx.logger.exporter()` 注册，以新在上行的方式在 `GET /api/server/logs` 提供，用 `POST /api/server/logs/clear` 清空。线上探查接着发现 daemon 中继行仍然缺失：管理器只排空 daemon 子进程的 stderr，从不读它的 stdout，中继输出滞留在一个无人读的管道里，写满就会卡住 daemon；现在 stdout 行经由日志转发。设置里的服务器日志分区（`packages/client/ui-server-logs/`，`settings.section` order 90）把该末尾新在上渲染，带实时刷新、子串过滤与清空。由 `packages/bundle/web-app/tests/server-log.spec.ts`、`packages/bundle/deamon/tests/deamon.spec.ts` 与 `packages/client/ui-server-logs/tests/server-logs.client.spec.tsx` 钉住。
