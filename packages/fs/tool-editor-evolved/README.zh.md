---
description: "Hashline 补丁核心：以 hash 锚定的 Update hunk、比较并交换（CAS）写入，以及面向编辑工具的写后字节校验。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-editor-evolved

[English](README.md) | 中文

## 概述

以单个全有或全无的补丁一次应用对一个文件的精确行编辑：首行 `<path>:<hash>` 指名文件，随后的 `@@ <line>` hunk 携带带行号的行证据（` <n>| text`、`-<n>| text`）以及不带行号的插入（`+text`）。两阶段应用在任何新内容产生之前先对照当前文件定位并校验每个 hunk，因此一次拒绝绝不会留下打了一半的补丁字符串。遇到不再匹配的 header hash 就拒绝执行；与并发编辑竞争时宁可输掉也不覆盖它，并返回 `FS_STALE_VERSION`（"Re-read the file and try again"）。写入后把文件读回，只有字节一致才报告成功。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

消费方是面向模型的编辑器：`@deepseek-ai/dsh-tool-fs`（`edit`）与 `@deepseek-ai/dsh-tool-str-replace-editor`（`str_replace_editor`）。两者都先把 hashline 形态的 `old_string`/`old_str` 路由到本核心；输入不是 hashline 补丁时，回退到各自的字面量字符串替换路径。

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

补丁语法：

```text
src/app.ts:0123456789abcdef
@@ 4
 4| export function main() {
-5|   run()
+5|   run({ strict: true })
 6| }
```

| 语法项 | 含义 |
|---|---|
| `<path>:<hash>` | 必填首行；对经 LF 规范化、无 BOM 的内容计算 `hashlineFileHash` |
| `@@ <line>` | 当前文件中从 1 开始计数的第 `<line>` 行处开始一个 Update hunk |
| ` <n>\| text` | 上下文行：文件第 `<n>` 行必须等于 `text` |
| `-<n>\| text` | 删除第 `<n>` 行 |
| `+text` | 插入的行；显示前缀（`12\| `、`12: `）由 `hashlineStripPrefixes` 剥除 |

没有结束标记：补丁在字符串末尾结束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`parseHashlinePatch` 规范化 CRLF 与开头的 BOM，校验 header 与每一行正文，并拒绝不含 `-`/`+` 行的 hunk。`applyHashlinePatch` 是纯函数：它检查 header hash，定位每个 hunk（唯一的字面量块匹配；同一块出现多次时用带行号的证据消歧，数字选不出唯一者时报 `FS_AMBIGUOUS_EDIT`），拒绝相互重叠的 hunk，然后才把所有 hunk 拼接成一个新字符串。从「所有 hunk 都有效」到「产出新内容」之间没有任何文件系统调用。

`runHashlineEdit` 是唯一有状态的入口。顺序：解析（参数错误在任何文件系统访问之前就失败）→ CAS 基准 → 读取 → 哈希 + 应用 → 防护写入 → 回读 → `verifyPatchedBytes`。回读比较 `Buffer`，因此被截断、被交错或被悄悄丢弃的写入不可能被报告为成功。

消费编辑器的字面量字符串替换路径保持不变，其安全分层也不变：编辑前先读取的要求来自保持不变的 `fs/edit-intent` waterfall（瀑布式事件），陈旧性来自 header hash 加 `replaceIfVersion` 守卫，`FS_AMBIGUOUS_EDIT` 消息保持模型已经熟悉的形态。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——提供方路径、`FsError` 错误码与防护变更约定。
- [字符串替换编辑器](../tool-str-replace-editor/README.zh.md)——本核心被路由到其前方的回退编辑器。

<a id="model-experience"></a>
## 模型体验

间接地通过 `dsh-tool-fs` 的 `edit` 与 `dsh-tool-str-replace-editor` 的 `str_replace_editor`，其参数承载 hashline 补丁形式。

#### KV Cache 影响

无直接失效；请求前缀的任何变更由消费编辑器负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 消费编辑器的面向模型提示词与 README 措辞仍只描述字面量路径；宣传 hashline 形式属于拥有这些文件的文档切片。
- 路由看形态而非意图：形似补丁（`<path>:<hash>` 头加 `@@ <line>` 开启行）却被当作字面文本的 `old_string` 会被送入 hashline 分支并在那里失败——只有输入不是 hashline 形态时才会咨询字面量字符串替换回退。
- 仅含插入的 hunk 若其唯一的 `+` 行不带文本，会在声明的行处锚定、不插入任何内容并报告成功：空补丁被当作无操作成功接受，而不是被拒绝。
- 已路由到 hashline 分支却以两个换行结尾的补丁会被解析器拒绝（容忍一个结尾换行，多出的空行不携带标记），而不是回落到字面量替换。
- `hashlineStripPrefixes` 无法区分显示前缀与确实以 `12| ` 开头的字面文本，因此插入这样的行需要不带前缀的形式。
- 仅实现了 Update hunk；OMP 的 `PUT`/`CUT`/`PASTE` 操作语法不在本波次范围内。

### 开发备注

格式原语从 OMP 二进制导出的 surface（`hashlineCountOps`、`hashlineFileHash`、`hashlineFormatHeader`、`hashlineFormatNumberedLines`、`hashlineStripPrefixes`）重新推导；原生实现是不透明的，因此 header 与带行号行的确切间距是本包自己的约定，由 `tests/core` 钉住。
