---
description: "dsh Web 客户端右侧 Sidebar 的沙箱 tab 类型：通过 WebSocket 帧消息实时呈现 Host 辅助进程发布的私有 Windows 桌面，把面板的像素尺寸回报给它，转发捕获的指针与键盘输入，并在画面旁列出其窗口列表与未查看变更徽标。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sandbox-view

[English](README.md) | 中文

## 概述

右侧 Sidebar 的沙箱 tab 类型：把 Host 辅助进程发布的实时 Windows 桌面画成一张按面板缩放的图片，每条 WebSocket 消息一张 JPEG。它是从引导页进入的页类型，不认领任何地址；它把面板的像素尺寸回报给辅助进程，让桌面按面板自身的形状合成。它的输入控制可把同一面板变成操作面，转发捕获的指针、滚轮与键盘事件，并在画面旁列出桌面的窗口。`ui-sidebar-right` 里没有任何东西认识本包。

## 目录

- [注册了什么](#what-it-registers)
- [视频流](#the-stream)
- [输入与窗口](#input-and-windows)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

- **类型**：`ctx.sidebarRightTabs.register(...)`，kind 为 `sandbox`，id 为 `@deepseek-ai/dsh-client-ui-sandbox-view`，档位 `extension`，没有地址 pattern，也没有引导页入口。
- **正文**：以该 id 为键的 `sidebar.right.pane.tab` slot：一张 `<img>`，由 Host 的 `/api/server/sandbox/ws` 帧消息绘制（每张 JPEG 一个 object URL），以 `object-fit: contain` 适配；工具条承载目标选择器、输入控制、变更徽标、帧率徽标以及刷新与停止操作，另有实时进程浮层；socket 无法连接时在原位显示一行提示。
- **标签页标题**：以该 id 为键的 `sidebar.right.pane.tab.title` slot：类型标签前的一枚 16px 显示器图标。

`src/client/` 下的源文件：`definition.ts`（类型是什么）、`SandboxBody.tsx`（视频流、尺寸回报与输入捕获）、`SandboxTitle.tsx`（标签页标题）、`inputCapture.ts`（帧像素换算与事件批次）、`LiveProcessesWidget.tsx`（窗口列表），另有 `locales.ts`（它说什么）与 `index.ts`（接线）。

<a id="the-stream"></a>
## 视频流

Host 路由在需要时启动沙箱辅助进程，把每一帧作为一条二进制 WebSocket 消息送达，浏览器经 object URL 把它绘进图片；本包从不读取其中任何字节。辅助进程、它的桌面以及每一条路由都是 `packages/bundle/deamon/sandbox/PROTOCOL.md` 里冻结的契约。

帧 socket 可能关闭或静默，因此正文盯着每秒一次的 `/api/server/sandbox/status` 轮询：一旦测得帧率为零超过四秒，就重建 socket，重试间隔从一秒退避到十五秒；恢复的视频流会重置退避阶梯。直接出错或关闭的 socket 会按两秒间隔重试三次，之后才显示加载提示。

正文上的 `ResizeObserver` 经去抖的 `POST /api/server/sandbox/size` 回报面板四舍五入后的 CSS 像素尺寸，请求体为 `{"width": <n>, "height": <n>}`，取值被夹在 320x240 到 3840x2160 之间，并在与最近一次观测到的尺寸重复时跳过，因此拖动面板只会产生一次请求。卸载时会释放 observer 与任何待执行的定时器。被拒绝的回报会被吞掉：辅助进程保持此前的视口，下一次缩放会再报一次，因此没有什么需要呈现给读者。

<a id="input-and-windows"></a>
## 输入与窗口

面板的输入控制默认关闭。打开后它会聚焦视频流图片，让指针、滚轮与键盘事件走向桌面而不是页面：面板把每个位置从渲染后的图片换算到帧自身的像素，夹到 0..5120，然后以一份 JSON 批次 `POST /api/server/sandbox/input`，由 Host 作为命令排入辅助进程。指针移动每 40 毫秒合并为一个末尾位置，批次在 60 个事件时送达；滚轮步进先合成一次移动，再以像素为单位送达（行或页增量会先被展开）；键盘输入转发 `keydown`/`keyup` 的键码，1..254 之外的键码会被丢弃。组合输入的 IME 文本按每个 UTF-16 代码单元变成一个 `char` 事件。失去焦点、卸载或切换实例都会经同一条路由释放所有按住的键与按钮，因此桌面上不会留下按住状态。被拒绝的请求会显示为一行状态，而指向真实桌面的输入会被 Host 拒绝。

实时进程浮层每三秒轮询 `GET /api/server/sandbox/windows`，列出每个可见窗口的标题、可执行文件与进程号，并提供聚焦与关闭操作，它们把同一实例范围加上窗口句柄 `POST` 给 `/api/server/sandbox/windows/focus` 与 `/api/server/sandbox/windows/close`。变更徽标以 `since=0&limit=1` 读取 `GET /api/server/sandbox/changes` 的环游标，并与本浏览器已查看过的游标比较，该游标按会话保存在 `localStorage` 键下；点击徽标即记录当前游标。该读取不推进模型的任何游标，因此徽标只是浏览器本地的事实。

<a id="model-experience"></a>
## 模型体验

无，因为本包在浏览器里绘制实时沙箱画面，不注册任何面向模型的内容。

#### KV Cache 影响

无；面板尺寸回报走 Web Host 自己的路由，不会组装模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>
- **仅限 Windows 辅助进程。** 视频流需要 Web Host 在 Windows 上启动的私有桌面辅助进程；在其他 Host 上路由不存在，正文显示加载提示。
- **输入是投递消息，而不是合成的系统输入。** 该控制经辅助进程自己的桌面抵达窗口的消息队列；直接读取硬件状态的程序看不到任何东西，安全桌面提示也无法被应答。
- **真实桌面保持只读。** 无论面板发送什么，Host 都会拒绝所有指向 Host 自身桌面的输入路由。
- **可见性取决于注册。** 这个 tab 是否存在由挂载本包的 profile 决定；已发布的 bundle 并不挂载它。
- **无硬件 GPU 加速。** 隔离的 Win32 桌面没有连接物理显示设备，不支持硬件 GPU 加速（OpenGL/Vulkan/Direct3D 交换链）。3D 应用与模拟器必须使用软件渲染（如 SwiftShader）或无头模式。
- **静默但未关闭的 socket 探测不到。** 关闭或出错的 socket 会自行重连；若它保持打开却不送帧，而辅助进程仍在服务其他观看者，测得帧率保持在零以上，直到刷新按钮主动请求前不会重连。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。正文的运行时状态是最近一次观测到的面板尺寸、重连记账、输入开关及其批次，以及已查看的变更游标，全部由挂载中的组件持有，并随其 observer、定时器与监听器一同释放；没有第二个观测源可与之比对。
