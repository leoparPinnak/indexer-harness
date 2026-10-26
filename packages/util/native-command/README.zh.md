---
description: "宿主原生命令与路径打开工具，提供无 shell 执行、取消、桌面探测与 WSL 路径交接。"
kind: "package-library"
---

# @deepseek-ai/dsh-native-command

[English](README.md) | 中文

## 概述

`dsh-native-command` 无需 shell 即可运行 Host 可执行文件，并通过桌面打开 Host 文件系统路径。命令运行器捕获 utf8 输出、传播取消，并隐藏 Windows 瞬时控制台。路径打开器支持默认应用与文本编辑器意图、浏览器可渲染文档、WSL 转换与桌面可用性检查。它是库而非插件：没有 `ctx`、无状态、不发事件。

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

当宿主侧集成需要执行一条原生命令、并需要它的输出或失败信息（或两者兼要）、且绝不能涉及 shell 时，使用本运行器。

### 运行一条命令

```ts
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'

declare const script: string
declare const signal: AbortSignal
const { stdout, stderr } = await runNativeCommand('osascript', ['-e', script], signal)
```

退出码为 0 时，调用解析为捕获到的 stdout 与 stderr。任何失败都会以错误拒绝，错误附带退出 `code` 与两路已捕获输出，因此调用方无需重跑命令即可区分工具缺失（`ENOENT`）、取消（`ABORT_ERR`）与真实的命令失败。

### 注入命令边界

`NativeCommandRunner` 类型是宿主集成的可注入命令边界：在集成需要一个可测试边界的位置传入该函数（或其包装层），测试即可替换为假运行器。

### 打开 Host 路径

`openNativePath(path, signal)` 将路径交给默认应用；平台能够确定默认浏览器时，HTML 与 SVG 会优先交给该浏览器。`openNativeTextFile(path, signal)` 选择文本编辑器意图；macOS 使用 `open -t`。WSL 路径先通过 `wslpath -w` 转换，再交给 Windows 桌面。`canOpenNativePath()` 报告当前 Host 是否可能具备桌面目标。

`revealNativePath(path, signal)` 在 Finder 或文件资源管理器中选中文件，包含 WSL 路径转换；在桌面 Linux 上通过 `xdg-open` 打开上层目录。`nativeFileManager()` 标识该操作，供 UI 根据 Host 选择文案；桌面是否可用仍由独立的 `canOpenNativePath()` 检查决定。调用方必须先授权绝对文件路径，再执行操作。平台分派由注入运行器的测试覆盖；原生桌面验证由对应平台负责。 Explorer 接收独立参数中的编码文件 URI。退出码 1 按已转交请求处理；取消、找不到可执行文件和其他退出码仍然报错。该确认不能证明桌面窗口已选中文件。

### Windows 文件夹窗口

在 Windows 上打开目录会直接调用 `explorer.exe`，而不是经由 shell 的 `Invoke-Item` 动词，因此窗口不必等待 PowerShell 冷启动。Explorer 在把请求转交给正在运行的桌面进程后会以退出码 1 结束，打开器将其视为成功转交。

被打开的窗口属于 Explorer 而不是本进程，因此 Windows 会拒绝它自身的激活请求，窗口就会落在操作者当前窗口的后面。转交之后，打开器显式夺取前台：它通过 shell 自己记录的已开窗口定位该文件夹对应的那个窗口（按文件夹路径匹配，绝不按显示的标题），然后执行一条逐步验证的阶梯——与当前前台线程共享输入状态并抬起窗口、再使用 shell 自身的切换、一次解锁前台锁的合成 ALT 按键、最后做一次短暂的 z 序闪动——每一步之后都重新检查 `GetForegroundWindow()`，直到窗口确实拥有前台。已经打开的同一文件夹会定位到那个既有窗口。该辅助程序以退出码报告结果（0 前台、2 无窗口、3 被拒绝）。

前台夺取在整个进程内串行执行并带重试：两个辅助程序同时争抢会互相夺走前台，因此第二次打开会排队等待；而窗口仍在创建中的文件夹会把它的夺取流程继续寻找最多五秒，之后由下一轮重新抬起找到的窗口。路径打开器把最终的拒绝视为“窗口已在后面打开”，而不是手势失败。启动 Explorer 时必须保持 `windowsHide` 为 `false`，而辅助程序必须为 `true`：隐藏的启动状态会被 GUI 子进程创建的窗口继承，从而让文件夹以不可见的方式打开。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

命令运行器是 Node `execFile` 的薄包装。路径打开器根据平台与环境事实选择一条无 shell 命令，而调用方继续负责决定允许打开哪个路径。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 命令运行器与路径打开器的公共导出 |
| [`src/runner.ts`](src/runner.ts) | 无 shell 的 `execFile` 适配器 |
| [`src/path-opener.ts`](src/path-opener.ts) | 桌面探测、打开意图、浏览器偏好与 WSL 转换 |
| [`src/windows-foreground.ts`](src/windows-foreground.ts) | 为托管打开所创建的文件夹窗口夺取 Windows 前台 |
| — | 不发布运行时不变式伴生入口；每次运行都是一次无状态的子进程往返，不拥有事件流或可变运行时数据；相关行为由单元测试保障。 |

### execFile 给了运行器什么

`execFile` 以 argv 数组直接 spawn 可执行文件——没有 shell 字符串，参数不经 shell 解释。`signal` 选项在调用方中止触发时终止子进程；`windowsHide` 在 Windows 上抑制瞬时控制台窗口。遇到非零退出或 spawn 错误时，回调把 `code`、`stdout`、`stderr` 挂到被拒绝的错误上，并保留原始错误作为 `cause`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要消费方或本工具刻意不属于的通用子进程能力时，阅读以下页面。

- [原生目录选择器](../../host/directory-picker-native/README.zh.md)——本运行器执行的 OS 选择器命令。
- [Session Controller](../../api/session-controller/README.zh.md)——打开前解析 Session 相对 workspace 路径。
- [Settings Controller](../../api/settings-controller/README.zh.md)——选择 settings 文档与 agent-preset 目录。
- [子进程能力](../../subprocess/subprocess/README.zh.md)——通用子进程 seam，本包并非其组成部分。

-----

<a id="model-experience"></a>
## 模型体验

无：宿主侧工具不注册任何面向模型的内容。

#### KV Cache 影响

此处没有任何内容进入请求前缀；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本运行器何时不是合适的工具。它们是当前包约束，不是任务积压。

- **不做输出限量**——两路流在内存中无界缓冲；当前每个调用方只运行输出为一个路径或一行错误的小型原生工具。把它指向输出量可观的命令之前，先接入 `dsh-output-retention` 限量。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
