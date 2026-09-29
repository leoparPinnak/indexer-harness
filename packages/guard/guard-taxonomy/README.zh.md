---
description: "分类化的工具调用门控：66 类 HARD/SOFT/ALLOW 策略分类体系接入 tools/pre-execute，包含失败即闭合的硬拒绝守卫、经审批链路由的软拒绝询问，以及强制允许例外。"
kind: "package-reference"
---

# @deepseek-ai/dsh-guard-taxonomy

[English](README.md) | 中文

## 概述

本包在派发前按已配置的策略类别门控每一次工具调用。硬拒绝类别经单调守卫失败即闭合，软拒绝类别经审批接缝发起询问，强制允许例外直接放行，未分类的调用保持既有的 allow/deny/ask 三态默认。基础组合包已挂载该插件但不带任何规则，因此只有 profile 补丁指定了类别后行为才会改变。类别 id 与分类来自从 Claude Code 2.1.223（`claude.exe @258901928`）打捞的 66 类分类体系。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

常见用法是组合中的一行：`dsh` 基础组合包已挂载该插件（无规则），由 profile 补丁添加把部署方的工具与 shell 命令映射到分类类别的规则。

### When to choose it

当部署方希望用一套共享、可审阅的词汇表——打捞得到的 HARD/SOFT/ALLOW 分类体系——来描述工具调用被允许做什么，并且要求硬拒绝不受任何监听器排序影响、软拒绝走既有审批策略、强制例外在限制性 `'never'` 姿态下仍放行时，选择本包。当分类需要的是判断力而非配置时不要选它：这里的规则是确定性的（工具名与命令模式），不是模型分类器；没有规则的组合与本包出现之前的行为完全一致。

### Setting it up

挂载插件，并为每条规则给出类别和至少一个匹配器：

```yaml
- id: guard-taxonomy
  name: '@deepseek-ai/dsh-guard-taxonomy'
  config:
    rules:
      - category: git_destructive
        command: '^git\s+(push|reset|clean|rebase)'
      - category: git_push_destination
        command: '^git push'
      - category: data_exfiltration
        tools: ['web_fetch']
```

若一条规则的 `tools`（精确工具名）与 `command`（针对调用的字符串 `command` 参数的正则，即 `bash`/`pwsh` shell 工具携带的形态）都为空或缺省，加载即失败；非法模式或超出分类体系的类别同样如此。一次调用可能命中多条规则；裁决先看 HARD（例外不能解除硬拒绝），再看强制 ALLOW 解除软拒绝，最后才是 SOFT。

### What you get

硬拒绝命中时，在工具体执行前返回 `Error: hard-deny category "<id>" blocks this call unconditionally (no ALLOW exception applies); have the user run this step directly`，且 `tools/pre-execute` 之后的单调 `tools.guard()` 阶段会重复同一拒绝理由，后续监听器无法把调用改回允许。软拒绝命中会转为 `ask` 决策，由审批服务按会话的 `ApprovalPolicy` 解析（`'never'` 无需询问即自动拒绝；没有审批接缝时调用失败即闭合）。允许命中放行调用并清除内层的询问，但绝不会抬起其他策略平面的拒绝。没有任何规则命中的调用原样返回内层 waterfall 决策。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

本节说明一次调用如何被分类与执行，并指出实现它的代码位置；可观察行为已全部由 [Use this package](#use-this-package) 覆盖。

### Design philosophy

该门控建立在四项承诺之上：

- **分类体系是带类型的配置，不是散落的常量。** `src/taxonomy.ts` 以 `as const` 元组保存打捞的 id——1 个 `hard` + 65 个 `soft` 拒绝类别、17 个允许例外——以及一张冻结的 `GUARD_TAXONOMY` 分类表，导入之后无法被改写。
- **waterfall 保持可扩展；守卫保持终局性。** 前置的 `tools/pre-execute` 监听器在其他策略监听器全部跑完后再决策（副作用监听器仍观察每次调用），而硬拒绝轨道通过 `ctx.tools.guard()` 注册——它在整个 waterfall 之后运行且只能拒绝，符合注册表文档化的单调性。
- **确定性匹配在加载时一次编译。** 规则在加载时编译为静态名称表加一个预构建的 `RegExp`；每次调用都不重新编译，配置错误（永远匹配不到的规则、非法模式）在插件加载时抛出，而不是静默丢掉某个类别。
- **在要紧处失败即闭合。** 没有审批接缝时软询问转为拒绝；应答者缺席时失败即闭合；未命中的调用保持既有默认，而不是新的猜测。

### How a call is gated

`apply()` 每次调用对已编译规则走一遍（`verdictOf`），按 hard → allow → soft 的优先级折叠命中结果，完全没有命中时返回 `undefined`。前置监听器据此映射裁决：`hard` → 以共享理由拒绝，`soft` → 内层决策未拒绝时转为询问，`allow` → 内层决策未拒绝时放行；`undefined` → 内层决策原样返回。其后的守卫重新计算裁决并返回完全相同的硬拒绝理由，因此被覆盖的监听器拒绝与守卫拒绝携带逐字节一致的文本。

### Composing with other wrappers

监听器顺序决定可扩展层：本插件的监听器是前置的，包裹在其之前或之后注册的普通监听器；在此之后再前置的监听器会位于本插件之外。任何排序都不影响守卫阶段——硬拒绝在那里一律被拒。

### Source map

| File | Role |
|---|---|
| [`src/taxonomy.ts`](src/taxonomy.ts) | 打捞的分类数据：id 元组、`GUARD_TAXONOMY`、`GuardVerdict` |
| [`src/index.ts`](src/index.ts) | 插件入口：`name`/`inject`/`Config`/`apply`、规则编译、前置 waterfall 监听器与单调守卫 |
| — | 不发布运行时不变式伴生入口；分类体系是冻结数据，插件除已编译配置外不持有可变状态。 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

当包级契约不够用时阅读以下页面。

- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——`tools/pre-execute` waterfall、守卫阶段与本门控接入的决策形态。
- [guard group map](../README.zh.md)——同族守卫包与循环卫生家族。
- 生成的配置目录条目（`dsh-guard-taxonomy`）——规则列表的全部可接受字段。

-----

<a id="model-experience"></a>
## Model Experience

### Conditional tool result

#### What the model sees

本包不新增提示词或 schema，只新增拒绝与询问：被硬/软阻断的调用表现为点名类别的错误结果，如 `Error: hard-deny category "data_exfiltration" blocks this call unconditionally …`，被放行的调用与未被触碰的调用无法区分。

#### Token effect

对放行与未分类调用为零 token。被阻断的调用用一条很小的保留错误结果替代完整工具结果；询问复用审批流既有审计，不产生新的提示词文本。

#### KV Cache effect

仅追加；本包不注册 system-prompt 上下文，因此既不增加也不使可复用请求前缀失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了分类体系何时不合适。它们是当前的包约束，不是任务积压。

- **是配置而非分类** ——本包不决定某次调用属于哪个类别，由部署方的规则决定；随附的基础行不带规则，因此开箱状态下每次调用都保持未分类。
- **例外只解除本分类体系自己的询问路径** ——其他策略平面的拒绝（hook、permission preset、部署方守卫）仍是允许例外不会抬起的地板。
- **命令匹配按参数进行** ——`command` 模式看到的是 shell 工具的 `command` 字符串，而不是重新推导的管道图；需要来源感知判断的部署方必须在自己的模式中编码这些判断。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本 Dev Note 是维护者的工作上下文：未决的问题与方向。它明确不具备权威性——已交付行为、限制与已接受的 rationale 见上文各节、包代码与链接的笔记。

来源：类别 id 与分类打捞自 Claude Code 2.1.223 的 Bun 编译二进制，字节偏移 `@258901928`，标记 `<user_hard_deny_rules_to_replace>`（66 个拒绝类别：1 HARD + 65 SOFT）。ALLOW 槽位含 17 条顶层例外；D9 简报中的「16」少算了一条，因为首个条目紧跟开始标签、前面没有换行。分类体系只移植名称与分类——绝不移植源字节——规则文档的散文不进入产品。

</details>
