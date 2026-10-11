---
name: self-improvement
description: >
  Self-repair and self-improvement loop: when a task exposes a GENUINE toolkit gap —
  the existing tools or skills cannot do the job and a better approach exists —
  improvise freely, build the missing capability as a Cordis plugin (plug-in,
  plug-out), and RECORD the episode as upgrade data for the harness developers.
  Use when a tool errors or falls short mid-task ("araç yetersiz kaldı", "no tool
  for this", "skill bunu kapsamıyor", "the tool can't"), when you decide to build
  or extend tooling to unblock work, or when you need the deficiency-report schema
  and store paths. The episode log is how this harness improves itself.
---

# Self-improvement loop — gaps become upgrade data

When work exposes a missing capability, three things happen **together**: the task
gets unblocked faster, the missing capability gets built as a first-class Cordis
plugin, and the episode gets recorded so the harness developers can turn it into
core. Skipping the record wastes the incident; the same gap will bite again.

This skill is the protocol. Plugin-authoring internals live in the
`cordis-plugin-development` skill; composition layout lives in
`editing-cordis-compositions`. This skill only defines **when**, **how freely**,
and **what gets written down**.

## When this loop triggers

Trigger only on a GENUINE gap. The bar is evidence, not inconvenience:

- A tool errors or returns what the task needs in a form you cannot use, and no
  flag/sequence makes it fit.
- No tool or skill covers the need at all, and the workaround you have is a
  manual procedure you have had to invent.
- A skill's guidance is wrong or stale for the current environment.

Do NOT trigger on: friction the existing tools absorb in one retry; preference
for a prettier path; anything solvable within the normal failure ladder. A
manufactured episode is worse than none — the developers train on this data.

## The loop

### 1. Prove the gap (before anything else)

Record while you work; you will need it verbatim later:

- **What you tried**: tool/skill name + exact call + its real output.
- **Why it cannot do the job**: the concrete shortfall (wrong output shape, missing
  primitive, broken assumption). One sentence per attempt.
- **What the task actually needs**: the primitive that is missing.

If you cannot fill this table honestly, the loop does not trigger. "Gerçekten
yetmedi" is a proven statement, never assumed.

### 2. Experiment freely

You are explicitly released from convention here: the goal is the best mechanism,
not the first plausible one.

- Run tests, spikes, throwaway scripts; compare approaches; measure.
- Fan out with subagents or a workflow for independent experiments; keep raw
  working files in a scratch area, never in shipped paths.
- The task's failure ladder (4 attempts) still bounds TASK work — but idea
  exploration is open-ended until one approach earns its way out.

### 3. Solve, and capture the directives

Whatever unblocks the task, transcribe it as an exact, replayable sequence:
commands with arguments, ordered steps, conditions. "Worked" is not a directive;
a directive replays on a cold machine.

### 4. Package the missing capability as a Cordis plugin

If the fix deserves a mechanism (not just one task's commands), build it
DSH-architecture-native — a Cordis plugin row, plug-in and plug-out:

- **Session prototype**: define and run a dynamic package for this session
  (`cordis_define` + `cordis_run`). It dies with the process — fine for proving
  behavior. Authoring pattern: `cordis-plugin-development`.
- **Durable**: author it as a composition — one directory per preset under the
  preset root (`editing-cordis-compositions`), or a row appended to an existing
  preset. Rules are theirs: a service a preset owns goes behind an `isolate`
  realm with every consumer; a host-consumed service stays out; validate with
  `standingKeyFor(id)` before handing off.
- **Trust line**: `cordis_mount` and dynamic plugins evaluate code against the
  live runtime — treat any session that authors them as shell access. Never
  weaken sandbox/approval rows to make a plugin "work".

Whatever the plugin is, **save its source as a file** even when session-scoped
(the process will erase the live one): `${DSH_HOME}/self-improvement/sources/`.
Durable composition files record their resolved path instead.

### 5. Record the episode (the non-negotiable step)

Append one JSON line to `${DSH_HOME:-~/.dsh}/self-improvement/episodes.jsonl`
(create the directory on first use) and write the readable twin
`self-improvement/episodes/<id>.md` containing the same content plus embedded
plugin code:

```json
{
  "schema": "dsh-selfimprovement.episode.v1",
  "id": "YYYYMMDD-<slug>-<n>",
  "ts": "<ISO 8601>",
  "workspace": "<path>",
  "model": "<provider/model>",
  "kind": "tool-gap | skill-gap | prompt-gap | workflow-gap",
  "task": { "goal": "...", "point": "the exact step where it bit" },
  "gap": {
    "evidence": [ { "attempt": "<tool/skill + exact call>", "result": "<real output>" } ],
    "why": "one tight paragraph: the concrete shortage",
    "refs": ["<files/urls the evidence lives in>"]
  },
  "fix": {
    "approach": "the better idea, one paragraph",
    "directives": ["<replayable step/command>", "..."],
    "proof": "how success was verified (effect read back, not claimed)"
  },
  "build": {
    "type": "none | session-plugin | composition | script",
    "id": "<plugin/tool id>",
    "source_path": "<absolute path of the saved source or composition>",
    "code": "<embedded source — mandatory when type is session-plugin or script>",
    "plug_notes": "rows/realms/services touched, standingKeyFor result",
    "core_candidate": true,
    "core_case": "why harness core should absorb this"
  }
}
```

Field disciplines:

- `gap.evidence` must contain real outputs. This is the developer team's ground
  truth; paraphrase-free.
- `fix.directives` must replay as written. Paste real commands, not descriptions.
- `build.code` is mandatory whenever the live artifact is perishable. A recorded
  path without embedded code is a dead artifact after restart.
- `core_candidate` is your engineering judgment: would this belong in core?
  Write the `core_case` like a promotion proposal in one or two sentences.
- Failures are episodes too: if the gap is real and nothing worked, log with
  `fix.approach: "none"` and the full attempt table — a proven dead end saves the
  developers a week.

### 6. Tell the operator

One short paragraph in the reply: what was missing, what you built (path), and
that the episode was logged. Offer the episode id. Then continue the task.

## Honesty rules (the whole value of the data)

1. **Proven, not assumed.** The gap table is the proof. No table, no episode.
2. **No vanity episodes.** Convenience wrappers are not gaps.
3. **Failures recorded.** Dead ends are half the dataset.
4. **The prompt is in scope.** If the shortfall was instructional (persona/skill
  text caused the wrong behavior), `kind: prompt-gap` and quote the offending
  line — that is exactly what the harness authors cannot see otherwise.

## How the developers consume it

`episodes.jsonl` is machine-shaped (stable `schema` field) so a collector can
aggregate across workspaces; `episodes/*.md` is the human review queue. A plugin
with `core_candidate: true` is a promotion candidate: the team copies the saved
source into a shipped package row and the episode id becomes provenance. Until
that day, your plugin keeps working for you as a plugged-in row — that is the
contract: you ship yourself the capability today, the log lets core take it
tomorrow.