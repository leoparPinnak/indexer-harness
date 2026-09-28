# Workflow and Automation Combos

End-to-end task automation and browser worker orchestration patterns.

## Browser Worker Patterns

The coordinator service in `packages/bundle/cdp/src/service.ts` combines connection management, tab control, and snapshot weaving. Autonomous subagents use the tool definitions in `packages/bundle/cdp/src/tools.ts` to perform multi-step web workflows.

## Network and Interaction Combos

Automated workflows combine DOM navigation with network verification. Intercepted exchanges are validated against expected API payloads while human-like input operates page elements.

## See also

- [Guide Map](00-map.md#cdp-guide-map) — index of all available guides.
- [DOM and Evaluation](03-dom-and-eval.md#dom-weaving-and-script-evaluation) — snapshot and DOM interaction primitives.
- [Proxy and Network Analysis](04-proxy-and-analysis.md#proxy-interception-and-analysis) — inspecting traffic captured during workflow runs.
- [Site Adapters](06-adapters.md#polymorphic-site-adapters) — tailoring workflows to specific web platforms.
- [Scraping Master](09-scraping-master.md#4-reçeteler) — concrete, measured end-to-end recipes: pinning a target, a single-page pull, a paginated loop, a login wall, and a resumable ledger.
- [Skill Architecture](10-skill-mimarisi.md#2-akiş-haritasi--14-iş-akışı) — the 14 named end-to-end flows (F1–F14) this page describes in the abstract: which tool chain belongs to which job, in order.
