# Polymorphic Site Adapters

Specialized interaction profiles for varied web applications.

## Adapter Architecture

The adapter framework implemented in `packages/bundle/cdp/src/adapters.ts` provides a data-driven mechanism to adapt automation to target web domains. Each adapter defines semantic selector maps and structured content extractors.

## Builtin Adapters

Pre-configured profiles support common platforms including GitHub, Wikipedia, and Hacker News, alongside a universal HTML5 fallback adapter that handles generic web pages.

## See also

- [Guide Map](00-map.md#cdp-guide-map) — index of all available guides.
- [Input and Stealth](02-input-and-stealth.md#human-like-input-and-stealth) — simulating natural user actions using adapter selectors.
- [DOM and Evaluation](03-dom-and-eval.md#dom-weaving-and-script-evaluation) — feeding snapshots into adapter extractors.
- [Workflow Combos](05-workflow-combos.md#workflow-and-automation-combos) — integrating site profiles into high-level workflows.
- [Scraping Master](09-scraping-master.md#22-okuma-ve-çıkarma--kazımanın-omurgası) — the generic extraction path a site profile has to beat, and the `cdp_extract` spec contract.
- [Skill Architecture](10-skill-mimarisi.md#35-veri-okuma--8-yol) — the 8 ways to read data out of a page, and when the generic path beats (or loses to) a site profile.
