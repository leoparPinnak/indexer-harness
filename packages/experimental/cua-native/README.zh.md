---
description: "通过 stdio NDJSON 拉起预编译的 cua-helper.exe，为 gui-motor A/B 基准驱动原生 COM UIA 读取、SendInput 合成与 Windows.Graphics.Capture 截帧。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cua-native

[English](README.md) | 中文

## 概述

本包是 CodexNative GUI 后端：一个 TypeScript 客户端，负责拉起预编译的 `cua-helper.exe` 并按 Codex 的 stdio NDJSON 协议通信，通过原生 COM UIA 读取活动窗口、用 SendInput 合成输入、通过 Windows.Graphics.Capture 抓取画面。它导出 gui-motor A/B 基准加载的 `GuiBackend` 工厂，以及原始的 `CuaHelperClient` 接口（`get_window_state`、点击、按键、次级操作、捕获）。辅助程序可从 `native/cua/build.cmd` 离线构建；使用者直接采用预编译二进制，无需编译。本包仅支持 Windows，处于实验阶段，不提供稳定性保证。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

当代码需要像 Codex 的 computer-use 辅助程序那样驱动真实 Win32 桌面时——例如在 `benchmarks/gui-motor` 中做对比测量，或未来的 GUI 工具需要活动窗口状态与真实输入——就使用本包。它是两个竞争后端之一；koffi/PInvoke 的替代实现位于 `packages/bundle/deamon`。

### 入口点

```ts
import { createCodexNativeBackend } from '@deepseek-ai/dsh-experimental-cua-native'

const backend = createCodexNativeBackend() // spawns the helper once
const receipt = await backend.sendInput({ kind: 'mouseClick', windowId: 'main', x: 400, y: 300, button: 'left' })
await backend.client.close()
```

成功的表现是：`{ delivered, detail }` 回执如实报告操作系统实际接受的内容；`readUia` 快照的元素路径跨次运行保持稳定；`capture` 帧的区域颜色取自真实像素。失败会高声报错：缺少辅助二进制时提示 `native/cua/build.cmd`，未知 `windowId` 以 `CodexNative backend has no window` 拒绝，辅助进程崩溃时以退出码与 stderr 尾部拒绝所有待处理请求。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 — 点击展开</summary>

### 设计哲学

- **忠实复刻。** 辅助程序重现 Codex 经实测的机制：`uiautomationcore.dll` 中原生 COM `IUIAutomation` 原生 vtable 遍历、`SendInput` 合成（绝不使用投递消息）、经 `Direct3D11CaptureFramePool` + `IGraphicsCaptureItemInterop` 的 `Windows.Graphics.Capture` 截帧。GDI 仅作为文档化的回退模式存在。
- **预编译、独立、离线。** `native/cua/build.cmd` 仅用 MSVC 与系统导入库编译辅助程序——不联网、无 cargo（本机未安装）、不涉及 `build.ts`，使用者无需任何编译。
- **单次拉起，稳态往返。** 客户端在构造时拉起辅助进程，并为每个请求盖上 `meta["x-oai-cua-request-budget-ms"]`，与 Codex 的 `helper_transport.js` 一致（launch_app 15 秒，其余方法 10 秒）。

### 源码地图

| 文件 | 职责 |
| --- | --- |
| [`src/adapter.ts`](src/adapter.ts) | `createCodexNativeBackend`：带能力描述符的 `GuiBackend` 工厂 |
| [`src/client.ts`](src/client.ts) | 拉起进程 + NDJSON 请求/响应、类型化错误、审批重发 |
| [`src/protocol.ts`](src/protocol.ts) | 编解码、按方法超时、`NdjsonDecoder` |
| [`native/cua/src`](../../../native/cua/src) | 辅助程序源码：COM UIA 遍历、SendInput、WGC 与 GDI 回退 |

### 机制与实测行为

- **读取** 通过 `IUIAutomationTreeWalker` 遍历 Control View 树，分配 `element_index` 与稳定路径（优先 `AutomationId`，否则名称 slug，再否则索引），并遵循 `disableDiff` 返回基准打分所用的永不同步裁剪的完整子树。
- **输入** 经 `SendInput` 落地；回执报告已排队事件数、移动后的光标位置，以及前台是否真正转移——由于激活在注入后的一个消息泵周期才完成，焦点转移采用轮询目标消息泵的方式观测。
- **捕获** 窗口坐标样本取自 WGC 窗口帧，桌面坐标样本取自 WGC 显示器帧。在本系统构建上，被完全遮挡的窗口不产生窗口项帧，因此辅助程序对该窗口做负缓存并回退到 PrintWindow 拷贝窗口像素，而桌面样本继续来自 WGC 显示器帧（`mode` + `desktopSource` 报告这一拆分；显式强制 `gdi` 的请求对桌面区域报告 `#000000` 未命中哨兵）。
- **构建：** `cmd /c native/cua/build.cmd` → `native/cua/bin/cua-helper.exe`，并复制到本包 `bin/` 供 `resolveHelperPath()` 使用。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [gui-motor 基准](../../../benchmarks/gui-motor/README.zh.md) — 本后端接入的 A/B 框架及其必须满足的打分权重。
- [`native/cua`](../../../native/cua) — 辅助程序的离线 MSVC 构建与三大子系统。
- Codex 的 `helper_transport.js`（由 CodexGuiSpy 实测） — 本包所镜像的原始线路协议。

-----

<a id="model-experience"></a>
## 模型体验

无：本包不注册任何提示词、工具模式或结果文本；向模型呈现 GUI 状态的消费者承担每一处模型可见的行。

#### KV 缓存影响

无影响：本包贡献的内容不进入任何请求前缀；KV 缓存行为属于组装提示词的消费者。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是当前的包级限制，而非与其他后端的对比：

- **仅限 Windows，且受桌面门控。** 真实集成套件需要可交互的活动桌面（win32 上设置 `DSH_CUA_DESKTOP=1` 且已构建辅助程序）；未门控的测试通道只覆盖协议、进程生命周期、路径解析与能力描述符。
- **本系统构建上被遮挡窗口的 WGC 被抑制。** 窗口项帧只在窗口位于最前可见时到达（实测前台 31–78ms，遮挡时永不到达）；负缓存加 GDI 窗口回退保证捕获继续可用，桌面样本保持其 WGC 来源。
- **GDI 回退模式没有桌面像素。** 窗口拷贝看不到任务栏或外来覆盖；这些样本按设计报告 `#000000` 未命中哨兵。
- **启动审批仅为协议实现。** 辅助程序可用 `approvalRequest` 暂停 `launch_app`（由 `CUA_REQUIRE_LAUNCH_APPROVAL=1` 启用）；客户端抛出类型化错误——真正的用户审批界面属于审批切片。
- **`list_apps` 只列出运行中的应用**（来自活动顶层窗口），不是已安装应用目录；`launch_app` 启动可执行文件/路径/协议，不支持商店 AppUserModelID。
- **辅助二进制不入库。** 它从源码离线构建；CI 或开发者须先运行 `native/cua/build.cmd` 再跑桌面门控套件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

工具链选择：本机没有 `cargo`，因此辅助程序是 C++/MSVC COM——与 windows-rs 会生成的原生 vtable `IUIAutomation` 路径相同。重建命令 `cmd /c native/cua/build.cmd`；门控套件 `DSH_CUA_DESKTOP=1 pnpm exec vitest run desktop.integration`。编辑任一 README 侧后：`pnpm run verify-translation-pairing --write packages/experimental/cua-native/README.md`。

</details>
