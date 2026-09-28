# Proxy Interception and Analysis

Local loopback proxy and certificate generation for HTTP and HTTPS inspection.

## Certificate Authority

The dynamic certificate generator in `packages/bundle/cdp/src/net/ca.ts` issues browser-scoped X.509 leaf certificates on demand, allowing the proxy in `packages/bundle/cdp/src/net/proxy.ts` to terminate TLS tunnels cleanly without modifying system trust stores.

## Traffic Redaction and Bounds

All intercepted requests and responses are recorded into the store in `packages/bundle/cdp/src/net/capture.ts`. Sensitive headers and query parameters are redacted at capture time, and memory usage is kept bounded by eviction policies.

## See also

- [Guide Map](00-map.md#cdp-guide-map) — index of extension documentation.
- [Protocol Core](01-protocol-core.md#protocol-core-architecture) — configuring browser proxy flags during launch.
- [Workflow Combos](05-workflow-combos.md#workflow-and-automation-combos) — integrating network verification into task execution.
- [Scraping Master](09-scraping-master.md#25-ağ-stealth-ve-doğrulama) — `net_capture`/`net_export` sözleşmeleri ve "veri DOM'da yok, ağda" reçetesi (F11).
- [Skill Architecture](10-skill-mimarisi.md#2-akiş-haritasi--14-iş-akışı) — when the data is on the wire rather than in the DOM (F11), and the download/PDF chain (F12).
