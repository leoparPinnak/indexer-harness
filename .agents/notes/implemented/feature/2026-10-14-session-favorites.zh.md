# Agent Note: Session 收藏作为存放于已存储 Session 旁的文档

Status: implemented

[English](2026-10-14-session-favorites.md) | 中文

## 问题

Workspace 树的增长方式与聊天记录相同：操作者每天都要回到的那些 Session，最终散落在一堆一次性聊天之间，回到它们唯一的方式就是滚动一个分组列表。浏览器没有办法让某个 Session 保持可达，也没有任何地方能跨浏览器记住这样的选择，因为侧边栏渲染的每个列表都派生自 Host 状态。

## 决策

收藏是一个 JSON 文档，`{"sessionIds": [...]}` 按加星顺序书写，并与它命名的 Session 放在一起：Web bundle 把 `workspace-controller` 必填的 `favoritesFile` 配置字段指向 `$DSH_HOME` 内的 `sessions/favorites.json`，因此这份列表随 Session 一同存续，并且从 harness 之外依然可读。

Host 拥有它：`SessionFavorites` 串行化读-改-写循环，并通过 `writeFileAtomic` 写入；既有的 `ctx.remote.workspace` namespace 增加了 `listFavorites` 与 `setFavorite`，两者都返回完整顺序。Client 把该顺序放进它本就发布的快照里（`favoriteSessionIds` 与 `archivedSessionIds` 并列），在启动时读取一次文档、在载体重连后再读一次，并安装每一次切换的回显。侧边栏把它渲染为 Workspace 分组之上的固定区域，为空时隐藏，并在每个 Session 行上提供一个星标切换。打开收藏项通过普通行相同的路径导航到那个 Session：文档只是一串 id，绝不是对话的副本。

## 曾考虑的替代方案

**把列表留在浏览器里（localStorage 或仅 Client 的存储）。** 完全省掉 Host 侧工作，但列表随浏览器配置一起消亡，对同一部署的其他 Client 不可见，并且会成为唯一不驻留在 Host 上的持久侧边栏状态。

**把它存进 settings 段落。** settings 文件已有 Remote 表面、无需新方法，但它不是操作者所说的 Session 目录，而收藏也不是部署所要配置的产品设置。

**新建一个拥有自己 Remote namespace 的包。** 归属清晰，模式也确实存在——但 `workspace-controller` 已经拥有 Session 级别的导航状态（归档集合），侧边栏也已经在接收它的快照，所以第二个 namespace 与第二行 bundle 配置买不到任何隔离：固定区域需要两个列表并排出现。

**用 `favorites` 增量搭上 `workspace/follow` 流。** 无需重载即可让每个 Client 保持同步，代价是为一种只在浏览器前那位单一操作者显式点击时才变化的状态，新增一种帧类型、一个增量分支，并改动流协议。

**在读取时删除 Session 已不存在的 id。** 让文档保持精确，却把一次列表读取变成 Session 存储查询，并使一次意外的 Session 删除破坏一个刻意的选择。

## 后果

- 该文档属于整个部署，且不在 Workspace 流的范围内：另一个 Client 的切换会在下次启动或载体重连时出现在这里。README 把这一点记为已知限制。
- 文档损坏时会带上其路径直接报错；文档缺失时读作空。把 Session 存放在别处的部署必须自行命名该文件，因为没有默认值。
- 其 Session 已不存在的 id 会留在文件中并被 UI 跳过，因此操作者可以取消加星，或者就让它留着。
- 打开收藏只是导航：不会创建、派生或复制任何 Session，也不会有任何内容进入 Session 日志。
- 收藏是操作者的 UI 状态。没有提示词、工具 schema 或会话事件发生变化，因此请求字节与缓存前缀都不移动。

## 关联

- [新会话总是开启一个聊天，行内操作在触屏上依然可用](../bug-fix/2026-10-14-new-session-blank-reuse-and-touch-actions.zh.md)把星标切换放进同一个无需 hover 即可到达的操作区。
