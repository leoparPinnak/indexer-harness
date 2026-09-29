# ui-context-control

## Summary

Composer context control: the context-occupancy ring with its per-session compaction trigger point, the `Sıkıştır` (compact now) action, and per-session compaction-mode settings (strategy, summarization model, budget, cap). It seats in ui-conversation's `conversation.input.context` and schedules no model requests.

Figures carry scope markers — green for session-only settings, blue for deployment-wide ones. The compaction-cap default is editable in General settings via this package's `settings.general.item` row (`compaction-basic.maxTokens`).

Occupancy and trigger come from the `contextPressure` and `compactionPolicy` Session projections; settings save via `session.setCompactionMode`, and the compact action submits `/compact` through `remote.commands`. Copy lives in the zh/en/tr locale dictionaries.

## Model Experience

### Compaction summarization, scheduled by this control

#### What the model sees

Nothing from this package directly: it renders Session projection values and submits durable intents. The dedicated-strategy setting routes future compaction summarization to the picked provider/model, and the compact action runs `/compact` now; the prompts those produce are pinned in `@deepseek-ai/dsh-compaction-basic`'s Model Experience.

#### Token effect

None of its own. The per-session budget and trigger point change where automatic compaction starts and what occupancy the meter reports as full, and therefore when `@deepseek-ai/dsh-compaction-basic` pays its summarization cost.

#### KV Cache effect

None of its own. Compaction's prefix-cache behavior is owned by `@deepseek-ai/dsh-compaction-basic`'s Model Experience.

## Known Limitations and Deferred Work

- The dedicated summarizer pickers offer the routable model catalog through `session.modelCatalog`; models known only to a provider's own listing are typed free-form in the same fields.
- The numeric budget and trigger fields accept raw token counts. A unit-shorthand input (300k) is deferred until the settings forms share one parser.

No runtime invariant companion is published: the package registers presentation only and owns no runtime relation independent of the projections and remotes it reads.
