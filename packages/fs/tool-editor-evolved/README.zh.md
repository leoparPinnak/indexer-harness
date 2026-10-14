---
description: "Hashline 补丁内核：hash 锚定的 Update hunk、比较并交换写入，以及写后逐字节核验，服务各编辑工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-editor-evolved

[English](README.md) | 中文

## 概述

用一次全有或全无的补丁施加单个文件的精确行编辑：头部 `<path>:<hash>` 指名文件，随后 `@@ <line>` hunk 携带编号行证据（` <n>| text`、`-<n>| text`）与无编号插入行（`+text`）。两阶段施加在任何新内容产生之前定位并校验每一个 hunk 与当前文件相符，因此一次拒绝绝不会留下补了一半的字符串。头部 hash 不再匹配时宁可拒绝并认输（`FS_STALE_VERSION`，“请重新读取文件再试一次”），也不覆盖一次并发编辑。写入后把文件读回来，仅当字节一致才报告成功。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

消费者是面向模型的编辑器：`@deepseek-ai/dsh-tool-fs`（`edit`）与 `@deepseek-ai/dsh-tool-str-replace-editor`（`str_replace_editor`）。两者都先把 hashline 形态的 `old_string`/`old_str` 路由到本内核；输入不是 hashline 补丁时，回落到各自的字面字符串替换路径。

```ts
import { isHashlinePatch, runHashlineEdit } from '@deepseek-ai/dsh-tool-editor-evolved'

if (isHashlinePatch(oldString)) {
  const result = await runHashlineEdit({
    displayPath: target.displayPath,
    casBasis: async () => ({ kind: 'replaceIfVersion', version: observed }),
    read: async () => ctx.fs.readText(target, exec.signal),
    write: async (content, expected) => {
      await ctx.fs.writeText(target, content, expected, exec.signal, sandboxPolicy)
    },
  }, oldString)
}
```

补丁文法：

```text
src/app.ts:0123456789abcdef
@@ 4
 4| export function main() {
-5|   run()
+5|   run({ strict: true })
 6| }
```

| 表面 | 含义 |
|---|---|
| `<path>:<hash>` | 必需的首行；对 LF 规范化、无 BOM 的内容取 `hashlineFileHash` |
| `@@ <line>` | 当前文件第 `<line>` 行（1 起）处的 Update hunk 起点 |
| ` <n>\| text` | 上下文行：文件第 `<n>` 行必须等于 `text` |
| `-<n>\| text` | 第 `<n>` 行被删除 |
| `+text` | 插入一行；显示前缀（`12\| `、`12: `）由 `hashlineStripPrefixes` 剥除 |

没有收尾标记：补丁在其字符串结尾处自然结束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`parseHashlinePatch` 规范化 CRLF 与开头的 BOM，校验头部和每一行正文，并拒绝不含 `-`/`+` 行的 hunk。`applyHashlinePatch` 是纯函数：检查头部 hash，定位每个 hunk（唯一的字面块匹配；块多次出现时以编号证据消歧，数字挑不出唯一目标时报 `FS_AMBIGUOUS_EDIT`），拒绝相互重叠的 hunk，然后才把各 hunk 拼接成一个新字符串。在“所有 hunk 有效”与“新内容产出”之间不发生任何文件系统调用。

`runHashlineEdit` 是唯一有状态的入口。顺序：解析（参数错误在任何文件系统访问之前失败）→ CAS 基准 → 读取 → hash + 施加 → 有防护的写入 → 读回 → `verifyPatchedBytes`。读回比较的是 `Buffer`，因此一次被截断、交错或悄然丢失的写入不可能被报告为成功。

消费工具的字面字符串替换路径原样不变，含其安全层：编辑前必须先读的要求出自不变的 `fs/edit-intent` 瀑布，过期性由头部 hash 加 `replaceIfVersion` 防护承担，`FS_AMBIGUOUS_EDIT` 的消息保持模型们已经熟悉的形状。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Filesystem 子系统](../../../docs/subsystems/filesystem.zh.md)——provider 路径、`FsError` 错误码与有防护的变更契约。
- [字符串替换编辑器](../tool-str-replace-editor/README.zh.md)——路由在本内核之后的回落编辑器。

<a id="model-experience"></a>
## 模型体验

间接经由 `dsh-tool-fs` 的 `edit` 与 `dsh-tool-str-replace-editor` 的 `str_replace_editor` 体验——它们的参数携带 hashline 补丁形态。

#### KV Cache 影响

无直接失效；消费编辑器各自拥有其请求前缀的任何变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 消费编辑器的面向模型提示词与 README 措辞仍只描述字面路径；为 hashline 形态做广告属于拥有那些文件的文档切片。
- 路由以形态而非意图为键：一个看起来像补丁（`<path>:<hash>` 头部加上 `@@ <line>` 起始行）但本意是字面文本的 `old_string` 会被路由进 hashline 分支并在那里失败——只有当输入不具备 hashline 形态时，才会咨询字面字符串替换回落。
- 一个只插入的 hunk，当其 `+` 行不含文本时，会锚定在声明行、不插入任何内容并报告成功：空补丁被当作空操作接受，而不是被拒绝。
- 一个已路由进 hashline 分支但以两个换行符结尾的补丁会被解析器拒绝（容忍一个尾随换行符；多出的空行不携带标记），而不是回落到字面替换。
- `hashlineStripPrefixes` 无法区分显示前缀与真正以 `12| ` 开头的字面文本，因此插入这样一行需要使用无前缀形式。
- 目前只实现了 Update hunk；OMP 的 `PUT`/`CUT`/`PASTE` 操作文法不在本波范围内。

### 开发备注

格式原语从 OMP 二进制导出的表面（`hashlineCountOps`、`hashlineFileHash`、`hashlineFormatHeader`、`hashlineFormatNumberedLines`、`hashlineStripPrefixes`）重新推导；原生实现是不透明的，因此头部与编号行的确切空格是本包自有的契约，由 `tests/core` 钉住。