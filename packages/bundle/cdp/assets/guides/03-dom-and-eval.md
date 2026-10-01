# DOM Weaving and Script Evaluation

Page state inspection, structural accessibility weaving, and bounded JavaScript execution.

## Stable Reference System

The DOM weaver in `packages/bundle/cdp/src/snapshot.ts` merges protocol accessibility trees and box models into a clean, hierarchical representation. Element references follow structural paths that remain stable across dynamic document updates.

## Bounded Evaluation

Page script evaluation managed by `packages/bundle/cdp/src/page.ts` enforces strict character and execution time bounds, returning sanitized values without risk of process exhaustion.

## When the DOM has no name for it: the point probe

Structural queries need a query. Canvas charts, icon-only controls, shadow-DOM
widgets and custom grids often have none that survives a `cdp_find`. When the
document cannot answer, **do not write a script to guess a selector — look at
the picture and prove the point against the DOM:**

```
1) cdp_screenshot({ selector|clip, rects: true, annotate: true, inline: true })
      → the image, plus the boxes mapped onto it
2) the model names a point (image pixels; convert with the reported deviceScaleFactor)
3) cdp_locate({ x, y })  → orada ne var? tag/id/role/text/coveredBy/ancestry
4) cdp_click({ x, y })   → only after the verification passed
```

**Görselde gördüğünü yazma; `cdp_locate` ile ne olduğunu doğrula, sonra tıkla.**
**Doğrulama geçmeden tıklama — bu, sessiz başarı sınıfının kapatılmasıdır.**

`cdp_locate` (`packages/bundle/cdp/src/locate.ts`) runs
`document.elementFromPoint(x, y)` and describes the node: `tag`, `id`, `classes`,
`role`, `ariaLabel`, short `text`, a fresh `rect`, `interactive`, `inViewport`,
`coveredBy`, `position`/`zIndex`, and a short `ancestry` chain naming the
component the point sits in. The two axes that turn a click into a silent no-op —
`coveredBy` and `inViewport` — carry **the same names and the same meaning as
`cdp_find`**, because both tools call one shared rule.

It is a **probe, not a click**: the loop is deliberately two-step so a wrong aim
costs one cheap read-back instead of an irreversible click. A point with no
element is data, not an exception — `ok:false` + `no element at (x,y)` + a
`nearest` element with its distance, so the model corrects itself. A point that
resolves to an element found only by its box answers `ok:true` with
`inViewport:false` and says so, instead of pretending a hit test happened.

## See also

- [Guide Map](00-map.md#cdp-guide-map) — index of all available guides.
- [Protocol Core](01-protocol-core.md#protocol-core-architecture) — executing DOM queries over active sessions.
- [Input and Stealth](02-input-and-stealth.md#human-like-input-and-stealth) — interacting with resolved element references.
- [Human Interaction](07-human-interaction.md#human-interaction-and-verification-challenges) — measuring discipline, the visual loop, sliders, and the verification-challenge boundary.
- [Site Adapters](06-adapters.md#polymorphic-site-adapters) — structured data extraction using semantic selectors.
- [Workflow Combos](05-workflow-combos.md#workflow-and-automation-combos) — how snapshot weaving and bounded evaluation are composed into end-to-end jobs.
- [Scraping Master](09-scraping-master.md#22-okuma-ve-çıkarma--kazımanın-omurgası) — `cdp_snapshot`/`cdp_eval`/`cdp_extract`/`cdp_exec` sözleşmeleri ve 17 kanıtlı kural.
- [Skill Architecture](10-skill-mimarisi.md#31-bir-öğeyi-bulma--9-yol) — snapshot ref, `cdp_find` ve görsel döngü arasındaki **geçiş kuralları** (`10-skill-mimarisi.md` §3.1).
- [Derin Tarama](11-derin-tarama.md) — merdivenin gölge körü oluşu (`pierceShadow`) ve atomik bul-ölç-tık: bu probun gördüğü boşluğun nasıl kapatılacağı.
