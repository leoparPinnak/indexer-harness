<#
Sandbox host helper: own a private Windows desktop running a shell, and emit its
picture.

The private desktop has no display surface, so the screen cannot be BitBlt'd.
This composites instead: every visible top-level window on that desktop is asked
to render itself with PrintWindow, and each result is blitted onto one canvas in
painting order. The canvas is what a viewer sees.

Modes:
  -CaptureOnce -Out <png>            one composite frame, for testing
  -Stream -Width <n> -Height <n>     base64 JPEG frames, one per line, on stdout

The process becomes per-monitor DPI aware at startup, so `-Width`/`-Height` and
every `size` command are PHYSICAL pixels: the panel sends its CSS box multiplied
by `devicePixelRatio`, which keeps the picture at the display's real resolution.
Before that call an unaware process halved every coordinate on a scaled display
and could capture only part of a window.

Control channel: `-CommandFile <path>`. Each frame the helper polls that file,
handles every line it contains, and deletes it. `size <w> <h>` changes the
viewport; `quit` shuts down. A file is used instead of stdin because
`[Console]::In` is a synchronous reader in Windows PowerShell: `Peek()` blocks
until a line arrives and even `ReadLineAsync()` runs synchronously, so an idle
stdin stalled the frame loop, and a runspace does not inherit the pipe at all.

Input channel: `-InputDir <path>`. Input batches arrive as individually named
files (`<seq6>-<hex4>.cmd`, staged as .tmp and renamed by the host) instead of
the single replaceable command file, because input runs at pointer speed and one
slot would drop every batch but the last. The helper sorts by name, reads one
file completely before deleting it, and drains at most 8 files per frame. All
command lines are ASCII; non-ASCII never crosses this channel.

Input modes: delivery is `PostMessage`-family by default (a private desktop has
no input surface, so posted messages are the only measured path that reaches
its windows). The opt-in grammar line `input mode send` switches the batch to
real input synthesis (`SendInput`/`SetCursorPos`), and the helper injects only
while the session's input desktop IS this sandbox desktop (otherwise the
events would land on the user's real desktop) and only from a worker thread
bound to that desktop with `SetThreadDesktop` (measured: `SendInput` from any
other desktop's thread returns zero events). A refused gate drops the batch's
send lines and reports once on stderr. Every batch starts back in `post` mode.

Accessibility: `uia <hwnd> [max]` (command file or input spool) writes
`<commandFile>.uia` — a bounded JSON read of that window's accessibility tree
(control type, name, value, bounds, enabled/offscreen, per-node hwnd), capped
at 256 nodes, for `GET/POST /api/server/sandbox/uia`. `-UiaOnce -UiaHwnd <n>`
prints the same document for one existing window and exits, without creating a
desktop or a shell.

Run it through the agent's PowerShell interpreter:
  powershell -NoProfile -ExecutionPolicy Bypass -File sandbox-host.ps1 -CaptureOnce -Out frame.png
#>

param(
  [switch]$CaptureOnce,
  [switch]$Stream,
  [string]$Out,
  [int]$Width = 1024,
  [int]$Height = 720,
  [string]$DesktopName = "dsh-shellbox",
  [int]$Fps = 30,
  [int]$Quality = 88,
  [string]$CommandFile = '',
  [string]$InputDir = '',
  [string]$Launch = '',
  [int]$ShellWaitSeconds = 20,
  [switch]$KillShellsOnExit,
  [switch]$UiaOnce,
  [int]$UiaHwnd = 0,
  [int]$UiaMax = 128
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# UIA client: the managed wrapper over the UIAutomationCore COM surface
# (IUIAutomation), so no compiled component and no additional interop layer.
Add-Type -AssemblyName UIAutomationClient
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Threading;
public class Sandbox {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct SI { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;
    public short wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr hProcess,hThread; public int dwProcessId,dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct BMIH { public uint biSize; public int biWidth,biHeight;
    public ushort biPlanes,biBitCount; public uint biCompression,biSizeImage; public int biXPelsPerMeter,biYPelsPerMeter;
    public uint biClrUsed,biClrImportant; }
  [StructLayout(LayoutKind.Sequential)] public struct BMI { public BMIH h; public uint c1,c2,c3; }
  public delegate bool EP(IntPtr h, IntPtr l);

  public const int SRCCOPY = 0x00CC0020;

  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CreateDesktopW")]
  public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr sa);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr h, EP cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inh, uint fl, IntPtr env, string cwd, ref SI si, out PI pi);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, out int size);

  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr dc, ref BMI b, uint u, out IntPtr bits, IntPtr s, uint o);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d,int x,int y,int w,int h,IntPtr s,int sx,int sy,int rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [DllImport("user32.dll")] public static extern int FillRect(IntPtr dc, ref RECT r, IntPtr brush);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateSolidBrush(uint color);
  // Capture fallbacks for the DComp-painted taskbar: a window DC BitBlt where
  // PrintWindow paints uniformly black, and a forced repaint before retrying.
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetDCEx(IntPtr h, IntPtr rgn, uint flags);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] public static extern bool InvalidateRect(IntPtr h, IntPtr r, bool erase);
  [DllImport("user32.dll")] public static extern bool UpdateWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  /**
   * Become per-monitor DPI aware before any window or device context exists.
   *
   * A DPI-unaware process sees virtualized coordinates: on a 200% display the
   * desktop reports half its real size, so `GetWindowRect` halves every window
   * rectangle while `PrintWindow` still paints the window at its real pixel
   * size. The canvas built from the halved rectangle then holds only part of
   * the window, and every dimension the viewer asks for is half of what it
   * means. Awareness makes one unit mean one physical pixel everywhere, which
   * is also what keeps the picture sharp on a scaled display.
   */
  public static string BeDpiAware() {
    if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2";
    if (SetProcessDPIAware()) return "system";
    return "unaware";
  }

  public static string Cls(IntPtr h){ var sb=new StringBuilder(200); GetClassName(h,sb,200); return sb.ToString(); }
  /** Ordinal class test: a Turkish-Culture -match would misread 'Edit' against 'EDIT'. */
  public static bool IsTextControl(IntPtr h) { return Cls(h).IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) >= 0; }
  public static string T(IntPtr h){ var sb=new StringBuilder(300); GetWindowText(h,sb,300); return sb.ToString(); }

  public static IntPtr CreateDesktopOwned(string name) {
    return CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, 0x000F01FF, IntPtr.Zero);
  }

  public static string Spawn(string exe, string cmd, string desktop) {
    var si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); si.lpDesktop = desktop;
    PI pi;
    return CreateProcess(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi)
      ? "ok:" + pi.dwProcessId : "failed:" + Marshal.GetLastWin32Error();
  }

  public static string SpawnCmd(string cmd, string desktop) {
    var si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); si.lpDesktop = desktop;
    PI pi;
    return CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi)
      ? "ok:" + pi.dwProcessId : "failed:" + Marshal.GetLastWin32Error();
  }

  public class Win { public IntPtr H; public int X, Y, W, Ht; public string Cls; public string Title; }

  static Dictionary<uint, string> exeNames = new Dictionary<uint, string>();

  /** Image file name of a process, cached per pid; "" once the process is gone. */
  public static string ExeName(uint pid) {
    string cached;
    if (exeNames.TryGetValue(pid, out cached)) return cached;
    string name = "";
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h != IntPtr.Zero) {
      var sb = new StringBuilder(600);
      int size = sb.Capacity;
      if (QueryFullProcessImageNameW(h, 0, sb, out size)) {
        name = sb.ToString();
        int cut = name.LastIndexOf('\\');
        if (cut >= 0) name = name.Substring(cut + 1);
      }
      CloseHandle(h);
    }
    exeNames[pid] = name;
    return name;
  }

  /** A JSON string body: quotes, backslashes, and control characters escaped. */
  static string J(string s) {
    if (s == null) return "";
    var b = new StringBuilder(s.Length + 8);
    foreach (char c in s) {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.ToString();
  }

  /**
   * One state document: the visible top-level windows of the desktop in
   * top-to-bottom Z-order, with the tracked subject and a monotonic generation.
   * The reader uses it to react to desktop changes without parsing frames.
   */
  public static string StateJson(IntPtr desk, IntPtr subject, int gen, long time) {
    var b = new StringBuilder(4096);
    b.Append("{\"gen\":").Append(gen).Append(",\"time\":").Append(time)
      .Append(",\"subject\":").Append(subject.ToInt64()).Append(",\"windows\":[");
    bool first = true;
    EnumDesktopWindows(desk, delegate(IntPtr w, IntPtr l) {
      if (!IsWindowVisible(w)) return true;
      RECT r; if (!GetWindowRect(w, out r)) return true;
      uint pid; GetWindowThreadProcessId(w, out pid);
      if (!first) b.Append(",");
      first = false;
      b.Append("{\"hwnd\":").Append(w.ToInt64())
        .Append(",\"pid\":").Append(pid)
        .Append(",\"title\":\"").Append(J(T(w)))
        .Append("\",\"exe\":\"").Append(J(ExeName(pid)))
        .Append("\",\"x\":").Append(r.L).Append(",\"y\":").Append(r.T)
        .Append(",\"w\":").Append(r.R - r.L).Append(",\"h\":").Append(r.B - r.T).Append("}");
      return true; }, IntPtr.Zero);
    b.Append("]}");
    return b.ToString();
  }

  /** Visible top-level windows, background first: biggest area paints first, the taskbar last. */
  public static List<Win> Layer(IntPtr desk) {
    var list = new List<Win>();
    EnumDesktopWindows(desk, delegate(IntPtr w, IntPtr l) {
      if (!IsWindowVisible(w)) return true;
      RECT r; if (!GetWindowRect(w, out r)) return true;
      int ww = r.R-r.L, hh = r.B-r.T;
      if (ww <= 4 || hh <= 4) return true;
      var win = new Win(); win.H = w; win.X = r.L; win.Y = r.T; win.W = ww; win.Ht = hh;
      win.Cls = Cls(w); win.Title = T(w);
      list.Add(win);
      return true; }, IntPtr.Zero);
    // Background first (large windows), foreground last; the taskbar paints last of all.
    list.Sort(delegate(Win a, Win b) {
      bool ta = a.Cls == "Shell_TrayWnd" || a.Cls == "Shell_SecondaryTrayWnd";
      bool tb = b.Cls == "Shell_TrayWnd" || b.Cls == "Shell_SecondaryTrayWnd";
      if (ta != tb) return ta ? 1 : -1;
      return (b.W * b.Ht).CompareTo(a.W * a.Ht);
    });
    return list;
  }

  /**
   * Whether the shell has finished building its desktop. `Shell_TrayWnd` or
   * `Progman` existing is the readiness signal: waiting for an application
   * window instead would spend the whole budget on a desktop whose shell opens
   * no folder window at all.
   */
  public static bool ShellReady(IntPtr desk) {
    bool ready = false;
    EnumDesktopWindows(desk, delegate(IntPtr w, IntPtr l) {
      var c = Cls(w);
      if (c == "Shell_TrayWnd" || c == "Progman") { ready = true; return false; }
      return true; }, IntPtr.Zero);
    return ready;
  }

  /**
   * Processes holding the shell windows of one desktop. Closing the helper's
   * desktop handle is not enough to destroy the desktop: the shell it started
   * keeps its own handle, so the desktop outlives the helper until the shell
   * dies. The returned ids are the ones to terminate on shutdown.
   */
  public static List<int> ShellPids(IntPtr desk) {
    var pids = new List<int>();
    EnumDesktopWindows(desk, delegate(IntPtr w, IntPtr l) {
      var c = Cls(w);
      if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Progman") {
        uint pid; GetWindowThreadProcessId(w, out pid);
        if (pid != 0 && !pids.Contains((int)pid)) pids.Add((int)pid);
      }
      return true; }, IntPtr.Zero);
    return pids;
  }

  /**
   * All processes holding any window on this desktop. Terminates child applications
   * and shell instances alike on shutdown so no orphan processes linger.
   */
  public static List<int> AllDesktopPids(IntPtr desk) {
    var pids = new List<int>();
    EnumDesktopWindows(desk, delegate(IntPtr w, IntPtr l) {
      uint pid; GetWindowThreadProcessId(w, out pid);
      if (pid != 0 && !pids.Contains((int)pid)) pids.Add((int)pid);
      return true; }, IntPtr.Zero);
    return pids;
  }

  /**
   * The application window the panel should follow: the top-most (front-most in Z-order)
   * visible application window that is not shell furniture, a framework helper, or a
   * zero-sized overlay. EnumDesktopWindows enumerates in top-to-bottom Z-order, so returning
   * false on the first valid application window locks onto the active front-most app.
   */
  public static IntPtr PickApp(IntPtr desk, out RECT rect) {
    IntPtr best = IntPtr.Zero; RECT found = new RECT();
    EnumDesktopWindows(desk, delegate(IntPtr w, IntPtr l) {
      if (!IsWindowVisible(w)) return true;
      var c = Cls(w);
      if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Progman" || c == "WorkerW"
          || c == "Tooltip" || c == "MSCTFIME UI" || c == "Default IME" || c == "CiceroUIWndFrame"
          || c == "Windows.UI.Core.CoreWindow"
          || c.StartsWith("GDI+") || c.StartsWith("TF_") || c.StartsWith("UAC_")) return true;
      if (T(w).Length == 0) return true;
      RECT r; if (!GetWindowRect(w, out r)) return true;
      int ww = r.R - r.L, hh = r.B - r.T;
      // A window smaller than a readable viewport is a helper, not a subject.
      if (ww < 120 || hh < 80) return true;
      // First valid application window in Z-order is the active foreground app.
      best = w; found = r;
      return false;
    }, IntPtr.Zero);
    rect = found;
    return best;
  }

  /** Resize a tracked window so the panel sees it at the panel's own size. */
  public static bool FitWindow(IntPtr hwnd, int w, int h) {
    return MoveWindow(hwnd, 0, 0, w, h, true);
  }

  /** A DIB section plus its DC, so the caller owns the pixels. */
  public class Canvas {
    public IntPtr Dc; public IntPtr Bmp; public IntPtr Bits; public int W, H;
    public Canvas(int w, int h) {
      W = w; H = h;
      Dc = CreateCompatibleDC(IntPtr.Zero);
      var bmi = new BMI();
      bmi.h.biSize = (uint)Marshal.SizeOf(typeof(BMIH));
      bmi.h.biWidth = w; bmi.h.biHeight = -h; bmi.h.biPlanes = 1; bmi.h.biBitCount = 32;
      Bmp = CreateDIBSection(Dc, ref bmi, 0, out Bits, IntPtr.Zero, 0);
      SelectObject(Dc, Bmp);
    }
    public void Fill(uint color) {
      var brush = CreateSolidBrush(color);
      var r = new RECT(); r.L = 0; r.T = 0; r.R = W; r.B = H;
      FillRect(Dc, ref r, brush);
      DeleteObject(brush);
    }
    public void Release() { DeleteObject(Bmp); DeleteDC(Dc); }
  }

  /** Composite the desktop into `canvas`, painting each window at its own position. */
  public static int Composite(IntPtr desk, Canvas canvas, out string taskbar) {
    var layer = Layer(desk);
    int painted = 0;
    taskbar = "";
    foreach (var win in layer) {
      var scratch = new Canvas(win.W, win.Ht);
      string source;
      if (CaptureWin(win, scratch, out source)) {
        BitBlt(canvas.Dc, win.X, win.Y, win.W, win.Ht, scratch.Dc, 0, 0, SRCCOPY);
        painted++;
      }
      if (IsTaskbar(win)) taskbar = source;
      scratch.Release();
    }
    return painted;
  }

  /** Reusable scan buffer: the black check copies the taskbar-sized DIB into
   *  it once per attempt, growing it once if a display ever reports a wider
   *  band than the first allocation covers (3600x96 taskbar = 1.38 MB). */
  static byte[] blackScan = new byte[1 << 20];

  /**
   * Whether a 32bpp BGRA snapshot holds no lit pixel: every blue, green, and
   * red byte zero (the unused alpha byte does not count). A uniform black fill
   * from PrintWindow means the window's composition surface has no readable
   * pixels on this desktop, which the fallback ladder keys on.
   */
  public static bool LooksUniformBlack(byte[] bgra, int count) {
    int n = count < bgra.Length ? count : bgra.Length;
    for (int i = 0; i + 3 < n; i += 4) {
      if (bgra[i] != 0 || bgra[i + 1] != 0 || bgra[i + 2] != 0) return false;
    }
    return true;
  }

  static bool UniformBlack(IntPtr bits, int w, int h) {
    long len = (long)w * h * 4;
    if (len <= 0) return false;
    if (len > blackScan.Length) blackScan = new byte[len];
    Marshal.Copy(bits, blackScan, 0, (int)len);
    return LooksUniformBlack(blackScan, (int)len);
  }

  /** Shell taskbar classes: the windows measured to paint uniformly black on a private desktop. */
  static bool IsTaskbar(Win w) {
    return w.Cls == "Shell_TrayWnd" || w.Cls == "Shell_SecondaryTrayWnd";
  }

  /**
   * One window's pixels into `scratch`. The default path is PrintWindow with
   * PW_RENDERFULLCONTENT, unchanged for every window. The taskbar is the
   * measured exception — its content is composed by DirectComposition with no
   * GDI backing store on a private desktop — so it gets a measured fallback
   * ladder: window-DC BitBlt, DCX_WINDOW|DCX_CACHE|DCX_USEWINDOW BitBlt, then
   * a forced repaint before PrintWindow again. When every rung is still black
   * the taskbar is left UNPAINTED, so the frame shows the desktop pixels
   * beneath it instead of a dead black band (taskbar UI itself needs Windows
   * Graphics Capture, deferred). `source` names the rung that supplied the
   * content for the caller's stderr attribution.
   */
  public static bool CaptureWin(Win win, Canvas scratch, out string source) {
    source = "pw2";
    if (PrintWindow(win.H, scratch.Dc, 2)) {
      if (!IsTaskbar(win) || !UniformBlack(scratch.Bits, win.W, win.Ht)) return true;
    } else if (!IsTaskbar(win)) {
      return false;
    }
    // Rung 1: the window's device context, copied without asking the window to paint.
    IntPtr dc = GetDC(win.H);
    if (dc != IntPtr.Zero) {
      bool ok = BitBlt(scratch.Dc, 0, 0, win.W, win.Ht, dc, 0, 0, SRCCOPY);
      ReleaseDC(win.H, dc);
      if (ok && !UniformBlack(scratch.Bits, win.W, win.Ht)) { source = "dc"; return true; }
    }
    // Rung 2: the same with DCX_WINDOW, which includes the non-client surface.
    dc = GetDCEx(win.H, IntPtr.Zero, 0x0001 | 0x0002 | 0x0040);
    if (dc != IntPtr.Zero) {
      bool ok = BitBlt(scratch.Dc, 0, 0, win.W, win.Ht, dc, 0, 0, SRCCOPY);
      ReleaseDC(win.H, dc);
      if (ok && !UniformBlack(scratch.Bits, win.W, win.Ht)) { source = "dcex"; return true; }
    }
    // Rung 3: invalidate and update the window, then ask it to paint again.
    InvalidateRect(win.H, IntPtr.Zero, true);
    UpdateWindow(win.H);
    if (PrintWindow(win.H, scratch.Dc, 2) && !UniformBlack(scratch.Bits, win.W, win.Ht)) {
      source = "repaint";
      return true;
    }
    source = "skipped-black";
    return false;
  }

  /**
   * Extent of the desktop's own coordinate space. A private desktop is as large
   * as the display, and the shell re-lays itself out to that size, so the
   * composited picture must match it and be scaled afterwards.
   */
  public static void Natural(IntPtr desk, out int w, out int h) {
    w = 0; h = 0;
    foreach (var win in Layer(desk)) {
      if (win.X + win.W > w) w = win.X + win.W;
      if (win.Y + win.Ht > h) h = win.Y + win.Ht;
    }
    if (w <= 0) w = 1024;
    if (h <= 0) h = 720;
  }

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr win);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] public static extern int ToUnicodeEx(uint vk, uint scan, byte[] state, StringBuilder buf, int cap, uint flags, IntPtr hkl);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint tid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

  static readonly byte[] Kbd = new byte[256];
  static long lastLp = 1;

  /**
   * Frame pixel through the contained-fit picture to a desktop point. `subject`
   * supplies the live rectangle when present; the fallback subject is the desktop
   * itself at the origin. False drops the event: empty viewport, empty subject, or
   * a point in the letterbox bars.
   */
  public static bool FrameToDesk(IntPtr subject, int orgX, int orgY, int dw, int dh,
      int viewW, int viewH, int fx, int fy, out int dx, out int dy) {
    dx = 0; dy = 0;
    RECT r;
    if (subject != IntPtr.Zero) {
      if (!GetWindowRect(subject, out r)) return false;
      orgX = r.L; orgY = r.T; dw = r.R - r.L; dh = r.B - r.T;
    }
    if (viewW <= 0 || viewH <= 0 || dw <= 0 || dh <= 0) return false;
    double scale = Math.Min((double)viewW / dw, (double)viewH / dh);
    double drawW = dw * scale, drawH = dh * scale;
    double offX = (viewW - drawW) / 2.0, offY = (viewH - drawH) / 2.0;
    if (fx < offX || fy < offY || fx >= offX + drawW || fy >= offY + drawH) return false;
    dx = orgX + (int)Math.Floor((fx - offX) / scale);
    dy = orgY + (int)Math.Floor((fy - offY) / scale);
    return true;
  }

  /** Whether a top-level window is one of this desktop's own windows. */
  static bool OnDesktop(IntPtr top, IntPtr desk) {
    bool on = false;
    EnumDesktopWindows(desk, delegate(IntPtr w, IntPtr l) {
      if (w == top) { on = true; return false; }
      return true; }, IntPtr.Zero);
    return on;
  }

  /**
   * Public membership test for grammar lines that address a window by id from
   * outside the class: `uia` refuses to read an accessibility tree for a
   * window that is not one of this desktop's own, so a guessed id cannot
   * reach across into another desktop's windows.
   */
  public static bool OwnsWindow(IntPtr desk, IntPtr h) { return OnDesktop(h, desk); }

  /** Window of this desktop under a screen point: top-level first, then its deepest visible child. */
  public static IntPtr ResolveAt(IntPtr desk, int sx, int sy) {
    IntPtr top = IntPtr.Zero;
    POINT p; p.X = sx; p.Y = sy;
    IntPtr hit = WindowFromPoint(p);
    if (hit != IntPtr.Zero) {
      IntPtr root = hit;
      IntPtr par = GetParent(root);
      while (par != IntPtr.Zero) { root = par; par = GetParent(root); }
      if (OnDesktop(root, desk)) top = root;
    }
    if (top == IntPtr.Zero) {
      // WindowFromPoint only sees windows of the helper's own desktop, so a point
      // on the private desktop falls through to a direct hit-test in Z-order.
      IntPtr found = IntPtr.Zero;
      EnumDesktopWindows(desk, delegate(IntPtr w, IntPtr l) {
        if (!IsWindowVisible(w)) return true;
        RECT r;
        if (GetWindowRect(w, out r) && sx >= r.L && sx < r.R && sy >= r.T && sy < r.B) { found = w; return false; }
        return true; }, IntPtr.Zero);
      top = found;
    }
    if (top == IntPtr.Zero) return IntPtr.Zero;
    // Deepest visible descendant containing the point: the control under the cursor.
    var hits = new List<IntPtr>();
    RECT rt;
    if (GetWindowRect(top, out rt) && sx >= rt.L && sx < rt.R && sy >= rt.T && sy < rt.B) hits.Add(top);
    EnumChildWindows(top, delegate(IntPtr w, IntPtr l) {
      if (!IsWindowVisible(w)) return true;
      RECT rc;
      if (GetWindowRect(w, out rc) && sx >= rc.L && sx < rc.R && sy >= rc.T && sy < rc.B) hits.Add(w);
      return true; }, IntPtr.Zero);
    foreach (var h in hits) {
      bool childIn = false;
      foreach (var g in hits) { if (g != h && IsChild(h, g)) { childIn = true; break; } }
      if (!childIn) return h; // enumeration order is top-most first
    }
    return top;
  }

  /** One pointer message at a screen point; the wheel messages keep screen coordinates, the rest convert to client. */
  public static bool MouseMsg(uint msg, IntPtr hwnd, int sx, int sy, int mk) {
    if (hwnd == IntPtr.Zero) return false;
    POINT p; p.X = sx; p.Y = sy;
    if (msg != 0x020Au && msg != 0x020Eu && !ScreenToClient(hwnd, ref p)) return false;
    uint packed = ((uint)p.Y << 16) | (uint)p.X;
    return PostMessage(hwnd, msg, (IntPtr)(long)mk, (IntPtr)(long)packed);
  }

  /** Wheel delta at a screen point: WM_MOUSEWHEEL horizontal or vertical, deltas packed high word. */
  public static bool WheelMsg(IntPtr hwnd, bool horizontal, int delta, int sx, int sy, int mk) {
    if (hwnd == IntPtr.Zero) return false;
    uint packed = ((uint)sy << 16) | (uint)sx;
    long w = (long)((uint)mk | (((uint)delta & 0xFFFFu) << 16));
    return PostMessage(hwnd, horizontal ? 0x020Eu : 0x020Au, (IntPtr)w, (IntPtr)(long)packed);
  }

  /** Track one virtual key in the keyboard state used for WM_CHAR synthesis. */
  static void SetKb(uint vk, bool down) {
    if (vk > 255) return;
    if (down) Kbd[vk] |= 0x80; else Kbd[vk] &= 0x7F;
    if (down && (vk == 0x14 || vk == 0x90 || vk == 0x91)) {
      Kbd[vk] = (byte)((Kbd[vk] & 0x80) | ((Kbd[vk] ^ 1) & 1)); // locks toggle on press
    }
    uint mirror = 0;
    if (vk == 0x10) mirror = 0xA0;        // generic Shift, Ctrl, Alt read as the
    else if (vk == 0x11) mirror = 0xA2;   // left-hand keys: clients only ever send
    else if (vk == 0x12) mirror = 0xA4;   // the generic codes
    if (mirror != 0) { if (down) Kbd[mirror] |= 0x80; else Kbd[mirror] &= 0x7F; }
  }

  /** Extended-key set for lParam bit 24; numpad Enter shares VK_RETURN and stays unextended. */
  static bool IsExtended(uint vk) {
    return vk == 0x03 || (vk >= 0x21 && vk <= 0x28) || vk == 0x2C || vk == 0x2D
      || vk == 0x2E || vk == 0x6F || vk == 0x90 || vk == 0xA3 || vk == 0xA5;
  }

  /**
   * One key up/down message with the latched scan code, extended flag, and
   * SYS-family pairing while Alt is held. Alt state is read before this key's
   * own state updates, so releasing Alt is still a SYSKEYUP. The down message's
   * lParam is remembered for the WM_CHAR messages that follow it.
   */
  public static bool KeyMsg(IntPtr hwnd, uint vk, bool down) {    if (hwnd == IntPtr.Zero) return false;
    bool sys = vk == 0x12 || (Kbd[0x12] & 0x80) != 0 || (Kbd[0xA4] & 0x80) != 0 || (Kbd[0xA5] & 0x80) != 0;
    SetKb(vk, down);
    long scan = MapVirtualKey(vk, 0) & 0xFF;
    long lp = 1L | (scan << 16);
    if (IsExtended(vk)) lp |= 1L << 24;
    if (!down) lp |= 1L << 30 | 1L << 31;
    uint msg = sys ? (down ? 0x104u : 0x105u) : (down ? 0x100u : 0x101u);
    if (down) lastLp = lp;
    return PostMessage(hwnd, msg, (IntPtr)(long)vk, (IntPtr)lp);
  }

  /** One UTF-16 unit posted as WM_CHAR under the last key's repeat, scan, and extended bits. */
  public static bool CharMsg(IntPtr hwnd, uint code) {
    if (hwnd == IntPtr.Zero) return false;
    return PostMessage(hwnd, 0x0004u, (IntPtr)(long)code, (IntPtr)lastLp);
  }

  /**
   * The text a key stands for under the tracked layout. Enter and Tab name their
   * control characters directly; everything else translates only while no Ctrl,
   * Alt, or Meta is held, through ToUnicodeEx over the persistent state array so
   * a dead key stays latched and composes with the next one. Zero or a lone
   * dead-key result yields no character here.
   */
  public static string Translate(uint vk) {
    if (vk == 13) return "\r";
    if (vk == 9) return "\t";
    if ((Kbd[0x11] & 0x80) != 0 || (Kbd[0x12] & 0x80) != 0
        || (Kbd[0x5B] & 0x80) != 0 || (Kbd[0x5C] & 0x80) != 0
        || (Kbd[0xA2] & 0x80) != 0 || (Kbd[0xA3] & 0x80) != 0
        || (Kbd[0xA4] & 0x80) != 0 || (Kbd[0xA5] & 0x80) != 0) return "";
    var sb = new StringBuilder(16);
    if (ToUnicodeEx(vk, MapVirtualKey(vk, 0), Kbd, sb, 16, 0, GetKeyboardLayout(0)) <= 0) return "";
    return sb.ToString();
  }

  /**
   * Insert exact text into a native text control. A measured target control
   * inserts the characters its own WM_KEYDOWN carries but ignores an injected
   * WM_CHAR, so the explicit character command needs this path to land at all:
   * EM_REPLACESEL takes the UTF-16 text the caller asked for, case included.
   */
  public static bool InsertText(IntPtr hwnd, string text) {
    if (hwnd == IntPtr.Zero) return false;
    SendMessageW(hwnd, 0x00C2u, (IntPtr)1, text);
    return true;
  }

  /** Foreground one of this desktop's top-level windows; WMActivate plus HWND_TOP when the OS refuses. */
  public static bool FocusWin(IntPtr desk, IntPtr hwnd) {
    if (!OnDesktop(hwnd, desk)) return false;
    if (SetForegroundWindow(hwnd)) return true;
    if (!PostMessage(hwnd, 0x0006u, (IntPtr)1 /* WA_ACTIVE */, IntPtr.Zero)) return false;
    return SetWindowPos(hwnd, IntPtr.Zero /* HWND_TOP */, 0, 0, 0, 0, 0x0003u /* NOMOVE|NOSIZE */);
  }

  /** WM_CLOSE to one of this desktop's top-level windows; membership first, so a bogus id posts nothing. */
  public static bool CloseWin(IntPtr desk, IntPtr hwnd) {
    return OnDesktop(hwnd, desk) && PostMessage(hwnd, 0x0010u, IntPtr.Zero, IntPtr.Zero);
  }

  // ---- Real input synthesis: the opt-in `input mode send` batch mode. ----
  // Struct layouts are the ABI x64 expects: MOUSEINPUT 32, KEYBDINPUT 24,
  // INPUT 40 with its union at offset 8 (verified by Marshal.SizeOf in the
  // D8 spec). One static array and a cached size keep every injection
  // allocation-free on the frame loop.
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint n, [MarshalAs(UnmanagedType.LPArray)] INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "OpenDesktopW")]
  public static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool SetThreadDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool GetUserObjectInformation(IntPtr h, int idx, byte[] buf, int len, out int need);

  static readonly int InputBytes = Marshal.SizeOf(typeof(INPUT));
  static readonly INPUT[] oneInput = new INPUT[1];
  static readonly INPUT[] twoInputs = new INPUT[2];

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
  const int UOI_NAME = 2;

  /** Name of an open desktop handle; "" when the handle cannot be queried. */
  static string DeskName(IntPtr h) {
    byte[] buf = new byte[512];
    int need;
    if (!GetUserObjectInformation(h, UOI_NAME, buf, buf.Length, out need)) return "";
    return Encoding.Unicode.GetString(buf, 0, need > 2 ? need - 2 : 0);
  }

  /**
   * Whether the session's input desktop — the one hardware and injected input
   * is actually delivered on — IS the named sandbox desktop. SendInput events
   * reach only that desktop; on a normal session it is the interactive one, so
   * without this gate an injected batch would type into the user's real
   * desktop instead of the private sandbox windows. Measured on this host:
   * input desktop `Default`, sandbox `dsh-shellbox` -> refused.
   */
  public static bool InputDesktopIs(string name) {
    IntPtr h = OpenInputDesktop(0, false, 0x01FF);
    if (h == IntPtr.Zero) return false;
    try { return string.Equals(DeskName(h), name, StringComparison.Ordinal); }
    finally { CloseDesktop(h); }
  }

  /** SetCursorPos for `input move` in send mode: the cursor position is session-global. */
  public static bool SendCursor(int x, int y) { return SetCursorPos(x, y); }

  /** One mouse button transition at the current cursor position. which: 0 left, 1 right, 2 middle. */
  public static bool SendMouseButton(int which, bool down) {
    uint f = which == 1 ? (down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP)
           : which == 2 ? (down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP)
           : (down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP);
    var a = oneInput[0];
    a.type = INPUT_MOUSE;
    a.u.mi = new MOUSEINPUT();
    a.u.mi.dwFlags = f;
    oneInput[0] = a;
    return SendInput(1, oneInput, InputBytes) == 1;
  }

  /** One wheel tick: vertical by default, horizontal when `horizontal` is set. */
  public static bool SendWheelDelta(bool horizontal, int delta) {
    var a = oneInput[0];
    a.type = INPUT_MOUSE;
    a.u.mi = new MOUSEINPUT();
    a.u.mi.dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
    a.u.mi.mouseData = (uint)delta;
    oneInput[0] = a;
    return SendInput(1, oneInput, InputBytes) == 1;
  }

  /** One virtual-key transition with its scan code and extended flag, as the OS would report it. */
  public static bool SendVirtualKey(uint vk, bool down) {
    var a = oneInput[0];
    a.type = INPUT_KEYBOARD;
    a.u.ki = new KEYBDINPUT();
    a.u.ki.wVk = (ushort)vk;
    a.u.ki.wScan = (ushort)(MapVirtualKey(vk, 0) & 0xFF);
    uint f = down ? 0u : KEYEVENTF_KEYUP;
    if (IsExtended(vk)) f |= KEYEVENTF_EXTENDEDKEY;
    a.u.ki.dwFlags = f;
    oneInput[0] = a;
    return SendInput(1, oneInput, InputBytes) == 1;
  }

  /**
   * One UTF-16 unit as a KEYEVENTF_UNICODE pair: the system derives the
   * character under the focused control's own keyboard handling, so no
   * WM_CHAR injection and no layout dependency.
   */
  public static bool SendUnicodeChar(uint code) {
    var down = twoInputs[0];
    down.type = INPUT_KEYBOARD;
    down.u.ki = new KEYBDINPUT();
    down.u.ki.wScan = (ushort)code;
    down.u.ki.dwFlags = KEYEVENTF_UNICODE;
    twoInputs[0] = down;
    var up = twoInputs[1];
    up.type = INPUT_KEYBOARD;
    up.u.ki = new KEYBDINPUT();
    up.u.ki.wScan = (ushort)code;
    up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    twoInputs[1] = up;
    return SendInput(2, twoInputs, InputBytes) == 2;
  }

  // ---- Send worker: real input is injected only from a thread whose desktop
  // IS the sandbox desktop. Measured on this host: SendInput from a thread on
  // any other desktop returns 0 events, while the same call from a thread
  // bound to the input desktop returns its full count. One background thread
  // is bound on the first armed `input mode send` batch and drains a small op
  // queue there; a post-mode helper run never creates it.
  struct SendOp { public int Kind; public int A; public int B; }
  static readonly Queue<SendOp> sendOps = new Queue<SendOp>();
  static readonly AutoResetEvent sendSignal = new AutoResetEvent(false);
  static readonly object sendLock = new object();
  static IntPtr sendWorkerDesk = IntPtr.Zero;
  static volatile bool sendWorkerReady = false;
  static volatile bool sendWorkerFailed = false;

  /** One queued op executed on the worker thread: kind 0 cursor, 1 button, 2 wheel, 3 key, 4 unicode. */
  static void SendOpExecute(SendOp op) {
    switch (op.Kind) {
      case 0: SetCursorPos(op.A, op.B); break;
      case 1: SendMouseButton(op.A, op.B != 0); break;
      case 2: SendWheelDelta(op.A != 0, op.B); break;
      case 3: SendVirtualKey((uint)op.A, op.B != 0); break;
      case 4: SendUnicodeChar((uint)op.A); break;
    }
  }

  /**
   * Bind one background thread to the named desktop and drain send ops there.
   * Idempotent per helper run: the second armed batch reuses the thread, and a
   * bind failure answers false so the caller drops the batch's send lines
   * instead of injecting from the wrong desktop.
   */
  public static bool StartSendWorker(string desktopName) {
    if (sendWorkerDesk != IntPtr.Zero) return sendWorkerReady && !sendWorkerFailed;
    IntPtr desk = OpenDesktop(desktopName, 0, false, 0x01FF);
    if (desk == IntPtr.Zero) return false;
    sendWorkerDesk = desk;
    var thread = new Thread(() => {
      if (!SetThreadDesktop(desk)) {
        sendWorkerFailed = true;
        sendSignal.Set();
        return;
      }
      sendWorkerReady = true;
      sendSignal.Set();
      while (true) {
        sendSignal.WaitOne();
        while (true) {
          SendOp op;
          lock (sendLock) {
            if (sendOps.Count == 0) break;
            op = sendOps.Dequeue();
          }
          SendOpExecute(op);
        }
      }
    });
    thread.IsBackground = true;
    thread.Name = "dsh-send-input";
    thread.Start();
    // The frame loop waits only for the bind result, not for queue work.
    for (int i = 0; i < 100 && !sendWorkerReady && !sendWorkerFailed; i++) Thread.Sleep(10);
    return sendWorkerReady && !sendWorkerFailed;
  }

  /** One send-mode event queued for the worker; false when no worker is bound. */
  public static bool QueueSendOp(int kind, int a, int b) {
    if (!sendWorkerReady || sendWorkerFailed) return false;
    lock (sendLock) {
      var op = new SendOp();
      op.Kind = kind; op.A = a; op.B = b;
      sendOps.Enqueue(op);
    }
    sendSignal.Set();
    return true;
  }
}
'@

if (-not ($CaptureOnce -or $Stream -or $UiaOnce)) { Write-Error 'pass -CaptureOnce, -Stream, or -UiaOnce'; exit 1 }

# Before the desktop handle, the shell, or any bitmap: one unit must mean one
# physical pixel from here on.
$dpi = [Sandbox]::BeDpiAware()

# Bounded accessibility read of one window: RawViewWalker pre-order, at most
# <cap> nodes (hard maximum 256), each node carrying control type, class, name,
# value, bounds clamped to the protocol's 0..5120 range, enabled/offscreen
# flags, and its native hwnd. UIA is served by the target process itself, so
# the read crosses desktops; measured live against a private-desktop window.
function Get-UiaTree {
  param([IntPtr]$Hwnd, [int]$MaxNodes)
  $cap = [Math]::Min([Math]::Max($MaxNodes, 1), 256)
  $result = [ordered]@{ ok = $false; error = ''; hwnd = [int64]$Hwnd; max = $cap; truncated = $false; nodes = @() }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
    if ($null -eq $root) { $result.error = 'no accessibility root for this window'; return [pscustomobject]$result }
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $stack = [System.Collections.Generic.Stack[System.Windows.Automation.AutomationElement]]::new()
    $stack.Push($root)
    $nodes = New-Object System.Collections.Generic.List[object]
    while ($stack.Count -gt 0) {
      if ($nodes.Count -ge $cap) { $result.truncated = $true; break }
      $el = $stack.Pop()
      $c = $el.Current
      $rect = $c.BoundingRectangle
      $x = 0; $y = 0; $w = 0; $h = 0
      if (-not [double]::IsNaN($rect.X)) {
        $x = [Math]::Min(5120, [Math]::Max(0, [int][Math]::Round($rect.X)))
        $y = [Math]::Min(5120, [Math]::Max(0, [int][Math]::Round($rect.Y)))
        $w = [Math]::Min(5120, [Math]::Max(0, [int][Math]::Round($rect.Width)))
        $h = [Math]::Min(5120, [Math]::Max(0, [int][Math]::Round($rect.Height)))
      }
      $name = [string]$c.Name
      if ($name.Length -gt 200) { $name = $name.Substring(0, 200) }
      $value = ''
      if ($c.IsValuePatternAvailable) {
        try {
          $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          if ($vp -is [System.Windows.Automation.ValuePattern]) {
            $value = [string]$vp.Current.Value
            if ($value.Length -gt 200) { $value = $value.Substring(0, 200) }
          }
        } catch { $value = '' }
      }
      $ct = [string]$c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      $nodes.Add([ordered]@{
        ct = $ct
        name = $name
        cls = [string]$c.ClassName
        value = $value
        x = $x; y = $y; w = $w; h = $h
        enabled = [bool]$c.IsEnabled
        offscreen = [bool]$c.IsOffscreen
        hwnd = [int64]$c.NativeWindowHandle
      })
      $children = New-Object 'System.Collections.Generic.List[System.Windows.Automation.AutomationElement]'
      $child = $walker.GetFirstChild($el)
      while ($null -ne $child) { $children.Add($child); $child = $walker.GetNextSibling($child) }
      for ($i = $children.Count - 1; $i -ge 0; $i--) { $stack.Push($children[$i]) }
    }
    $result.ok = $true
    $result.nodes = $nodes.ToArray()
  } catch {
    $result.error = $_.Exception.Message
  }
  return [pscustomobject]$result
}

# `-UiaOnce`: the same document for one already-existing window, with no
# desktop, no shell, and no frame loop — the desktop-gated spec reads it.
if ($UiaOnce) {
  if ($UiaHwnd -eq 0) { Write-Error '-UiaOnce needs -UiaHwnd'; exit 1 }
  $uiaJson = Get-UiaTree -Hwnd ([IntPtr]$UiaHwnd) -MaxNodes $UiaMax | ConvertTo-Json -Compress -Depth 5
  [Console]::Out.WriteLine($uiaJson)
  [Environment]::Exit(0)
}

$desk = [Sandbox]::CreateDesktopOwned($DesktopName)
if ($desk -eq [IntPtr]::Zero) { Write-Error "CreateDesktop failed (err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"; exit 1 }

# In stream mode stdout carries frames only, so every diagnostic goes to stderr.
function Write-Status {
  param([string]$Message)
  if ($Stream) { [Console]::Error.WriteLine($Message) } else { Write-Output $Message }
}
$shellReady = [Sandbox]::ShellReady($desk)
if (-not $shellReady) {
  $shell = "$env:SystemRoot\explorer.exe"
  $shellLine = '"' + $shell + '"'
  $spawned = [Sandbox]::Spawn($shell, $shellLine, $DesktopName)
  Write-Status "dpi=$dpi desktop=$DesktopName spawn=$spawned"

  # Wait until the shell has built its desktop. A fixed sleep both raced (a desktop
  # with more windows to lay out was still empty when the first frame was built)
  # and wasted the rest of its budget when the shell was up sooner, so poll for the
  # readiness signal and give up at the deadline.
  $waitStart = Get-Date
  $deadline = $waitStart.AddSeconds($ShellWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    if ([Sandbox]::ShellReady($desk)) { break }
    Start-Sleep -Milliseconds 250
  }
  # Close any default folder window Explorer opened during initial shell boot
  Start-Sleep -Milliseconds 500
  $cabinet = [Sandbox]::PickApp($desk, [ref](New-Object Sandbox+RECT))
  if ($cabinet -ne [IntPtr]::Zero -and [Sandbox]::Cls($cabinet) -eq 'CabinetWClass') {
    [Sandbox]::CloseWin($desk, $cabinet) | Out-Null
  }
  $natW = 0; $natH = 0
  [Sandbox]::Natural($desk, [ref]$natW, [ref]$natH)
  $waitMs = [int]((Get-Date) - $waitStart).TotalMilliseconds
  Write-Status "shell-ready=${waitMs}ms ready=$([Sandbox]::ShellReady($desk)) natural=${natW}x${natH}"
} else {
  $natW = 0; $natH = 0
  [Sandbox]::Natural($desk, [ref]$natW, [ref]$natH)
  Write-Status "dpi=$dpi desktop=$DesktopName shell-ready=already ready (spawn skipped) natural=${natW}x${natH}"
}

# An application named up front becomes the subject as soon as it has a window.
if ($Launch -ne '') {
  $launchLine = '"' + $Launch + '"'
  Write-Status "launch=$Launch $([Sandbox]::Spawn($Launch, $launchLine, $DesktopName))"
  Start-Sleep -Seconds 4
}

# Composite at the desktop's own size, then scale to the requested viewport.
Write-Status "viewport=${Width}x${Height}"

# Scale a composited DIB into the viewport, preserving the desktop's aspect: the
# display's ratio rarely matches the pane's, and stretching would distort every
# window in the picture. The remainder is letterboxed in the backdrop tone.
function ConvertTo-Viewport {
  param([IntPtr]$Dib, [int]$NatW, [int]$NatH, [int]$OutW, [int]$OutH)
  $source = [System.Drawing.Image]::FromHbitmap($Dib)
  if ($NatW -eq $OutW -and $NatH -eq $OutH) {
    return $source
  }
  $target = New-Object System.Drawing.Bitmap($OutW, $OutH)
  $graphics = [System.Drawing.Graphics]::FromImage($target)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighSpeed
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighSpeed
  $graphics.Clear([System.Drawing.Color]::FromArgb(32, 32, 32))
  $scale = [Math]::Min($OutW / $NatW, $OutH / $NatH)
  $drawW = [int][Math]::Round($NatW * $scale)
  $drawH = [int][Math]::Round($NatH * $scale)
  $graphics.DrawImage($source, [int](($OutW - $drawW) / 2), [int](($OutH - $drawH) / 2), $drawW, $drawH)
  $graphics.Dispose()
  $source.Dispose()
  return $target
}

# What the panel follows: one application window when the sandbox has one open,
# and the whole desktop only as the fallback. A view of every icon and the
# wallpaper wastes the panel on furniture the user cannot act on.
function Get-SandboxTarget {
  param([IntPtr]$Desk)
  $rect = New-Object Sandbox+RECT
  $hwnd = [Sandbox]::PickApp($Desk, [ref]$rect)
  if ($hwnd -ne [IntPtr]::Zero) {
    return @{ Hwnd = $hwnd; W = $rect.R - $rect.L; H = $rect.B - $rect.T }
  }
  $fallbackW = 0; $fallbackH = 0
  [Sandbox]::Natural($Desk, [ref]$fallbackW, [ref]$fallbackH)
  return @{ Hwnd = [IntPtr]::Zero; W = $fallbackW; H = $fallbackH }
}

# Size the tracked window to the panel. The application reflows into the panel's
# proportions, so the picture is the window's own pixels at 1:1 with no scaling
# loss and no letterbox — the point of showing an application rather than the
# desktop. A window that refuses the size simply reports its own, and the viewer
# falls back to letterboxing it.
function Sync-TargetToViewport {
  param([hashtable]$Target, [int]$W, [int]$H)
  if ($Target.Hwnd -eq [IntPtr]::Zero) { return }
  [Sandbox]::FitWindow($Target.Hwnd, $W, $H) | Out-Null
}

# Closing our desktop handle does not destroy the desktop while processes
# started on it still hold one, so terminate all windows on that desktop first.
function Stop-SandboxShell {
  param([IntPtr]$Desk)
  $pids = [Sandbox]::AllDesktopPids($Desk)
  foreach ($targetPid in $pids) {
    Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
  }
  return $pids.Count
}

if ($CaptureOnce) {
  if (-not $Out) { Write-Error '-CaptureOnce needs -Out'; exit 1 }
  # Report the paint order: the taskbar must be last so it covers what it overlaps.
  $index = 0
  foreach ($win in [Sandbox]::Layer($desk)) {
    $index++
    Write-Output ("  layer[{0}] {1,-24} {2,4},{3,-4} {4}x{5} '{6}'" -f $index, $win.Cls, $win.X, $win.Y, $win.W, $win.Ht, $win.Title)
  }
  $box = Get-SandboxTarget -Desk $desk
  Sync-TargetToViewport -Target $box -W $Width -H $Height
  $box = Get-SandboxTarget -Desk $desk
  $canvas = New-Object Sandbox+Canvas($box.W, $box.H)
  $canvas.Fill(0x00202020)
  $taskbarSource = ''
  if ($box.Hwnd -ne [IntPtr]::Zero) {
    [Sandbox]::PrintWindow($box.Hwnd, $canvas.Dc, 2) | Out-Null
  } else {
    [Sandbox]::Composite($desk, $canvas, [ref]$taskbarSource) | Out-Null
  }
  $scaled = ConvertTo-Viewport -Dib $canvas.Bmp -NatW $box.W -NatH $box.H -OutW $Width -OutH $Height
  $scaled.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $scaled.Dispose()
  $canvas.Release()
  Write-Output "target=$($box.W)x$($box.H) fallback=$($box.Hwnd -eq [IntPtr]::Zero) taskbar=$taskbarSource out=$Out"
  [Sandbox]::CloseDesktop($desk) | Out-Null
  exit 0
}

# The state document beside the command file: the host reads it to learn the
# desktop's windows and tracked subject without parsing frames. Written at
# startup and then every 30 frames or 1000 ms, staged as .tmp so a reader never
# observes half a document. UTF-8 without a byte-order mark, because the host
# parses the bytes directly; Out-File and Set-Content would write UTF-16.
$script:statePath = ''
$script:uiaPath = ''
if ($CommandFile -ne '') { $script:statePath = "$CommandFile.state"; $script:uiaPath = "$CommandFile.uia" }
$script:stateGen = 0
$script:stateFrames = 30
$script:stateLastMs = 0
$script:stateUtf8 = New-Object System.Text.UTF8Encoding($false)

function Write-State {
  param([IntPtr]$Subject)
  if ($script:statePath -eq '') { return }
  $script:stateGen = $script:stateGen + 1
  $json = [Sandbox]::StateJson($desk, $Subject, $script:stateGen, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  $tmp = $script:statePath + '.tmp'
  try {
    [IO.File]::WriteAllText($tmp, $json, $script:stateUtf8)
    # MoveFileEx under the same directory: the rename replaces any previous
    # document in one step, so a reader sees either the old or the new file.
    Move-Item -LiteralPath $tmp -Destination $script:statePath -Force
  } catch {
    Write-Status "state-error=$($_.Exception.Message)"
  }
}

# One accessibility read answered as a sidecar beside the command file, staged
# as .tmp and renamed so a reader never observes a partial document — the same
# discipline as the state file. A refused window answers `ok:false` in the
# same document rather than by silence, so the route can tell "the helper
# answered" from "the helper never saw the line".
function Write-UiaResult {
  param([IntPtr]$Hwnd, [int]$MaxNodes)
  if ($script:uiaPath -eq '') { return }
  if (-not [Sandbox]::OwnsWindow($desk, $Hwnd)) {
    $doc = '{"ok":false,"error":"not a window of this desktop","hwnd":' + $Hwnd.ToInt64() + ',"max":0,"truncated":false,"nodes":[]}'
  } else {
    $doc = Get-UiaTree -Hwnd $Hwnd -MaxNodes $MaxNodes | ConvertTo-Json -Compress -Depth 5
  }
  $tmp = $script:uiaPath + '.tmp'
  try {
    [IO.File]::WriteAllText($tmp, $doc, $script:stateUtf8)
    Move-Item -LiteralPath $tmp -Destination $script:uiaPath -Force
  } catch {
    Write-Status "uia-error=$($_.Exception.Message)"
  }
}

# Stream mode: base64 JPEG frames, one per line, so the Node bridge can relay them.# The tracked window is re-picked every frame, so opening another application in
# the sandbox moves the view; the canvas follows its size.
$script:viewW = $Width
$script:viewH = $Height
$script:target = Get-SandboxTarget -Desk $desk
Sync-TargetToViewport -Target $script:target -W $script:viewW -H $script:viewH
$script:target = Get-SandboxTarget -Desk $desk
$canvas = New-Object Sandbox+Canvas($script:target.W, $script:target.H)
$stdout = [Console]::OpenStandardOutput()
$frameInterval = [int](1000 / $Fps)
# Input grammar dispatch (`input ...`, `focus <hwnd>`, `wmclose <hwnd>`). One
# line is one independent event: a malformed line is dropped without stopping
# the batch or the frame loop, and an unknown verb is ignored so an older helper
# survives a newer spool. Spool lines are ASCII-only (numeric codes), so no
# reading or decoding step can corrupt them. The converted pointer point is
# cached because button and wheel messages address the last position the viewer
# moved to; a subject switch drops it, and the next `input move` refills it.
$script:cacheX = 0
$script:cacheY = 0
$script:cacheHas = $false
$script:mk = 0        # MK_LBUTTON|MK_RBUTTON|MK_MBUTTON latched by button messages
$script:kShift = $false
$script:kCtrl = $false
$script:lastTaskbarSource = ''
# Delivery mode of the current batch: 'post' (PostMessage family, the default
# and unchanged path) or 'send' (opt-in SendInput/SetCursorPos synthesis).
# The host opens only send batches with `input mode send`, and every drained
# spool file starts back at 'post', so one batch can never leak its mode into
# the next.
$script:inputMode = 'post'
$script:sendGate = $false
$script:sendGateLogged = $false
$script:sendGateArmedLogged = $false
function Invoke-InputLine([string]$line) {
  if ($null -eq $line) { return }
  $line = $line.Trim()
  if ($line -eq '') { return }
  try {
    if ($line -match '^input mode (post|send)$') {
      $script:inputMode = $Matches[1]
      if ($script:inputMode -eq 'send') {
        # Two measured conditions must hold before any send line runs: the
        # session's input desktop must BE this sandbox desktop (else the
        # events would reach the user's real session), and the injection
        # worker thread must have bound to it (SendInput from any other
        # thread's desktop returns zero events). Both re-evaluate at every
        # mode line; a refusal drops the batch's send lines once, reported.
        $reason = ''
        if ([Sandbox]::InputDesktopIs($DesktopName)) {
          if ([Sandbox]::StartSendWorker($DesktopName)) {
            $script:sendGate = $true
          } else {
            $script:sendGate = $false
            $reason = 'worker-bind-failed'
          }
        } else {
          $script:sendGate = $false
          $reason = 'input-desktop!=sandbox-desktop'
        }
        if ($script:sendGate) {
          if (-not $script:sendGateArmedLogged) { Write-Status 'send-input=armed' }
          $script:sendGateArmedLogged = $true
          $script:sendGateLogged = $false
        } else {
          if (-not $script:sendGateLogged) { Write-Status "send-input=refused $reason" }
          $script:sendGateLogged = $true
          $script:sendGateArmedLogged = $false
        }
      }
      return
    }
    if ($line -match '^input move (\d+) (\d+)$') {
      if ($null -eq $script:target) { $script:cacheHas = $false; return }
      $mdx = 0; $mdy = 0
      $ok = [Sandbox]::FrameToDesk([IntPtr]$script:target.Hwnd, 0, 0, [int]$script:target.W, [int]$script:target.H,
        [int]$script:viewW, [int]$script:viewH, [int]$Matches[1], [int]$Matches[2], [ref]$mdx, [ref]$mdy)
      if ($ok) {
        $script:cacheX = $mdx; $script:cacheY = $mdy; $script:cacheHas = $true
        # The mapping caches in both modes; only the physical cursor move is
        # a send-mode effect, and only behind the gate (queue op 0 = cursor).
        if ($script:inputMode -eq 'send' -and $script:sendGate) {
          [void][Sandbox]::QueueSendOp(0, $mdx, $mdy)
        }
      }
      else { $script:cacheHas = $false }
      return
    }
    if ($line -match '^input button (left|right|middle) (down|up)$') {
      if (-not $script:cacheHas) { return }
      $bit = 1; $dn = [uint32]0x0201; $up = [uint32]0x0202
      $which = 0
      if ($Matches[1] -eq 'right') { $bit = 2; $dn = [uint32]0x0204; $up = [uint32]0x0205; $which = 1 }
      elseif ($Matches[1] -eq 'middle') { $bit = 16; $dn = [uint32]0x0207; $up = [uint32]0x0208; $which = 2 }
      $isDown = ($Matches[2] -eq 'down')
      if ($script:inputMode -eq 'send') {
        # Latch the viewer's belief about held buttons in both modes; only the
        # delivery differs. Post path below keeps its original order: the
        # mouse-move posts before this button's bit is latched. Queue ops:
        # 0 = cursor to the cached point, 1 = button (which, down).
        if ($isDown) { $script:mk = $script:mk -bor $bit } else { $script:mk = $script:mk -band (-bnot $bit) }
        if ($script:sendGate) {
          [void][Sandbox]::QueueSendOp(0, $script:cacheX, $script:cacheY)
          [void][Sandbox]::QueueSendOp(1, $which, [int]$isDown)
        }
        return
      }
      $hwnd = [Sandbox]::ResolveAt($desk, $script:cacheX, $script:cacheY)
      if ($hwnd -eq [IntPtr]::Zero) { return }
      # WM_MOUSEMOVE first so the window has a current position when the button flips.
      [void][Sandbox]::MouseMsg([uint32]0x0200, $hwnd, $script:cacheX, $script:cacheY, $script:mk)
      if ($isDown) {
        $script:mk = $script:mk -bor $bit
        [void][Sandbox]::MouseMsg($dn, $hwnd, $script:cacheX, $script:cacheY, $script:mk)
      } else {
        $script:mk = $script:mk -band (-bnot $bit)
        [void][Sandbox]::MouseMsg($up, $hwnd, $script:cacheX, $script:cacheY, $script:mk)
      }
      return
    }
    if ($line -match '^input wheel (-?\d+) (-?\d+)$') {
      if (-not $script:cacheHas) { return }
      $wDX = [int]$Matches[1]; $wDY = [int]$Matches[2]
      if ($script:inputMode -eq 'send') {
        # Queue ops: 0 = cursor, 2 = wheel (horizontal?, delta), order preserved.
        if ($script:sendGate) {
          [void][Sandbox]::QueueSendOp(0, $script:cacheX, $script:cacheY)
          if ($wDY -ne 0) { [void][Sandbox]::QueueSendOp(2, 0, $wDY) }
          if ($wDX -ne 0) { [void][Sandbox]::QueueSendOp(2, 1, $wDX) }
        }
        return
      }
      $hwnd = [Sandbox]::ResolveAt($desk, $script:cacheX, $script:cacheY)
      if ($hwnd -eq [IntPtr]::Zero) { return }
      $mkNow = $script:mk
      if ($script:kShift) { $mkNow = $mkNow -bor 4 }
      if ($script:kCtrl) { $mkNow = $mkNow -bor 8 }
      if ($wDY -ne 0) { [void][Sandbox]::WheelMsg($hwnd, $false, $wDY, $script:cacheX, $script:cacheY, $mkNow) }
      if ($wDX -ne 0) { [void][Sandbox]::WheelMsg($hwnd, $true, $wDX, $script:cacheX, $script:cacheY, $mkNow) }
      return
    }
    if ($line -match '^input key (\d+) (down|up)$') {
      $vk = [uint32][int]$Matches[1]
      if ($vk -lt 1 -or $vk -gt 254) { return }
      $isDown = ($Matches[2] -eq 'down')
      if ($script:inputMode -eq 'send') {
        # Real synthesis needs no target window: the system routes the event to
        # the focused control, scan code and extended flag included, and the
        # character a key stands for follows from the key itself — so no
        # WM_CHAR is appended here. Modifier latches stay coherent with what
        # the viewer believes is held.
        if ($vk -eq 16) { $script:kShift = $isDown }
        if ($vk -eq 17) { $script:kCtrl = $isDown }
        if ($script:sendGate) { [void][Sandbox]::QueueSendOp(3, [int]$vk, [int]$isDown) }
        return
      }
      # Keys address the window under the pointer, or without a pointer yet the
      # subject itself, so a click-to-focus flow types where the user is looking.
      if ($script:cacheHas) { $hwnd = [Sandbox]::ResolveAt($desk, $script:cacheX, $script:cacheY) }
      elseif ($null -ne $script:target) { $hwnd = [IntPtr]$script:target.Hwnd }
      else { $hwnd = [IntPtr]::Zero }
      if ($hwnd -eq [IntPtr]::Zero) { return }
      if ($vk -eq 16) { $script:kShift = $isDown }
      if ($vk -eq 17) { $script:kCtrl = $isDown }
      [void][Sandbox]::KeyMsg($hwnd, $vk, $isDown)
      if ($isDown) {
        foreach ($ch in ([Sandbox]::Translate($vk)).ToCharArray()) {
          [void][Sandbox]::CharMsg($hwnd, [uint32][int]$ch)
        }
      }
      return
    }
    if ($line -match '^input char (\d+)$') {
      $code = [int]$Matches[1]
      if ($code -lt 0 -or $code -gt 65535) { return }
      if ($script:inputMode -eq 'send') {
        # KEYEVENTF_UNICODE pair on the worker (queue op 4): the system
        # delivers the character under the focused control's own handling,
        # with no EM_REPLACESEL and no WM_CHAR injection involved.
        if ($script:sendGate) { [void][Sandbox]::QueueSendOp(4, $code, 0) }
        return
      }
      if ($script:cacheHas) { $hwnd = [Sandbox]::ResolveAt($desk, $script:cacheX, $script:cacheY) }
      elseif ($null -ne $script:target) { $hwnd = [IntPtr]$script:target.Hwnd }
      else { $hwnd = [IntPtr]::Zero }
      if ($hwnd -eq [IntPtr]::Zero) { return }
      # A measured text control ignores an injected WM_CHAR and inserts only what
      # its own key handling produces, so an explicit character reaches a text
      # control through EM_REPLACESEL and every other target through WM_CHAR.
      if ([Sandbox]::IsTextControl($hwnd)) {
        [void][Sandbox]::InsertText($hwnd, [string][char]$code)
      } else {
        [void][Sandbox]::CharMsg($hwnd, [uint32]$code)
      }
      return
    }
    if ($line -match '^focus (\d+)$') {
      [void][Sandbox]::FocusWin($desk, [IntPtr]([int64]$Matches[1]))
      return
    }
    if ($line -match '^wmclose (\d+)$') {
      [void][Sandbox]::CloseWin($desk, [IntPtr]([int64]$Matches[1]))
      return
    }
  } catch {
    Write-Status "input-error=$($_.Exception.Message)"
  }
}

# Handle one control or input grammar line. Shared by the command file and the
# input spool so both channels behave identically. Every arm is independent: a
# bad line must not stop the frame loop or the remaining lines of a batch.
function Invoke-HelperLine([string]$line) {
  if ($line -eq 'quit') { $script:stopping = $true }
  elseif ($line -match '^size\s+(\d+)\s+(\d+)$') {
    $script:viewW = [int]$Matches[1]; $script:viewH = [int]$Matches[2]
    Sync-TargetToViewport -Target $script:target -W $script:viewW -H $script:viewH
    Write-Status "viewport=${script:viewW}x${script:viewH}"
  }
  elseif ($line -match '^fps\s+(\d+)$') {
    $newFps = [int]$Matches[1]
    if ($newFps -ge 1 -and $newFps -le 60) {
      $Fps = $newFps
      $frameInterval = [int](1000 / $Fps)
      Write-Status "fps=${Fps} interval=${frameInterval}ms"
    }
  }
  elseif ($line -match '^launch\s+(.+)$') {
    $cmdToLaunch = $Matches[1].Trim()
    if ($cmdToLaunch -ne '') {
      $spawnRes = [Sandbox]::SpawnCmd($cmdToLaunch, $DesktopName)
      Write-Status "launch=$cmdToLaunch result=$spawnRes"
    }
  }
  elseif ($line -match '^uia (\d+)(?: (\d+))?$') {
    $uiaTarget = [IntPtr]([int64]$Matches[1])
    $uiaCap = 128
    if ($Matches[2] -ne '') { $uiaCap = [int]$Matches[2] }
    Write-UiaResult -Hwnd $uiaTarget -MaxNodes $uiaCap
  }
  else {
    Invoke-InputLine $line
  }
}

$script:loopCount = 0
$reader = [Console]::In
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters 1
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)

Write-Status "streaming ${Width}x${Height} at ${Fps}fps tracking $($script:target.W)x$($script:target.H)"
$script:stopping = $false
while ($true) {
  $started = Get-Date
  $b64 = $null
  # A failing frame is dropped, not fatal: one bad window or GDI hiccup must
  # not end the capture while a viewer is still watching. The stdout write
  # stays outside the try so a closed pipe still ends an orphaned helper.
  try {
    if ($CommandFile -ne '' -and (Test-Path -LiteralPath $CommandFile)) {
      # Read fully before deleting: a writer can create the file a moment before its
      # bytes land, and deleting a half-written command would lose it silently.
      $text = Get-Content -LiteralPath $CommandFile -Raw -ErrorAction SilentlyContinue
      if ($null -ne $text -and $text.Trim() -ne '') {
        Remove-Item -LiteralPath $CommandFile -Force -ErrorAction SilentlyContinue
        # A drained file is one batch: mode is batch-scoped, so a send batch
        # can never bleed into whatever arrives next (the host opens every
        # input batch with its own `input mode` line regardless).
        $script:inputMode = 'post'
        foreach ($line in ($text -split "`r?`n")) {
          Invoke-HelperLine $line
        }
      }
    }
    if ($InputDir -ne '' -and (Test-Path -LiteralPath $InputDir)) {
      # Sorted by the zero-padded sequence so batches apply in order; .tmp staging
      # files never match *.cmd, and 8 files per frame bounds the work in one
      # frame while the rest stay queued for the next frames.
      $spoolFiles = @(Get-ChildItem -LiteralPath $InputDir -Filter '*.cmd' -File -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 8)
      foreach ($sf in $spoolFiles) {
        $batch = Get-Content -LiteralPath $sf.FullName -Raw -ErrorAction SilentlyContinue
        if ($null -ne $batch -and $batch.Trim() -ne '') {
          Remove-Item -LiteralPath $sf.FullName -Force -ErrorAction SilentlyContinue
          # One spool file is one batch; mode starts at 'post' and the batch's
          # own `input mode` line opts into synthesis when asked for.
          $script:inputMode = 'post'
          foreach ($line in ($batch -split "`r?`n")) {
            if ($line.Trim() -ne '') { Invoke-HelperLine $line }
          }
        }
      }
    }
    if ($script:stopping) { break }
    # Follow the sandbox's own activity: a new application becomes the subject, and
    # the canvas is rebuilt only when its size actually changes.
    $script:loopCount = ($script:loopCount + 1) % 30
    $recheck = ($script:loopCount -eq 0) -or ($null -eq $script:target) -or ($script:target.Hwnd -eq [IntPtr]::Zero) -or (-not [Sandbox]::IsWindowVisible($script:target.Hwnd))
    if ($recheck) {
      $box = Get-SandboxTarget -Desk $desk
    } else {
      $rect = New-Object Sandbox+RECT
      if ([Sandbox]::GetWindowRect($script:target.Hwnd, [ref]$rect)) {
        $box = @{ Hwnd = $script:target.Hwnd; W = $rect.R - $rect.L; H = $rect.B - $rect.T }
      } else {
        $box = Get-SandboxTarget -Desk $desk
      }
    }
    if ($null -eq $script:target -or $box.W -ne $script:target.W -or $box.H -ne $script:target.H) {
      # A newly opened application becomes the subject, and is fitted to the panel
      # before its first frame so the view never shows a mismatched window.
      if ($null -eq $script:target -or $box.Hwnd -ne $script:target.Hwnd) {
        Sync-TargetToViewport -Target $box -W $script:viewW -H $script:viewH
        $box = Get-SandboxTarget -Desk $desk
      }
      $script:target = $box
      $script:cacheHas = $false   # the cached point was mapped in the old subject's space
      $canvas.Release()
      $canvas = New-Object Sandbox+Canvas($box.W, $box.H)
      Write-Status "target=$($box.W)x$($box.H) fallback=$($box.Hwnd -eq [IntPtr]::Zero)"
    }
    # State cadence: startup, then every 30 frames or 1000 ms, whichever first.
    $script:stateFrames = $script:stateFrames + 1
    $stateNowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($script:stateFrames -ge 30 -or ($stateNowMs - $script:stateLastMs) -ge 1000) {
      $script:stateFrames = 0
      $script:stateLastMs = $stateNowMs
      Write-State -Subject $box.Hwnd
    }
    $canvas.Fill(0x00202020)
    $taskbarSource = ''
    if ($box.Hwnd -ne [IntPtr]::Zero) {
      [Sandbox]::PrintWindow($box.Hwnd, $canvas.Dc, 2) | Out-Null
    } else {
      [Sandbox]::Composite($desk, $canvas, [ref]$taskbarSource) | Out-Null
      if ($taskbarSource -ne $script:lastTaskbarSource) {
        $script:lastTaskbarSource = $taskbarSource
        Write-Status "taskbar=$taskbarSource"
      }
    }
    $scaled = ConvertTo-Viewport -Dib $canvas.Bmp -NatW $box.W -NatH $box.H -OutW $script:viewW -OutH $script:viewH
    $ms = New-Object System.IO.MemoryStream
    $scaled.Save($ms, $codec, $encoderParams)
    $scaled.Dispose()
    $bytes = $ms.ToArray(); $ms.Dispose()
    $b64 = [Convert]::ToBase64String($bytes)
  } catch {
    Write-Status "frame-error=$($_.Exception.Message)"
    # Release the capture surface and force a clean-slate rebuild next frame.
    try { $canvas.Release() } catch { }
    $script:target = $null
    $script:cacheHas = $false
    $script:loopCount = 0
  }
  if ($null -ne $b64) {
    $payload = [Text.Encoding]::ASCII.GetBytes($b64 + "`n")
    $stdout.Write($payload, 0, $payload.Length)
    $stdout.Flush()
  }
  $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
  $wait = $frameInterval - $elapsed
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
}

$canvas.Release()
if ($KillShellsOnExit) {
  Write-Status "shells-stopped=$(Stop-SandboxShell -Desk $desk)"
}
[Sandbox]::CloseDesktop($desk) | Out-Null
[Environment]::Exit(0)
