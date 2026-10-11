# gui-motor — GUI 自动化后端的对比 A/B 基准

[English](README.md) | 中文

本测试工具是 "hangisi en iyi → varsayılan"（谁最好 → 谁当默认）这一决策的机制：它在速度与原生保真度上测量候选 GUI 自动化后端，为每项指标赋予权重打分，并输出"默认 vs 回退"的裁决。参与竞争的两个后端是：koffi FFI + PowerShell P/Invoke 后端（`NativeWin`，已接入 deamon 引擎）与原生 COM UIA + SendInput 后端（`CodexNative`，已接入 `packages/experimental/cua-native`）。测试表现最佳者成为默认后端，另一个成为回退后端。

分两个阶段：MOCK 阶段（每个结果、表格行与 JSON 文档都明确标注 `MOCK`）在任何机器上都能运行、无需实时桌面；REAL 阶段在实时工作站上通过桌面门控驱动真实 Win32 窗口。

## 布局

- `src/backend.ts` — 可插拔的 `GuiBackend` 接口：`sendInput(op)`、`readUia(selector)`、`capture(target)`，外加 `GuiCapabilities` 能力描述符（`nativeInjection`、`comUia`、`capturesWinRt`）。
- `src/fixture.ts` — `GUI_MOTOR_FIXTURE`：三个目标窗口（普通、丢弃投递消息、提权）、十个真值元素、五个预期采集区域；以及运行器推导场景的辅助函数。
- `src/mocks/` — 两个 MOCK 后端（`createKoffiMockBackend`、`createCodexNativeMockBackend`），以及用于确定性测量的虚拟时钟。
- `src/runner.ts` — N 轮迭代运行器：每操作的中位数/p95 延迟，以及相对真值的四个保真度比率。
- `src/scoring.ts` — 加权综合分与 `decideBest` 裁决（默认、回退、逐项指标的理由）。
- `src/report.ts` — 打印的结果表格；对比文档本身可原样序列化为 JSON。
- `src/adapters/` — 真实后端适配器：`native-win.adapter.ts` 驱动 deamon 引擎的本地路由（`send` 模式的 `handleSandboxInputLocal`、`handleSandboxUiaLocal`、一次性 `-CaptureOnce` 帧并经 `png-region.ts` 采样）；`codex-native.adapter.ts` 委托给 `@deepseek-ai/dsh-experimental-cua-native` 的 `createCodexNativeBackend`。
- `src/live-target.ts` — 确定性 WinForms 目标窗口（已知颜色/文本）、其设备像素几何探针，以及两侧桌面的派生辅助函数。
- `src/png-region.ts` — 面向 NativeWin 采集路径的最小 PNG 解码 + 区域采样。
- `run.ts` — MOCK 阶段对比：`pnpm exec tsx protop/shellbox/gui-motor/run.ts`。
- `run-real.ts` — 桌面门控的真实对比：`DSH_D8_DESKTOP=1 DSH_CUA_DESKTOP=1 pnpm exec tsx protop/shellbox/gui-motor/run-real.ts`。
- `tests/` — 单元证明：`pnpm exec vitest run gui-bench`。

## 运行

- `pnpm exec tsx protop/shellbox/gui-motor/run.ts` — 为两个 MOCK 后端打分，先打印结果表格，再打印 JSON 对比文档，最后输出 `verdict: <x> = default, <y> = fallback`。
- `pnpm exec vitest run gui-bench` — 运行单元证明（虚拟时钟，因此瞬间完成并保持在 15s testTimeout 预算内），包含对两个真实后端适配器的构造一致性验证。
- `DSH_D8_DESKTOP=1 DSH_CUA_DESKTOP=1 pnpm exec tsx protop/shellbox/gui-motor/run-real.ts` — 在实时 Win32 桌面上跑真实 A/B。缺少任一门控它会拒绝运行（退出码 2）；该运行会移动物理光标并合成私有 shellbox 桌面，因此请在交互式工作站上执行，不要放在无头 CI 通道里。

## 测量内容

延迟是一次调用的墙钟往返时间，对每种操作类别的每一轮迭代采样，报告中位数 + p95（最近秩）：

- `sendInput` — 对目标窗口合成鼠标移动/点击/按键。
- `readUia` — 遍历窗口的元素子树。
- `capture` — 抓取目标的一帧。

保真度跨全部迭代汇总为相对夹具真值的 0..1 比率：

- `inputReach` — 成功送达的输入尝试 ÷ 总尝试（合成输入是否真正落地，包括在丢弃投递消息或提权的窗口上）。
- `uiaCompleteness` — 找到的真值元素 ÷ 真值元素总数。
- `uiaPropertyAccuracy` — 在已找到元素上，name/value/bounds 正确的观测数 ÷ 比较的观测总数。
- `captureFidelity` — 与预期颜色匹配的区域 ÷ 预期区域（漏采的区域上报黑色哨兵值）。

## 评分与决策流程

每项指标在 `DEFAULT_WEIGHTS` 中都带有权重（速度 0.35，原生保真度 0.65；七项权重求和为 1 并做防御性归一化；`inputReach` 是单项最高权重，因为在忽略投递消息/提权窗口上的 SendInput 触达是首要的原生区分点）：

| 指标 | 权重 | 原始值 | 得分 |
| --- | --- | --- | --- |
| `sendInputLatency` | 0.10 | p95 ms | `best p95 / p95` |
| `readUiaLatency` | 0.15 | p95 ms | `best p95 / p95` |
| `captureLatency` | 0.10 | p95 ms | `best p95 / p95` |
| `inputReach` | 0.25 | 0..1 比率 | 原始值 |
| `uiaCompleteness` | 0.15 | 0..1 比率 | 原始值 |
| `uiaPropertyAccuracy` | 0.10 | 0..1 比率 | 原始值 |
| `captureFidelity` | 0.15 | 0..1 比率 | 原始值 |

综合分是各项指标得分的权重和。决策流程：综合分更高者赢得 `default` 席位，次高者为 `fallback`；综合分完全打平时按总保真度决胜；若决胜后仍然打平则抛错（请增加迭代轮数或复核权重）。理由会逐项指明每条准则的胜者，因此"后端 X 在 <准则> 上胜出"本身就是裁决的一部分。

要重新调整评分标准，把 `ScoreWeights` 对象传给 `runComparison` 或 `decideBest`；非正或非有限的权重会立即报错。

## 真实后端（已接线）

两个适配器都已连接到各自引擎；测试工具、运行器、评分与报表在两个阶段完全一致：

- **CodexNative** — `createCodexNativeBackend(options?)` 返回 `@deepseek-ai/dsh-experimental-cua-native` 的后端：SendInput 合成（回执携带真实落地与焦点事实）、`get_window_state` 的 `disableDiff` 映射为 `readUia`（`element_index` → `UiaElement.path`）、WGC 区域采样用于 `capture`。helper 在构造时只派生一次；派生与管道建立被排除在每操作采样之外（只测稳态往返），由调用方负责 `backend.client.close()`。
- **NativeWin** — `createNativeWinBackend(options?)` 通过基准专属会话驱动 deamon 引擎（`persistencePath: false`，桌面 `dsh-sb-guibench`）：输入批次经引擎自有路由的 `send` 模式（在私有桌面上做真实 `SendInput`）、可访问性经引擎的 `uia` sidecar 遍历 + `parseUiaResult` 钳制（托管 .NET UIA）、采集经 helper 一次性 `-CaptureOnce` PNG 路径（含进程拉起开销；引擎的流式帧路径是 JPEG，未被采样）、窗口经引擎的 `.state` 快照解析。`launch()` 启动 helper 并把目标放到私有桌面；`close()` 停止它。

受测能力描述符：CodexNative `true/true/true`（SendInput、原生 COM UIA 虚表、WGC Direct3D11CaptureFramePool）；NativeWin `true/false/false`（SendInput 按需启用、托管 .NET UIA 而非原生 COM 虚表、GDI 阶梯而非 WGC）。

## 实测结果（本机，2026-09-29，桌面门控）

每操作 6 轮迭代，两个后端对准同一个实时目标（`gui-motor-live-target`；CodexNative 在输入桌面，NativeWin 在其私有桌面）：

| 后端 | sendInput 中位/p95 | readUia 中位/p95 | capture 中位/p95 | reach | tree | props | frame |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CodexNative (COM UIA + SendInput + WGC) | 1.2/21.4ms | 44.4/71.7ms | 475.9/504.1ms | 1.00 | 1.00 | 1.00 | 1.00 |
| NativeWin (SendInput + managed UIA + GDI) | 1.4/5.4ms | 35.3/156.9ms | 683.9/710.8ms | 1.00 | 1.00 | 0.89 | 1.00 |

裁决：**codex-native = 默认，nativewin = 回退**（综合分 0.93 vs 0.88）。CodexNative 赢得 readUia 延迟（p95）、采集延迟与属性准确率（NativeWin 的托管遍历读不到文本框的值）；NativeWin 赢得 sendInput p95；触达、完整性与采集保真度双方并列 1.00。

本轮测量的披露：NativeWin 的 `inputReach` 采用引擎自身契约（批次已按 `send` 模式暂存到 helper），而 CodexNative 报告输入队列确认落地并附带焦点转移；NativeWin 的 `capture` 含一次性 PowerShell 进程拉起；NativeWin 的完整性以七个内容控件为范围（其托管遍历不枚举非客户端标题栏，而 CodexNative 的真值包含它）；元素边界按各后端观测到的坐标空间固定（托管 helper 报告相对根的边界）。上表中每个保真度指标与每个延迟样本都需要实时桌面；MOCK 阶段无需桌面即可复现机制差异。

## 接入或更换后端

1. 契约是 `GuiBackend`（`src/backend.ts`）；后端实现三个方法并如实声明 `GuiCapabilities` 描述符 + `mock: false`。
2. 适配器位于 `src/adapters/` —— 引擎调用面变动时只改这一个文件；测试工具、运行器、评分与报表永不需要动。
3. 两个阶段都跑：MOCK 裁决随时可跑，真实裁决在两个桌面门控下跑；`runComparison([...], fixture, { iterations })` 与 `decideBest(results, weights)` 可组合进任何其他测试工具。

## 注意事项

- MOCK 配置编码的是实测的真实世界预期：koffi/PowerShell 互操作路径每操作更慢（每次调用都要 FFI/编组）且有损（消息注入在忽略投递消息/提权的窗口上落空，GDI 帧把任务栏与外部区域采成黑色），而原生 helper 每操作更快、触达/完整性/采集保真度满分。它们是经评审的合成常量，真实后端一经接入即被测量取代；权重敏感性本身由评分单元测试证明。
- 运行器有意串行运行各后端：并发后端会相互争用并污染延迟样本。
- 按 benchmarks AGENTS.md 的约定，在第二个基准目录产生同样需求之前，场景支撑代码保持在 `gui-motor/` 内。
