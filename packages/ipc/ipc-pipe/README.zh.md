---
description: "dsh 用它替代本机回环 HTTP 跳转的命名管道网关：经 Windows 命名管道或 unix socket 的成帧请求/响应消息、sha256 密钥摘要握手、64 KiB/512 KiB 上限、2 秒默认预算，以及每个 home 一个监听者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ipc-pipe

[English](README.md) | 中文

## 概述

让同一台机器上的两个进程用命名管道交换消息，而不是走回环 HTTP 往返。在真正干活的一侧挂载服务端，调用方凭共享的 home 密钥连接，每一次交换都成帧、有大小上限、有时间预算。不持密钥的对端在握手处被拒绝，同一端点上的第二个监听者被锁拒绝。它只搬运字节：无 TLS、无跨机器传输、无浏览器界面。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

常见路径：宿主桥接挂载客户端、其辅助守护进程挂载服务端，于是命令与事件以管道帧穿越，而浏览器继续使用它的 HTTP 与 WebSocket 表面。

### When to choose it

当同机跳转发生在两个 dsh 进程之间、且消息需要预算、大小上限与已认证的对端时，选择本网关；调用方的传输选项以 `pipe`（默认）选择它，回环旧路径为 `http`（D9 移除）。当调用方是浏览器或外部工具时仍用 HTTP——管道端点为单个 home 私有，从不绑定 TCP 端口。

### Minimal configuration

本包是库而非插件：不占用 `cordis.yml` 行，每个选择都以调用方的选项或环境变量到达。

| Field | Default | Meaning |
|---|---|---|
| `seed` | DSH home | 决定端点名的摘要种子（`dsh-gateway-<homehash16>`）；spec 传入自己的坐标 |
| `DSH_GATEWAY_PATH` | 平台端点 | 直接固定端点路径，而非推导 |
| `DSH_GATEWAY_KEY` | `$DSH_HOME/ipc/dsh-gateway-<hash>.key` | 握手密钥覆盖；文件在首次使用时创建 |
| `timeoutMs` | `2000` | 默认逐请求预算（毫秒）；单个请求可自带预算 |
| `halfCloseToleranceMs` | `30000` | 已半关闭的对端还能接收应答多久 |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

一个帧是 `[u32 total][header JSON][0x0A][body]`：大端字节数、单行信封、换行，随后是信封所描述的原始正文。由于 `JSON.stringify` 不会产生裸换行，读取方在缓冲正文之前就能还原信封，因此在得知帧类型的那一刻即可拒绝超限帧。上限是硬性的：超过 64 KiB 的 `req` 帧、超过 512 KiB 的 `res`/`chunk` 帧会以明确的 `PAYLOAD_TOO_LARGE` 错误关闭连接，而不是截断消息。

客户端在第一帧自证：`hello` 携带 `sha256(key)` 与协议代次；不匹配会被记录日志、以 `AUTH_FAILED` 应答，并在任何请求被受理前关闭连接。双方从相同坐标推导密钥——`$DSH_HOME/ipc/dsh-gateway-<hash>.key`（首次使用时以 `wx` 创建）或 `DSH_GATEWAY_KEY` 覆盖——因此从未写过密钥文件的 home 也能与对端达成一致。

服务端以两种形态应答。只设头并结束的处理器发送一个携带完整正文的缓冲 `res` 帧；先 flush 或先写的处理器打开流，对端读取 `chunk` 帧直到 `end`。第二种形态正是 Deamon 的 multipart JPEG 帧流能逐字节穿越管道的原因。读者离开时发送 `abort`，结束该应答，让处理器自身的 `close` 监听器解除挂载——与 HTTP 客户端断开所产生的释放一致。

端点旁的单实例锁（`<home>/ipc/dsh-gateway-<hash>.lock`，内容 `{pid, startedAt}`）在持有者存活时拒绝第二次挂载，pid 消亡时被夺取，因此两个守护进程从不共享同一管道名。崩溃遗留的 socket 文件只有在锁证明没有存活持有者之后才被删除。发送 FIN 的对端保留可写侧 `halfCloseToleranceMs`：FIN 之后算出的应答仍会送达，只有始终算不出的应答才会失去连接。

### Source map

| File | Role |
|---|---|
| `src/coords.ts` | 端点、锁与密钥推导；常量时间摘要比对 |
| `src/protocol.ts` | 帧语法、上限、预算与增量读取器 |
| `src/server.ts` | 监听器、锁、握手、请求路由与应答帧 |
| `src/client.ts` | 连接、握手、缓冲请求、流与中止 |
| `src/errors.ts` | 每次拒绝所携带的类型化失败词汇表 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-deamon](../../../protop/shellbox/deamon/README.zh.md)——经本网关对话的桥接与辅助守护进程
- [dsh-host-webserver](../../host/webserver/README.zh.md)——为浏览器保留的 HTTP 表面
- [Development](../../../docs/development.zh.md)——贡献者工作流与检查通道

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- 每个 home 与每个种子只有一个端点：同一台机器上的两个进程共享一个连接目标，而同一扇流被一个服务端扇出给多个读者并未建模——每个读者各自开连接。
- 传输仅限本机。Windows 命名管道与 unix domain socket 没有跨机器形态，此处也不协商 TLS。
- 上限按设计是硬失败：超过 64 KiB 的请求或超过 512 KiB 的响应块会关闭连接，因此更大的负载必须在本层之上自行分块。
- `deamon.transport: 'http'` 在 D9 移除之前仍与管道并行服务旧的回环路径；无法挂载网关的对端会回落到该路径并记录降级。
- 密钥文件在端点旁以明文落盘（权限 `0600`）。希望使用外部管理的密钥的部署应改设 `DSH_GATEWAY_KEY`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

线格式由 `packages/ipc/ipc-pipe/tests/ipc-pipe.spec.ts` 演练：握手成功与拒绝、两种大小上限、请求预算、单实例竞争、半关闭容忍，以及读者离开后仍继续的流。Deamon 侧经 `packages/bundle/deamon/tests/deamon.spec.ts` 与 `sandbox-routes.spec.ts` 钉住同一传输。

端点名沿用 Hermes `control_socket.py` 的形状（`\\.\pipe\dsh-gateway-<homehash16>` 加 unix socket 回落），但代码为全新编写；摘要握手沿用 OMP `omp-daemon` 模式。帧携带 `timeoutMs`，使服务端装配与调用方相同的预算，钳制在 100 毫秒到 60 秒之间。

</details>
