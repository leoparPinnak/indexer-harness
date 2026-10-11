# Sandbox view protocol

The contract between the Windows sandbox helper, the Web host bridge, and the
client tab. Frozen before either side was written; change it here first.

## Helper

`packages/bundle/deamon/sandbox/sandbox-host.ps1`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <path> -Stream -Width 800 -Height 600 -Fps 8
```

The helper creates a private Windows desktop named `-DesktopName` (default
`dsh-shellbox`), starts `explorer.exe` on it, and publishes the desktop:

| Channel | Content |
|---|---|
| stdout | **one base64 JPEG per line, nothing else** — a complete frame per line |
| stderr | diagnostics only (`desktop=…`, `natural=…`, `streaming …`, `viewport=…`, `shells-stopped=…`) |
| `-CommandFile` | the host writes `size <width> <height>\n`, `launch <command>\n`, or `quit\n`; the helper drains it once per frame |
| `-InputDir` | spool directory beside the command file: one uniquely named grammar file per input batch; the helper drains up to 8 files per frame |

The control channel is a file rather than stdin for two measured reasons.
`[Console]::In` is a synchronous reader in Windows PowerShell: `Peek()` blocks
until a line arrives, and even `ReadLineAsync()` runs synchronously, so an idle
stdin stalled the frame loop — the original "connected but no frames" bug. A
runspace does not inherit the pipe either, so a background reader saw nothing.

A command file is created before its bytes land, and the helper polls that path
every frame, so the host stages the write and renames it into place. The helper
must also read a full non-empty body before deleting the file; deleting a
half-written command loses it silently.

Input batches use the `-InputDir` spool instead of the single command file,
because input arrives at pointer speed and one replaceable slot would drop every
batch but the last. The host stages each batch as `<seq6>-<hex4>.cmd.tmp` and
renames it to `...cmd`, and the helper sorts by the zero-padded sequence,
reads one file completely before deleting it, and caps the drain at 8 files
per frame, so unique names make concurrent writers harmless.

Frames are composited at the tracked window's own size and scaled to the last
requested viewport.

**Every dimension in this protocol is physical pixels.** The helper calls
`SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` before it creates the
desktop, so one unit is one physical pixel in `GetWindowRect`, `MoveWindow`,
`CreateDIBSection`, and `PrintWindow` alike. A DPI-unaware helper sees virtualized
coordinates — half of the real ones on a 200% display — and then builds a canvas
that holds only part of a window, which presents as an oversized, clipped picture.
The panel therefore reports its CSS box times `devicePixelRatio`, and the same
multiplier is what keeps the picture at the display's real resolution.

**The subject is an application, not the desktop.** `PickApp` chooses the largest
visible window that is not shell furniture, a framework helper, or a sub-viewport
overlay, and the loop re-picks it every frame, so opening a browser, an emulator,
or a terminal inside the sandbox moves the picture to it. The desktop is only the
fallback for a sandbox with nothing open; a view of wallpaper and icons spends the
panel on furniture the user cannot act on.

**The tracked window is sized to the panel.** `Sync-TargetToViewport` resizes it
when the viewport changes and when a new window takes over, so the application
reflows into the panel's proportions. The captured picture is then the window's
own pixels at 1:1: no scaling loss, no letterbox, no distortion. A window that
refuses the size (a minimum-size dialog) reports its own extent, and the viewer
letterboxes it with `object-fit: contain`.

`-Launch <path>` starts one program on the sandbox desktop after the shell, which
is how an application is put in front of the view; mouse and keyboard input then
reach it through the grammar below.

Measured startup: the helper polls for the shell's own furniture (`Shell_TrayWnd`
or `Progman`) and streams as soon as it exists — **0.3 to 1 second** on a
3600x2400 desktop, against the fixed 8-second sleep it replaced, which also raced
on a slower desktop and produced an empty first frame. A viewer still shows a
starting state for the connect window rather than treating the silence as
failure. Measured throughput at 800x600: ~6 to 8 frames per second, ~60 to 72 KB
per JPEG. A `size` command is applied within one frame, and the helper logs
`viewport=WxH` on stderr so the change is attributable.

The helper never blocks on stdin, and a closed stdin must not end the stream.

Shutdown order matters twice over:

- The host must keep **draining stdout until the helper is gone**. Unhooking the
  stdout listener first fills the OS pipe, which blocks the helper mid-frame —
  and the command file is only polled between frames, so `quit` never lands.
- Closing the helper's own desktop handle does **not** destroy the desktop while
  the shell it started still holds one, so the helper terminates the shell first —
  found by owning `Shell_TrayWnd` or `Progman` — and the host's `quit` grace
  period must outlast that work.

## Input

One batch is one grammar file: plain lines, one command per line, processed in
order and clamped by the host before spooling (at most 64 events, coordinates
0..5120, key codes 1..254, character codes 0..65535):

| Line | Meaning |
|---|---|
| `input move <x> <y>` | pointer target in frame pixels; converted to a desktop point and cached |
| `input button <left\|right\|middle> <down\|up>` | mouse button at the last converted pointer point |
| `input wheel <dx> <dy>` | pre-converted wheel deltas posted at the last converted pointer point; no cached point drops the event |
| `input key <vk> <down\|up>` | virtual-key code |
| `input char <code>` | one UTF-16 code unit inserted exactly; a text control receives it through `EM_REPLACESEL` |
| `focus <hwnd>` | foreground a window already on this desktop |
| `wmclose <hwnd>` | post `WM_CLOSE` to a window already on this desktop |

Frame pixels invert through the contained-fit picture: `scale` is the smaller of
`viewportW/desktopW` and `viewportH/desktopH`, the offsets center that fit, and
points in the letterbox bars are dropped. The desktop side of the mapping is the
subject window's own rectangle (the desktop origin at 1:1 when the subject is the
desktop itself), in physical pixels like every other dimension here. No `size`
has arrived yet, or a point outside 0..5120, drops the event.

Delivery is `PostMessage`-family only, targeted at the window under the cached
pointer point, the subject window before any `move` has been converted, and
nothing when neither exists. `SendInput`, `keybd_event`, and `mouse_event` would
type into the user's real desktop instead of the private one and are never used.
Key events carry the latched scan code and extended flag; `WM_CHAR` is
synthesized through `ToUnicodeEx` over a persistent 256-key state array only
while no Ctrl, Alt, or Meta is held, so dead keys compose; named Enter and Tab
synthesize their control characters. Mouse move and button messages carry client
coordinates from `ScreenToClient`; both wheel messages carry the screen point
MSDN specifies for them. `focus` validates membership on this desktop before
`SetForegroundWindow`, falling back to `WMActivate` plus `SetWindowPos(HWND_TOP)`;
`wmclose` validates the same way.

Two measured limits shape this grammar. A text control inserts the characters
its own message loop derives from the posted `WM_KEYDOWN` and ignores an injected
`WM_CHAR`, so `input char` reaches a text control — class name containing `EDIT`,
tested ordinally — through `EM_REPLACESEL` and every other target through
`WM_CHAR`. `AttachThreadInput` is refused across desktops, so the helper cannot
seed the target thread's keyboard state: characters a target derives from key
events arrive unmodified, with no Shift, AltGr, or Caps Lock effect, and exact
text including case comes from `input char`.

Input is full remote control of the desktop. The routes refuse the host-desktop
session with 403, answer 409 while no helper runs, and reject malformed batches
with 400; `focus` and `close` carry the same statuses and a positive-integer
`hwnd`.

## State file

Beside the command file the helper writes `<commandFile>.state` at startup and
thereafter every 30 frames or 1000 ms, whichever comes first, staged as `.tmp`
and renamed so readers never observe a partial document:

```json
{"gen":0,"time":0,"subject":0,"windows":[{"hwnd":0,"pid":0,"title":"","exe":"","x":0,"y":0,"w":0,"h":0}]}
```

`gen` is monotonic within one helper run, `time` is epoch milliseconds, `subject`
is the tracked window (0 for the desktop fallback), and `windows` is the visible
top-level set in Z-order, topmost first, with the process image name cached per
pid and `""` once the process is gone. A reader treats a missing, unparsable, or
over-old (2000 ms) file as `fresh:false` rather than an error.

## Host routes

Registered in `packages/bundle/deamon/src/sandbox.ts` with `ctx.webServer.register`,
following the existing `/api/server/model-config` route; the WebSocket face is
added with `ctx.webServer.registerUpgrade`.

| Route | Method | Behaviour |
|---|---|---|
| `/api/server/sandbox/stream` | GET | Legacy face: starts the helper if needed, then streams `multipart/x-mixed-replace; boundary=frame`, one JPEG per part. Ends when the client disconnects. Kept for debugging and non-WebSocket consumers; the client tab uses `/ws`. |
| `/api/server/sandbox/ws` | WS upgrade | The frame feed the client tab consumes: each multipart part of the same source is reassembled and sent as **one binary message = one JPEG**. The handshake runs Connection's `requestRejection` Host/Origin trust first; a source failure closes the socket with 1013 (a reconnect may succeed) or 1011 (the source ended), and the viewer's retry ladder owns recovery. A viewer that stops keeping up loses frames instead of stalling the feed. |
| `/api/server/sandbox/size` | POST | Body `{ "width": <n>, "height": <n> }` in physical pixels, each from 1 through 5120. Writes `size <w> <h>` to the helper's command file. |
| `/api/server/sandbox/launch` | POST | Body `{ "command": <string> }`. Starts the helper if needed, then writes `launch <command>` to the helper's command file to start a GUI app on the private desktop. (Alias: `/api/server/shellbox/launch`) |
| `/api/server/sandbox/stop` | POST | Stops the helper and destroys the desktop. |
| `/api/server/sandbox/input` | POST | Body `{ "session": <key>, "instance": <id>?, "events": [<ShellboxInputEvent>] }`, at most 64 events; spools one grammar file. 400 malformed, 403 for the host-desktop session, 409 while no helper runs; success answers `{ "ok": true, "accepted": <n>, "delivered": true }`. |
| `/api/server/sandbox/windows` | GET | Reads the state file: `{ "ok": true, "active": <helper running>, "fresh": <state under 2000 ms old>, "windows": [...] }`. An unknown session answers `active:false`, not 404. |
| `/api/server/sandbox/windows/focus` | POST | Body `{ "session": <key>, "instance": <id>?, "hwnd": <positive int> }`; spools `focus <hwnd>`; success `{ "ok": true, "delivered": true }`; 400/403/409 as input. |
| `/api/server/sandbox/windows/close` | POST | Same body and statuses; spools `wmclose <hwnd>`. |
| `/api/server/sandbox/changes` | GET | Pure read over the change ring: `session`, `instance` (omit = every instance), `since` (exclusive, default 0), `limit` (1..500, default 50; outside = 400). Never advances a cursor; wrong method answers 405; an unknown session answers an empty inactive page. |

The bridge owns exactly one helper process. A second `GET /stream` or `WS /ws`
attaches to the running helper instead of starting another. A helper exit is
reported to the next request rather than swallowed.

Beside the routes the controller keeps a 500-entry change ring per bridge fed
by a one-second diff of the state file while the helper runs: window opened,
closed, title, and focused records, process started and exited records, and a
synthetic `desktop-reset` when a helper stops or settles. Ids come from one
process-wide counter, so `/changes` pages resume across restarts; entries below
`since` that the retention dropped surface as `truncated`. Every input, windows,
focus, close, and changes request marks its session touched, which is what lets
the model's next step pull unreviewed changes.

## Client tab

New package `packages/client/ui-sandbox-view`, modelled on the guide tab in
`packages/client/ui-sidebar-right/src/client/tabs/guide/`:

1. `ctx.sidebarRightTabs.register(definition)` — the tab type, stage one.
2. A registration into the keyed slot `sidebar.right.pane.tab` under the
   definition's `id` — the body, stage two.

The body opens `ws(s)://<host>/api/server/sandbox/ws`, paints each binary
message into the image by swapping the image's object URL, and keeps the pane
it always drew:

```tsx
<img src={frameUrl} alt="Sandbox" />
```

On pane resize it reports the pane's **physical** pixel size — the CSS box times
`devicePixelRatio` — with a debounced `POST /api/server/sandbox/size`, so the
helper composites at the display's real resolution and the picture needs no
upscaling on a scaled display.

A control toggle on the tab (off by default) sends input. Pointer, wheel, and
key events on the image map through the contained-fit picture back into frame
pixels — the same physical-pixel basis the `/size` report uses — points in the
letterbox bars drop, coordinates clamp to 0..5120, and requests batch over
`POST /api/server/sandbox/input`: moves coalesce on a ~40 ms timer, discrete
events flush ahead of the queue, and no request exceeds 60 events. Wheel input
first pushes a synthetic move so the helper has a current point, and
`deltaMode:1` deltas scale by 120. While the toggle is on, every keydown and
keyup calls `preventDefault()` and `stopPropagation()`, keeping the dock's
window-level Escape handler out of the desktop, printable characters rely on
the helper's `WM_CHAR` synthesis rather than client `char` events, and IME
composition suppresses keys until `compositionend` emits one `char` event per
UTF-16 unit. Blur, unmount, a session or instance switch, a toggle-off, and a
closed frame stream each release every pressed key and button first.

A processes widget beside the image lists the state file's windows with pid and
image name and offers focus, close, and refresh actions against the same
routes; an error state keeps a retry. A badge on the control counts changes the
tab has not surfaced yet — `max(0, ringCursor - lastSeenId)` from the pure
`/changes` probe — against a purely client-local cursor; the REST cursor is
ring-id only because the log's session sequence cannot cross the daemon split,
and clicking the badge advances it. Both surfaces reuse the tab's liquid-glass
styling through the shared alias tokens.

## Known limitations

### The taskbar renders black

The Windows 11 taskbar (`Shell_TrayWnd`) renders as a **uniform black rectangle**
on a private desktop. Tested and rejected:

| Attempt | Result |
|---|---|
| `PrintWindow` flags 0, 1, 2 | 0 lit pixels of 86,400 |
| `WM_PRINT` flags 0x3F, 0x1F, 0x0F, 0x04, 0x02 | uniform black |
| taskbar children (`Start`, `TrayNotifyWnd`, `ReBarWindow32`) | zero-sized, not laid out |
| `MSTaskSwWClass` / `MSTaskListWClass` | 146x40 fragment only |

The composited picture therefore contains the desktop and its application windows
but no taskbar. A shell-accurate view needs a real display, which means RDP
loopback rather than a private desktop.

Test lesson: a "pixels differ from the backdrop" counter cannot detect this,
because a uniform black fill also differs from a coloured backdrop. Save a PNG and
judge by its size — a blank 1800x48 capture compresses to ~555 bytes.

### A console application cannot live on the private desktop

Starting `powershell.exe` with `STARTUPINFO.lpDesktop` pointing at the sandbox
desktop and `CREATE_NEW_CONSOLE` produced no `ConsoleWindowClass` window there:
enumerating the sandbox desktop lists only the shell's own windows, while
`Default` gains a `PseudoConsoleWindow` for the client pid, and the visible
console appears on the user's screen. `conhost.exe` creates the console window on
the interactive desktop regardless of the client's `lpDesktop`, so the sandbox
cannot host a terminal by launching one. A terminal view needs a pseudo-console
whose output the viewer renders itself.
