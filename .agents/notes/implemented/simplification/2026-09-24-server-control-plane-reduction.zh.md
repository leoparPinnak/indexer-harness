# Agent Note：服务器控制面收敛为进程退出式关闭

Status: implemented

[English](2026-09-24-server-control-plane-reduction.md) | 中文

## 问题

设置里的电源对话框原本提供三项控制：一次软刷新、一次硬重置（`POST /api/server/restart` 写入 `.dsh/restart.signal`，期间轮询 `GET /api/server/ping`），以及进程退出式关闭。树外的重启依赖无人拥有的辅助物——`baslat.bat`/`kapat.bat` 驱动 `scripts/launcher.ps1`（其看护循环占着自己的终端）、`scripts/hard-reset.*` 后台观察器，以及 home 层每 10 秒探测 web 与 daemon 端口的 `heartbeat.mjs`。用户报告这些启停辅助物与程序观察器不可靠，要求只保留退出服务器进程的那个按钮。

## 决策

- 设置电源按钮现在只打开关闭对话框：一张危险卡片 POST `/api/server/shutdown`，该路由先回应、发出 `SIGTERM`，随后落入 `process.exit(0)`。`power.*` 词条、阶段状态机、ping 轮询与 orb/pill 状态面已从 en/zh/tr 中移除。
- `@deepseek-ai/dsh-web-app` 删除 `POST /api/server/restart`、`GET /api/server/ping` 与两处 `.dsh/*.signal` 写入；关闭路由保留其来源栅栏与方法校验。
- 辅助脚本（`scripts/launcher.ps1`、`scripts/hard-reset.ps1`、`scripts/hard-reset.bat`、`baslat.bat`、`kapat.bat`）连同 heartbeat 观察器及其 `heartbeat.log` 一并删除。重新启动使用已记录的 `dsh web` 启动方式。
- [server-death-evidence](../bug-fix/2026-09-23-server-death-evidence.zh.md) 保持有效：其日志读法权威（tee、exit 见证、存活 tick、port-owner 消息）依然交付；它关于辅助脚本与 heartbeat 的执行者行已在这次部分取代下就地改写。

## 后果

只剩一条退出路径（GUI → 关闭路由 → SIGTERM → exit），重启或恢复是在终端里人工执行 `dsh web` 启动。死亡证据仍留在 `$DSH_HOME/logs/dsh-web.log`；第二次人工启动以 `stopping code=1` 与点名的端口属主收场。

## 考虑过的替代方案

**把重启留在配置开关后面。** 被拒：被报告为故障的正是这套机制，开关后面不会剩下任何当前消费者。

**保留 `/api/server/ping` 作为通用健康端点。** 被拒：它唯一的消费者是被移除的硬重置轮询器，不满足当前拥有者规则。

## 测试

`settings-root.client.spec.tsx` 钉住 shutdown-only 对话框（soft 与 hard 缺席）与 `POST /api/server/shutdown` 的完成文案；`test:gui`、typecheck、oxlint 与 doc-sync 覆盖宿主路由移除。
