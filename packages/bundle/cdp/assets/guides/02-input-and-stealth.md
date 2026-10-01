# Human-like Input and Stealth

Realistic user input simulation and anti-detection stealth patches.

## Bezier Movement and Jitter

The input engine in `packages/bundle/cdp/src/input.ts` translates pointer moves into quadratic Bézier curves with randomized jitter and easing. Key events model human typing cadence with inter-character delays and modifier chords.

## Stealth Patches

The script generator in `packages/bundle/cdp/src/stealth.ts` injects evaluation scripts before document scripts execute, masking automation indicators such as `navigator.webdriver`, plugins, mime types, and WebGL renderer signatures.

## See also

- [Guide Map](00-map.md#cdp-guide-map) — index of all available guides.
- [Protocol Core](01-protocol-core.md#protocol-core-architecture) — transport layer dispatching input commands.
- [DOM and Evaluation](03-dom-and-eval.md#dom-weaving-and-script-evaluation) — locating elements before dispatching clicks.
- [Site Adapters](06-adapters.md#polymorphic-site-adapters) — applying site-specific interaction strategies.
- [Human Interaction](07-human-interaction.md#human-interaction-and-verification-challenges) — the full measuring discipline these input primitives serve, and the slider protocol.
- [Scraping Master](09-scraping-master.md#23-girdi-ve-etkileşim) — when to reach for `cdp_fill` instead of these keystroke primitives, and why that is almost always.
- [Skill Architecture](10-skill-mimarisi.md#31-bir-öğeyi-bulma--9-yol) — the 9 ways to address an element, and when each beats the others; plus the `fingerprint` → `stealth` → retry order (F13).
- [Derin Tarama](11-derin-tarama.md) — yazım bütçesi gerçeği (buradaki gecikme tablolarının sınır bilgisi), sahte tık kanunu ve gölge körü merdiven: bu üç tuzak senin primitiflerini kullanırken en sık yakalananlar.
