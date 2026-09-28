# CDP Guide Map

Central hub for the DeepSeek Harness Chrome DevTools Protocol extension.
The extension source is located in `packages/bundle/cdp`.

## Guide Network

- [Protocol Core](01-protocol-core.md#protocol-core-architecture) — raw WebSocket connection, target registry, and page session lifecycle in `packages/bundle/cdp/src/connection.ts`.
- [Input and Stealth](02-input-and-stealth.md#human-like-input-and-stealth) — Bézier mouse movement, natural typing cadence, and stealth patches in `packages/bundle/cdp/src/input.ts`.
- [DOM and Evaluation](03-dom-and-eval.md#dom-weaving-and-script-evaluation) — DOM snapshot weaving, stable element references, and bounded script evaluation in `packages/bundle/cdp/src/snapshot.ts`.
- [Proxy and Network Analysis](04-proxy-and-analysis.md#proxy-interception-and-analysis) — local MITM proxy, custom certificate authority, and capture store in `packages/bundle/cdp/src/net/proxy.ts`.
- [Workflow Combos](05-workflow-combos.md#workflow-and-automation-combos) — end-to-end task automation and browser worker orchestration in `packages/bundle/cdp/src/service.ts`.
- [Site Adapters](06-adapters.md#polymorphic-site-adapters) — polymorphic data-driven site profiles and semantic selectors in `packages/bundle/cdp/src/adapters.ts`.
- [Human Interaction and Verification Challenges](07-human-interaction.md#human-interaction-and-verification-challenges) — measure-before-you-click discipline, what the tools already guarantee, slider handling without a drag tool, and the first-party-only challenge boundary.
- [Web Scraping Mastery](09-scraping-master.md#web-kazıma-ustalığı--mevcut-araç-setinin-tam-kullanım-kılavuzu) — the full 36-tool inventory, evidence-learned rules, and proven recipes for single-page extraction, table diagnosis, multi-page loops, and completeness discipline.
- [Skill Architecture](10-skill-mimarisi.md#skill-mimarisi--ağ-haritası-akışlar-ve-polimorfizm) — the **network** itself: a 36-tool "what do I do next" table, 14 end-to-end flows (F1–F14), and 9 polymorphism clusters that say which path is preferred and when to switch.

## See also

- [Protocol Core](01-protocol-core.md#protocol-core-architecture) — low-level transport and session details.
- [Site Adapters](06-adapters.md#polymorphic-site-adapters) — specialized automation profiles.
- [Human Interaction](07-human-interaction.md#layer-c-verification-challenge-roles) — how to aim, approach, and report honestly.
- [Skill Architecture](10-skill-mimarisi.md#1-araç--sonraki-araç-3939) — start here when you know *what* to do but not *which chain* of tools gets you there.
