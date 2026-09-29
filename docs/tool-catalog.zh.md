<!-- 英文源文件由 scripts/gen-tool-catalog.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-tool-catalog` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/tool-catalog.md` 重新记录配对。 -->

# 工具 Schema 目录

[English](tool-catalog.md) | 中文

已发布插件向 `ctx.tools` 提供的所有面向模型的工具：模型通过系统提示词组装获得的 `name`、`description` 和 JSON Schema `parameters`。本目录是[子系统页面](subsystems/core.zh.md)（类型及每页生成的 `cordis-surface` 接线区域）的补充；本页列出的是向 agent（智能体）提供的*工具*。

英文源文件由系统**生成**，并通过 `pnpm run verify-tool-catalog`（`doc-sync`（文档同步门禁）的一部分）验证新鲜度；本中文文件作为经评审对侧通过双语配对维护。与 Cordis 目录（纯源码 AST 处理）不同，英文生成器会在真实上下文中**启动**每个工具插件并读取 `ctx.tools.schemas()`，因为工具 schema 无法通过静态分析完全确定，例如运行时展开的枚举、拼接的描述、由配置决定的名称以及使用原始 JSON Schema 的 MCP 工具。完整性守卫会 glob 匹配 `packages/*/tool-*`；如果生成器的启动 manifest（元数据清单）遗漏任何包，检查就会失败，因此新工具不会在无人察觉的情况下缺少文档。

范围：`packages/*/tool-*` 下已发布的产品工具，每个工具均使用其**默认**配置启动；但如果某个 Config 字段是**必填项**且没有默认值，生成器就必须作出选择，对应包的说明会记录本页展示的是哪个分支。注册的工具**名称**可以是加载时配置，例如 `tool-subagent` 的 `toolName`，因此部署可能以不同名称或额外名称提供某个包；如果存在随产品发布的别名，对应包的说明会予以记录。`examples/` 中的演示工具（例如 `echo`）不在范围内，这与 Cordis 目录仅涵盖包的范围一致。

<a id="tool-package-map"></a>

## 工具包映射

下表将模型可见的工具名称与其背后的插件包和服务 seam 对应起来。各包章节随后给出确切的 JSON Schema。

| 工具包 | 模型可见名称 | 依赖 | 写入／影响 | 随产品发布的别名 | 部署说明 |
| --- | --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh-tool-ask-user` | `ask_user_question` | `ctx.tools`、`ctx.userQuestions` | `tool/call`、`tool/result after a UI/provider answers the question` | - | ask_user_question 会暂停工具调用，直到当前 UI 提供方返回人类答案。 |
| `@deepseek-ai/dsh-tools` | `run_code` | `ctx.tools`、`ctx.codeRuntime (execution time)`、`ctx.systemPrompt` | `tool/call`、`one tool/ptc-dispatch-start + tool/ptc-dispatch pair per bridged sub-call`、`tool/result` | - | 在 `mode: ptc`／`mode: both` 下，它由工具注册表所有，作为可过滤能力层之外的保留传输机制（参见 PTC mode Agent Note）。在 `ptc` 下，它是注册表对协议格式（wire format）的唯一贡献；其他可见能力在使用已加载运行时语言生成的 SDK 章节中声明。程序通过 binding 调用这些能力，调用按照原生并发约定调度：启动顺序和策略遵循提交顺序，并发安全的函数体最多重叠执行 `maxParallelSubCalls` 个。调用会重新进入完整且受守卫保护的工具流水线，并将每个嵌套执行关联到此外层结果。 |
| `@deepseek-ai/dsh-plan-mode` | `enter_plan_mode`、`exit_plan_mode` | `ctx.tools`、`ctx.systemPrompt`、`ctx.userQuestions (execution time, opportunistic)` | `tool/call`、`plan/mode inactive on an approved review`、`tool/result` | - | 规划未激活时，exit_plan_mode 仍保留在面向模型的 schema 中，这样状态转换不会在规划策略变更之外额外造成工具目录变动。其执行路径会拒绝规划模式之外的调用；在规划模式下，它通过用户交互 seam 提交计划（批准／根据反馈继续规划），批准后会在步骤边界记录规划模式已停用。 |
| `@deepseek-ai/dsh-tool-bash` | `bash` | `ctx.tools`、`ctx.shell`、`ctx.systemPrompt`、`ctx.shellEnv`、`ctx.jobs at call time for run_in_background` | `tool/call`、`tool/result` | - | bash 工具是 bash 执行器 seam 面向模型的消费方。使用 `run_in_background` 的运行会注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具（来自 `@deepseek-ai/dsh-tool-jobs`）收集／停止；禁用 `enableRunInBackground` 配置（默认为 true）后，该参数会被完全移除。 |
| `@deepseek-ai/dsh-tool-present` | `present` | `ctx.tools`, `ctx.fs`, `ctx.sessionProjections` | `tool/call`, `deliverables/presented 在成功的最终结果之后`, `tool/result` | - | 交付归调用方 Session 所有；Web ui-deliverables 提供源文件打开与卡片。 |
| `@deepseek-ai/dsh-tool-pwsh` | `pwsh` | `ctx.tools`、`ctx.shell`、`ctx.systemPrompt`、`ctx.shellEnv`、`ctx.jobs at call time for run_in_background` | `tool/call`、`tool/result` | - | pwsh 工具是 Windows 组合中 bash 执行器 seam 的 PowerShell 方言消费方（由 `@deepseek-ai/dsh-pwsh-local` 等 PowerShell 执行器为 `ctx.shell` 提供后端）；除沙箱接口外，它逐项对应 bash 工具调用。使用 `run_in_background` 的运行会注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具收集／停止；托管的 `DSH_*` 环境来自 `@deepseek-ai/dsh-shell-env`。每次调用都在新进程中运行，不使用持久 PTY 会话。路径采用原生 `C:\...` 形式，变量采用 `$env:NAME`。 |
| `@deepseek-ai/dsh-tool-cordis` | `cordis_define`、`cordis_inspect_list`、`cordis_inspect_query`、`cordis_inspect_self`、`cordis_run`、`cordis_stop`、`cordis_undefine` | `ctx.tools`、`ctx.dynamicCordisRunner` | `tool/call`、`tool/result`、`process-local dynamic package lifecycle` | - | 不在任何随产品发布的树中，需要显式选择启用；动态 Package 代码可以访问真实运行时，见 .agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md。该工具集注入 `@deepseek-ai/dsh-cordis-host-runner` 提供的 `ctx.dynamicCordisRunner`，后者拥有定义注册表和 vm 沙箱；组合缺少它时这些工具不会激活。运行中的 Package 在停止、undefine 或 DSH 重启前可以注册**额外的**模型可见工具；发生这类工具集变化时，系统会记录完整且有变动的请求头。 |
| `@deepseek-ai/dsh-tool-bash-persistent` | `bash` | `ctx.tools`、`ctx.terminals`、`an owning Agent at execution time` | `tool/call`、`PTY shell state`、`tool/result` | - | 一个按所有者隔离的持久 bash 工具；部署组合提供 PTY 后端，并可覆盖面向模型的环境描述。 |
| `@deepseek-ai/dsh-tool-pwsh-persistent` | `pwsh` | `ctx.tools`、`ctx.terminals`、`an owning Agent at execution time` | `tool/call`、`PTY shell state`、`tool/result` | - | 一个按所有者隔离的持久 pwsh 工具，持久 bash 工具的 Windows 对应物；部署组合提供 pwsh 方言的 PTY 后端，并可覆盖面向模型的环境描述。 |
| `@deepseek-ai/dsh-tool-str-replace-editor` | `str_replace_editor` | `ctx.tools`、`ctx.fs` | `tool/call`、`fs/observed after view presence/absence, edit absence, or successful mutation`、`tool/result` | - | 基于文件系统 seam 的独立查看／创建／唯一字面量替换／按行插入工具；可与任何 shell 或终端接口组合。 |
| `@deepseek-ai/dsh-tool-fs` | `edit`、`read`、`read_image`、`write` | `ctx.tools`、`ctx.fs`、`ctx.systemPrompt`、`ctx.attachments (image-tool registration)`、`ctx.llm + an image-capable route (image-tool execution)` | `tool/call`、`fs/write-intent or fs/edit-intent for mutations`、`fs/observed after read presence/absence or successful file operation`、`durable attachment (read_image)`、`tool/result` | - | 先读后写／编辑策略由 `@deepseek-ai/dsh-fs-observation-policy` 添加；它是一个 `fs/*` 事件门禁插件，不会改变 schema。加载这些工具的部署按预期也应加载该插件。没有 `ctx.attachments` 时图片工具不会注册；其 schema 与路由无关，执行时除非确切路由的模型声明图片输入，否则拒绝。 |
| `@deepseek-ai/dsh-tool-fs-search` | `glob`、`grep` | `ctx.tools`、`ctx.subprocess`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | glob 和 grep 是无条件可用的发现工具，通过 ctx.subprocess spawn 随包提供的 ripgrep 二进制文件（`@vscode/ripgrep`），并作为普通前台调用运行，绝不作为后台任务；无需在宿主机安装 `rg`，也不经过 shell 层。本目录使用 `sampleOverCapGlobResults: true`；部署必须显式选择该行为。结果超过上限时，会通过可选的 ctx.spillStore 后端保存完整的格式化列表；在共置部署中，如果后端公开本地路径，返回的定位信息可供后续读取／搜索。 |
| `@deepseek-ai/dsh-tool-terminal` | `terminal_close`、`terminal_list`、`terminal_open`、`terminal_read`、`terminal_send`、`terminal_signal` | `ctx.tools`、`ctx.terminals`、`ctx.systemPrompt`、`ctx.jobs at call time for run_in_background` | `tool/call`、`tool/result` | - | 这 6 个终端工具需要选择启用，用于补充一次性 bash／文件系统工具。`terminal_send(run_in_background: true)` 会注册到 `ctx.jobs`；schema 不包含 TUI、具名按键序列、BEL、调整尺寸、自动启动和跨 agent 共享。 |
| `@deepseek-ai/dsh-tool-goal` | `create_goal`、`get_goal`、`update_goal` | `ctx.tools`、`ctx.agents`、`ctx.goals`、`ctx.systemPrompt`、`a calling Agent in an authorized open turn` | `tool/call`、`goal/change for mutations`、`tool/result` | - | create、edit、pause 和 resume 要求直接来自人类的根权限；complete 和 blocked 也接受确切的当前 Goal Round。blocked 的默认下限是 3 个获准的 Round。 |
| `@deepseek-ai/dsh-schedule` | `schedule_create`、`schedule_delete`、`schedule_list` | `ctx.tools`、`ctx.sessions`、Session 持久化、未来创建的 live 根 Agent | `tool/call`、`schedule/change create or delete`、`tool/result` | - | 仅在选择启用的 Schedule 插件加载后创建的 live 根 Agent scope 内注册。版本 1 接受 after_seconds、显式绝对 at 和有界固定速率 every_seconds，并披露 session-local 交付；管理读取与变更必须通过共享的 Session 持久化 barrier。 |
| `@deepseek-ai/dsh-tool-lsp` | `lsp` | `ctx.tools`、`ctx.lsp`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | lsp 工具将提供方选择和语言服务器子进程置于 ctx.lsp 之后，因此其模型可见 schema 在更换提供方时保持稳定。运行时要求已注册提供方，例如 `@deepseek-ai/dsh-lsp-stdio`；如果没有提供方，查询会返回结构化 `LSP_UNAVAILABLE` 错误，而不会改变 schema。 |
| `@deepseek-ai/dsh-tool-ralph` | `ralph` | `ctx.tools`、`ctx.workflowEngine`、`ctx.subagents`、`ctx.systemPrompt`、`a calling Agent (exec.agent parents every fresh round)` | `tool/call`、`tool/result`、`workflow and child session events during execution` | - | 固定的前台工作流会在每个 Round 启动一个全新的结构化子级；模型只能选择不可变目标和可选的 Round 上限。 |
| `@deepseek-ai/dsh-tool-skill` | `skill` | `ctx.tools`、`ctx.agents`、`ctx.skills` | `tool/call`、`tool/result`、`user/message replacement catalogs via agent.inject()` | - | - |
| `@deepseek-ai/dsh-tool-session-query` | `session_event_read`、`session_event_search`、`session_event_trace`、`session_search`、`session_trace` | `ctx.tools`、`ctx.systemPrompt`、`ctx.sessionQuery`、`a calling Agent for workspace authority` | `tool/call`、`tool/result` | - | 这 5 个只读工具会隐藏提供方游标，并根据不可变的调用 agent 会话为每个结果授权。该包需要选择启用；需要强制截止时间或限制行内输出的组合还会挂载通用超时或 spill 策略。 |
| `@deepseek-ai/dsh-tool-subagent` | `list_subagent_models`、`subagent` | `ctx.tools`、`ctx.subagents`、`ctx.systemPrompt`、`用于模型发现和所选路由校验的 ctx.llm` | `tool/call`、`tool/result`、`child session events through the chosen provider` | `subagent`、`subagent_fork` | 注册的委派工具名称取决于加载时 `toolName` 配置（默认为 `subagent`）；上述默认 schema 关闭模型选择，而发现 schema 则展示为已启用 Session 中可用的固定配套工具。Web preset 会在每个新顶层 Session 创建时读取插件页偏好，并为其子 Session 保留该决定；`subagent_fork` 始终使用固定路由。每个实例通过 `modelSelectionSettings`、`backgroundMode` 与 `enableRunInBackground` 独立控制是否读取模型选择设置及其后台行为。 |
| `@deepseek-ai/dsh-tool-subagent-control` | `interrupt_agent`、`list_agents`、`send_message` | `ctx.tools`、`ctx.subagents`、`ctx.agents and ctx.sessionProjections (list_agents only)` | `tool/call`、`tool/result`、`child session events through ctx.subagents` | - | 这些是控制可继续后台 subagent 的全局命名工具：绑定提供方的 `tool-subagent` 实例注册不同的委派工具；本包注册一次 `send_message` 和 `interrupt_agent`，另由 `list_agents` 通过单独加载的 `/list-agents` 插件提供，其目录行使用 sessionProjections 和实时 Agent 注册表。 |
| `@deepseek-ai/dsh-tool-jobs` | `job_kill`、`job_list`、`job_output` | `ctx.tools`、`ctx.jobs`、`ctx.systemPrompt` | `tool/call`、`tool/result`、`user/message via agent.inject() for background completion notices` | - | 与任务种类无关的后台任务控制器：后台 bash 命令、PTY 发送和 subagent 都通过相同的 3 个工具读取、列出和终止。加载该插件会挂接控制器，从而启用生产方的 `ctx.jobs.start()`。 |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | `interrupt_agent`、`list_agents`、`send_message`、`spawn_teammate`、`team_task_create`、`team_task_get`、`team_task_list`、`team_task_update`、`wait_agent` | `ctx.tools`、`ctx.systemPrompt`、`ctx.agentTeams`、`an exact live Team member Agent` | `tool/call`、`team/member`、`team/message/queued`、`team/message/delivered`、`team/task`、`tool/result` | - | 这 9 个工具限定于隐式 Team Lead 与持久 teammate 作用域。随产品发布的 dsh-base bundle 默认禁用该包；文档中的 Agent Teams profile patch 会启用它，并禁用旧 continuable child 的同名控制工具。 |
| `@deepseek-ai/dsh-tool-todo` | `todo_write` | `ctx.tools`、`owning Agent session` | `tool/call`、`todo/write`、`tool/result` | - | todo_write 是会话所有的状态；UI 将最新的 todo/write 事件渲染为检查清单。`allowParallelInProgress` 是没有默认值的必填项，因此本目录明确选择 `true`，对应描述允许同时存在多个 `in_progress` 项。选择 `false` 的部署会获得同一工具，但描述会要求只能有 1 个活动任务。 |
| `@deepseek-ai/dsh-tool-workflow` | `workflow` | `ctx.tools`、`ctx.workflowEngine`、`ctx.systemPrompt`、`a calling Agent (exec.agent parents the script children)` | `tool/call`、`tool/result` | - | - |
| `@deepseek-ai/dsh-tool-web` | `web_fetch`、`web_search` | `ctx.tools`、`ctx.web`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | web_search 和 web_fetch 将提供方选择置于 ctx.web 之后，使模型可见 schema 在更换后端时保持稳定。 |
| `@deepseek-ai/dsh-cdp` | `cdp_captcha`、`cdp_click`、`cdp_contexts`、`cdp_dialog`、`cdp_download`、`cdp_endpoints`、`cdp_eval`、`cdp_exec`、`cdp_expect`、`cdp_extract`、`cdp_files`、`cdp_fill`、`cdp_find`、`cdp_fingerprint`、`cdp_locate`、`cdp_lock`、`cdp_navigate`、`cdp_open`、`cdp_pdftotext`、`cdp_printpdf`、`cdp_profiles`、`cdp_readpdf`、`cdp_screenshot`、`cdp_scroll`、`cdp_snapshot`、`cdp_status`、`cdp_stealth`、`cdp_tab_close`、`cdp_tab_focus`、`cdp_tab_new`、`cdp_tabs`、`cdp_text`、`cdp_type`、`cdp_unlock`、`cdp_upload`、`cdp_viewport`、`cdp_wait`、`net_capture`、`net_export` | `ctx.tools`、`ctx.webServer (route registration seam)`、`ctx.systemPrompt (prompt section, opportunistic)`、`ctx.skills (skill provider, opportunistic)` | `tool/call`、`tool/result` | - | CDP bundle 在 `bundle/cdp` 叶子（位于 `tool-*` 完整性 glob 之外）下随包提供 36 个面向模型的工具（34 个 `cdp_*` 加 `net_capture`/`net_export`），并且只挂载在 webServer surface 上；skills 与 systemPrompt 注册是机会性注入，因此裸上下文启动仍能采集到全部 schema。`cdp_status` 反映已安装版本／target／代理与当前浏览器 profile；`cdp_open` 会先发现既有 endpoint，并在附加或启动前询问使用哪个 profile。`cdp_exec` 比 `cdp_eval` 更倾向于给出有保证的错误 envelope；`cdp_captcha` 检测、驱动并验证第一方挑战，绝不经手任何第三方提供方；stealth 工具加固客户端（检测姿态），并不绕过第三方 CAPTCHA 提供方。 |

<a id="deepseek-aidsh-tool-ask-user"></a>

## `@deepseek-ai/dsh-tool-ask-user`

### `ask_user_question`

继续操作前，如果需要确认、选择或缺失的信息，请向用户提出简明问题。发送一个或多个问题，每个问题都带一个稳定 id，该 id 会在答案中原样返回。

```json
{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "description": "Questions to ask the user before continuing.",
      "items": {
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "id": {
            "type": "string",
            "description": "Stable id for this question; echoed in the answer."
          },
          "question": {
            "type": "string",
            "description": "The specific question to ask the user."
          },
          "header": {
            "type": "string",
            "description": "Optional short heading for the question, such as \"Confirm\" or \"Choose Mode\"."
          },
          "options": {
            "type": "array",
            "description": "Optional choices to show the user. If you recommend one, put it first and append \"(Recommended)\" to that label.",
            "items": {
              "type": "object",
              "additionalProperties": true,
              "properties": {
                "label": {
                  "type": "string",
                  "description": "Short user-facing option label."
                },
                "description": {
                  "type": "string",
                  "description": "One sentence explaining the tradeoff or impact."
                }
              },
              "required": [
                "label"
              ]
            }
          },
          "multi_select": {
            "type": "boolean",
            "description": "Whether the user may select more than one option. Defaults to false."
          }
        },
        "required": [
          "id",
          "question"
        ]
      }
    }
  },
  "required": [
    "questions"
  ]
}
```

来源：[`packages/interaction/tool-ask-user/src/index.ts`](../packages/interaction/tool-ask-user/src/index.ts)

ask_user_question 会暂停工具调用，直到当前 UI 提供方返回人类答案。

<a id="deepseek-aidsh-tools"></a>

## `@deepseek-ai/dsh-tools`

### `run_code`

针对可用工具执行 TypeScript 程序。接受两个必填参数：`code`，即异步函数的**函数体**（仅使用可擦除语法；支持顶层 `await` 和 `return`）；以及 `description`，简要说明该程序做什么。请根据系统提示词中的声明，以 `await tools.name(args)` 形式调用工具。只有打印或返回的内容属于程序输出，请谨慎筛选。含图片的子工具结果会在运行结束后附加。

```json
{
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "description": "The program: the body of an async TypeScript function."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: \"Count TODO markers across packages\"; \"Read failing test and its fixture\"; \"Rename config key in every cordis.yml\"."
    }
  },
  "required": [
    "code",
    "description"
  ]
}
```

来源：[`packages/core/tools/src/ptc.ts`](../packages/core/tools/src/ptc.ts)

在 `mode: ptc`／`mode: both` 下，它由工具注册表所有，作为可过滤能力层之外的保留传输机制（参见 PTC mode Agent Note）。在 `ptc` 下，它是注册表对协议格式的唯一贡献；其他可见能力在使用已加载运行时语言生成的 SDK 章节中声明。程序通过 binding 调用这些能力，调用按照原生并发约定调度：启动顺序和策略遵循提交顺序，并发安全的函数体最多重叠执行 `maxParallelSubCalls` 个。调用会重新进入完整且受守卫保护的工具流水线，并将每个嵌套执行关联到此外层结果。

<a id="deepseek-aidsh-plan-mode"></a>

## `@deepseek-ai/dsh-plan-mode`

### `enter_plan_mode`

仅在规划模式之外使用。提议先做规划：当请求较大、跨越多个子系统或含义不清时，以及用户提出要计划时调用它——用户因此无需自行切换会话模式。决定在这次调用内由用户做出，只有获批才会进入规划模式；提议被拒绝意味着直接执行请求，不做规划。

```json
{
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "description": "Why planning first helps on this request, in one sentence the user reads."
    }
  },
  "required": [
    "reason"
  ]
}
```

来源：[`packages/plan/plan-mode/src/index.ts`](../packages/plan/plan-mode/src/index.ts)

### `exit_plan_mode`

仅在规划模式下使用。提交计划供用户评审，并在获批后退出规划模式。发送**完整的** Markdown 计划，以一个为计划命名的 # 标题开头。用户可以批准（从你的下一步骤起执行计划），也可以要求继续规划；其反馈会通过工具结果返回，请修改后再次提交。

```json
{
  "type": "object",
  "properties": {
    "plan": {
      "type": "string",
      "description": "The complete plan, as markdown, starting with a # heading that names it."
    }
  },
  "required": [
    "plan"
  ]
}
```

来源：[`packages/plan/plan-mode/src/index.ts`](../packages/plan/plan-mode/src/index.ts)

规划未激活时，exit_plan_mode 仍保留在面向模型的 schema 中，这样状态转换不会在规划策略变更之外额外造成工具目录变动。其执行路径会拒绝规划模式之外的调用；在规划模式下，它通过用户交互 seam 提交计划（批准／根据反馈继续规划），批准后会在步骤边界记录规划模式已停用。

<a id="deepseek-aidsh-tool-bash"></a>

## `@deepseek-ai/dsh-tool-bash`

### `bash`

执行 bash 命令（`bash -c`）并返回 stdout/stderr。每次调用都在新 shell 中运行：调用之间不保留任何状态（cwd、变量、函数），请传入 `workdir`，不要使用 `cd`。非零退出会报告为 `[exit code: N]`。当前 harness 环境信息通过托管的 `$DSH_*` 变量公开，需要时请检查这些变量。命令可能在文件沙箱中运行；被阻止的文件操作报告为 `[sandbox: file access denied under <mode> mode]`，这是策略拒绝，而不是命令缺陷。较长的输出会截断，只保留尾部；如可用，完整输出会保存到文件并报告其路径。对于长时间运行的命令，请设置 `run_in_background: true`：调用会立即返回 job id；使用 `job_output` 读取输出，使用 `job_kill` 停止任务。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The bash command to execute."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"git status\" → \"Show working tree status\"; \"npm install\" → \"Install package dependencies\"."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry."
    },
    "workdir": {
      "type": "string",
      "description": "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies."
    }
  },
  "required": [
    "command",
    "description"
  ]
}
```

来源：[`packages/shell/tool-bash/src/index.ts`](../packages/shell/tool-bash/src/index.ts)

bash 工具是 bash 执行器 seam 面向模型的消费方。使用 `run_in_background` 的运行会注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具（来自 `@deepseek-ai/dsh-tool-jobs`）收集／停止；禁用 `enableRunInBackground` 配置（默认为 true）后，该参数会被完全移除。

<a id="deepseek-aidsh-tool-present"></a>

## `@deepseek-ai/dsh-tool-present`

### `present`

声明交付 Session 文件系统可访问的已有文件。如果你创建或更新的文件是用户要求接收的成果，则必须在写入完成后、最终回复前调用 present，包括通过 Bash 或代码执行创建的文件。在回复中提到文件路径不能替代这次调用。文件必须已存在。用户打开当前源文件；不复制或保存其内容。

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "path": {
            "type": "string",
            "description": "Path of an existing regular file. Relative paths use the Session working directory."
          },
          "description": {
            "type": "string",
            "description": "Brief description for the user."
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  "required": [
    "files"
  ]
}
```

来源： [`packages/fs/tool-present/src/index.ts`](../packages/fs/tool-present/src/index.ts)

交付归调用方 Session 所有；Web ui-deliverables 提供源文件打开与卡片。

<a id="deepseek-aidsh-tool-pwsh"></a>

## `@deepseek-ai/dsh-tool-pwsh`

### `pwsh`

执行 PowerShell 命令（`pwsh -Command`）并返回 stdout/stderr。每次调用都在新的 pwsh 进程中运行：调用之间不保留任何状态（cwd、变量、函数），请传入 `workdir`，不要使用 `cd`。路径采用 Windows 原生形式（`C:\...`）；使用 `$env:NAME` 读取环境变量。非零退出会报告为 `[exit code: N]`。当前 harness 环境信息通过托管的 `$env:DSH_*` 变量公开，需要时请检查这些变量。命令可能在文件沙箱中运行；被阻止的文件操作报告为 `[sandbox: file access denied under <mode> mode]`，这是策略拒绝，而不是命令缺陷。较长的输出会截断，只保留尾部；如可用，完整输出会保存到文件并报告其路径。在 Windows 上，被强制终止的命令会以 `[exit code: 1]` 结算且不带信号标记，请将其视为中断，而不是命令失败。对于长时间运行的命令，请设置 `run_in_background: true`：调用会立即返回 job id；使用 `job_output` 读取输出，使用 `job_kill` 停止任务。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The PowerShell command to execute."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"git status\" → \"Show working tree status\"; \"Get-Process\" → \"List running processes\"."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry."
    },
    "workdir": {
      "type": "string",
      "description": "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies."
    }
  },
  "required": [
    "command",
    "description"
  ]
}
```

来源：[`packages/shell/tool-pwsh/src/index.ts`](../packages/shell/tool-pwsh/src/index.ts)

pwsh 工具是 Windows 组合中 bash 执行器 seam 的 PowerShell 方言消费方（由 `@deepseek-ai/dsh-pwsh-local` 等 PowerShell 执行器为 `ctx.shell` 提供后端）；除沙箱接口外，它逐项对应 bash 工具调用。使用 `run_in_background` 的运行会注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具收集／停止；托管的 `DSH_*` 环境来自 `@deepseek-ai/dsh-shell-env`。每次调用都在新进程中运行，不使用持久 PTY 会话。路径采用原生 `C:\...` 形式，变量采用 `$env:NAME`。

<a id="deepseek-aidsh-tool-cordis"></a>

## `@deepseek-ai/dsh-tool-cordis`

### `cordis_define`

定义一个不可变的 Cordis Package。新建 Plugin 时使用 kind:"new"，只提供 3 至 6 位小写英文字母组成的语义前缀；Host 返回最终 pluginId 和 packageId。修改现有 Plugin 时使用 kind:"existing" 并传入精确 pluginId，以追加 Package 而不覆盖旧版本。code.host 与 code.client 至少提供一个；每个值都是返回 Cordis Plugin 的 plain JavaScript 函数体，不经过 TypeScript、JSX 或 import 转换。依赖 Service、Event、Builtin、Slot 或 token 前先查询 Inspect。Define 只校验参数和语法并记录源码，不申请审批、不执行 apply，也不改变 currentPackageId。成功后用返回的 ID 调用 cordis_run。

```json
{
  "type": "object",
  "properties": {
    "plugin": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "kind": {
              "type": "string",
              "const": "new"
            },
            "idPrefix": {
              "type": "string",
              "description": "Suggested semantic prefix of 3–6 lowercase English letters; the Host adds a unique numeric suffix."
            }
          },
          "required": [
            "kind",
            "idPrefix"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "kind": {
              "type": "string",
              "const": "existing"
            },
            "pluginId": {
              "type": "string",
              "description": "Exact ID of an existing Plugin; the new Package is appended to that instance."
            }
          },
          "required": [
            "kind",
            "pluginId"
          ]
        }
      ]
    },
    "name": {
      "type": "string",
      "description": "Short, readable Package name."
    },
    "purpose": {
      "type": "string",
      "description": "One-sentence, user-facing description of the Package purpose."
    },
    "code": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "host": {
          "type": "string",
          "description": "Plain JavaScript function body that returns the Host-half Cordis Plugin."
        },
        "client": {
          "type": "string",
          "description": "Plain JavaScript function body that returns the browser Client-half Cordis Plugin."
        }
      }
    }
  },
  "required": [
    "plugin",
    "name",
    "purpose",
    "code"
  ]
}
```

来源：[`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts)

### `cordis_inspect_list`

列出 Host 当前已知的全部 Cordis Inspect Provider，包括本地 Host Provider 和 Client 最近同步的 manifest。每项包含所属平台、用途、只读方法及输入／输出 schema。创建或修改 Package 前先调用本 Tool，再从结果中选择 cordis_inspect_query 的 provider 和 method。不要猜测名称，也不要把 Inspect method 当作 Plugin 代码可调用的业务 Service。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts)

### `cordis_inspect_query`

执行 Inspect Provider 显式声明的只读查询。platform、provider 和 method 必须来自 cordis_inspect_list，input 必须符合该方法的 schema。在 cordis_define 前用本 Tool 读取精确 Service 方法、Event mode、Builtin 签名、Tool schema、主题 token，或实时 Slot 树及 props。Host 查询在本地执行；Client 查询等待首个有效页面响应，在页面回答或 Tool 被取消前保持 pending。本 Tool 不能调用业务 Service 方法或修改运行时。查询 Service.listService 和 Event.listEvents 时，先不传 input 浏览紧凑签名目录，再查询精确 service 或 event 获取结构化约定和引用类型。查询 Slots.listSubTree 时，先不传 root 浏览紧凑树，再查询精确 root 获取完整注册约定和 props。

```json
{
  "type": "object",
  "properties": {
    "platform": {
      "type": "string",
      "description": "Runtime platform that owns the Provider.",
      "enum": [
        "host",
        "client"
      ]
    },
    "provider": {
      "type": "string",
      "description": "Exact Provider ID returned by cordis_inspect_list."
    },
    "method": {
      "type": "string",
      "description": "Exact method name declared by the Provider manifest."
    },
    "input": {
      "description": "Optional query input; it must satisfy the method input schema."
    }
  },
  "required": [
    "platform",
    "provider",
    "method"
  ]
}
```

来源：[`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts)

### `cordis_inspect_self`

按逐层增加的详细程度检查当前 Session 拥有的动态 Cordis 对象。不传 ID 时只列 Plugin 摘要；只传 pluginId 时返回版本指针、最新 Run 和全部 Package 摘要；只有同时传 pluginId 与 packageId 才返回该不可变 Package 的 Host/Client 源码和运行诊断。packageId 不能单独传入。处理 @pluginId、修复异步失败或定义更新版本前，先查询精确 Package。本 Tool 只读，不执行代码，也不改变版本指针。

```json
{
  "type": "object",
  "properties": {
    "pluginId": {
      "type": "string",
      "description": "Stable Plugin ID returned by cordis_define or injected by @pluginId; omit it to list every current Plugin."
    },
    "packageId": {
      "type": "string",
      "description": "Exact immutable Package ID owned by pluginId; when specified, source and diagnostics are returned."
    }
  }
}
```

来源：[`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts)

### `cordis_run`

激活动态 Plugin 的一个精确 Package。首次激活、重启 currentPackageId 或回退使用 mode:"run"；已有 current 时，即使 Plugin 当前已停止，切换到其他 Package 也使用 mode:"update"。未授权的 Client Package 创建审批请求并返回 awaiting-approval；已授权的 Package 返回 starting，并在浏览器中异步继续。两种结果都不会在 Tool 内等待最终结局。currentPackageId 只在完整成功后改变；失败时保留旧 current 和目标 next。异步成功、拒绝或技术失败通过状态与 steering 报告。技术失败后，用 cordis_inspect_self 读取诊断，修正同一 Plugin 并自主重试。

```json
{
  "type": "object",
  "properties": {
    "pluginId": {
      "type": "string",
      "description": "Stable Plugin ID returned by cordis_define."
    },
    "packageId": {
      "type": "string",
      "description": "Exact immutable Package ID to activate under that Plugin."
    },
    "mode": {
      "type": "string",
      "description": "Use run for the first activation, restarting current, or rollback; use update to switch from current to a different Package.",
      "enum": [
        "run",
        "update"
      ]
    }
  },
  "required": [
    "pluginId",
    "packageId",
    "mode"
  ]
}
```

来源：[`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts)

### `cordis_stop`

停止动态 Plugin 的当前 Run，并取消尚未完成的审批或激活请求。保留 Plugin、全部不可变 Package、授权、currentPackageId 和 nextPackageId，以便之后直接运行或更新。停止已处于停止状态的 Plugin 会幂等成功。临时禁用副作用使用本 Tool；永久移除使用 cordis_undefine。

```json
{
  "type": "object",
  "properties": {
    "pluginId": {
      "type": "string",
      "description": "Stable dynamic Plugin ID to stop."
    }
  },
  "required": [
    "pluginId"
  ]
}
```

来源：[`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts)

### `cordis_undefine`

永久移除当前 Session 拥有的动态 Plugin。如果它正在运行或等待审批，先停止并取消请求，再删除全部 Package、授权和版本指针。返回后，其 pluginId、packageIds、@ 引用和 Package 业务视图均失效；历史卡片只保留“Plugin 已移除”记录。需要保留版本以便重启或回退时不要调用本 Tool，应改用 cordis_stop。

```json
{
  "type": "object",
  "properties": {
    "pluginId": {
      "type": "string",
      "description": "Stable dynamic Plugin ID to remove permanently."
    }
  },
  "required": [
    "pluginId"
  ]
}
```

来源：[`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts)

不在任何随产品发布的树中，需要显式选择启用；动态 Package 代码可以访问真实运行时，见 .agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md。该工具集注入 `@deepseek-ai/dsh-cordis-host-runner` 提供的 `ctx.dynamicCordisRunner`，后者拥有定义注册表和 vm 沙箱；组合缺少它时这些工具不会激活。运行中的 Package 在停止、undefine 或 DSH 重启前可以注册**额外的**模型可见工具；发生这类工具集变化时，系统会记录完整且有变动的请求头。

<a id="deepseek-aidsh-tool-bash-persistent"></a>

## `@deepseek-ai/dsh-tool-bash-persistent`

### `bash`

在持久 bash shell 中运行命令。包括当前目录和已导出环境变量在内的状态会在此 agent 的多次调用之间保留。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The bash command to run. Relative path is preferred in the command."
    }
  },
  "required": [
    "command"
  ]
}
```

来源：[`packages/shell/tool-bash-persistent/src/index.ts`](../packages/shell/tool-bash-persistent/src/index.ts)

一个按所有者隔离的持久 bash 工具；部署组合提供 PTY 后端，并可覆盖面向模型的环境描述。

<a id="deepseek-aidsh-tool-pwsh-persistent"></a>

## `@deepseek-ai/dsh-tool-pwsh-persistent`

### `pwsh`

在持久 PowerShell shell 中运行命令。包括当前目录和已导出环境变量在内的状态会在此 agent 的多次调用之间保留。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The PowerShell command to run. Relative path is preferred in the command."
    }
  },
  "required": [
    "command"
  ]
}
```

来源：[`packages/shell/tool-pwsh-persistent/src/index.ts`](../packages/shell/tool-pwsh-persistent/src/index.ts)

一个按所有者隔离的持久 pwsh 工具，持久 bash 工具的 Windows 对应物；部署组合提供 pwsh 方言的 PTY 后端，并可覆盖面向模型的环境描述。

<a id="deepseek-aidsh-tool-str-replace-editor"></a>

## `@deepseek-ai/dsh-tool-str-replace-editor`

### `str_replace_editor`

用于查看、创建和编辑文件的自定义编辑工具：
* 状态会在命令调用以及与用户的讨论之间持久保留
* 如果 `path` 是文件，`view` 会显示应用 `cat -n` 后的结果。如果 `path` 是目录，`view` 会列出最多向下 2 层的非隐藏文件和目录
* 如果指定的 `create` 命令目标 `path` 已作为文件存在，则不能使用该命令
* 如果 `command` 产生较长输出，输出会被截断并标记为 `<response clipped>`
* 当前命令不使用某个参数时，值为 `null` 的占位参数视为未提供。必填参数仍须提供值；删除匹配内容时应省略 `str_replace.new_str`，而不是将其设为 `null`

使用 `str_replace` 命令时请注意：
* `old_str` 参数应与原文件中一行或多行连续内容**完全**匹配。请留意空白字符！
* 如果 `old_str` 参数在文件中不唯一，则不会执行替换。请确保在 `old_str` 中包含足够的上下文，使其唯一
* `new_str` 参数应包含用于替换 `old_str` 的已编辑行

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
      "enum": [
        "view",
        "create",
        "str_replace",
        "insert"
      ]
    },
    "path": {
      "type": "string",
      "description": "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`."
    },
    "file_text": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "description": "Required string parameter of `create` command, with the content of the file to be created. A null placeholder is treated as omitted by commands that do not use this parameter."
    },
    "insert_line": {
      "oneOf": [
        {
          "type": "integer"
        },
        {
          "type": "null"
        }
      ],
      "description": "Required integer parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`. A null placeholder is treated as omitted by commands that do not use this parameter."
    },
    "new_str": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "description": "Optional string parameter of `str_replace` command containing the new string (if omitted, no string will be added). Required string parameter of `insert` command containing the string to insert. A null placeholder is accepted only by commands that do not use this parameter."
    },
    "old_str": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "description": "Required string parameter of `str_replace` command containing the string in `path` to replace. A null placeholder is treated as omitted by commands that do not use this parameter."
    },
    "view_range": {
      "oneOf": [
        {
          "type": "array",
          "items": {
            "type": "integer"
          }
        },
        {
          "type": "null"
        }
      ],
      "description": "Optional parameter of `view` command when `path` points to a file. If omitted or null, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file."
    }
  },
  "required": [
    "command",
    "path"
  ]
}
```

来源：[`packages/fs/tool-str-replace-editor/src/index.ts`](../packages/fs/tool-str-replace-editor/src/index.ts)

基于文件系统 seam 的独立查看／创建／唯一字面量替换／按行插入工具；可与任何 shell 或终端接口组合。

<a id="deepseek-aidsh-tool-fs"></a>

## `@deepseek-ai/dsh-tool-fs`

### `edit`

通过替换字面量文本来编辑现有 UTF-8 文本文件。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to edit, resolved by the filesystem backend."
    },
    "old_string": {
      "type": "string",
      "description": "Literal text to replace. Must match exactly."
    },
    "new_string": {
      "type": "string",
      "description": "Literal replacement text. Use an empty string to delete the match."
    },
    "replace_all": {
      "type": "boolean",
      "description": "Replace all matches. Defaults to false; when false, old_string must appear exactly once."
    }
  },
  "required": [
    "file_path",
    "old_string",
    "new_string"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)

### `read`

读取 UTF-8 文本文件，并返回带行号的内容。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to read, resolved by the filesystem backend."
    },
    "offset": {
      "type": "number",
      "description": "1-based first line to return. Defaults to 1."
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of lines to return. Defaults to 2000."
    }
  },
  "required": [
    "file_path"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)

### `read_image`

读取 PNG/JPEG/WebP/GIF 文件并返回图像本身。无扩展名的路径同样被接受；格式按文件内容检测，因此规范化附件路径可以直接传入，无需复制或重命名。Harness 会在下一次模型请求前校验并缩小受支持的大图，因此仅为查看图片时应直接使用此工具，无需安装图片库或创建缩略图。可以用小批次并发读取彼此独立的文件。要求当前模型接受图像输入。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to the image file, resolved by the filesystem backend."
    }
  },
  "required": [
    "file_path"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)

### `write`

创建或完全替换 UTF-8 文本文件。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to write, resolved by the filesystem backend."
    },
    "content": {
      "type": "string",
      "description": "Full UTF-8 text content to write."
    }
  },
  "required": [
    "file_path",
    "content"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)

先读后写／编辑策略由 `@deepseek-ai/dsh-fs-observation-policy` 添加；它是一个 `fs/*` 事件门禁插件，不会改变 schema。加载这些工具的部署按预期也应加载该插件。没有 `ctx.attachments` 时图片工具不会注册；其 schema 与路由无关，执行时除非确切路由的模型声明图片输入，否则拒绝。

<a id="deepseek-aidsh-tool-fs-search"></a>

## `@deepseek-ai/dsh-tool-fs-search`

### `glob`

查找路径匹配 glob 模式的文件。只返回匹配的文件路径，绝不返回目录；包括隐藏文件和被忽略的文件，但排除 VCS 元数据目录。最多按修改时间顺序返回 100 条路径；如果结果更多，则改为返回从顶层条目中抽样的 100 条路径，说明已抽样，并报告完整排序列表的保存位置。该工具不枚举目录条目。

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Glob pattern to match file paths against (e.g. \"**/*.ts\", \"src/**/*.test.js\"). A pattern with no \"/\" matches the basename at any depth, so \"*\" and \"*.ts\" both search the whole tree; include a separator to anchor the depth."
    },
    "path": {
      "type": "string",
      "description": "Directory to search in. Defaults to the session workspace; a relative path resolves against it."
    }
  },
  "required": [
    "pattern"
  ]
}
```

来源：[`packages/fs/tool-fs-search/src/index.ts`](../packages/fs/tool-fs-search/src/index.ts)

### `grep`

使用 ripgrep 正则表达式搜索文件内容。返回带行号的匹配行，并按文件分组。前 250 条匹配会直接返回；结果达到上限时会报告完整匹配列表的保存位置。如需周边上下文，请对匹配的文件使用 read。

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Regular expression to search for (ripgrep syntax)."
    },
    "path": {
      "type": "string",
      "description": "File or directory to search. Defaults to the session workspace; a relative path resolves against it."
    },
    "include": {
      "type": "string",
      "description": "One glob filter for which files to search (e.g. \"*.ts\", \"*.{js,jsx}\"). Not a list; negation is not supported."
    }
  },
  "required": [
    "pattern"
  ]
}
```

来源：[`packages/fs/tool-fs-search/src/index.ts`](../packages/fs/tool-fs-search/src/index.ts)

glob 和 grep 是无条件可用的发现工具，通过 ctx.subprocess spawn 随包提供的 ripgrep 二进制文件（`@vscode/ripgrep`），并作为普通前台调用运行，绝不作为后台任务；无需在宿主机安装 `rg`，也不经过 shell 层。本目录使用 `sampleOverCapGlobResults: true`；部署必须显式选择该行为。结果超过上限时，会通过可选的 ctx.spillStore 后端保存完整的格式化列表；在共置部署中，如果后端公开本地路径，返回的定位信息可供后续读取／搜索。

<a id="deepseek-aidsh-tool-terminal"></a>

## `@deepseek-ai/dsh-tool-terminal`

### `terminal_close`

关闭一个持久终端，并等待其捕获且所有的进程树完全退出。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id."
    }
  },
  "required": [
    "sessionId"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

### `terminal_list`

列出当前 agent 所有的持久终端会话。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

### `terminal_open`

通过已注册的后端类型创建按所有者隔离的持久终端会话。需要在多次工具调用之间保留 shell 或 REPL 状态时，请使用此工具。

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "description": "Registered terminal backend type, usually \"shell\"."
    },
    "name": {
      "type": "string",
      "description": "Optional owner-local display name such as \"main\" or \"gdb\"."
    },
    "cwd": {
      "type": "string",
      "description": "Initial working directory. Defaults to the deployment workspace root."
    }
  },
  "required": [
    "type"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

### `terminal_read`

从持久终端读取一页有界的保留输出，不发送输入。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id."
    },
    "offset": {
      "type": "number",
      "description": "Newest-relative line offset (default 0)."
    },
    "count": {
      "type": "number",
      "description": "Requested line count (default 500; backend caps apply)."
    }
  },
  "required": [
    "sessionId"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

### `terminal_send`

向持久终端发送文本。默认会提交 Enter，并等待提示符、stdin 等待、输出静默、超时或会话退出。后台模式会返回供 job_output／job_kill 使用的 job id。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id returned by terminal_open or terminal_list."
    },
    "text": {
      "type": "string",
      "description": "UTF-8 text to write to the terminal."
    },
    "submit": {
      "type": "boolean",
      "description": "Submit Enter after text (default true). Set false for control characters or incomplete REPL input."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Return a job id immediately; collect with job_output or stop with job_kill."
    }
  },
  "required": [
    "sessionId",
    "text"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

### `terminal_signal`

向持久终端当前的前台进程组发送允许的信号。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id."
    },
    "signal": {
      "type": "string",
      "description": "Signal to deliver. Shell-targeted SIGKILL is rejected; use terminal_close.",
      "enum": [
        "SIGINT",
        "SIGTERM",
        "SIGKILL",
        "SIGTSTP",
        "SIGHUP"
      ]
    }
  },
  "required": [
    "sessionId",
    "signal"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

这 6 个终端工具需要选择启用，用于补充一次性 bash／文件系统工具。`terminal_send(run_in_background: true)` 会注册到 `ctx.jobs`；schema 不包含 TUI、具名按键序列、BEL、调整尺寸、自动启动和跨 agent 共享。

<a id="deepseek-aidsh-tool-goal"></a>

## `@deepseek-ai/dsh-tool-goal`

### `create_goal`

当当前直接人类请求是需要跨自主 Goal Round 持续推进的长期目标时，创建一个持久化的同会话完成目标。即使用户没有明确说「创建目标」，你也可以推断其意图。不要用于简单的单轮工作。执行时会拒绝非人类权限和 subagent 权限。

```json
{
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "description": "The concrete completion objective inferred from the direct human request."
    },
    "max_goal_rounds": {
      "type": "number",
      "description": "Optional positive safe-integer limit on automatic continuation rounds."
    }
  },
  "required": [
    "objective"
  ]
}
```

来源：[`packages/goal/tool-goal/src/index.ts`](../packages/goal/tool-goal/src/index.ts)

### `get_goal`

读取当前的同会话目标，包括确切的 id／revision、目标、阶段、已完成的延续 Round 数、Round 上限、存在时的阻塞原因，以及是否已准备下一次延续。更新目标前请先调用此工具。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/goal/tool-goal/src/index.ts`](../packages/goal/tool-goal/src/index.ts)

### `update_goal`

更新确切的当前目标 revision。edit、pause 和 resume 要求直接的顶层人类请求。在自动延续当前目标期间，也允许 complete 和 blocked。在达到配置的最小 Round 数之前会拒绝 blocked；模型仍须判断相同条件是否在这些 Round 中持续存在，并在 blocked_reason 中予以说明。

```json
{
  "type": "object",
  "properties": {
    "goal_id": {
      "type": "string",
      "description": "Exact id returned by get_goal."
    },
    "revision": {
      "type": "number",
      "description": "Exact positive revision returned by get_goal."
    },
    "action": {
      "type": "string",
      "description": "edit | pause | resume | complete | blocked",
      "enum": [
        "edit",
        "pause",
        "resume",
        "complete",
        "blocked"
      ]
    },
    "objective": {
      "type": "string",
      "description": "Replacement objective; valid only with action edit."
    },
    "max_goal_rounds": {
      "type": "number",
      "description": "Replacement cap; valid only with action edit."
    },
    "blocked_reason": {
      "type": "string",
      "description": "Concrete blocking condition; required only with action blocked."
    }
  },
  "required": [
    "goal_id",
    "revision",
    "action"
  ]
}
```

来源：[`packages/goal/tool-goal/src/index.ts`](../packages/goal/tool-goal/src/index.ts)

create、edit、pause 和 resume 要求直接来自人类的根权限；complete 和 blocked 也接受确切的当前 Goal Round。blocked 的默认下限是 3 个获准的 Round。

<a id="deepseek-aidsh-schedule"></a>

## `@deepseek-ai/dsh-schedule`

### `schedule_create`

在当前会话中创建一条提醒。请提供非空 prompt 和恰好一个 selector：正的安全整数 after_seconds 延时；作为严格带偏移日期时间或本地日期／时间对象的 at；或不小于 300 的安全整数 every_seconds。固定速率提醒始终与创建时刻对齐，会跳过错过的发生时点，并把每条逾期规则的最新一个发生时点合并到一个批次中。交付模式是 session-local：只有此会话处于 live 状态时，提醒才会准时运行；否则提醒会进入 overdue 状态，直至会话恢复。

```json
{
  "type": "object",
  "properties": {
    "prompt": {
      "type": "string",
      "description": "Reminder content to present when the target becomes due."
    },
    "after_seconds": {
      "type": "number",
      "description": "Positive safe-integer delay in seconds."
    },
    "every_seconds": {
      "type": "number",
      "description": "Fixed-rate safe-integer interval in seconds, at least 300."
    },
    "at": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "date": {
              "type": "string"
            },
            "time": {
              "type": "string"
            },
            "time_zone": {
              "type": "string"
            }
          },
          "required": [
            "date",
            "time",
            "time_zone"
          ]
        }
      ],
      "description": "Absolute target as strict offset RFC 3339 or local date/time with an explicit IANA zone."
    }
  },
  "required": [
    "prompt"
  ]
}
```

来源：[`packages/schedule/schedule/src/tools.ts`](../packages/schedule/schedule/src/tools.ts)

### `schedule_delete`

使用 schedule_create 或 schedule_list 返回的确切 id，删除当前会话中的一条活动提醒。未知或已经结束的 id 会返回 deleted false。

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Exact session-local schedule id."
    }
  },
  "required": [
    "id"
  ]
}
```

来源：[`packages/schedule/schedule/src/tools.ts`](../packages/schedule/schedule/src/tools.ts)

### `schedule_list`

按创建顺序列出当前会话中的所有活动提醒，包括确切 id、UTC 目标、scheduled 或 overdue 状态，以及 session-local 交付模式。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/schedule/schedule/src/tools.ts`](../packages/schedule/schedule/src/tools.ts)

仅在选择启用的 Schedule 插件加载后创建的 live 根 Agent scope 内注册。版本 1 接受 after_seconds、显式绝对 at 和有界固定速率 every_seconds，并披露 session-local 交付；管理读取与变更必须通过共享的 Session 持久化 barrier。

<a id="deepseek-aidsh-tool-lsp"></a>

## `@deepseek-ai/dsh-tool-lsp`

### `lsp`

查询语言服务器，以精确导航代码。operation 可取 goToDefinition、findReferences、goToImplementation 或 hover。line 和 character 是从 1 开始的 UTF-16 光标坐标。findReferences 包含声明。

```json
{
  "type": "object",
  "properties": {
    "operation": {
      "type": "string",
      "description": "goToDefinition, findReferences, goToImplementation, or hover.",
      "enum": [
        "goToDefinition",
        "findReferences",
        "goToImplementation",
        "hover"
      ]
    },
    "file_path": {
      "type": "string",
      "description": "The source file to query, relative to the workspace or absolute."
    },
    "line": {
      "type": "number",
      "description": "One-based line of the cursor."
    },
    "character": {
      "type": "number",
      "description": "One-based UTF-16 column of the cursor."
    }
  },
  "required": [
    "operation",
    "file_path",
    "line",
    "character"
  ]
}
```

来源：[`packages/lsp/tool-lsp/src/index.ts`](../packages/lsp/tool-lsp/src/index.ts)

lsp 工具将提供方选择和语言服务器子进程置于 ctx.lsp 之后，因此其模型可见 schema 在更换提供方时保持稳定。运行时要求已注册提供方，例如 `@deepseek-ai/dsh-lsp-stdio`；如果没有提供方，查询会返回结构化 `LSP_UNAVAILABLE` 错误，而不会改变 schema。

<a id="deepseek-aidsh-tool-ralph"></a>

## `@deepseek-ai/dsh-tool-ralph`

### `ralph`

围绕一个不可变目标运行使用全新 agent 的前台 Ralph 循环。仅当直接人类明确要求 Ralph 或使用全新 agent 迭代时使用。每个 Round 都会启动一个全新子级，该子级看不到父级对话或先前子会话；共享工作区充当长期记忆，Round 之间只传递有界的结构化报告。当工作进程报告完成、报告具体阻塞项或达到 Round 上限时，调用返回。普通的长期同会话工作应使用 goal 工具。

```json
{
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "description": "The immutable completion objective for every fresh Ralph round."
    },
    "maxRounds": {
      "type": "number",
      "description": "Optional positive safe-integer round cap, bounded by the deployment ceiling."
    }
  },
  "required": [
    "objective"
  ]
}
```

来源：[`packages/workflow/tool-ralph/src/index.ts`](../packages/workflow/tool-ralph/src/index.ts)

固定的前台工作流会在每个 Round 启动一个全新的结构化子级；模型只能选择不可变目标和可选的 Round 上限。

<a id="deepseek-aidsh-tool-skill"></a>

## `@deepseek-ai/dsh-tool-skill`

### `skill`

加载可用 skill（技能）的完整说明。在执行点名某项 skill 或与其明确匹配的任务前，请使用会话 skill 目录中的确切名称调用此工具。

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "The exact skill name from the available skills list."
    }
  },
  "required": [
    "name"
  ]
}
```

来源：[`packages/skill/tool-skill/src/index.ts`](../packages/skill/tool-skill/src/index.ts)

<a id="deepseek-aidsh-tool-session-query"></a>

## `@deepseek-ai/dsh-tool-session-query`

### `session_event_read`

从一个已获授权的会话中读取一个完整且未删节的事件，以及可选的相邻原始事件概述。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    },
    "seq": {
      "type": "integer",
      "description": "Target event sequence number."
    },
    "before": {
      "type": "integer",
      "description": "Number of preceding raw events to summarize. Omit for none."
    },
    "after": {
      "type": "integer",
      "description": "Number of following raw events to summarize. Omit for none."
    }
  },
  "required": [
    "seq"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)

### `session_event_search`

在一个已获授权的会话中搜索先前事件；如果搜索当前会话，则排除执行此次调用的步骤。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    },
    "query": {
      "type": "string",
      "description": "Literal full-text query over the target session."
    },
    "seq_from": {
      "type": "integer",
      "description": "Inclusive event sequence lower bound."
    },
    "seq_to": {
      "type": "integer",
      "description": "Inclusive event sequence upper bound."
    },
    "time_from": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time lower bound."
    },
    "time_to": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time upper bound."
    },
    "event_types": {
      "type": "array",
      "description": "Event types to include.",
      "items": {
        "type": "string"
      }
    },
    "surfaces": {
      "type": "array",
      "description": "Event surfaces to include.",
      "items": {
        "type": "string",
        "enum": [
          "current",
          "shadowed",
          "log-only"
        ]
      }
    }
  },
  "required": [
    "query"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)

### `session_event_trace`

读取已获授权会话中某个事件的所有直接替换关系，以及该事件与其引用的来源事件之间的关系。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    },
    "seq": {
      "type": "integer",
      "description": "Target event sequence number."
    }
  },
  "required": [
    "seq"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)

### `session_search`

搜索调用方工作区中的先前会话，并从每个会话返回匹配度最高的事件。

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Literal full-text query over prior session history."
    },
    "session_ids": {
      "type": "array",
      "description": "Optional session ids to include.",
      "items": {
        "type": "string"
      }
    },
    "created_at_from": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 creation-time lower bound."
    },
    "created_at_to": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 creation-time upper bound."
    },
    "parent_session_ids": {
      "type": "array",
      "description": "Optional direct parent session ids.",
      "items": {
        "type": "string"
      }
    },
    "include_root_sessions": {
      "type": "boolean",
      "description": "Include sessions with no parent in the parent filter."
    },
    "availability": {
      "type": "array",
      "description": "Require at least one selected source availability.",
      "items": {
        "type": "string",
        "enum": [
          "live",
          "persisted"
        ]
      }
    },
    "event_seq_from": {
      "type": "integer",
      "description": "Inclusive event sequence lower bound."
    },
    "event_seq_to": {
      "type": "integer",
      "description": "Inclusive event sequence upper bound."
    },
    "event_time_from": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time lower bound."
    },
    "event_time_to": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time upper bound."
    },
    "event_types": {
      "type": "array",
      "description": "Event types to include.",
      "items": {
        "type": "string"
      }
    },
    "event_surfaces": {
      "type": "array",
      "description": "Event surfaces to include.",
      "items": {
        "type": "string",
        "enum": [
          "current",
          "shadowed",
          "log-only"
        ]
      }
    }
  },
  "required": [
    "query"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)

### `session_trace`

读取围绕一个会话的已授权会话谱系，包括完整可见的祖先和后代关系。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    }
  }
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)

这 5 个只读工具会隐藏提供方游标，并根据不可变的调用 agent 会话为每个结果授权。该包需要选择启用；需要强制截止时间或限制行内输出的组合还会挂载通用超时或 spill 策略。

<a id="deepseek-aidsh-tool-subagent"></a>

## `@deepseek-ai/dsh-tool-subagent`

### `list_subagent_models`

发现 subagent 可用的 LLM 路由，不更改当前 Agent。无参数调用会列出已注册提供方；提供 `provider` 时会列出其公布的模型；同时提供 `provider` 和 `model` 时会检查该精确模型及其推理强度。目录条目只提供建议：adapter 可能接受未列出的模型 id。把返回的 id 用于委派工具的 `provider`、`model` 与 `reasoning_effort` 字段。

```json
{
  "type": "object",
  "properties": {
    "provider": {
      "type": "string",
      "description": "Registered LLM provider id. Omit to list providers."
    },
    "model": {
      "type": "string",
      "description": "Exact model id to inspect. Requires provider; omit to list that provider's advertised models."
    }
  }
}
```

来源：[`packages/subagent/tool-subagent/src/list-models.ts`](../packages/subagent/tool-subagent/src/list-models.ts)

### `subagent`

将一项自包含任务委派给 subagent（在自身上下文中工作的独立 agent），用它卸载聚焦且独立的工作，例如研究、限定范围的实现或分析，以免消耗当前对话的上下文。subagent 会返回结果，但不会返回中间步骤。请提供完整、独立的提示词，因为它看不到当前对话。此调用默认等待结果。设置 `run_in_background: true` 可返回 job id；使用 `job_output` 收集结果，使用 `job_kill` 停止任务。

```json
{
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "description": "A short (3-5 word) description of the delegated task, for display."
    },
    "prompt": {
      "type": "string",
      "description": "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs. Require a final summary report as the closing message — findings and outcome only, no step narration."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill."
    }
  },
  "required": [
    "description",
    "prompt"
  ]
}
```

来源：[`packages/subagent/tool-subagent/src/index.ts`](../packages/subagent/tool-subagent/src/index.ts)

注册的委派工具名称取决于加载时 `toolName` 配置（默认为 `subagent`）；上述默认 schema 关闭模型选择，而发现 schema 则展示为已启用 Session 中可用的固定配套工具。Web preset 会在每个新顶层 Session 创建时读取插件页偏好，并为其子 Session 保留该决定；`subagent_fork` 始终使用固定路由。每个实例通过 `modelSelectionSettings`、`backgroundMode` 与 `enableRunInBackground` 独立控制是否读取模型选择设置及其后台行为。

<a id="deepseek-aidsh-tool-subagent-control"></a>

## `@deepseek-ai/dsh-tool-subagent-control`

### `interrupt_agent`

根据 agent id 请求取消后台 agent 的当前轮次。目标可以是你的直接子级，也可以是在你下方创建的更深层 agent。只有当前轮次会停止：已经排队发给该 agent 的消息会一直搁置到后续的 send_message；它启动的 agent 会继续运行；该 agent 本身仍可接受后续操作。停止请求被接受后，此调用立即返回，因此目标可能还会短暂运行；中断一个已经完成的 agent 是可接受的空操作。

```json
{
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "The agent id of the running agent to interrupt."
    }
  },
  "required": [
    "agent_id"
  ]
}
```

来源：[`packages/subagent/tool-subagent-control/src/index.ts`](../packages/subagent/tool-subagent-control/src/index.ts)

### `list_agents`

按持久 id 和标签列出你的可继续后台 subagent。用它回忆你启动过哪些 subagent，而不是轮询完成情况——subagent 完成时你会被告知。状态来自实时注册表：running 表示 agent 此刻正在工作；idle 表示已加载但处于轮次之间，可能正在等待它启动的 agent；ready 表示它只存在于存储中——可恢复而非终态，也不表示有结果等待收集；`send_message` 会在运行中 child 的最近 step 边界 steer 消息，或为 idle、ready child 启动轮次，且无论处于哪种状态，直接子级都仍可作为 `send_message` 的目标。该快照并非投递承诺；`send_message` 会执行权威检查，仍可能失败。无法读取的子级会作为诊断信息报告，而不会被静默丢弃。`descendants` 作用域会按稳定的前序顺序遍历你下方的整棵树，并为每个条目标注其持久的直接父会话 id 和深度。只有深度为 1 的条目可以使用 `send_message`；更深的条目只能作为 `interrupt_agent` 的候选目标。

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "description": "children (default) lists direct children only; descendants walks the complete tree below you.",
      "enum": [
        "children",
        "descendants"
      ]
    }
  }
}
```

来源：[`packages/subagent/tool-subagent-control/src/list-agents.ts`](../packages/subagent/tool-subagent-control/src/list-agents.ts)

### `send_message`

根据 agent id 向直接可继续 child 发送消息。如果你是驻留的可继续 child，也可以把自己的直接 parent 作为目标。如果目标仍在工作，消息会 steer 其最近的 step；如果目标处于 idle，消息会启动一个轮次。此调用不会返回该 agent 的答案，只会确认消息已投递。调用失败表示消息**未**投递。

```json
{
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "The agent id of your direct continuable child, or your direct parent when you are a resident continuable child."
    },
    "message": {
      "type": "string",
      "description": "The message to deliver to the agent."
    }
  },
  "required": [
    "agent_id",
    "message"
  ]
}
```

来源：[`packages/subagent/tool-subagent-control/src/index.ts`](../packages/subagent/tool-subagent-control/src/index.ts)

这些是控制可继续后台 subagent 的全局命名工具：绑定提供方的 `tool-subagent` 实例注册不同的委派工具；本包注册一次 `send_message` 和 `interrupt_agent`，另由 `list_agents` 通过单独加载的 `/list-agents` 插件提供，其目录行使用 sessionProjections 和实时 Agent 注册表。

<a id="deepseek-aidsh-tool-jobs"></a>

## `@deepseek-ai/dsh-tool-jobs`

### `job_kill`

根据 job id 请求取消正在运行的后台任务。此调用立即返回；任务的工作真正停止后，会以 killed 状态结算。

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "description": "Job id returned by the tool that started the background work."
    },
    "reason": {
      "type": "string",
      "description": "Optional short reason, recorded in the log and forwarded to the job."
    }
  },
  "required": [
    "job_id"
  ]
}
```

来源：[`packages/jobs/tool-jobs/src/index.ts`](../packages/jobs/tool-jobs/src/index.ts)

### `job_list`

列出你的后台任务（包括正在运行和已完成的任务）及其 id、种类和状态。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/jobs/tool-jobs/src/index.ts`](../packages/jobs/tool-jobs/src/index.ts)

### `job_output`

读取后台任务。流式任务只返回自上次读取以来的输出；最终输出任务会在结算后返回结果。每个响应都以 `[status: ...]` 结尾。读取默认不阻塞；设置 `wait: true` 后，最长等待到配置的上限。

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "description": "Job id returned by the tool that started the background work."
    },
    "wait": {
      "type": "boolean",
      "description": "Block until the job reaches a terminal status or the timeout expires. A timed-out wait returns [status: running] and leaves the job alive."
    },
    "timeout_ms": {
      "type": "number",
      "description": "Max wait in milliseconds (only meaningful with wait: true). Defaults to the configured wait timeout; capped by the configured maximum."
    }
  },
  "required": [
    "job_id"
  ]
}
```

来源：[`packages/jobs/tool-jobs/src/index.ts`](../packages/jobs/tool-jobs/src/index.ts)

与任务种类无关的后台任务控制器：后台 bash 命令、PTY 发送和 subagent 都通过相同的 3 个工具读取、列出和终止。加载该插件会挂接控制器，从而启用生产方的 `ctx.jobs.start()`。

<a id="deepseek-aidsh-experimental-tool-agent-team"></a>

## `@deepseek-ai/dsh-experimental-tool-agent-team`

### `interrupt_agent`

中断一名 teammate 的当前 turn，同时保留其待处理 inbox。仅 Team Lead 可用。

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Teammate name."
    }
  },
  "required": [
    "target"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `list_agents`

列出 Lead 与所有持久 teammate，以及各自当前的运行时状态。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `send_message`

向另一名 Team member 发送一条持久消息。running target 会在最近的步骤边界收到消息；idle target 会启动一个 turn；inactive teammate 会冷恢复。

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Team member name, or lead."
    },
    "message": {
      "type": "string",
      "description": "Self-contained message for the target."
    }
  },
  "required": [
    "target",
    "message"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `spawn_teammate`

创建一名具名、持久的 teammate。只有 Team Lead 可以调用此工具。

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Unique lower-kebab-case teammate name."
    },
    "description": {
      "type": "string",
      "description": "Short description of the delegated responsibility."
    },
    "prompt": {
      "type": "string",
      "description": "Complete initial task for the teammate."
    },
    "context": {
      "type": "string",
      "description": "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.",
      "enum": [
        "fresh",
        "fork"
      ]
    }
  },
  "required": [
    "name",
    "description",
    "prompt"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `team_task_create`

在共享 Team 任务板上创建一个无 owner 的 pending task。

```json
{
  "type": "object",
  "properties": {
    "subject": {
      "type": "string",
      "description": "Concise task title."
    },
    "description": {
      "type": "string",
      "description": "Complete task details and acceptance criteria."
    },
    "blocked_by": {
      "type": "array",
      "description": "Task ids that must complete first.",
      "items": {
        "type": "string"
      }
    },
    "write_scopes": {
      "type": "array",
      "description": "Advisory workspace-relative file or directory prefixes this task expects to modify.",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "subject",
    "description"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `team_task_get`

在修改或执行共享任务前，读取其完整的最新值。

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "string",
      "description": "Shared task id."
    }
  },
  "required": [
    "task_id"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `team_task_list`

列出共享任务，包括 readiness、owner、revision、blocker 与 write-scope warning。

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "description": "Optional exact status filter.",
      "enum": [
        "pending",
        "in_progress",
        "completed"
      ]
    },
    "owner": {
      "type": "string",
      "description": "Optional member-name filter; use unowned for tasks without an owner."
    },
    "ready": {
      "type": "boolean",
      "description": "Optional readiness filter."
    },
    "cursor": {
      "type": "integer",
      "description": "Zero-based result offset. Defaults to 0."
    },
    "limit": {
      "type": "integer",
      "description": "Number of rows, 1 through 100. Defaults to 50."
    }
  }
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `team_task_update`

使用 team_task_get 或 team_task_list 返回的最新 revision，对共享任务操作执行 compare-and-set。

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "string",
      "description": "Shared task id."
    },
    "expected_revision": {
      "type": "integer",
      "description": "Current task revision used as the CAS precondition."
    },
    "action": {
      "type": "string",
      "description": "Task transition to apply.",
      "enum": [
        "claim",
        "release",
        "edit",
        "set_dependencies",
        "complete",
        "reopen",
        "reassign",
        "delete"
      ]
    },
    "subject": {
      "type": "string",
      "description": "Replacement title for edit."
    },
    "description": {
      "type": "string",
      "description": "Replacement details for edit."
    },
    "blocked_by": {
      "type": "array",
      "description": "Complete blocker list for set_dependencies.",
      "items": {
        "type": "string"
      }
    },
    "write_scopes": {
      "type": "array",
      "description": "Replacement advisory write scopes for edit.",
      "items": {
        "type": "string"
      }
    },
    "owner": {
      "type": "string",
      "description": "Member name for Lead-only reassign; omit to unassign."
    }
  },
  "required": [
    "task_id",
    "expected_revision",
    "action"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

### `wait_agent`

等待本次调用开始后下一次 teammate 状态、mailbox 或共享任务变更。它绝不会唤醒 inactive member；若没有其他 member 正在 running 或 provisioning，则立即返回 noProgress。唤醒或超时后应重新列出状态，而不是轮询。

```json
{
  "type": "object",
  "properties": {
    "timeout_ms": {
      "type": "integer",
      "description": "Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000."
    }
  }
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

这 9 个工具限定于隐式 Team Lead 与持久 teammate 作用域。随产品发布的 dsh-base bundle 默认禁用该包；文档中的 Agent Teams profile patch 会启用它，并禁用旧 continuable child 的同名控制工具。

<a id="deepseek-aidsh-tool-todo"></a>

## `@deepseek-ai/dsh-tool-todo`

### `todo_write`

记录并更新当前工作的结构化任务列表。每次调用都要发送**完整列表**，它会**替换**之前的列表，不支持局部更新或逐项编辑。请用它规划多步骤工作并展示进度：开始前为每个具体步骤添加一项 todo。将当前正在处理的每项 todo 标记为 `in_progress`；确实并行运行时（例如并发 subagent 或后台命令）可同时标记多项，顺序工作则标记 1 项。只要工作尚未完成，就应至少有一项任务为 `in_progress`。某项 todo 完成后立即标记为 `completed`，不要批量标记完成；只有全部工作完成后，才可以没有 `in_progress` 项。简单的单步骤任务无需使用列表。状态：`pending`（未开始）、`in_progress`（正在处理）、`completed`（已完成）。

```json
{
  "type": "object",
  "properties": {
    "todos": {
      "type": "array",
      "description": "The COMPLETE task list, replacing any previous list.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "content": {
            "type": "string",
            "description": "What the task is — a short imperative line."
          },
          "status": {
            "type": "string",
            "description": "pending (not started) | in_progress (now) | completed (done).",
            "enum": [
              "pending",
              "in_progress",
              "completed"
            ]
          }
        },
        "required": [
          "content",
          "status"
        ]
      }
    }
  },
  "required": [
    "todos"
  ]
}
```

来源：[`packages/todo/tool-todo/src/index.ts`](../packages/todo/tool-todo/src/index.ts)

todo_write 是会话所有的状态；UI 将最新的 todo/write 事件渲染为检查清单。`allowParallelInProgress` 是没有默认值的必填项，因此本目录明确选择 `true`，对应描述允许同时存在多个 `in_progress` 项。选择 `false` 的部署会获得同一工具，但描述会要求只能有 1 个活动任务。

<a id="deepseek-aidsh-tool-workflow"></a>

## `@deepseek-ai/dsh-tool-workflow`

### `workflow`

运行用于大规模编排 subagent 的 JavaScript 工作流脚本。当工作会分散到许多相互独立的部分时，请使用此工具，例如审查大量文件、执行迁移、开展多角度研究或对发现进行对抗式验证；此时应将编排写成脚本，而不是逐轮委派。

工作流的身份通过 `meta` 参数以 JSON 形式传入：必填的 `name`（简短 kebab-case）和 `description` 字符串，以及可选的 `whenToUse` 字符串和 `phases` 数组（`{title, detail?, provider?, model?}`）。`script` 参数只能是纯 JavaScript **函数体**，不能是 TypeScript，也不能包含 `export const meta` 语句；meta 是参数而非代码。脚本支持顶层 await；请以 `return <value>` 结尾，该值必须可以 JSON 序列化，并作为此工具的结果。

脚本函数体提供以下钩子：
- `agent(prompt, opts?): Promise<any>`：运行一个 subagent 直至完成。不提供 `opts.schema` 时，解析为子级最终文本；提供 `opts.schema` 时，它必须是以对象为根、且**只能**使用 type/properties/required/additionalProperties/items/enum/const/oneOf 的 JSON Schema，不支持 pattern/format/数值边界，此时解析为通过校验的对象。子级失败时解析为 `null`，可使用 `.filter(Boolean)` 过滤。其他选项包括 `label`（显示名称）、`phase`（进度组），以及相互独立的 `provider`／`model` LLM（大语言模型）目标覆盖项，两者可单独提供。其他任何选项（`effort`／`isolation`／`agentType`）都会明确报错。
- `pipeline(items, ...stages): Promise<any[]>`：让每个条目分别经过各阶段，阶段之间**没有**屏障；多阶段工作优先使用它。每个阶段接收 `(prev, item, index)`。普通的阶段异常会将该**条目**变为 `null`，并跳过它的剩余阶段。
- `parallel(thunks): Promise<any[]>`：并发运行零参数函数并等待**全部**完成。它会形成屏障，仅当某个阶段确实需要汇总全部先前结果时使用。抛出异常的 thunk 解析为 `null`。
- `phase(title)`：开始一个进度阶段；`log(message)`：说明进度；`args`：工具调用的 `args` 输入，原样提供。

如果误用钩子（参数错误、未知选项、不受支持的 schema、触发上限），抛出的错误**总会**终止脚本，绝不会退化为单个条目的 `null`。

约束：并发上限和 agent 总数上限均会生效；不提供文件系统、网络、定时器或 Node.js API。具体工作由 agent 完成，脚本只负责编排。该运行在前台执行：整个脚本完成后，调用才会返回。

```json
{
  "type": "object",
  "properties": {
    "script": {
      "type": "string",
      "description": "The plain-JS workflow script body (top-level await allowed; NO `export const meta` statement; end with `return <json-value>`)."
    },
    "meta": {
      "type": "object",
      "description": "The workflow identity block (plain JSON — never code).",
      "additionalProperties": true,
      "properties": {
        "name": {
          "type": "string",
          "description": "Short kebab-case workflow name."
        },
        "description": {
          "type": "string",
          "description": "One-line description of what the workflow does."
        },
        "whenToUse": {
          "type": "string",
          "description": "Optional guidance on when this workflow applies."
        },
        "phases": {
          "type": "array",
          "description": "Optional phase declarations matched by phase() calls.",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "properties": {
              "title": {
                "type": "string",
                "description": "The phase title phase() calls match by exact string."
              },
              "detail": {
                "type": "string",
                "description": "Optional one-line description of the phase."
              },
              "provider": {
                "type": "string",
                "description": "Optional provider override this phase is expected to use."
              },
              "model": {
                "type": "string",
                "description": "Optional model override this phase is expected to use."
              }
            },
            "required": [
              "title"
            ]
          }
        }
      },
      "required": [
        "name",
        "description"
      ]
    },
    "args": {
      "type": "object",
      "description": "Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {\"files\": [...]}).",
      "additionalProperties": true
    }
  },
  "required": [
    "script",
    "meta"
  ]
}
```

来源：[`packages/workflow/tool-workflow/src/index.ts`](../packages/workflow/tool-workflow/src/index.ts)

<a id="deepseek-aidsh-tool-web"></a>

## `@deepseek-ai/dsh-tool-web`

### `web_fetch`

获取指定 HTTP(S) URL 的内容，并将其解码为文本后返回。

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "The HTTP(S) URL to fetch."
    }
  },
  "required": [
    "url"
  ]
}
```

来源：[`packages/web/tool-web/src/index.ts`](../packages/web/tool-web/src/index.ts)

### `web_search`

在 Web 上搜索最新信息。在必填的 `queries` 数组中提供 1–4 个查询。返回可选的摘要答案和来源 URL 列表。

```json
{
  "type": "object",
  "properties": {
    "queries": {
      "type": "array",
      "description": "Required search queries; accepts 1–4 items and merges their results.",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "queries"
  ]
}
```

来源：[`packages/web/tool-web/src/index.ts`](../packages/web/tool-web/src/index.ts)

web_search 和 web_fetch 将提供方选择置于 ctx.web 之后，使模型可见 schema 在更换后端时保持稳定。

<a id="deepseek-aidsh-cdp"></a>

## `@deepseek-ai/dsh-cdp`

### `cdp_captcha`

检测、驱动并读取第一方验证挑战。action "scan"（Katman A）为每个第一方候选分类（checkbox、滑块、图片选择、表单字段、延迟确认遮罩、多步链、帧内挑战、假成功诱饵、动态目标、可见蜜罐），并为每个候选附加深度 DOM 证据：getBoundingClientRect → scrollIntoView → 重新测量（FRESH）→ elementFromPoint 命中测试，外加覆盖层与陷阱清单以及第三方判定。action "drag"（Katman B）基于读取到的轨道几何（K4 接近路径、过冲＋回拉，mouseup 前重新测量一次）执行真实的 CDP 按下—移动—释放滑块手势，并通过回读值证明送达——已派发的手势绝不会被报告为成功。action "verify" 在一次调用中读取解题状态：aria-checked、data-solved/data-confirmed、滑块值与 data-target 的比对、徽章文本，以及页面自身的 wrongClick/decoy/honeypot 计数（页面未公布的计数器直接省略，绝不臆造）。第三方提供方（reCAPTCHA/hCaptcha/Turnstile/Cloudflare）会与候选一同报告（thirdParty.verdict），遍历继续处理同源候选。空扫描会带原因返回 candidates: []，绝不静默返回 []。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "scan = detect + deep DOM + third-party verdict; drag = human-like slider gesture; verify = read the solution state.",
      "enum": [
        "scan",
        "drag",
        "verify"
      ]
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to the active tab)."
    },
    "ref": {
      "type": "string",
      "description": "drag only: snapshot ref from cdp_snapshot addressing the slider."
    },
    "css": {
      "type": "string",
      "description": "drag only: CSS selector for the track (also used to pick the thumb)."
    },
    "ariaLabel": {
      "type": "string",
      "description": "drag only: match the aria-label attribute (normalized comparison)."
    },
    "role": {
      "type": "string",
      "description": "drag only: ARIA role to match (requires name)."
    },
    "name": {
      "type": "string",
      "description": "drag only: accessible name; only used together with role."
    },
    "text": {
      "type": "string",
      "description": "drag only: visible text resolved through the locator ladder."
    },
    "textMatch": {
      "type": "string",
      "description": "drag only: how text compares (default exact).",
      "enum": [
        "exact",
        "contains"
      ]
    },
    "nth": {
      "type": "integer",
      "description": "drag only: 0-based candidate index; required when more than one element matches."
    },
    "scope": {
      "type": "string",
      "description": "drag only: CSS selector bounding the whole search."
    },
    "thumbSelector": {
      "type": "string",
      "description": "drag only: explicit thumb selector inside the track (default: the first thumb-like child)."
    },
    "targetPct": {
      "type": "number",
      "description": "drag only: target percent 0..100; read from the track's data-target when omitted."
    },
    "steps": {
      "type": "integer",
      "description": "drag only: press-move-release sample count (clamped 4..200, default 24)."
    },
    "approach": {
      "type": "boolean",
      "description": "drag only: emit the K4 approach path before pressing (default true)."
    },
    "overshoot": {
      "type": "boolean",
      "description": "drag only: overshoot the target and pull back before releasing (default true)."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Re-probe window in ms; each action applies its own default when omitted."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_click`

在视口坐标上点击，使用逼真的类人指针运动与时序。plan08：传入快照 `ref` 而非 x/y，点击该元素的新鲜（FRESH）中心（在动作时解析；页面重渲染会返回 stale-ref，绝不会给出错误坐标）。

```json
{
  "type": "object",
  "properties": {
    "x": {
      "type": "number",
      "description": "X coordinate in CSS pixels (required together with y, unless ref is passed)."
    },
    "y": {
      "type": "number",
      "description": "Y coordinate in CSS pixels (required together with x, unless ref is passed)."
    },
    "ref": {
      "type": "string",
      "description": "Snapshot ref from cdp_snapshot; clicks that element’s fresh centre instead of x/y."
    },
    "css": {
      "type": "string",
      "description": "CSS selector; when any locator param is present, x/y are refused."
    },
    "ariaLabel": {
      "type": "string",
      "description": "Match the aria-label attribute (normalized comparison)."
    },
    "role": {
      "type": "string",
      "description": "ARIA role to match (requires name)."
    },
    "name": {
      "type": "string",
      "description": "Accessible name; only used together with role."
    },
    "text": {
      "type": "string",
      "description": "Visible text resolved through the ladder aria-label > role+name > tag+text > innerText."
    },
    "textMatch": {
      "type": "string",
      "description": "How text compares (default exact).",
      "enum": [
        "exact",
        "contains"
      ]
    },
    "nth": {
      "type": "integer",
      "description": "0-based candidate index; required when more than one element matches."
    },
    "scope": {
      "type": "string",
      "description": "CSS selector bounding the whole search."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Locator resolve budget in ms (default 5000, max 30000)."
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to active tab)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_contexts`

管理活动浏览器中的隔离浏览器上下文：列出上下文及其实时 target 数量、创建新上下文（独立的 cookie／存储，而不是第二个浏览器）、在其中打开标签页，或销毁某个上下文（关闭其标签页并清空其存储）。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "'list' (default), 'create', 'open', or 'dispose'."
    },
    "contextId": {
      "type": "string",
      "description": "Target context; required for 'open'/'dispose' unless the default context is meant (empty string)."
    },
    "url": {
      "type": "string",
      "description": "With action:'open', the initial URL of the new tab (required)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_dialog`

检查并应答 JavaScript 对话框（alert/confirm/prompt/beforeunload）。对话框挂起期间，页面级工具会以 dialog-open 被拒绝，直到你在这里接受或关闭它。使用 action:"policy" 可为会话自动应答后续对话框。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "'list' (default), 'accept', 'dismiss', or 'policy'."
    },
    "targetId": {
      "type": "string",
      "description": "Tab whose dialog to answer; required when several tabs have pending dialogs."
    },
    "promptText": {
      "type": "string",
      "description": "Reply sent when accepting a prompt dialog (defaults to the dialog's own defaultPrompt)."
    },
    "policy": {
      "type": "string",
      "description": "With action:'policy', the new auto-answer policy: 'none', 'accept', or 'dismiss'."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_download`

等待下一次浏览器下载完成，并报告它落在下载根目录内的位置。会把自动命名的文件重命名为其建议文件名；renameTo 目标已被占用是硬错误。

```json
{
  "type": "object",
  "properties": {
    "timeoutMs": {
      "type": "number",
      "description": "How long to wait for a download to begin (default 60000)."
    },
    "renameTo": {
      "type": "string",
      "description": "Explicit destination basename (must not already exist)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_endpoints`

发现并报告浏览器调试端点：探测每个已配置 loopback 端口的 /json/version，把应答与实时连接池合并，展示哪个端点处于活动状态、哪些已附加／停靠、重连后的 socket 健康状况，以及每个端点运行在哪个 profile 上（'assistant'、一次性 dsh-cdp-*，或对外来浏览器为 unknown）。

```json
{
  "type": "object",
  "properties": {
    "ports": {
      "type": "string",
      "description": "Comma-separated loopback ports to probe, e.g. \"9222,9333\" (default: configured discovery ports)."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Per-port probe timeout in milliseconds (default 500)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_eval`

在页面执行上下文中求值一段受限的 JavaScript 表达式。

```json
{
  "type": "object",
  "properties": {
    "expression": {
      "type": "string",
      "description": "JavaScript code to evaluate."
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to active tab)."
    }
  },
  "required": [
    "expression"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_exec`

在页面中运行一段 JavaScript 表达式，带强制错误 envelope、在脚本之后断言的可选后置条件、可选的 promise 等待，以及显式的“是否发生了任何事”标志。表达式抛出时绝不返回空结果。

```json
{
  "type": "object",
  "properties": {
    "expression": {
      "type": "string",
      "description": "JavaScript to evaluate in the page. May be an IIFE/statement block."
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to active tab)."
    },
    "awaitPromise": {
      "type": "boolean",
      "description": "Await a returned promise before reading the value (default false)."
    },
    "postCondition": {
      "type": "string",
      "description": "Expression evaluated AFTER the script; must be truthy to pass. Failure marks ok:false."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Bound for the whole call in milliseconds (default 15000 — doubled only for a CORROBORATED hidden tab, and the doubled bound comes back as effectiveTimeoutMs; max 60000). /* plan10-fix, plan15-hidden */"
    }
  },
  "required": [
    "expression"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_expect`

用 locator 断言页面条件：exists、visible、enabled、textEquals、textContains 或 urlMatches（页面 URL 正则，忽略 locator）。轮询直到通过或 timeoutMs 到期（默认 0 = 单次尝试）。断言失败返回 ok:false 以及原因＋候选——预期之内的失败是数据，不是错误。plan08：传入快照 `ref` 以断言那个确切元素（strategy 'ref'；页面重渲染会返回 stale-ref）。

```json
{
  "type": "object",
  "properties": {
    "check": {
      "type": "string",
      "description": "The assertion to run.",
      "enum": [
        "exists",
        "visible",
        "enabled",
        "textEquals",
        "textContains",
        "urlMatches"
      ]
    },
    "expected": {
      "type": "string",
      "description": "Required for textEquals/textContains (expected text) and urlMatches (a regex); ignored by the other checks."
    },
    "css": {
      "type": "string",
      "description": "CSS selector; bypasses the text ladder, matches within scope."
    },
    "ariaLabel": {
      "type": "string",
      "description": "Match the aria-label attribute (normalized comparison)."
    },
    "role": {
      "type": "string",
      "description": "ARIA role to match (requires name), e.g. button, link, textbox."
    },
    "name": {
      "type": "string",
      "description": "Accessible name; only used together with role."
    },
    "text": {
      "type": "string",
      "description": "Visible text resolved through the ladder aria-label > role+name > tag+text > innerText."
    },
    "textMatch": {
      "type": "string",
      "description": "How text compares (default exact).",
      "enum": [
        "exact",
        "contains"
      ]
    },
    "nth": {
      "type": "integer",
      "description": "0-based candidate index; REQUIRED when more than one element matches."
    },
    "scope": {
      "type": "string",
      "description": "CSS selector bounding the whole search."
    },
    "ref": {
      "type": "string",
      "description": "Snapshot ref from cdp_snapshot; asserts against that exact element (other locator params ignored)."
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to active tab)."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Poll until the assertion passes within this budget (default 0 = single attempt, max 30000)."
    }
  },
  "required": [
    "check"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_extract`

用 JSON 规格从当前页面抽取结构化数据——{"kind":"page"} 取页面字段（title/url/h1/lang/description/openDialog），{"kind":"list"} 取过滤后的集合（from: role/selector/ariaLabel/withinRole，where: nameMatches/visibleOnly，fields: name|role|value|text|href|checked|box|count|attr:<name>），{"kind":"field"} 取单个值。构造上即诚实：损坏的规格返回 ok:false ＋ error，空结果返回 data:[] ＋ missing，只要 missing/truncatedFields/limit 截断了答案，complete 就为 false。数据行在动作时重新测量。

```json
{
  "type": "object",
  "properties": {
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to the active tab)."
    },
    "spec": {
      "type": "string",
      "description": "JSON projection spec, e.g. {\"kind\":\"list\",\"from\":{\"role\":\"link\"},\"fields\":{\"name\":\"name\",\"href\":\"href\"},\"limit\":50}."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Wait window for the slice to appear (default 0 = single probe)."
    }
  },
  "required": [
    "spec"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_files`

限定在下载根目录内的文件操作：list、read、write、stat、delete、mkdir。逃出根目录的路径会被拒绝；读取有上限；写入绝不会在根目录之外创建目录。

```json
{
  "type": "object",
  "properties": {
    "op": {
      "type": "string",
      "description": "Operation: list, read, write, stat, delete, or mkdir."
    },
    "path": {
      "type": "string",
      "description": "Root-relative path; empty addresses the root (list/stat/delete only)."
    },
    "content": {
      "type": "string",
      "description": "Text to write (write only)."
    },
    "encoding": {
      "type": "string",
      "description": "utf8 (default) or base64 for read/write."
    },
    "overwrite": {
      "type": "boolean",
      "description": "Allow write to replace an existing file (default false → hard error)."
    },
    "recursive": {
      "type": "boolean",
      "description": "Allow delete to remove a directory tree (default false)."
    },
    "maxBytes": {
      "type": "number",
      "description": "Read byte budget (default and cap 4 MiB)."
    }
  },
  "required": [
    "op"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_fill`

通过 locator DSL 填写表单字段：解析元素（css > aria-label > role+name > text 阶梯），经由原生 value setter ＋ input/change 事件写入（对 React/Vue 安全），选中匹配的 <option>，或插入 contenteditable——然后回读值以证明写入生效。若框架回滚写入，会触发一次聚焦的 Input.insertText 后备（fallbackUsed:true）；第二次失败会报告期望值／实际值之差——绝不静默吞掉。文件输入会被拒绝。

```json
{
  "type": "object",
  "properties": {
    "css": {
      "type": "string",
      "description": "CSS selector; bypasses the text ladder, matches within scope."
    },
    "ariaLabel": {
      "type": "string",
      "description": "Match the aria-label attribute (normalized comparison)."
    },
    "role": {
      "type": "string",
      "description": "ARIA role to match (requires name), e.g. button, link, textbox."
    },
    "name": {
      "type": "string",
      "description": "Accessible name; only used together with role."
    },
    "text": {
      "type": "string",
      "description": "Visible text resolved through the ladder aria-label > role+name > tag+text > innerText."
    },
    "textMatch": {
      "type": "string",
      "description": "How text compares (default exact).",
      "enum": [
        "exact",
        "contains"
      ]
    },
    "nth": {
      "type": "integer",
      "description": "0-based candidate index; REQUIRED when more than one element matches."
    },
    "scope": {
      "type": "string",
      "description": "CSS selector bounding the whole search."
    },
    "value": {
      "type": "string",
      "description": "Value to write into the element."
    },
    "clear": {
      "type": "boolean",
      "description": "Replace the current value (default true); false appends."
    },
    "verify": {
      "type": "boolean",
      "description": "Read the value back after writing (default true)."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Resolve + write budget in ms (default 5000, max 30000)."
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to active tab)."
    }
  },
  "required": [
    "value"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_find`

按 ref/selector/aria-label/role/text 定位元素，并返回所选元素的 ref，附带新鲜的 rect 与可操作性（visible/inViewport/enabled/hitTarget）。诚实发现：0 个匹配会带原因返回 ok:false，而不是静默吞掉；多个匹配会返回候选＋警告（用 nth 选择）。矩形在动作时测量——绝不沿用更早快照中存下的值。

```json
{
  "type": "object",
  "properties": {
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to the active tab)."
    },
    "ref": {
      "type": "string",
      "description": "Exact snapshot reference to resolve (role|name|ordinal, #n-disambiguated)."
    },
    "selector": {
      "type": "string",
      "description": "CSS selector (scoped when scope is given)."
    },
    "css": {
      "type": "string",
      "description": "Alias of selector (same argument name as cdp_click/cdp_text)."
    },
    "ariaLabel": {
      "type": "string",
      "description": "Exact aria-label / accessible-name match."
    },
    "role": {
      "type": "string",
      "description": "ARIA role to match; combined with text/ariaLabel."
    },
    "text": {
      "type": "string",
      "description": "Accessible-name substring match (display-normalized, bidi-safe)."
    },
    "scope": {
      "type": "string",
      "description": "CSS selector limiting the search to one subtree."
    },
    "nth": {
      "type": "number",
      "description": "0-based candidate index (default 0)."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Re-probe window while waiting for the element (default 0 = single probe)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_fingerprint`

探测一次页面，报告浏览器叙事的一致程度：把 navigator 表面（webdriver、UA、platform、languages、UA-CH、plugins、screen 与 window 对比、chrome 附加项、fonts、connection、device 数值、自动化变量）与当前 stealth profile 对比，然后把每处差异分类为有序的 why-blocked 原因（A11：critical → low，每条都带 layer ＋ 证据）。仅做诊断——它分类页面为何会拒绝自动化；不改变任何页面状态。

```json
{
  "type": "object",
  "properties": {
    "targetId": {
      "type": "string",
      "description": "Page to probe; defaults to the active tab."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_locate`

回答“这一点上是什么？”——识别并描述 document.elementFromPoint(x,y)：tag/id/classes/role/ariaLabel/短文本、新鲜的视口 rect、是否可交互、inViewport、coveredBy（有东西压在其上时的遮挡者，字段名与含义同 cdp_find）、position/z-index，以及一条简短的祖先链（kapsam），指明该点所在的组件。这是探测（PROBE），绝不是点击：视觉循环是 cdp_screenshot（selector|clip ＋ rects:true ＋ annotate:true ＋ inline:true）→ 模型指定一个点 → cdp_locate(x,y) 核实那里是什么 → cdp_click(x,y)。把“看”与“做”分开，才让瞄错可以恢复：空点会返回 ok:false ＋ reason ＋ 带距离的 `nearest` 元素，于是模型自行纠正，而不是点进虚空。绝不臆造数据——某处没有元素是数据，不是异常。

```json
{
  "type": "object",
  "properties": {
    "x": {
      "type": "number",
      "description": "Viewport CSS x of the point (the coordinate cdp_click takes)."
    },
    "y": {
      "type": "number",
      "description": "Viewport CSS y of the point."
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to the active tab)."
    }
  },
  "required": [
    "x",
    "y"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_lock`

对一个标签页取得 TTL 租约，让并行自动化排队，而不是在同一页面上交错输入。租约会随 `lockedUntil` 到期而失效，无需任何计时器——被遗忘的锁绝不会越过其 TTL。lock-held 在返回内带 holder 与到期时间（是数据，不是错误）。

```json
{
  "type": "object",
  "properties": {
    "targetId": {
      "type": "string",
      "description": "Target id of the tab to lease (defaults to the active tab)."
    },
    "holder": {
      "type": "string",
      "description": "Who is taking the lease (e.g. the subagent id); echoed in lock-held answers. Defaults to \"session\"."
    },
    "ttlMs": {
      "type": "number",
      "description": "Lease lifetime in ms, clamped to 1000..300000 (default 60000)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_navigate`

把活动的或指定的浏览器标签页导航到某个 URL。

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Destination URL to navigate to."
    },
    "targetId": {
      "type": "string",
      "description": "Target id of tab to navigate (defaults to active tab)."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Maximum load wait timeout in milliseconds."
    }
  },
  "required": [
    "url"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_open`

通过 Chrome DevTools Protocol 打开或附加到一个 Chromium 浏览器实例。不带 endpoint/port 调用时，它首先扫描默认的 loopback 调试端口：若发现活动浏览器，会返回带发现表的 needsChoice，且不附加到任何东西，由用户来选（“9222 上那个 Google profile，还是新端口？”）。传入 switchTo/port/endpoint 可直接做出该决定，或传 profile:'assistant' 在 $DSH_HOME/profiles 下的持久已登录 profile 上启动（其会话在重启后依然存续）。

```json
{
  "type": "object",
  "properties": {
    "port": {
      "type": "number",
      "description": "Port of an already running remote debugging browser."
    },
    "headless": {
      "type": "boolean",
      "description": "Whether to launch headless when starting a new browser."
    },
    "executablePath": {
      "type": "string",
      "description": "Custom path to Chromium/Chrome/Edge executable."
    },
    "endpoint": {
      "type": "string",
      "description": "Explicit ws:// debugger URL; skips port discovery and launching."
    },
    "switchTo": {
      "type": "number",
      "description": "The chosen live port from a needsChoice table; switches to it explicitly."
    },
    "profile": {
      "type": "string",
      "description": "Named persistent profile under $DSH_HOME/profiles (e.g. 'assistant'); the signed-in session survives restarts."
    },
    "managed": {
      "type": "boolean",
      "description": "Launch on the DSH-owned pinned browser in $DSH_HOME/browser (strict: no system fall-back; a miss refuses honestly). Ignored when executablePath is given."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_pdftotext`

抽取页面正在展示的 PDF 中的文本：自动策略依次为 network → print → axtree（也可用 strategy 固定其一）。报告策略细节与诚实性注记；所有策略失败时汇总各自的原因。

```json
{
  "type": "object",
  "properties": {
    "strategy": {
      "type": "string",
      "description": "Pin one strategy: network, print, axtree, or auto (default)."
    },
    "maxChars": {
      "type": "number",
      "description": "Character budget (default 16000, cap 64000)."
    },
    "page": {
      "type": "number",
      "description": "Read exactly this page."
    },
    "pageFrom": {
      "type": "number",
      "description": "First page when continuing a window."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Per-strategy wall-clock budget (default 20000)."
    },
    "targetId": {
      "type": "string",
      "description": "Target id of the PDF tab (defaults to active tab)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_printpdf`

把当前页面打印为下载根目录内的 PDF（Page.printToPDF 往返）。返回保存路径、大小与页数；字节留在磁盘上。

```json
{
  "type": "object",
  "properties": {
    "format": {
      "type": "string",
      "description": "Paper format: A4, Letter, Legal, or Tabloid (default: CDP default)."
    },
    "landscape": {
      "type": "boolean",
      "description": "Landscape orientation."
    },
    "scale": {
      "type": "number",
      "description": "Paper scale 0.1..2.0."
    },
    "printBackground": {
      "type": "boolean",
      "description": "Include background graphics (default true)."
    },
    "pageRanges": {
      "type": "string",
      "description": "Page range such as \"1-3,5\"."
    },
    "targetId": {
      "type": "string",
      "description": "Target id of the tab to print (defaults to active tab)."
    },
    "saveTo": {
      "type": "string",
      "description": "Explicit destination filename inside the downloads root; hard-errors if it exists."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_profiles`

管理 $DSH_HOME/profiles 下持久已登录浏览器 profile 的命名清单与生命周期。action:"list"（默认）报告每个 profile 及其诚实的锁报告（locked、artifacts、pid），外加活动 profile 的标识；action:"stop" 结束活动会话——只有当是本服务启动了该浏览器时才终止其进程，并且绝不删除 profile（会话才是全部意义；锁状态从磁盘读取，绝不猜测）。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "'list' (default) or 'stop'."
    },
    "profile": {
      "type": "string",
      "description": "stop: the profile to stop; defaults to the active one. Refused in-band when it is not the active profile."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_readpdf`

从下载根目录读取 PDF，输出带页码标记、受预算约束的文本。支持 page/pageFrom 游标、pages 规格（"1-5"、"3,7"）、meta/forms/barcode 诚实性字段，以及对加密或纯图片文档的诚实报告。

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Root-relative PDF path inside the downloads root."
    },
    "page": {
      "type": "number",
      "description": "Read exactly this page (single-page mode; its own budget, cursor = next page)."
    },
    "pageFrom": {
      "type": "number",
      "description": "First page to read when continuing a previous window."
    },
    "pages": {
      "type": "string",
      "description": "Page list/range spec, e.g. \"1-5\" or \"3,7,9-12\"."
    },
    "maxChars": {
      "type": "number",
      "description": "Character budget for this call (default 16000, cap 64000)."
    },
    "includeMeta": {
      "type": "boolean",
      "description": "Skip /Info metadata parsing when false."
    }
  },
  "required": [
    "path"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_screenshot`

把截图捕获到文件：返回路径与解析出的尺寸，绝不返回原始二进制。可选 fullPage/clip/selector 捕获、jpeg 质量、小预算内的内联 base64，以及不依赖 DOM 的矩形图例／标注。

```json
{
  "type": "object",
  "properties": {
    "targetId": {
      "type": "string",
      "description": "Target id of the tab (defaults to active tab)."
    },
    "fullPage": {
      "type": "boolean",
      "description": "Capture the whole scrollable page instead of the viewport."
    },
    "format": {
      "type": "string",
      "description": "Image format: \"png\" (default) or \"jpeg\"."
    },
    "quality": {
      "type": "number",
      "description": "JPEG quality 0..100 (default 80; ignored for png)."
    },
    "clip": {
      "type": "object",
      "description": "Explicit CSS-pixel capture region {x, y, width, height, scale?}; overrides fullPage.",
      "additionalProperties": false,
      "properties": {
        "x": {
          "type": "number"
        },
        "y": {
          "type": "number"
        },
        "width": {
          "type": "number"
        },
        "height": {
          "type": "number"
        },
        "scale": {
          "type": "number"
        }
      }
    },
    "selector": {
      "type": "string",
      "description": "CSS selector; captures that element's bounding box (top document only)."
    },
    "saveTo": {
      "type": "string",
      "description": "Workspace-relative destination; defaults to screenshots/<timestamp>-<n>.<ext>."
    },
    "inline": {
      "type": "boolean",
      "description": "Also return the image as base64 when it fits inlineMaxBytes (default false)."
    },
    "inlineMaxBytes": {
      "type": "number",
      "description": "Inline budget in bytes (default 65536, capped at 65536)."
    },
    "rects": {
      "type": "boolean",
      "description": "Return snapshot box rects mapped onto image pixels with a coordinate legend."
    },
    "annotate": {
      "type": "boolean",
      "description": "Paint the legend rects onto the saved png after capture; the page DOM is never touched."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_scroll`

用类人滚轮事件、键盘翻页（PageUp/PageDown）或锚点／selector／边缘跳转滚动页面，并报告滚动后经核实的位置（scrollY、范围、边缘）。

```json
{
  "type": "object",
  "properties": {
    "deltaY": {
      "type": "number",
      "description": "Wheel delta in CSS px, positive = down (mode 'wheel')."
    },
    "deltaX": {
      "type": "number",
      "description": "Horizontal wheel delta in CSS px."
    },
    "mode": {
      "type": "string",
      "description": "wheel (default) | pagedown | pageup | top | bottom | anchor | selector."
    },
    "x": {
      "type": "number",
      "description": "Pointer X for wheel mode (default: viewport centre)."
    },
    "y": {
      "type": "number",
      "description": "Pointer Y for wheel mode (default: viewport centre)."
    },
    "selector": {
      "type": "string",
      "description": "CSS selector to scroll into view (mode 'selector')."
    },
    "anchor": {
      "type": "string",
      "description": "Element id or name to jump to (mode 'anchor')."
    },
    "smooth": {
      "type": "boolean",
      "description": "Use behavior:'smooth' for anchor/selector/top/bottom."
    },
    "repetitions": {
      "type": "number",
      "description": "Repeat the unit 1-20 times (default 1)."
    },
    "settleMs": {
      "type": "number",
      "description": "Wait 0-2000 ms after scrolling before reading the position."
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to the resolution policy)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_snapshot`

捕获当前页面的编织式 DOM 快照，带稳定的元素引用与包围盒。plan08：传入 `ref` 可额外用新文档核验该引用（stale-ref 会诚实返回，而不是信任一个旧 rect）。

```json
{
  "type": "object",
  "properties": {
    "targetId": {
      "type": "string",
      "description": "Target id of the tab (defaults to active tab)."
    },
    "ref": {
      "type": "string",
      "description": "Snapshot ref to verify in this call; adds ref/staleRef/refRect to the answer."
    },
    "interactive": {
      "type": "boolean",
      "description": "Keep only interactive entries (buttons, links, fields…); nodeCount stays the woven total."
    },
    "compact": {
      "type": "boolean",
      "description": "Clip names/values to 80 chars — smaller payload, identical refs."
    },
    "includeDiff": {
      "type": "boolean",
      "description": "Diff against the previous cdp_snapshot of the same target key: the nodes list narrows to what changed and a diff block carries the full delta (a rename shows as removed+added since the ref carries the name)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_status`

报告 CDP 浏览器控制扩展的状态：已安装 bundle 版本、活动浏览器 target、代理监听器状态、连接状态、当前 target、已知的打开标签页，以及一旦探测过就报告实时视口。在驱动浏览器之前调用它，检查扩展是否可用。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_stealth`

检查或切换同时驱动浏览器叙事每一层的 stealth profile——JS 补丁、User-Agent/Sec-CH-UA*/Accept-Language 头，以及启动标志（G9/G3/G4/G26 一致性）。action "status" 报告活动 profile、每个内置 profile、跨层一致性判定以及各层警告；action "apply" 激活某个 profile 并在页面上重新注册整套叙事（新建或刷新的文档会拾取它）。诊断与叙事维护：它让浏览器报告的表面与一套一致的叙事对齐，并报告差异。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "'status' (default), 'apply' (switch profile), or 'list' (profiles only, no page contact).",
      "enum": [
        "status",
        "apply",
        "list"
      ]
    },
    "profile": {
      "type": "string",
      "description": "Profile id (windows-chrome|macos-chrome|linux-chrome|windows-edge); required for action 'apply'."
    },
    "targetId": {
      "type": "string",
      "description": "Page session to register on; defaults to the active tab."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_tab_close`

带守卫地关闭浏览器标签页：关闭活动标签页需要显式 targetId（或 confirmActive:true），关闭最后一个剩余页面标签页需要 force:true。报告后继的活动标签页。

```json
{
  "type": "object",
  "properties": {
    "targetId": {
      "type": "string",
      "description": "Tab to close. Defaults to the active tab (guarded)."
    },
    "force": {
      "type": "boolean",
      "description": "Permit closing the last remaining page tab (default false)."
    },
    "confirmActive": {
      "type": "boolean",
      "description": "Required when targetId is omitted and it is the active tab."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_tab_focus`

聚焦（激活）某个浏览器标签页——这是显式切换“省略 targetId 的调用所解析到的那个”标签页的方式。它还会请浏览器把该标签页带到前台（activateBrowser:false 跳过这一步）。

```json
{
  "type": "object",
  "properties": {
    "targetId": {
      "type": "string",
      "description": "Tab to focus."
    },
    "activateBrowser": {
      "type": "boolean",
      "description": "Send Target.activateTarget to the real browser (default true)."
    }
  },
  "required": [
    "targetId"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_tab_new`

打开一个新的浏览器标签页（Target.createTarget）并报告其 id、url 与焦点。这是创建标签页唯一被认可的方式——解析绝不会静默地生出一个标签页。

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "URL to open. Defaults to about:blank."
    },
    "focus": {
      "type": "boolean",
      "description": "Activate the new tab after creating it (default true)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_tabs`

列出受控浏览器中打开的标签页与 target，并标记活动标签页。默认从浏览器刷新；可按类型或标题／url 子串过滤。

```json
{
  "type": "object",
  "properties": {
    "refresh": {
      "type": "boolean",
      "description": "Force a Target.getTargets round trip (default true)."
    },
    "type": {
      "type": "string",
      "description": "Filter rows by target type, e.g. 'page'."
    },
    "query": {
      "type": "string",
      "description": "Case-insensitive substring matched against title and url."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_text`

读取 locator 解析到的元素的可见文本，并断言该 locator 无歧义地解析成功。locator 优先级：css > aria-label > role+name > text（text 阶梯：aria-label、role+name、tag+text、innerText）。未找到、有歧义（多于 1 个匹配且未给 nth）以及隐藏元素都会连同原因＋候选证据失败——绝不返回猜来的元素。plan08：传入快照 `ref` 读取那个确切元素（strategy 'ref'；页面重渲染会返回 stale-ref，而不是猜一个匹配）。

```json
{
  "type": "object",
  "properties": {
    "css": {
      "type": "string",
      "description": "CSS selector; bypasses the text ladder, matches within scope."
    },
    "ariaLabel": {
      "type": "string",
      "description": "Match the aria-label attribute (normalized comparison)."
    },
    "role": {
      "type": "string",
      "description": "ARIA role to match (requires name), e.g. button, link, textbox."
    },
    "name": {
      "type": "string",
      "description": "Accessible name; only used together with role."
    },
    "text": {
      "type": "string",
      "description": "Visible text resolved through the ladder aria-label > role+name > tag+text > innerText."
    },
    "textMatch": {
      "type": "string",
      "description": "How text compares (default exact).",
      "enum": [
        "exact",
        "contains"
      ]
    },
    "nth": {
      "type": "integer",
      "description": "0-based candidate index; REQUIRED when more than one element matches."
    },
    "scope": {
      "type": "string",
      "description": "CSS selector bounding the whole search."
    },
    "ref": {
      "type": "string",
      "description": "Snapshot ref from cdp_snapshot; reads that exact element (other locator params ignored)."
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to active tab)."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Poll until resolved+visible within this budget (default 0 = single attempt, max 30000)."
    },
    "maxChars": {
      "type": "integer",
      "description": "Maximum characters of returned text (default 2000, max 4000)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_type`

以类人的节奏与字符延迟把文本输入到聚焦的页面元素中。plan08：传入快照 `ref` 可先聚焦该元素（在其新鲜中心点击，然后输入）。

```json
{
  "type": "object",
  "properties": {
    "text": {
      "type": "string",
      "description": "Text to type."
    },
    "ref": {
      "type": "string",
      "description": "Snapshot ref from cdp_snapshot; clicks that element’s fresh centre to focus it, then types."
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to active tab)."
    }
  },
  "required": [
    "text"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_unlock`

归还一个 cdp_lock 租约。传入 `holder` 时持有者必须匹配；未知或已释放的 id 在返回内带说明（重复解锁是数据，不是错误）。

```json
{
  "type": "object",
  "properties": {
    "lockId": {
      "type": "string",
      "description": "Lease id returned by cdp_lock."
    },
    "holder": {
      "type": "string",
      "description": "Unlocking owner; must match the lease holder when given."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_upload`

把宿主机上的绝对路径文件绑定到页面 file input（selector 模式）或打开中的文件选择器（chooser:true），随后校验 input.files。路径必须是绝对路径且位于允许的根内（工作目录、下载目录、已配置的 uploadRoots）；对话框挂起期间会以 dialog-open 拒绝。

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "description": "Absolute host paths to bind (max 10 per call).",
      "items": {
        "type": "string"
      }
    },
    "selector": {
      "type": "string",
      "description": "CSS selector of the file input (set mode; omit with chooser:true)."
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to active tab)."
    },
    "chooser": {
      "type": "boolean",
      "description": "Wait for an open file chooser instead of selecting by selector."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Chooser wait budget in milliseconds (500-30000, default 5000)."
    }
  },
  "required": [
    "files"
  ]
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_viewport`

读取或显式修改视口（Emulation.setDeviceMetricsOverride）。不带参数时只报告实时视口；width+height 设置它；reset 清除它。没有任何其他工具会改变视口。只有当页面自身的 resize 处理器可证明地运行过，变更才会被报告为已生效——否则返回 ok:false 及原因。appliedViewport 才是本次调用实际作用的对象。/* plan15-viewport */

```json
{
  "type": "object",
  "properties": {
    "width": {
      "type": "number",
      "description": "Viewport width in CSS pixels (16..10000, integer; requires height)."
    },
    "height": {
      "type": "number",
      "description": "Viewport height in CSS pixels (16..10000, integer; requires width)."
    },
    "deviceScaleFactor": {
      "type": "number",
      "description": "Device pixel ratio to emulate (default: keep the observed one)."
    },
    "mobile": {
      "type": "boolean",
      "description": "Whether to emulate a mobile (touch) viewport; default false."
    },
    "reset": {
      "type": "boolean",
      "description": "Clear the emulation override and restore the live window metrics."
    },
    "targetId": {
      "type": "string",
      "description": "Target id of the tab (defaults to active tab)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `cdp_wait`

等待页面条件：CSS selector、aria-label/text/visible 元素状态、network-idle（默认安静 500ms）、下一次导航，或 URL 正则模式。超时以返回内带方式给出（ok:false ＋ reason ＋ waitedMs），而不是抛出。strategy=text 等待与 text 参数匹配的可见文本（＋ textMatch），无需 selector。向后兼容：cdp_wait({selector}) 与从前一样等待 CSS 存在（默认超时 10000ms）。

```json
{
  "type": "object",
  "properties": {
    "selector": {
      "type": "string",
      "description": "Value for css/aria-label/visible strategies (css is the default); may also carry strategy=text for back-compat."
    },
    "strategy": {
      "type": "string",
      "description": "What to wait for: css, aria-label, text, visible, network-idle, navigation, url (default css; defaults to text when text is passed).",
      "enum": [
        "css",
        "aria-label",
        "text",
        "visible",
        "network-idle",
        "navigation",
        "url"
      ]
    },
    "text": {
      "type": "string",
      "description": "Expected visible text for strategy=text — works standalone, no selector required."
    },
    "textMatch": {
      "type": "string",
      "description": "How strategy=text compares the text (default exact).",
      "enum": [
        "exact",
        "contains"
      ]
    },
    "url": {
      "type": "string",
      "description": "Regex for strategy=url (the selector may carry it instead)."
    },
    "idleMs": {
      "type": "number",
      "description": "Quiet window for network-idle in milliseconds (default 500)."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Maximum wait timeout in milliseconds (default: 10000)."
    },
    "targetId": {
      "type": "string",
      "description": "Target id (defaults to active tab)."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `net_capture`

查询本地代理拦截到的 HTTP/HTTPS 网络交换。

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "number",
      "description": "Maximum number of exchanges to return (default 50)."
    },
    "host": {
      "type": "string",
      "description": "Filter captured requests by target host."
    }
  }
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

### `net_export`

从代理捕存中导出流量指标、主机分组与请求时间线。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/bundle/cdp/src/tools.ts`](../packages/bundle/cdp/src/tools.ts)

CDP bundle 在 `bundle/cdp` 叶子（位于 `tool-*` 完整性 glob 之外）下随包提供 36 个面向模型的工具（34 个 `cdp_*` 加 `net_capture`/`net_export`），并且只挂载在 webServer surface 上；skills 与 systemPrompt 注册是机会性注入，因此裸上下文启动仍能采集到全部 schema。`cdp_status` 反映已安装版本／target／代理与当前浏览器 profile；`cdp_open` 会先发现既有 endpoint，并在附加或启动前询问使用哪个 profile。`cdp_exec` 比 `cdp_eval` 更倾向于给出有保证的错误 envelope；`cdp_captcha` 检测、驱动并验证第一方挑战，绝不经手任何第三方提供方；stealth 工具加固客户端（检测姿态），并不绕过第三方 CAPTCHA 提供方。
