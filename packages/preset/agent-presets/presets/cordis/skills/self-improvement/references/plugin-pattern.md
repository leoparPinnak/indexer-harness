# Episodic plugin pattern — session prototype vs durable composition

Companion to `self-improvement/SKILL.md` step 4. Plugin authoring APIs belong to
the `cordis-plugin-development` skill and composition layout to
`editing-cordis-compositions`; this file only covers the **episode-specific**
decisions: what shape the artifact takes, where its source is filed, and how the
record keeps it alive.

## Choosing the shape

| Situation | Shape | Lifetime | Record in episode |
|---|---|---|---|
| Proving behavior, one session | **session-plugin** (`cordis_define` + `cordis_run`) | dies with the process | `source_path` under `sources/` + full code embedded |
| Reused across sessions by you | **composition** (preset dir + row, or row appended to a preset) | until unmounted | resolved composition path + row id |
| Not worth a plugin at all | **script** (scratch or project tooling) | file lifetime | path + full code |
| Needed in every DSH install | session/composition **plus** `core_candidate: true` | — | `core_case` promotion argument |

Rules of thumb:

- Prototype in the session layer first; promote the winner, not every attempt.
- One plugin = one capability. Do not bundle episode odds and ends into a
  grab-bag plugin; the core team promotes by slicing.
- A plugin that publishes a service follows the composition realm rule
  (`editing-cordis-compositions`: isolate the provider and every consumer
  together). Mount-validate before recording `plug_notes`.

## Filing the source (perishable artifacts)

```
${DSH_HOME:-~/.dsh}/self-improvement/
├── episodes.jsonl            # append-only machine log
├── episodes/<id>.md          # human twin, embeds code
└── sources/<id>.mjs          # plugin/script source, even for session-plugins
```

A session-plugin without a saved source is gone at restart; the episode must be
self-sufficient: anyone on a cold machine should rebuild the exact plugin from
`episodes/<id>.md` alone.

## Minimal record example (trimmed)

```json
{
  "schema": "dsh-selfimprovement.episode.v1",
  "id": "20261001-bulk-md-stat-1",
  "ts": "2026-10-01T08:10:00+03:00",
  "workspace": "C:/work/proj",
  "model": "vendor/model-x",
  "kind": "tool-gap",
  "task": { "goal": "measure 21 markdown files", "point": "inventory step" },
  "gap": {
    "evidence": [
      { "attempt": "Get-ChildItem -Include *.md | Get-Content loops",
        "result": "timeout after 120s on large tree" }
    ],
    "why": "no streaming counter tool; per-file reads quadratic on big trees",
    "refs": ["<transcript or log path>"]
  },
  "fix": {
    "approach": "single-pass streaming counter as a defined tool",
    "directives": [
      "cordis_define: metric_probe plugin exposing count_md(paths)",
      "cordis_run",
      "count_md(['src','docs']) -> {files: 21, lines: 4727}"
    ],
    "proof": "result cross-checked against Get-Item sample of 3 files"
  },
  "build": {
    "type": "session-plugin",
    "id": "metric_probe",
    "source_path": "C:/Users/u/.dsh/self-improvement/sources/20261001-bulk-md-stat-1.mjs",
    "code": "<full source>",
    "plug_notes": "tools-registry only, no services, standingKeyFor not required (no rows shipped)",
    "core_candidate": true,
    "core_case": "bulk-metric probes recur in every audit episode; a core metric tool would remove the bootstrap entirely"
  }
}
```

Note the shape of `gap.evidence`: exact invocation and real output. That entry
is what makes the episode trainable data instead of an anecdote.