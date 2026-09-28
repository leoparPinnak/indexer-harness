# Agent Note: 接管出站连接超时并放宽默认重试预算

Status: implemented

[English](2026-09-11-outbound-connect-deadline-and-retry-budget.md) | 中文

## Problem

当一个模型请求的 TCP SYN 始终没有回应时，它要耗完 undici 十秒的连接超时，重试策略才会安排下一次尝试。于是五次尝试在轮次失败前花掉约 66 秒，且每次尝试都让轮次整整停留十秒。在会零星丢 SYN 的链路上——在报告该问题的机器上测得：连往 `api.deepseek.com`（CloudFront 边缘 3.173.21.63）的连接耗时在 0.06 秒到 9.2 秒之间波动，ICMP 通畅，其他 CloudFront 源站均为毫秒级响应——Harness 无法恢复，而它所等待的这个超时无法由任何部署调整。

undici 的连接超时属于 dispatcher。`dsh-http-proxy` 拥有全局 dispatcher，但当启动环境未指定任何代理时它什么都不安装，于是直连进程跑在 Node 内置 dispatcher 上，沿用 undici 自己的默认值，且无从缩短。

## Decision

`dsh-http-proxy` 为每份策略都安装 dispatcher，包括不代理任何流量的那份；它构建的每个 dispatcher 与 pool 都携带 `connect: { timeout: connectTimeoutMs }`。该超时由 `DSH_CONNECT_TIMEOUT_MS` 从启动器的环境快照解析，默认 4000 毫秒；不可用的取值会让启动失败，而不是像代理 URL 那样被报告并跳过——不存在其他工具可能设置过这个名字。

四秒恰好放行一次 Windows 上的 SYN 重传（其初始 RTO 为三秒），并让无法建立的连接比 undici 默认值早约两倍半结束；正常路径上的握手只需毫秒级。

`DEFAULT_MAX_RETRIES` 从 5 提升到 8。每次尝试如今受传输超时约束，因此八次尝试花费的耐心预算与先前五次同量级，同时让请求获得更多独立机会穿过有损链路，且首次恢复来得更早。

重试提示中的延迟标签说明该取值是计划值——`重试延迟（计划）`、`Retry delay (planned)`、`Yeniden deneme gecikmesi (planlanan)`。该行在等待开始前就打印计划退避时间，读者一直把它当成已经过去的时间。

## Alternatives considered

**在提供方适配器里设置请求级超时。** 已否决：围绕 `fetch` 的超时会在响应头到达时解除，因此慢速上行链路上传大体积内联请求体时会被当作连接失败而中止。只有 dispatcher 的连接超时能仅约束连接与 TLS。

**只在环境指定了代理时缩短该超时。** 已否决：报告中的停滞发生在直连链路上，而那恰恰是不安装 dispatcher 的情形。

**保留 undici 默认超时、只提高重试次数。** 已否决：这样每次丢 SYN 仍值十秒的停滞请求，而这正是要消除的等待。

**只提高 `maxRetries` 而不约束单次尝试。** 已否决：每次十秒的更多尝试意味着更长的停滞，而不是更好的恢复。

## Consequences

- 每个 `dsh` 进程都会安装 dispatcher，因此在不代理任何流量的链路上，`getGlobalDispatcher()` 不再是 Node 的内置对象。该情形仍然不改动环境，`proxyRouteFor` 也仍然报告直连路由。
- 低于链路往返时间的连接超时会把可达源站变成失败。`DSH_CONNECT_TIMEOUT_MS` 可将其调高；包 README 说明了这一取舍。
- 完全宕机的提供方如今在轮次失败前要耗掉约 78 秒重试，而先前那组默认值是约 66 秒。
- 标签改动属于客户端自有文案，因此只有重建客户端 bundle 后才会体现在 GUI 上。

## Testing

`packages/util/http-proxy/tests/install.spec.ts` 钉住直连链路的安装、在无路由地址（TEST-NET-1）上对已配置超时的执行、解析默认值、可接受取值，以及其余取值的加载期拒绝。`packages/llm/llm/tests/retry-policy.spec.ts` 与 `packages/llm/llm/tests/service.spec.ts` 钉住新的重试默认值，`apps/web/tests/shipped-composition.e2e.ts` 与 `apps/web/tests/smoke-real.e2e.ts` 把它钉为随附 profile 的策略。`packages/client/ui-chat/tests/chat-branch-tails.client.spec.tsx` 钉住本地化标签。
