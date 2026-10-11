# Agent Note: 音频与视频输入模态声明

Status: implemented

[English](2026-10-11-audio-video-input-modality-declarations.md) | 中文

## 问题

模型设置对话框提供四个输入模态 chip——文本、图像、音频、视频——但 `llm-pi-ai` 的配置 schema 拒绝保存后两个。在自定义提供方的模型上勾选音频或视频会显示 `$.providers.<route>.models[3].input[2] expected "text" | "image" but got "video"` 并阻断"应用"。该 schema 直接从 pi-ai 自身的 `Model.input` 类型推导可接受集合，而该类型是 `("text" | "image")[]`，因此其网关原生接受音频或视频的模型根本无法记录这一事实。

## 决策

`PiAiModality` 现在是 pi-ai 自身请求模态联合类型加上两个仅声明的条目——`audio` 与 `video`。pi-ai 的集合仍被枚举在一个 `Record<PiAiUpstreamModality, true>` 漂移门之后，因此 pi-ai 升级新增模态或移除模态时，仍会按名编译失败，而不会悄悄收窄 profile 可声明的范围。扩展后的 `MODALITIES` 列表供 `input` 与 `defaultInput` 两个 schema 使用，因此两个字段都接受这两个新值，并继续拒绝其他任何值。

`audio` 与 `video` 是能力元数据，不是请求路径。pi-ai 只通过 `includes("image")` 读取模型的 `input` 来决定图像降级，且没有适配器序列化音频或视频请求内容。声明其中之一会原样到达 `LlmModelInfo.inputModalities`，且不再约束其他任何内容；正因如此，共享的 `ModelModalityMap` 把它们记录为可声明词汇，而非内容块。`resolveEntry` 的合并是唯一一处把更宽的 harness 列表收窄回 pi-ai `Model.input` 类型的地方，它使用带内联理由的类型断言完成这一点。

## 考虑过的替代方案

**改为在对话框中拒绝音频和视频。** 把四个 chip 裁剪为 schema 接受的两个能消除不一致，但会告诉操作者其网关是错的，而它其实确实服务这些模态。声明是关于一个无法被询问的端点的断言，因此诚实的做法是记录它。

**把音频和视频建模为一等内容块。** 向 `ContentBlockMap` 添加 `AudioBlock`/`VideoBlock` 能让 harness 原生发送这些媒体，但没有适配器序列化它们，pi-ai 的上游类型也不承载它们，持久化、投影、回放与计费路径都需要支持。那是一个提供方序列化特性，而非设置修复，因此不在范围内。

**让 schema 继续严格对齐 pi-ai 的联合类型，稍后再扩展。** 这保留了紧密的类型对应，但正是它产生了该 bug：pi-ai 狭窄的类型是上游序列化的限制，而非关于网关接受什么的陈述。把它当作设置词汇混淆了二者。

## 后果

操作者现在可以在 `llm-pi-ai` 模型上勾选音频或视频并干净地保存；这些值会持久化到 `settings.yaml`，并通过 `listModels`/`resolveModelInfo` 呈现。这些声明不改变任何请求——附加的媒体文件仍以确定性句柄文本到达提供方，因为附件路径只接受位图图像与逐字文件。漂移门保持 pi-ai 自身集合的诚实性，而 `llm-deepseek` 独立的 `inputModalities` schema 被有意保留不动，因为它校验的是另一提供方的目录，且仍只接受文本与图像。
