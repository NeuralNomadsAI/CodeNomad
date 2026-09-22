param([int]$OwnerPid, [ValidateSet('snapshot','dismiss','focus','select')] [string]$Action='snapshot', [long]$Handle=0, [int]$Index=0, [long]$MenuHandle=0)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeMenuFixture {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  public static void Focus(IntPtr hwnd) {
    uint pid; var targetThread=GetWindowThreadProcessId(hwnd, out pid);
    var thread=GetCurrentThreadId();
    var attached=AttachThreadInput(thread, targetThread, true);
    try { ShowWindow(hwnd, 9); SetForegroundWindow(hwnd); }
    finally { if (attached) AttachThreadInput(thread, targetThread, false); }
  }
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr menu, uint index, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr menu, uint index, StringBuilder text, int size, uint flags);
  public static object[] Windows(int owner) {
    var result = new List<object>();
    EnumWindows((hwnd, _) => { uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid != owner) return true;
      var cls=new StringBuilder(256); var title=new StringBuilder(256);
      GetClassName(hwnd, cls, 256); GetWindowText(hwnd, title, 256);
      result.Add(new { handle=hwnd.ToInt64(), cls=cls.ToString(), title=title.ToString() }); return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
$windows=@([NativeMenuFixture]::Windows($OwnerPid))
if ($Handle -and -not ($windows | Where-Object handle -eq $Handle)) { throw 'Target is not owned by fixture process' }
if ($Action -eq 'focus') {
  [NativeMenuFixture]::Focus([IntPtr]$Handle)
  if ([NativeMenuFixture]::GetForegroundWindow().ToInt64() -ne $Handle) { throw 'Fixture foreground did not change' }
}
$popups=@($windows | Where-Object cls -eq '#32768')
if ($Action -eq 'dismiss') {
  foreach ($popup in $popups) { [void][NativeMenuFixture]::PostMessage([IntPtr]$popup.handle, 0x100, [IntPtr]27, [IntPtr]0) }
}
if ($Action -eq 'select') {
  if ($popups.Count -ne 1) { throw 'Expected one fixture popup' }
  $popup=[IntPtr]$popups[0].handle
  [void][NativeMenuFixture]::PostMessage($popup, 0x100, [IntPtr]36, [IntPtr]0)
  for ($i=0; $i -lt $Index; $i++) { [void][NativeMenuFixture]::PostMessage($popup, 0x100, [IntPtr]40, [IntPtr]0) }
  [void][NativeMenuFixture]::PostMessage($popup, 0x100, [IntPtr]13, [IntPtr]0)
}
if ($Action -ne 'snapshot') { @{ok=$true;foreground=[NativeMenuFixture]::GetForegroundWindow().ToInt64()} | ConvertTo-Json -Compress; exit }
if ($MenuHandle) {
  if (-not $Handle) { throw 'Retained menu reads require its fixture-owned window' }
  $popups=@([pscustomobject]@{handle=$Handle})
}
$menus=@(foreach ($popup in $popups) {
  $menu=[IntPtr]::Zero
  if ($MenuHandle) { $menu=[IntPtr]$MenuHandle }
  elseif ([NativeMenuFixture]::SendMessageTimeout([IntPtr]$popup.handle, 0x1e1, [IntPtr]0, [IntPtr]0, 2, 1000, [ref]$menu) -eq [IntPtr]::Zero) { throw 'Native popup is unresponsive' }
  if ([NativeMenuFixture]::GetMenuItemCount($menu) -lt 0) { throw 'Invalid retained menu' }
  $items=@(for ($i=0; $i -lt [NativeMenuFixture]::GetMenuItemCount($menu); $i++) {
    $text=New-Object System.Text.StringBuilder 512
    [void][NativeMenuFixture]::GetMenuString($menu, $i, $text, 512, 0x400)
    $state=[NativeMenuFixture]::GetMenuState($menu, $i, 0x400)
    [pscustomobject]@{index=$i;text=$text.ToString();enabled=($state -band 3) -eq 0;checked=($state -band 8) -ne 0}
  })
  [pscustomobject]@{handle=$popup.handle;menuHandle=$menu.ToInt64();items=$items}
})
[pscustomobject]@{windows=$windows;menus=$menus;foreground=[NativeMenuFixture]::GetForegroundWindow().ToInt64()} | ConvertTo-Json -Depth 8 -Compress
