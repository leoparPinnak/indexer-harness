# Agent Note：服务器死亡证据——exit 见证、存活 tick 与第二实例守卫

Status: implemented

[English](2026-09-23-server-death-evidence.md) | 中文

## 问题

一夜间三次收场完全相同：`$DSH_HOME/logs/dsh-web.log` 在例行输出中戛然而止，既无错误行也无退出行，Windows 事件日志里没有 node 条目，进程直接消失——于是磁盘证据无法区分外部强杀、launcher 的 kill-then-start 与假想的卡死。端口被占用时第二个 `dsh web` 以不点名 owner 的裸 EADDRINUSE 死掉，而 `baslat.bat` 的重复运行也无法与首次死亡后的重启区分。heartbeat 观察器也在 05:10 死掉，恰好在最需要它的时刻缺失了 `DEAD:` 行。记录该文件的日志 tee 由 [shellbox-stream-liveness](2026-09-22-shellbox-stream-liveness.zh.md) 建立；重启辅助脚本（`baslat.bat`、`kapat.bat`、`scripts/launcher.ps1`）与 heartbeat 观察器已由 [server-control-plane-reduction](../simplification/2026-09-24-server-control-plane-reduction.zh.md) 移除，因此下表中的 kill-then-start 行与 heartbeat 行不再有存活的执行者。

## 决策

- `packages/bundle/web-app/src/server-log.ts` 安装 **exit 见证**：`process.on('exit')` 处理器同步向日志文件追加 `stopping code=<code> uptime=<seconds>s`。一切由 Node 发起的退出（有意关停、未捕获异常退出、CLI 拒绝）都会产生该行；强杀会在 `exit` 监听器运行前终止进程，因此该行的缺失就是外部强杀的签名。
- **存活 tick** 每 `ALIVE_TICK_MS`（60 秒，`unref`）经 logger 写入一次 `alive uptime=<seconds>s`，且 `startup.ts` 在解析命令之前就安装 tee 与见证，使启动期失败也能进文件。证据按下表解读：

| 日志证据 | 解读 |
|---|---|
| 正常启动后出现 `stopping code=0` | 有意的优雅关停 |
| `stopping code=1` 与 `port <n> taken by PID=…, refusing second instance`——守卫文本打印在被拒绝启动的控制台上，文件保存的是 stopping 行 | 第二实例被拒绝；第一个服务器仍在运行 |
| `stopping code=<other>` 之上有诊断行 | 启动被拒绝（错误 flag、组合失败），原因已记录 |
| 末行 `alive uptime=Xs`，无 stopping 行、无错误，进程消失 | H1 外部强杀（taskkill / 控制台关闭 / 杀毒软件） |
| 存活行停止但进程仍持有端口 | H4 事件循环卡死 |
| 启动后完全没有 `alive` 行 | 60 秒内死亡，或运行着见证之前的旧代码 |
| 末行与下一个 `dsh web:` URL 行之间的空档 | 停机窗口，直到人工重新启动 |

- webserver 的 `EADDRINUSE` 处理器现在以 `port <n> taken by PID=<pid|unknown>, refusing second instance (EADDRINUSE)` 拒绝，owner PID 来自 `packages/host/webserver/src/port-owner.ts` 中一次尽力而为的 `netstat -ano` / `ss -lptn` 探测（runner 可注入 fixture）；命令不可用时读作 `unknown`，而不是拖延一次已经失败的启动。探测发生在绑定失败之时而非绑定之前——消息就是计划中的消息，这一时机关闭了 check-to-use 时间窗且不给健康启动增加开销。
- `vitest.config.ts` 把 `packages/host/webserver/src/*` 覆盖率豁免收窄为 `index.ts` 与 `injections.ts`，新的 `port-owner.ts` 留在逐文件 100% 门内。

## 考虑过的替代方案

**绑定前探测端口。** 作为实现被拒：在同一个失败路径里绑定并探测给出相同的用户可见消息，同时关闭 check-to-use 时间窗、不向健康启动收费；计划中的绑定前探测以该消息的形式保留。

**用关停路由写 stopping 行。** 被拒：关停路由在被诊断的失败路径上永远不会运行；一次 `exit` 注册覆盖每个由 Node 发起的退出。

**只保留 heartbeat 观察器作为探针。** 被拒：它在 05:10 静默死亡，当晚三次停机都没留下 `DEAD:` 行——日志文件才是权威，因为服务器亲自写它。

## 后果

- 重启之后每次停机都在一个文件里留下可读的死亡原因。生产环境已演练过该协议：实例 A 在 06:43:34 记下 `alive uptime=68s`，06:44:32 被第二次 `baslat.bat` 强杀且没有 stopping 行（辅助脚本的 kill-then-start，H1 签名），当前实例每 60 秒写一行 `alive`。
- 被拒绝的第二实例以 `stopping code=1` 和点名的 owner PID 收场，而非一个裸 errno。
- stopping 行的缺失如今是外部强杀的正面证据，而不再是一个无法测量的空缺。

## 测试

- `packages/bundle/web-app/tests/server-log.spec.ts` 钉住见证行（`stopping code=7 uptime=<n>s`）、无见证时的空操作、每次间隔一行存活直到释放，以及 60 秒默认节奏。
- `packages/bundle/web-app/tests/startup.spec.ts` 钉住启动期输出在后续行之前就进入文件；`tests/web-app.spec.ts` 挂载插件并钉住日志文件中的存活行。
- `packages/host/webserver/tests/webserver.spec.ts` 在真实双绑上同时钉住 `failed to apply loader entry.*EADDRINUSE` 与新的 `port \d+ taken by PID=\S+, refusing second instance`；`tests/port-owner.spec.ts` 注入 win32 与 ss 表，钉住命中、未命中、owner 不可读与命令不可用的降级。
- `$DSH_HOME/heartbeat.mjs` 观察器与重启辅助脚本已由 [server-control-plane-reduction](../simplification/2026-09-24-server-control-plane-reduction.zh.md) 移除；日志 tee、exit 见证、存活 tick 与 port-owner 探测仍是已交付的证据面。
