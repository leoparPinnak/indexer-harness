---
description: "dsh Web 客户端右侧 Sidebar 的 CDP tab 类型：把 Chrome DevTools Protocol 扩展的 Host 状态路由渲染为可用性、版本、实时目标数量与代理状态，并带有加载、失败与重试状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cdp-view

[English](README.md) | 中文

## 概述

右侧 Sidebar 的 CDP tab 类型，标签为 **CDP**：一块面板，呈现 Chrome DevTools Protocol 扩展在 Web Host 上注册的状态路由。它以纯 `fetch` 读取 `GET /api/server/cdp/status`，并绘制 Host 报告的内容——扩展是否应答、已安装 bundle 的版本、它当前控制多少个浏览器目标，以及它的本地代理监听器是否启用。`ui-sidebar-right` 里没有任何东西认识本包。

## 目录

- [注册了什么](#what-it-registers)
- [状态路由](#the-status-route)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

- **类型**：`ctx.sidebarRightTabs.register(...)`，kind 为 `cdp`，id 为 `@deepseek-ai/dsh-client-ui-cdp-view`，档位 `extension`，没有地址 pattern。一个引导页入口以 `CDP` 为标签把它放到“添加标签页”页面上。
- **正文**：以该 id 为键的 `sidebar.right.pane.tab` slot：一枚可用性圆点与一行状态、一块版本/目标/代理字段面板，以及加载、失败与重试状态。

`src/client/` 下的源文件：`definition.ts`（类型是什么）、`CdpBody.tsx`（状态读取、校验与状态机），另有 `locales.ts`（它说什么）与 `index.ts`（接线）。

<a id="the-status-route"></a>
## 状态路由

Host bundle 拥有该路由与响应体，本面板只读取它。`GET /api/server/cdp/status` 应答 `{"ok": true, "version": "<bundle 版本>", "targets": <n>, "proxy": {"active": <布尔值>}}`，与 `cdp_status` 模型工具报告的字段相同。

本面板重新声明这四个字段，而不是导入 Host bundle 的类型，并在 `fetch` 解析后逐一校验：被拒绝、传输失败、不是 JSON，或字段类型不符合声明的响应，都会落到失败行及其重试控件上，由后者重新发起读取。版本字符串与目标数量原样显示；可用性行把一枚状态色圆点与文本标签配对，因此颜色从不是唯一的通道。

<a id="further-exploration"></a>
## 延伸阅读

- [cdp](../../bundle/cdp/README.zh.md) — 注册状态路由、`cdp_status` 工具以及本面板所读响应体的 Host bundle。
- [ui-sidebar-right](../ui-sidebar-right/README.zh.md) — 拥有右侧 Sidebar 的标签页注册表、带键正文 slot 与“添加标签页”引导页。
- [Web UI 样式参考](../../../docs/web-styling.zh.md) — 本面板样式表遵循的 token 与浮层规则。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只在浏览器里读取一条 Host 状态路由，不注册任何面向模型的内容。

#### KV Cache 影响

无；状态读取走 Web Host 自己的路由，不会组装模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **可见性取决于注册。** 这个 tab 是否存在由挂载本包的 profile 决定；成为已发布的 row 是另一步注册工作。
- **响应体是镜像而非共享。** 本面板重新声明这四个状态字段，而不导入 Host bundle 的 `CdpStatusResponse`，因为浏览器包不依赖 Host bundle；Host 新增或改名字段时，需要同步更新本面板的解析器。
- **读取发生在 tab 挂载时。** 面板在每次挂载以及每次重试时读取一次该路由，不做轮询，因此 tab 保持打开时变化的目标数量要等到读者重试或重新打开才会刷新。
- **只绘制状态面。** 实时目标明细、最近一次快照与请求日志不属于本面板。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。面板唯一的运行时状态是加载状态及其重试计数，二者由挂载中的组件持有，并在每次读取时被替换；没有第二个观测源可与之比对。
