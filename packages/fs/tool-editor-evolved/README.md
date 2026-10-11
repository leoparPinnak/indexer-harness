---
description: "Hashline patch core: hash-anchored Update hunks, compare-and-swap writes, and post-write byte verification for the edit tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-editor-evolved

English | [中文](README.zh.md)

## Summary

Apply one file's exact line edits in a single all-or-nothing patch: a header `<path>:<hash>` names the file, then `@@ <line>` hunks carry numbered-line evidence (` <n>| text`, `-<n>| text`) plus unnumbered inserts (`+text`). Two-phase application locates and validates every hunk against the current file before any new content exists, so a rejection never leaves a half-patched string. Reject a header hash that no longer matches and lose, rather than overwrite, a concurrent edit with `FS_STALE_VERSION` ("Re-read the file and try again"). Read the file back after the write and report success only when the bytes match.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Consumers are the model-facing editors: `@deepseek-ai/dsh-tool-fs` (`edit`) and `@deepseek-ai/dsh-tool-str-replace-editor` (`str_replace_editor`). Both route a hashline-shaped `old_string`/`old_str` through this core first and fall back to their literal string-replace path when the input is not a hashline patch.

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

Patch grammar:

```text
src/app.ts:0123456789abcdef
@@ 4
 4| export function main() {
-5|   run()
+5|   run({ strict: true })
 6| }
```

| Surface | Meaning |
|---|---|
| `<path>:<hash>` | Required first line; `hashlineFileHash` over LF-normalized, BOM-free content |
| `@@ <line>` | Start of an Update hunk at 1-indexed line `<line>` of the current file |
| ` <n>\| text` | Context line: file line `<n>` must equal `text` |
| `-<n>\| text` | Line `<n>` is removed |
| `+text` | Line inserted; display prefixes (`12\| `, `12: `) are stripped by `hashlineStripPrefixes` |

There is no closing marker: a patch ends at the end of its string.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`parseHashlinePatch` normalizes CRLF and a leading BOM, validates the header, every body line, and rejects a hunk that carries no `-`/`+` line. `applyHashlinePatch` is pure: it checks the header hash, locates each hunk (unique literal block match, disambiguated by the numbered evidence when the block occurs more than once, `FS_AMBIGUOUS_EDIT` when the numbers cannot pick one), rejects overlapping hunks, and only then splices the hunks into one new string. No filesystem call happens between "all hunks valid" and "new content produced".

`runHashlineEdit` is the only stateful entry point. Order: parse (argument errors fail before any filesystem access) → CAS basis → read → hash + apply → guarded write → read back → `verifyPatchedBytes`. The read-back compares `Buffer`s, so a truncated, interleaved, or silently dropped write cannot be reported as success.

The literal string-replace path of the consuming tools is unchanged, including its safety layers: the read-before-edit requirement comes from the unchanged `fs/edit-intent` waterfall, staleness from the header hash plus the `replaceIfVersion` guard, and the `FS_AMBIGUOUS_EDIT` message keeps the shape the models already know.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — provider paths, `FsError` codes, and the guarded mutation contract.
- [String-replace editor](../tool-str-replace-editor/README.md) — the fallback editor this core is routed in front of.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-fs`'s `edit` and `dsh-tool-str-replace-editor`'s `str_replace_editor`, whose parameters carry the hashline patch form.

#### KV Cache effect

No direct invalidation; the consuming editors own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Model-facing prompt and README wording for the consuming editors still describe only the literal path; advertising the hashline form belongs to the documentation slices that own those files.
- `hashlineStripPrefixes` cannot distinguish a display prefix from literal text that genuinely starts with `12| `, so inserting such a line requires the prefix-free form.
- Only Update hunks are implemented; the OMP `PUT`/`CUT`/`PASTE` operation grammar is out of scope for this wave.

### Dev Note

Format primitives are re-derived from the OMP binary's exported surface (`hashlineCountOps`, `hashlineFileHash`, `hashlineFormatHeader`, `hashlineFormatNumberedLines`, `hashlineStripPrefixes`); the native implementations are opaque, so the exact spacing of the header and numbered lines is this package's own contract, pinned by `tests/core`.
