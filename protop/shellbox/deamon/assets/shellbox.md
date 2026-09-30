# Shellbox — the isolated private Windows desktop

Operate and troubleshoot the DSH Shellbox desktop: a private Win32 desktop streamed live into the Web GUI's right-sidebar "Shellbox" tab. This is the full manual; the `app:shellbox-surface` and `app:shellbox-changes` prompt sections and the `shellbox_launch`, `shellbox_state`, and `shellbox_input` tool descriptions carry only the short invariants.

## What it is (and what it is not)

- A private desktop created with the Win32 `CreateDesktop` API, running directly on the host machine. Names: `dsh-shellbox` for the default, `dsh-sb-<session>` per chat session (long session ids truncate at 16 characters, so the suffix carries a collision hash).
- NOT Windows Sandbox (the Hyper-V VM) and NOT the DSH file-permission sandbox — do not use those words for it.
- Fully authoritative inside the shellbox: window contents can be inspected and controlled, and mouse/keyboard input reaches the desktop through `shellbox_input`. The browser tab itself is view-only — it paints frames and never forwards pointer or keyboard input — and input reaches only the private desktop — the host desktop is not a target.
- Windows-only: the capture helper is a PowerShell script (`sandbox/sandbox-host.ps1`) driving GDI capture. On other platforms no desktop starts.

## Seeing the desktop

- The Daemon tab (right sidebar) opens one WebSocket to `GET /api/server/sandbox/ws?session=<id>` and paints one JPEG per binary message. A `ResizeObserver` reports the pane size through `POST /api/server/sandbox/size` (clamped 320x240..3840x2160).
- The body watches the one-second `GET /api/server/sandbox/status` poll: zero measured fps for four seconds rebuilds the socket with 1s..15s backoff; a recovered stream resets the ladder.
- Switching chat sessions re-targets the socket to that session's desktop. The view tracks the currently focused application window of the target desktop.
- `GET /api/server/sandbox/stream` is the legacy multipart face kept for debugging; the tab itself never uses it, and it holds connections open until the client leaves.

## Launching applications

Use the `shellbox_launch` tool (defaults to the current session's desktop):

- `command` (required): executable plus arguments, e.g. `notepad.exe`, `calc.exe`, `msedge.exe https://example.com`.
- `sessionId` / `instanceId`: target a specific session desktop or virtual-desktop instance.
- Hyper-V consoles: `shellbox_launch({ command: "vmconnect.exe localhost <VM>" })`.
- Console applications (cmd, powershell without a window, plain CLI tools) cannot attach their console window to the private desktop — they run but never appear. Launch a GUI application instead; for CLI work use the shell, not Shellbox.
- No GPU: there is no physical display and no hardware 3D acceleration. Never launch 3D games or emulators with `-gpu host`; use software rendering (`-gpu swiftshader`) or headless mode. Doing otherwise risks driver timeouts and process crashes.
- The same launch is reachable over HTTP for scripts: `POST /api/server/sandbox/launch` (alias `POST /api/server/shellbox/launch`) with `{"command": "..."}`.

## Reviewing changes and sending input

- Desktop changes (a window opened, closed, or renamed; a process starting) are committed to the session log. While some remain unreviewed, the `app:shellbox-changes` prompt line asks you to run `shellbox_state` before acting; a complete read clears it.
- `shellbox_state` (required `sessionId`): one page of changes since your last complete read (default 50, max 200). `hasMore: true` means more pages remain — read again until a complete page comes back. `instanceId` and `since` narrow or reposition the read; a stopped session returns `ok` with no changes and a status message.
- `shellbox_input` (required `sessionId`, `steps`): ordered input steps — `move` (x, y), `button` (b, p), `wheel` (dx, dy), `key` (vk, p), `char` (c code point) — delivered to that session's win32 desktop in order. The host desktop is not a target for these steps; with no desktop helper running the result reports that input needs a running win32 desktop.

## Instances and desktops

- One helper process per desktop; the first stream request starts it, `POST /api/server/sandbox/stop` ends it. Every viewer attaches to the running process.
- Virtual-desktop instances are listed by `GET /api/server/sandbox/instances?session=<id>`; create/attach/detach/terminate through the `instances/*` endpoints (the Shellbox dock and the Virtualization dashboard in the tab use them).
- Instance records persist in `$DSH_HOME/sandbox-instances.json` and survive restarts, so stale entries from earlier runs can appear in the list.
- A status request without `session` resolves to the default `dsh-shellbox` desktop.

## Known behaviors and limitations

These are current facts of the implementation:

- **Foreground is capture-order, not focus-granted.** The helper picks the most recently active visible window of the target desktop and re-fits it into the viewport with `MoveWindow`; it never calls `SetForegroundWindow`. Whichever window happened to be on top when the pick ran is what the stream shows.
- **The tab can show the wrong window** when instances from different sessions share the truncated desktop name, or when the viewer still paints frames captured for a previous target before the re-target lands. Re-open the tab or switch sessions again to re-bind.
- **Explorer shells are respawned** on helper start; the desktop may flicker before the application window appears.
- **Closing the view does not end the desktop** — after every viewer leaves the helper keeps running and capturing; it ends only through `POST /api/server/sandbox/stop`, an instance terminate, or a server shutdown.
- The capture helper and daemon are Windows/PowerShell components; the bundle's HTTP routes mount everywhere but only produce a stream on Windows.

## Security and ports

- The WebSocket handshake runs Connection's `requestRejection` Host/Origin fence first — same trust as every other `/api` route.
- The helper daemon binds loopback only (default port 4005, `DEAMON_PORT` to pin; falls back to an ephemeral port and publishes it in a discovery file under `$DSH_HOME`). It is not a public endpoint.

## Troubleshooting

1. **Wrong window or empty stream** — check `GET /api/server/sandbox/status` (`desktop`, `fps`, `instance`); re-target the session tab; stop the helper (`POST /api/server/sandbox/stop`) to rebuild the desktop cleanly.
2. **Stream dead, tab shows the load notice** — read status fps; four zero-seconds means the client is already reconnecting; a persistent zero means the helper exited (restart by opening the tab again).
3. **Application missing** — it was a console tool (invisible by design) or it opened on another desktop; check the instance list and switch.
4. **Port or discovery problems** — the daemon log line `deamon stdout:` in `$DSH_HOME/logs/dsh-web.log` carries the bound port and errors.

The wire format for every endpoint is documented in [`sandbox/PROTOCOL.md`](../../sandbox/PROTOCOL.md) inside this package.
