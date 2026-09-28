# Protocol Core Architecture

The extension drives Chromium instances over raw WebSocket connections using the Chrome DevTools Protocol without Puppeteer or Playwright.

## Connection Lifecycle

The protocol client implemented in `packages/bundle/cdp/src/connection.ts` connects directly to a browser debugging WebSocket endpoint. It correlates commands and asynchronous replies by unique message ids and dispatches incoming events to session-scoped listeners.

## Target Registry

The target manager in `packages/bundle/cdp/src/targets.ts` tracks browser tabs, workers, and extensions. Each tab is attached via flattened target sessions and driven through `packages/bundle/cdp/src/page.ts`.

## See also

- [Guide Map](00-map.md#cdp-guide-map) — index of all available guides.
- [Input and Stealth](02-input-and-stealth.md#human-like-input-and-stealth) — driving pointer and keyboard input across sessions.
- [DOM and Evaluation](03-dom-and-eval.md#dom-weaving-and-script-evaluation) — reading page state and evaluating expressions.
- [Proxy and Network Analysis](04-proxy-and-analysis.md#proxy-interception-and-analysis) — the browser-side launch flags this transport hands over to, and the capture store that reports what the page then did.
- [Human Interaction](07-human-interaction.md#human-interaction-and-verification-challenges) — what a session on this transport is *for*: aiming, measuring, and the verification-challenge boundary.
- [Skill Architecture](10-skill-mimarisi.md#2-akiş-haritasi--14-iş-akışı) — which tools chain together to get a browser attached and talking (F1, F2, F3).
