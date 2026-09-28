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
  [switch]$KillShellsOnExit
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
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
  public static int Composite(IntPtr desk, Canvas canvas) {
    var layer = Layer(desk);
    int painted = 0;
    foreach (var win in layer) {
      var scratch = new Canvas(win.W, win.Ht);
      if (PrintWindow(win.H, scratch.Dc, 2)) {
        BitBlt(canvas.Dc, win.X, win.Y, win.W, win.Ht, scratch.Dc, 0, 0, SRCCOPY);
        painted++;
      }
      scratch.Release();
    }
    return painted;
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
}
'@

if (-not ($CaptureOnce -or $Stream)) { Write-Error 'pass -CaptureOnce or -Stream'; exit 1 }

# Before the desktop handle, the shell, or any bitmap: one unit must mean one
# physical pixel from here on.
$dpi = [Sandbox]::BeDpiAware()

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
  if ($box.Hwnd -ne [IntPtr]::Zero) {
    [Sandbox]::PrintWindow($box.Hwnd, $canvas.Dc, 2) | Out-Null
  } else {
    [Sandbox]::Composite($desk, $canvas) | Out-Null
  }
  $scaled = ConvertTo-Viewport -Dib $canvas.Bmp -NatW $box.W -NatH $box.H -OutW $Width -OutH $Height
  $scaled.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $scaled.Dispose()
  $canvas.Release()
  Write-Output "target=$($box.W)x$($box.H) fallback=$($box.Hwnd -eq [IntPtr]::Zero) out=$Out"
  [Sandbox]::CloseDesktop($desk) | Out-Null
  exit 0
}

# The state document beside the command file: the host reads it to learn the
# desktop's windows and tracked subject without parsing frames. Written at
# startup and then every 30 frames or 1000 ms, staged as .tmp so a reader never
# observes half a document. UTF-8 without a byte-order mark, because the host
# parses the bytes directly; Out-File and Set-Content would write UTF-16.
$script:statePath = ''
if ($CommandFile -ne '') { $script:statePath = "$CommandFile.state" }
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
function Invoke-InputLine([string]$line) {
  if ($null -eq $line) { return }
  $line = $line.Trim()
  if ($line -eq '') { return }
  try {
    if ($line -match '^input move (\d+) (\d+)$') {
      if ($null -eq $script:target) { $script:cacheHas = $false; return }
      $mdx = 0; $mdy = 0
      $ok = [Sandbox]::FrameToDesk([IntPtr]$script:target.Hwnd, 0, 0, [int]$script:target.W, [int]$script:target.H,
        [int]$script:viewW, [int]$script:viewH, [int]$Matches[1], [int]$Matches[2], [ref]$mdx, [ref]$mdy)
      if ($ok) { $script:cacheX = $mdx; $script:cacheY = $mdy; $script:cacheHas = $true }
      else { $script:cacheHas = $false }
      return
    }
    if ($line -match '^input button (left|right|middle) (down|up)$') {
      if (-not $script:cacheHas) { return }
      $hwnd = [Sandbox]::ResolveAt($desk, $script:cacheX, $script:cacheY)
      if ($hwnd -eq [IntPtr]::Zero) { return }
      $bit = 1; $dn = [uint32]0x0201; $up = [uint32]0x0202
      if ($Matches[1] -eq 'right') { $bit = 2; $dn = [uint32]0x0204; $up = [uint32]0x0205 }
      elseif ($Matches[1] -eq 'middle') { $bit = 16; $dn = [uint32]0x0207; $up = [uint32]0x0208 }
      # WM_MOUSEMOVE first so the window has a current position when the button flips.
      [void][Sandbox]::MouseMsg([uint32]0x0200, $hwnd, $script:cacheX, $script:cacheY, $script:mk)
      if ($Matches[2] -eq 'down') {
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
      $hwnd = [Sandbox]::ResolveAt($desk, $script:cacheX, $script:cacheY)
      if ($hwnd -eq [IntPtr]::Zero) { return }
      $mkNow = $script:mk
      if ($script:kShift) { $mkNow = $mkNow -bor 4 }
      if ($script:kCtrl) { $mkNow = $mkNow -bor 8 }
      $wDX = [int]$Matches[1]; $wDY = [int]$Matches[2]
      if ($wDY -ne 0) { [void][Sandbox]::WheelMsg($hwnd, $false, $wDY, $script:cacheX, $script:cacheY, $mkNow) }
      if ($wDX -ne 0) { [void][Sandbox]::WheelMsg($hwnd, $true, $wDX, $script:cacheX, $script:cacheY, $mkNow) }
      return
    }
    if ($line -match '^input key (\d+) (down|up)$') {
      $vk = [uint32][int]$Matches[1]
      if ($vk -lt 1 -or $vk -gt 254) { return }
      # Keys address the window under the pointer, or without a pointer yet the
      # subject itself, so a click-to-focus flow types where the user is looking.
      if ($script:cacheHas) { $hwnd = [Sandbox]::ResolveAt($desk, $script:cacheX, $script:cacheY) }
      elseif ($null -ne $script:target) { $hwnd = [IntPtr]$script:target.Hwnd }
      else { $hwnd = [IntPtr]::Zero }
      if ($hwnd -eq [IntPtr]::Zero) { return }
      $isDown = ($Matches[2] -eq 'down')
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
    if ($box.Hwnd -ne [IntPtr]::Zero) {
      [Sandbox]::PrintWindow($box.Hwnd, $canvas.Dc, 2) | Out-Null
    } else {
      [Sandbox]::Composite($desk, $canvas) | Out-Null
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
