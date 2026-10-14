# win32-memory-engine

[English](README.md) | 中文

Win32 内存/观测/输入引擎。为 `packages/host/win32-memory-bridge` 提供纯 C-ABI + JSON 行式 IPC 内核：`observer`（OpenProcess + ReadProcessMemory + AOB + 指针链）、`writer`（WriteProcessMemory，仅经由 `MemoryActuator`，逐调用确认钩子）、`hwnd`（Direct HWND Mapping + UI 缓存）、`input`（原始 Scan Code `SendInput`，专用 OS 线程）、`policy`（能力探测 + 降级阶梯）、`lib`（FFI 面）。

热循环从不进入 async 执行器；使用常驻 OS 线程 + 通道（不使用 `tokio`）。

## 能力探测与降级阶梯

每个目标仅依据测量结果落入某一能力档（`policy.rs`）：

| 能力 | 证据 | 允许的操作 |
| --- | --- | --- |
| `MEMORY_ALLOWED` | `OpenProcess(VM_READ\|QUERY_INFORMATION)` 成功 | 内存读/写尝试 + 输入 + UI |
| `INPUT_ONLY` | VM 关闭，存在属于目标的可见 HWND | 原始 scan-code 输入 + UI |
| `VISION_ONLY` | VM 关闭、无 HWND、进程存活（`QUERY_LIMITED`） | 仅外部观测 + UI 记录 |
| `REFUSED` | 进程不存在（`Gone`） | 进程未找到错误 |

阶梯只向下走；访问丢失不会跳回更高能力档。若 `OpenProcess` 以 `ERROR_ACCESS_DENIED` 拒绝，引擎会探测进程保护（`GetProcessInformation` / `ProcessProtectionLevelInfo`）并把结果写入 `TargetClass`：`Normal`、`ProtectedProcessLight`（PPL）、`ProtectedProcess`、`ProtectedUnknown`、`Gone`。没有吞没：每次探测都以 `ProbeAttempt` 留在报告中，拒绝以带代号错误返回（`E_PROTECTED_TARGET`、`E_NOT_FOUND`、`E_ACCESS_DENIED`）。保护标签（`TargetClass`）是信息，不是障碍：包括 PPL/ProtectedProcess/anti-cheat 目标在内的每个目标上，每个访问向量都会被尝试；每次探测都作为 `ProbeAttempt` 写入报告，只有操作系统实际拒绝的调用才被报告为 `denied`。必须尝试备用/监管之外的向量；不允许预先放弃。

## SeDebugPrivilege 与提权启动

`wme_enable_debug_privilege`（或 `enable_debug_privilege` 命令）调用通过 `AdjustTokenPrivileges` 启用 `SeDebugPrivilege` 并如实报告结果（若未授予特权则返回 `enabled: false`，并附 `ERROR_NOT_ALL_ASSIGNED` 说明）。

注意：`SeDebugPrivilege` 只在已承认该特权的 token 中生效；实践中引擎必须以**提权（administrator）**方式启动。未提权的引擎不会静默假装成功，而是返回 `enabled: false`。

## UIPI 范围

原始 scan-code 输入经 `SendInput` 注入系统；按 UIPI 规则，**只有引擎同样提权时，输入才能到达提权的目标窗口**。引擎未提权时发往提权目标的输入会被操作系统静默丢弃——引擎无法报告这一点（丢弃发生在目标一侧）。使用规则：目标提权时，引擎也以提权启动。

## 支持说明

- **Wow64（32 位目标）指针宽度**：通过 `observe` 上的 `pointer_width: 4|8` 支持；4 字节链需要单独的进程验证，不支持混合模式场景。

层分离：`win32-kernel-bridge` 的 IOCTL 访问独立于引擎策略；桥在每个目标上尝试全部向量（句柄、`MmCopyVirtualMemory`、类输入）并原样报告结果。策略不是许可闸门，而是测量标尺。

## FFI 面（JSON 行式 IPC）

每次调用接受单行 JSON，产出单行 JSON 应答（`{"ok":true,"data":…}` 或 `{"ok":false,"error":{"code","detail","win32"}}`）。

- `wme_request(line) -> char*` —— 行式请求（`{"cmd":"attach|detach|modules|observe|unobserve|read|peek|poll|status|scope_allow|scope_clear|actuate|send_scancode|ui_attach|ui_detach|enable_debug_privilege", …}`）。
- `wme_reply_free(ptr)` —— 释放 `wme_request` 的输出。
- `wme_set_confirm_hook(cb, ctx)` —— 写入确认钩子；`actuate` 仅在钩子返回 `1`（确认）时才写入。没有钩子时所有写入以 `E_REJECTED` 拒绝。
- `wme_enable_debug_privilege() -> char*` —— `SeDebugPrivilege` 启用报告（JSON 行）。
- `wme_version() -> char*` —— 静态版本字符串（无需释放）。

## 测试

`cargo test` 以 mock 内存栈运行纯求解器：AOB 解析/扫描（含 chunk 边界）、指针链（4/8 字节）、值解码、写入范围 + 确认钩子逻辑、UI 脏标记/TTL、输入时序调度、JSON 请求解析。Win32 边界调用只在薄封装中 `unsafe`；可测试逻辑位于 `ByteSource`/`ByteSink` 之后保持纯。
