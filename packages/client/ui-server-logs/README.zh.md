---
description: "dsh Web 客户端的设置“服务器日志”分区：Web 宿主服务器日志文件末尾，以新在上的文本呈现，带实时刷新、子串过滤与清空操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-server-logs

[English](README.md) | 中文

## 概述

设置的服务器日志分区：Web 宿主进程日志文件（`$DSH_HOME/logs/dsh-web.log`）的末尾，以新在上绘制，新行永远可见，无需滚动锚定。每两秒刷新，按子串过滤，并可按需截断文件。写文件的主机 tee 与末尾路由在 `packages/bundle/web-app/src/server-log.ts`。

## 目录

- [注册了什么](#what-it-registers)
- [日志窗格](#the-log-pane)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

- **分区**：一个 `settings.section` 条目，id 为 `server-logs`，order 90（诊断排最后），标签取自 `serverLogs` 字典：日志窗格及其过滤／刷新／清空控件。

`src/client/` 下一个源文件：`ServerLogsSection.tsx`（窗格与控件），另有 `locales.ts`（它说什么）与 `index.ts`（接线）。

<a id="the-log-pane"></a>
## 日志窗格

分区在挂载时、自动刷新开启时每两秒、手动刷新时拉取 `GET /api/server/logs?limit=300`；响应携带 `{ ok, lines, truncated }`，行按从旧到新排列。窗格以一个 `<pre>` 新在上渲染，因此跟随日志是重渲染，不是滚动。搜索框按大小写不敏感子串过滤；清空按钮向 `/api/server/logs/clear` 发送请求并清空窗格。被拒绝的加载或清空留下一行提示。文件比宿主进程活得久，因此重启后窗格显示的是上一次运行的末尾——这正是崩溃可诊断的原因。

<a id="model-experience"></a>
## 模型体验

无，因为本包在浏览器里绘制主机日志文件，不注册任何面向模型的内容。

#### KV Cache 影响

无；末尾走 Web Host 自己的路由，不会组装模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>
- **无结构化级别。** 文件里是原始控制台行，窗格只能按子串过滤；没有级别或来源分面。
- **只留一个备份。** 主机在超过五兆时把 live 文件轮转进唯一的 `dsh-web.log.1`；更早的历史不保留。
- **可见性取决于注册。** 这个分区是否存在由挂载本包的 profile 决定；已发布的 bundle 并不挂载它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。分区唯一的运行时状态是拉到的行加上过滤／刷新／清空控件，全部由挂载中的组件持有，并随其定时器一同释放；没有第二个观测源可与之比对。
