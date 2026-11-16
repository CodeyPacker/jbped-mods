# wininput.ps1: mouse and keyboard input for ONE private Herdr window, as window messages.
# Called by private-app (click, drag, wheel, key, type); see README.md.
#
# Safety: the target is the visible top-level window of process -ProcId, and only when that
# process is herdr-app.exe created at exactly -Ticks (the instance's recorded pid and creation
# time), checked here right before anything is sent. Nothing else is touched: messages go to that
# window handle only. The real pointer never moves (no SetCursorPos), no global input is made
# (no SendInput / keybd_event / mouse_event), no window is activated or focused, and the clipboard
# is never read or written. Modifier keys (ctrl, shift, alt) are set in the keyboard state of the
# app's own input thread for the duration of one key (AttachThreadInput + SetKeyboardState), then
# put back as they were. Every argument arrives as data: numbers, a fixed set of names, base64 text.
param(
  [Parameter(Mandatory = $true)][int]$ProcId,
  [Parameter(Mandatory = $true)][long]$Ticks,
  [Parameter(Mandatory = $true)][ValidateSet("click", "drag", "wheel", "key", "type", "info")][string]$Op,
  [int]$X = 0, [int]$Y = 0, [int]$X2 = 0, [int]$Y2 = 0,
  [ValidateSet("left", "right", "middle")][string]$Button = "left",
  [int]$Count = 1,
  [int]$Delta = 0,
  [string]$Mods = "",
  [string]$Key = "",
  [string]$Text64 = ""
)
$ErrorActionPreference = "Stop"

function Fail([string]$m, [int]$code = 2) { [Console]::Error.WriteLine("wininput: $m"); exit $code }

if ($Mods -notmatch '^(|(ctrl|shift|alt)(,(ctrl|shift|alt))*)$') { Fail "bad modifiers '$Mods'" }
if ($Key -notmatch '^[a-z0-9]*$') { Fail "bad key '$Key'" } # one character comes as c<code>: c45 is '-'
if ($Text64 -notmatch '^[A-Za-z0-9+/=]*$') { Fail "text must be base64" }
if ($Count -lt 1 -or $Count -gt 3) { Fail "count must be 1 to 3" }

$p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId"
if (-not $p -or $p.Name -ne "herdr-app.exe" -or $p.CreationDate.ToUniversalTime().Ticks -ne $Ticks) {
  Fail "refused: pid $ProcId is not the instance's herdr-app.exe (pid and creation time must match the record)"
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class PaInput {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public POINT p; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr res);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool GetKeyboardState(byte[] s);
  [DllImport("user32.dll")] static extern bool SetKeyboardState(byte[] s);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint a, uint b, uint remove);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  public static IntPtr Window; public static uint Thread;

  // The process's visible, unowned top-level window with the largest client area.
  public static bool Find(uint pid) {
    IntPtr best = IntPtr.Zero; long area = 0;
    EnumWindows((h, l) => {
      uint owner; uint tid = GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      RECT r; if (!GetClientRect(h, out r)) return true;
      long a = (long)(r.R - r.L) * (r.B - r.T);
      if (a > area) { area = a; best = h; }
      return true;
    }, IntPtr.Zero);
    if (best == IntPtr.Zero) return false;
    uint o; Thread = GetWindowThreadProcessId(best, out o);
    if (o != pid) return false;
    Window = best; return true;
  }
  public static string Info() {
    RECT r; GetClientRect(Window, out r);
    return String.Format("window 0x{0:x} client {1}x{2} dpi {3}", (long)Window, r.R - r.L, r.B - r.T, GetDpiForWindow(Window));
  }
  public static bool Inside(int x, int y) { RECT r; GetClientRect(Window, out r); return x >= 0 && y >= 0 && x < r.R && y < r.B; }

  static IntPtr XY(int x, int y) { return (IntPtr)(((long)(y & 0xFFFF) << 16) + (long)(x & 0xFFFF)); }
  static void Post(uint m, long w, IntPtr l) { if (!PostMessage(Window, m, (IntPtr)w, l)) throw new Exception("PostMessage failed"); }
  // Gives the window's thread time to take what was posted: a WM_NULL sent with
  // SendMessageTimeout returns once the thread reads its queue again (at most 2 s, and at once
  // when it hangs). Repeated with short pauses; posted messages carry no receipt of their own.
  public static void Settle(int rounds) {
    IntPtr res;
    for (int i = 0; i < rounds; i++) { SendMessageTimeout(Window, 0, IntPtr.Zero, IntPtr.Zero, 0x2 /*ABORTIFHUNG*/, 2000, out res); Sleep(15); }
  }
  public static void Sleep(int ms) { System.Threading.Thread.Sleep(ms); }

  // ---- modifier state on the app's input thread -------------------------------------------
  static byte[] saved; static bool attached;
  public static void ModsOn(bool ctrl, bool shift, bool alt) {
    MSG m; PeekMessage(out m, IntPtr.Zero, 0, 0, 0); // gives this thread a message queue
    attached = AttachThreadInput(GetCurrentThreadId(), Thread, true);
    if (!attached) throw new Exception("AttachThreadInput failed");
    saved = new byte[256]; GetKeyboardState(saved);
    byte[] s = (byte[])saved.Clone();
    Set(s, 0x11, 0xA2, ctrl); Set(s, 0x10, 0xA0, shift); Set(s, 0x12, 0xA4, alt);
    SetKeyboardState(s);
  }
  static void Set(byte[] s, int vk, int left, bool on) { if (on) { s[vk] |= 0x80; s[left] |= 0x80; } else { s[vk] &= 0x7F; s[left] &= 0x7F; } }
  public static void ModsOff() {
    if (saved != null) { SetKeyboardState(saved); saved = null; }
    if (attached) { AttachThreadInput(GetCurrentThreadId(), Thread, false); attached = false; }
  }

  // ---- mouse ------------------------------------------------------------------------------
  static long Flags(string button, bool ctrl, bool shift) {
    long f = button == "left" ? 1L : button == "right" ? 2L : 0x10L;
    return f | ModFlags(ctrl, shift);
  }
  static long ModFlags(bool ctrl, bool shift) { return (ctrl ? 8L : 0L) + (shift ? 4L : 0L); }
  public static void Click(int x, int y, string button, int count, bool ctrl, bool shift) {
    uint down = button == "left" ? 0x201u : button == "right" ? 0x204u : 0x207u;
    Post(0x200, ModFlags(ctrl, shift), XY(x, y)); Settle(1);
    for (int i = 0; i < count; i++) {
      Post(down, Flags(button, ctrl, shift), XY(x, y));
      Post(down + 1, ModFlags(ctrl, shift), XY(x, y));
      Settle(2);
    }
  }
  public static void Drag(int x1, int y1, int x2, int y2, bool ctrl, bool shift) {
    long mk = 1 | ModFlags(ctrl, shift);
    Post(0x200, ModFlags(ctrl, shift), XY(x1, y1)); Settle(1);
    Post(0x201, mk, XY(x1, y1)); Settle(1);
    int steps = Math.Max(4, Math.Min(30, (int)(Math.Sqrt((double)(x2 - x1) * (x2 - x1) + (double)(y2 - y1) * (y2 - y1)) / 12)));
    for (int i = 1; i <= steps; i++) {
      Post(0x200, mk, XY(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)); Settle(1); Sleep(10);
    }
    Post(0x202, ModFlags(ctrl, shift), XY(x2, y2)); Settle(2);
  }
  public static void Wheel(int x, int y, int delta, bool ctrl, bool shift, bool horizontal) {
    POINT p; p.X = x; p.Y = y; ClientToScreen(Window, ref p); // wheel messages carry screen coordinates
    Post(0x200, ModFlags(ctrl, shift), XY(x, y)); Settle(1);
    int left = delta;
    while (left != 0) {
      int step = Math.Max(-120, Math.Min(120, left)); left -= step;
      Post(horizontal ? 0x20Eu : 0x20Au, ((long)(step & 0xFFFF) << 16) + ModFlags(ctrl, shift), XY(p.X, p.Y));
      Settle(1);
    }
  }

  // ---- keyboard -----------------------------------------------------------------------------
  static IntPtr KeyL(uint vk, bool up, bool alt) {
    uint scan = MapVirtualKey(vk, 0);
    bool ext = vk >= 0x21 && vk <= 0x2E; // page up .. delete, arrows, insert: extended keys
    long l = 1L + ((long)scan << 16) + (ext ? 1L << 24 : 0L) + (alt ? 1L << 29 : 0L);
    if (up) l |= (1L << 30) | (1L << 31);
    return (IntPtr)l;
  }
  // One key with modifiers. The app turns WM_KEYDOWN into its keystroke and, for a typing key,
  // WM_CHAR, the way a real key press arrives.
  public static void Key(uint vk, bool ctrl, bool shift, bool alt) {
    ModsOn(ctrl, shift, alt);
    try {
      Settle(1);
      Post(alt ? 0x104u : 0x100u, vk, KeyL(vk, false, alt));
      Settle(3);
      Post(alt ? 0x105u : 0x101u, vk, KeyL(vk, true, alt));
      Settle(2);
    } finally { ModsOff(); }
  }
  // Text: each character through its key when the keyboard layout has one (with shift if it
  // needs it), else as WM_CHAR alone (a text box takes it; a key handler sees nothing).
  public static void Type(string text) {
    foreach (char c in text.Replace("\r\n", "\n")) {
      if (c == '\n') { Key(0x0D, false, false, false); continue; }
      if (c == '\t') { Key(0x09, false, false, false); continue; }
      short k = VkKeyScan(c);
      int mods = (k >> 8) & 0xFF;
      if (k != -1 && (mods & ~1) == 0) { Key((uint)(k & 0xFF), false, (mods & 1) != 0, false); continue; }
      Post(0x102, c, (IntPtr)1); Settle(2);
    }
  }
  public static uint VkOf(char c) { short k = VkKeyScan(c); return k == -1 ? 0 : (uint)(k & 0xFF); }
}
"@

if (-not [PaInput]::Find([uint32]$ProcId)) { Fail "no visible window for pid $ProcId" 3 }
# The window must still belong to the checked process (pid reuse between the check and now).
$p2 = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId"
if (-not $p2 -or $p2.CreationDate.ToUniversalTime().Ticks -ne $Ticks) { Fail "refused: the process changed" }

$m = @{}; foreach ($mod in ($Mods -split ",")) { if ($mod) { $m[$mod] = $true } }
$ctrl = [bool]$m['ctrl']; $shift = [bool]$m['shift']; $alt = [bool]$m['alt']

function Need-Inside([int]$a, [int]$b) { if (-not [PaInput]::Inside($a, $b)) { Fail "($a, $b) is outside the window's client area ($([PaInput]::Info()))" } }

$named = @{
  escape = 0x1B; enter = 0x0D; tab = 0x09; space = 0x20; backspace = 0x08; delete = 0x2E; insert = 0x2D
  up = 0x26; down = 0x28; left = 0x25; right = 0x27; home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22
}
switch ($Op) {
  "info" { [PaInput]::Info() }
  "click" {
    Need-Inside $X $Y
    if ($ctrl -or $shift) { [PaInput]::ModsOn($ctrl, $shift, $false) }
    try { [PaInput]::Click($X, $Y, $Button, $Count, $ctrl, $shift) } finally { [PaInput]::ModsOff() }
    "clicked $Button x$Count at $X,$Y"
  }
  "drag" {
    Need-Inside $X $Y; Need-Inside $X2 $Y2
    if ($ctrl -or $shift) { [PaInput]::ModsOn($ctrl, $shift, $false) }
    try { [PaInput]::Drag($X, $Y, $X2, $Y2, $ctrl, $shift) } finally { [PaInput]::ModsOff() }
    "dragged $X,$Y -> $X2,$Y2"
  }
  "wheel" {
    Need-Inside $X $Y
    if ($Delta -eq 0 -or [Math]::Abs($Delta) -gt 120 * 50) { Fail "delta must be nonzero, at most 6000" }
    if ($ctrl -or $shift) { [PaInput]::ModsOn($ctrl, $shift, $false) }
    try { [PaInput]::Wheel($X, $Y, $Delta, $ctrl, $shift, $false) } finally { [PaInput]::ModsOff() }
    "wheel $Delta at $X,$Y"
  }
  "key" {
    $vk = 0
    if ($named.ContainsKey($Key)) { $vk = $named[$Key] }
    elseif ($Key -match '^f([1-9]|1[0-9]|2[0-4])$') { $vk = 0x6F + [int]$Matches[1] }
    elseif ($Key -match '^c([0-9]{2,3})$') { $vk = [PaInput]::VkOf([char][int]$Matches[1]) }
    elseif ($Key.Length -eq 1) { $vk = [PaInput]::VkOf($Key[0]) }
    if ($vk -eq 0) { Fail "unknown key '$Key'" }
    [PaInput]::Key([uint32]$vk, $ctrl, $shift, $alt)
    "key $Mods $Key"
  }
  "type" {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Text64))
    [PaInput]::Type($text)
    "typed $($text.Length) characters"
  }
}
