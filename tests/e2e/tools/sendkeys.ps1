<#
  OS-level keystroke injector for the barcode-scanner end-to-end tests (Windows only).

  It uses user32!SendInput, i.e. the same path a real USB/Bluetooth keyboard-wedge reader takes through the Windows
  keyboard stack (the OS generates WM_KEYDOWN/WM_CHAR for the focused window), NOT a synthetic browser event.

  Usage (server mode, used by the tests): powershell -NoProfile -File sendkeys.ps1 -Server
    then write one command per line on stdin; every command answers with exactly one line ("ok ..." or "err ...").

  Commands (key=value tokens separated by spaces; text/prefix are base64(UTF-8) so any character is safe):
    ping
    state                                   -> caps=0|1 num=0|1 fg=<hwnd> fgpid=<pid>
    focus pid=<pid>                         bring the main window of that process to the foreground -> "ok focused"
    caps on|off | num on|off                set the CapsLock / NumLock toggle state
    type text=<b64> [mode=scancode|unicode|numpad|altcode] [gap=5] [suffix=enter|tab|crlf|lfctrl|none] [prefix=<b64>]
         [shift=latched] [repeat=1]
         mode=scancode  hardware-like: VkKeyScan on the current layout, Shift held around shifted characters, scan codes only
         mode=unicode   KEYEVENTF_UNICODE packets (what some Bluetooth/HID-to-keyboard bridges do)
         mode=numpad    digits via the numeric keypad scan codes (NumLock must be on)
         mode=altcode   Alt+decimal-code numeric keypad sequences ("Alt+065" style readers)
         gap            milliseconds between the keydown of one character and the next (spin-waited, sub-ms accurate)
    key name=<Enter|Tab|Escape|Backspace|F2|...> [repeat=1] [gap=30]
    hold name=<key> ms=<n> rate=<ms>        press and HOLD a key: first auto-repeat after 500 ms, then every <rate> ms (keydown repeats)
#>
param([switch]$Server, [string]$Command)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Kb {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short VkKeyScanEx(char ch, IntPtr hkl);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyEx(uint code, uint mapType, IntPtr hkl);
  [DllImport("user32.dll")] static extern short GetKeyState(int vk);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);

  const uint KEYEVENTF_EXTENDEDKEY = 1, KEYEVENTF_KEYUP = 2, KEYEVENTF_UNICODE = 4, KEYEVENTF_SCANCODE = 8;
  const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_CAPITAL = 0x14, VK_NUMLOCK = 0x90, VK_RETURN = 0x0D, VK_TAB = 0x09;
  static readonly Stopwatch SW = Stopwatch.StartNew();

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i;
  }
  static void Send(List<INPUT> l) {
    INPUT[] a = l.ToArray();
    uint n = SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
    if (n != a.Length) throw new Exception("SendInput injected " + n + "/" + a.Length + " events (err " + Marshal.GetLastWin32Error() + ")");
  }
  static bool IsExt(ushort vk) { return vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E || vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x6F || vk == 0x5B; }
  static INPUT Sc(ushort vk, bool up) {
    uint sc = MapVirtualKeyEx(vk, 0, GetKeyboardLayout(0));
    uint f = KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0) | (IsExt(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
    return Key(0, (ushort)sc, f);
  }
  public static void Wait(double ms) {
    if (ms <= 0) return;
    long end = SW.ElapsedTicks + (long)(ms * Stopwatch.Frequency / 1000.0);
    if (ms > 15) Thread.Sleep((int)(ms - 8));
    while (SW.ElapsedTicks < end) { Thread.SpinWait(30); }
  }

  public static string State() {
    uint pid; IntPtr fg = GetForegroundWindow(); GetWindowThreadProcessId(fg, out pid);
    return "caps=" + (GetKeyState(VK_CAPITAL) & 1) + " num=" + (GetKeyState(VK_NUMLOCK) & 1) + " fg=" + fg.ToInt64() + " fgpid=" + pid;
  }
  public static void SetToggle(ushort vk, bool on) {
    bool cur = (GetKeyState(vk) & 1) == 1;
    if (cur == on) return;
    List<INPUT> l = new List<INPUT>(); l.Add(Sc(vk, false)); l.Add(Sc(vk, true)); Send(l);
    Thread.Sleep(60);
  }
  public static void Caps(bool on) { SetToggle(VK_CAPITAL, on); }
  public static void Num(bool on) { SetToggle(VK_NUMLOCK, on); }

  public static string Focus(int pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == (uint)pid && IsWindowVisible(h) && GetWindowTextLength(h) > 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return "err no visible window for pid " + pid;
    if (IsIconic(found)) ShowWindow(found, 9);
    for (int attempt = 0; attempt < 6; attempt++) {
      // the classic "foreground lock" workaround: tap Alt and attach to the current foreground thread
      keybd_event((byte)VK_MENU, 0, 0, UIntPtr.Zero); keybd_event((byte)VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      IntPtr fg = GetForegroundWindow(); uint fgp; uint ft = GetWindowThreadProcessId(fg, out fgp); uint me = GetCurrentThreadId();
      if (ft != 0 && ft != me) AttachThreadInput(me, ft, true);
      BringWindowToTop(found); SetForegroundWindow(found);
      if (ft != 0 && ft != me) AttachThreadInput(me, ft, false);
      Thread.Sleep(120);
      if (GetForegroundWindow() == found) return "ok focused hwnd=" + found.ToInt64();
    }
    return "err could not take foreground (is the desktop locked / session non-interactive?) fg=" + GetForegroundWindow().ToInt64();
  }

  static void TapSc(ushort vk, bool shift, bool latched) {
    List<INPUT> l = new List<INPUT>();
    if (shift && !latched) l.Add(Sc(VK_SHIFT, false));
    l.Add(Sc(vk, false)); l.Add(Sc(vk, true));
    if (shift && !latched) l.Add(Sc(VK_SHIFT, true));
    Send(l);
  }
  static ushort NumpadVk(char c) { return (ushort)(0x60 + (c - '0')); }

  static void TypeChar(char c, string mode, bool latched) {
    if (mode == "unicode") {
      List<INPUT> l = new List<INPUT>(); l.Add(Key(0, c, KEYEVENTF_UNICODE)); l.Add(Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)); Send(l); return;
    }
    if (mode == "numpad" && c >= '0' && c <= '9') { TapSc(NumpadVk(c), false, false); return; }
    if (mode == "altcode") {
      int code = (int)c; string d = code.ToString();
      List<INPUT> l = new List<INPUT>(); l.Add(Sc(VK_MENU, false)); Send(l);
      foreach (char x in d) { Wait(2); TapSc(NumpadVk(x), false, false); }
      Wait(2); l = new List<INPUT>(); l.Add(Sc(VK_MENU, true)); Send(l); return;
    }
    short r = VkKeyScanEx(c, GetKeyboardLayout(0));
    if (r == -1) { // not on this layout: fall back to a unicode packet
      List<INPUT> l = new List<INPUT>(); l.Add(Key(0, c, KEYEVENTF_UNICODE)); l.Add(Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)); Send(l); return;
    }
    ushort vk = (ushort)(r & 0xFF); bool shift = (r & 0x100) != 0;
    // CapsLock inverts letters: a hardware reader that wants "A" while CapsLock is ON simply sends the letter WITHOUT Shift
    bool caps = (GetKeyState(VK_CAPITAL) & 1) == 1;
    if (caps && ((vk >= 0x41 && vk <= 0x5A))) { /* keep requested shift: the OS will invert, exactly like a real reader on a Caps Lock keyboard */ }
    TapSc(vk, shift, latched);
  }

  public static string Type(string text, string mode, double gap, string suffix, string prefix, bool latched, int repeat) {
    if (latched) { List<INPUT> l = new List<INPUT>(); l.Add(Sc(VK_SHIFT, false)); Send(l); }
    try {
      for (int rep = 0; rep < repeat; rep++) {
        if (rep > 0) Wait(Math.Max(gap, 50));
        long last = -1;
        Action<Action> step = delegate (Action a) {
          if (last >= 0) { double el = (SW.ElapsedTicks - last) * 1000.0 / Stopwatch.Frequency; Wait(gap - el); }
          last = SW.ElapsedTicks; a();
        };
        if (!string.IsNullOrEmpty(prefix)) foreach (char c in prefix) { char cc = c; if (cc == '\t') step(delegate { TapSc(VK_TAB, false, false); }); else if (cc == '\n') step(delegate { TapSc(VK_RETURN, false, false); }); else step(delegate { TypeChar(cc, mode, latched); }); }
        foreach (char c in text) { char cc = c; step(delegate { TypeChar(cc, mode, latched); }); }
        if (suffix == "enter") step(delegate { TapSc(VK_RETURN, false, false); });
        else if (suffix == "tab") step(delegate { TapSc(VK_TAB, false, false); });
        else if (suffix == "crlf") { step(delegate { TapSc(VK_RETURN, false, false); }); step(delegate { TapSc(VK_RETURN, false, false); }); }
        else if (suffix == "lfctrl") { step(delegate { TapSc(VK_RETURN, false, false); }); step(delegate { List<INPUT> l = new List<INPUT>(); l.Add(Sc(VK_CONTROL, false)); l.Add(Sc(0x4A, false)); l.Add(Sc(0x4A, true)); l.Add(Sc(VK_CONTROL, true)); Send(l); }); }
      }
    } finally {
      if (latched) { List<INPUT> l = new List<INPUT>(); l.Add(Sc(VK_SHIFT, true)); Send(l); }
    }
    return "ok typed=" + (text.Length * repeat);
  }

  static ushort NamedVk(string name) {
    switch (name.ToLowerInvariant()) {
      case "enter": return VK_RETURN; case "tab": return VK_TAB; case "escape": return 0x1B; case "backspace": return 0x08;
      case "space": return 0x20; case "up": return 0x26; case "down": return 0x28; case "left": return 0x25; case "right": return 0x27;
      case "delete": return 0x2E; case "f2": return 0x71; case "f4": return 0x73; case "f8": return 0x77; case "f9": return 0x78;
      case "shift": return VK_SHIFT; case "numenter": return VK_RETURN;
    }
    if (name.Length == 1) { short r = VkKeyScanEx(name[0], GetKeyboardLayout(0)); return (ushort)(r & 0xFF); }
    throw new Exception("unknown key " + name);
  }
  public static string KeyPress(string name, int repeat, double gap) {
    ushort vk = NamedVk(name);
    for (int i = 0; i < repeat; i++) { if (i > 0) Wait(gap); TapSc(vk, false, false); }
    return "ok key";
  }
  public static string Hold(string name, int ms, int rate) {
    ushort vk = NamedVk(name);
    List<INPUT> l = new List<INPUT>(); l.Add(Sc(vk, false)); Send(l); // first keydown
    long start = SW.ElapsedTicks; int count = 1; Wait(500);
    while ((SW.ElapsedTicks - start) * 1000.0 / Stopwatch.Frequency < ms) { l = new List<INPUT>(); l.Add(Sc(vk, false)); Send(l); count++; Wait(rate); }
    l = new List<INPUT>(); l.Add(Sc(vk, true)); Send(l);
    return "ok downs=" + count;
  }
}
'@ -ErrorAction Stop

function Parse-Args([string]$line) {
  $h = @{}
  foreach ($tok in ($line -split '\s+')) { if ($tok -match '^([a-z]+)=(.*)$') { $h[$Matches[1]] = $Matches[2] } elseif ($tok) { if (-not $h.ContainsKey('_')) { $h['_'] = $tok } else { $h['_2'] = $tok } } }
  return $h
}
function B64([string]$s) { if ([string]::IsNullOrEmpty($s)) { return '' } return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }

function Run-One([string]$line) {
  try {
    $a = Parse-Args $line
    $cmd = $a['_']
    switch ($cmd) {
      'ping' { return 'ok pong' }
      'state' { return 'ok ' + [Kb]::State() }
      'focus' { return [Kb]::Focus([int]$a['pid']) }
      'caps' { [Kb]::Caps($a['_2'] -eq 'on'); return 'ok ' + [Kb]::State() }
      'num' { [Kb]::Num($a['_2'] -eq 'on'); return 'ok ' + [Kb]::State() }
      'type' {
        $mode = if ($a['mode']) { $a['mode'] } else { 'scancode' }
        $gap = if ($a['gap']) { [double]$a['gap'] } else { 5.0 }
        $suffix = if ($a.ContainsKey('suffix')) { $a['suffix'] } else { 'enter' }
        $rep = if ($a['repeat']) { [int]$a['repeat'] } else { 1 }
        return [Kb]::Type((B64 $a['text']), $mode, $gap, $suffix, (B64 $a['prefix']), ($a['shift'] -eq 'latched'), $rep)
      }
      'key' { $rep = if ($a['repeat']) { [int]$a['repeat'] } else { 1 }; $g = if ($a['gap']) { [double]$a['gap'] } else { 30.0 }; return [Kb]::KeyPress($a['name'], $rep, $g) }
      'hold' { $rate = if ($a['rate']) { [int]$a['rate'] } else { 33 }; return [Kb]::Hold($a['name'], [int]$a['ms'], $rate) }
      default { return "err unknown command: $line" }
    }
  } catch { return 'err ' + ($_.Exception.Message -replace '\s+', ' ') }
}

if ($Server) {
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line -eq 'exit') { break }
    if ($line.Trim() -eq '') { continue }
    [Console]::Out.WriteLine((Run-One $line))
    [Console]::Out.Flush()
  }
} elseif ($Command) {
  Write-Output (Run-One $Command)
}
