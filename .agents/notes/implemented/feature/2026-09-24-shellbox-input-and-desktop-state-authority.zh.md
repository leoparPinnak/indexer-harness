# Agent Note: Shellbox 输入与桌面状态权威

Status: implemented

[English](2026-09-24-shellbox-input-and-desktop-state-authority.md) | 中文

## 问题

沙箱 tab 只绘制帧，不向回传任何东西。桌面可以被观看却无法被操作，模型与读者也都看不到桌面里有哪些窗口、自上次查看以来又发生了什么变化。面板的路由还能抵达 Host 自身的桌面，因此观看者有可能对着真实会话而不是仅对私有桌面输入。

## 决策

辅助进程在帧流之外承担第二项工作：它的收集目录接收带类型的输入命令，并写出一个 `.state` 文档，列出桌面上可见的窗口。浏览器发出的每一个输入事件都变成投递给私有桌面上某个目标窗口的消息；辅助进程从不调用 `SendInput`、`keybd_event` 或 `mouse_event`，因此这条路径无法触及另一桌面上的窗口。`input char` 对文本控件经 `EM_REPLACESEL` 插入精确文本，其余情况投递 `WM_CHAR`，因为投递的 `WM_KEYDOWN` 不携带字符，而文本控件会忽略注入的 `WM_CHAR`（两者均已实测；跨桌面时 `AttachThreadInput` 会被拒绝，因此无法给目标线程植入自己的键盘状态）。Host 在进程内与 daemon 两个面上都暴露五条路由——输入、窗口、窗口聚焦、窗口关闭与变更环——对指向 Host 自身桌面的输入以 403 拒绝，对不存在的辅助进程以 409 而不是 404 作答，客户端因此能区分空闲的辅助进程与未挂载的路由。面板在工具条上提供输入开关，把渲染后的像素换算为帧像素并批处理捕获的事件（40 毫秒末尾合并移动、每批 60 个事件、失去焦点时全部释放），列出桌面的窗口并提供聚焦与关闭操作，其未查看变更徽标则来自按会话保存在 `localStorage` 里的环游标，而模型自己的确认仍然是会话游标。

## 考虑过的替代方案

**合成系统输入。** `SendInput` 会抵达 Windows 会话视为激活的那个桌面——辅助进程运行在隐藏桌面时，那就是 Host 自身的桌面；投递消息是唯一被限定在目标桌面上的机制。

**所有文本插入都走 `WM_CHAR`。** 对原生 Win32 `EDIT` 与 WinForms `TextBox` 的实测显示：两者都会忽略注入的 `WM_CHAR`，精确文本因此会丢失。选择 `EM_REPLACESEL` 的序数类名判断正来自那次实测，而必须用序数比较，是因为本机的土耳其语区域性会让 `'Edit'` 与 `'EDIT'` 的大小写不敏感 `-match` 返回 false。

**为每个窗口事实发一条模型可见的会话事件。** 变更环已经承载了提交后的变更批次；逐窗口事件会重复日志，并把每次轮询都变成一次模型可见的写入。

## 后果

辅助进程的输入文法、`.state` 文档与五条路由是 `packages/bundle/deamon/sandbox/PROTOCOL.md` 中冻结的表面；deamon 与客户端包的 README 承载消费方一侧。输入只能抵达窗口的消息队列：直接读取硬件状态的程序看不到任何东西，安全桌面提示也无法被应答。两条实测限制——跨桌面无法植入键盘状态、文本控件忽略注入的 `WM_CHAR`——都由辅助进程的验证夹具固定下来，而非假设。本决策延伸了 [shellbox bundle 抽取](../architecture/2026-09-24-shellbox-bundle-extraction.zh.md) 与 [deamon 改名与持久桌面](../simplification/2026-09-24-deamon-rename-and-persistent-desktop.zh.md)：加上窗口操作与变更环后，其表面数量现为六；帧流相关的两篇笔记（[存活检测](../bug-fix/2026-09-22-shellbox-stream-liveness.zh.md)、[WebSocket 帧流](../bug-fix/2026-09-23-ws-sandbox-frame-stream.zh.md)）保留各自的决策，未被取代。
