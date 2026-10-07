# Isolated native F6 check. Never launches CodeNomad, OpenCode or a user profile.
param([switch]$Baseline, [switch]$Decorated, [switch]$Capture)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This regression requires Windows.' }
$root = Split-Path $PSScriptRoot -Parent
Push-Location "$root/packages/tauri-app/src-tauri"
try { cargo build --example f6_windows; if ($LASTEXITCODE) { throw 'Fixture build failed.' } }
finally { Pop-Location }
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IsolatedF6Input {
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct Union { [FieldOffset(0)] public Keyboard keyboard; [FieldOffset(0)] public Mouse mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public Union value; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w,out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a,uint b,bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr w);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr w,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr w,out Rect r);
  public static Rect Bounds(IntPtr w) { Rect r; if(!GetWindowRect(w,out r)) throw new Exception("Fixture bounds unavailable"); return r; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr w,uint flags);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
  [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] input,int size);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  public static void Activate(IntPtr w) {
    uint pid; var current=GetCurrentThreadId(); var foreground=GetWindowThreadProcessId(GetForegroundWindow(),out pid); var target=GetWindowThreadProcessId(w,out pid);
    bool a=current!=foreground && AttachThreadInput(current,foreground,true); bool b=current!=target && target!=foreground && AttachThreadInput(current,target,true);
    try { SetForegroundWindow(w); }
    finally { if(b) AttachThreadInput(current,target,false); if(a) AttachThreadInput(current,foreground,false); }
  }
  public static void Click(IntPtr w) {
    Rect r; if(!GetWindowRect(w,out r)) throw new Exception("Missing fixture bounds");
    var p=new Point {x=r.left+120,y=r.top+100}; if(GetAncestor(WindowFromPoint(p),2)!=w) throw new Exception("Fixture obscured; no click sent");
    Point old; GetCursorPos(out old);
    try { SetCursorPos(p.x,p.y); mouse_event(2,0,0,0,UIntPtr.Zero); mouse_event(4,0,0,0,UIntPtr.Zero); }
    finally { SetCursorPos(old.x,old.y); }
  }
  public static void Press(IntPtr w,ushort key,ushort modifier=0) {
    if(GetForegroundWindow()!=w) throw new Exception("Focus changed; no key sent");
    foreach(var k in new[]{0x10,0x11,0x12}) if(GetAsyncKeyState(k)<0) throw new Exception("User modifier held; no key sent");
    var down=new Input {type=1}; down.value.keyboard.key=key; var up=down; up.value.keyboard.flags=2;
    var mod=new Input {type=1}; mod.value.keyboard.key=modifier; var modUp=mod; modUp.value.keyboard.flags=2;
    var input=modifier==0?new[]{down,up}:new[]{mod,down,up,modUp};
    if(SendInput((uint)input.Length,input,Marshal.SizeOf<Input>())!=input.Length) {
      var releases=modifier==0?new[]{up}:new[]{up,modUp}; SendInput((uint)releases.Length,releases,Marshal.SizeOf<Input>());
      throw new Exception("Native input incomplete");
    }
  }
}
'@
$exe = [IO.Path]::GetFullPath("$root/packages/tauri-app/target/debug/examples/f6_windows.exe")
$log = Join-Path ([IO.Path]::GetTempPath()) "opencode/issue875-$([guid]::NewGuid().ToString('N')).out"
$launch = @{FilePath=$exe;PassThru=$true;RedirectStandardOutput=$log;RedirectStandardError="$log.err"}
$arguments = @()
if (-not $Baseline) { $arguments += '--handled' }
if ($Decorated) { $arguments += '--decorated' }
if ($arguments.Count) { $launch.ArgumentList=$arguments }
$previous = [IsolatedF6Input]::GetForegroundWindow()
$process = Start-Process @launch
$oldDpi = [IsolatedF6Input]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 100
    $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
    if ($text -match 'READY PID=(\d+) HWND=(\d+)') { $ownerPid=[int]$Matches[1]; $window=[IntPtr][long]$Matches[2]; break }
  } while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited)
  if (-not $window -or $ownerPid -ne $process.Id -or (Get-Process -Id $ownerPid).Path -ne $exe) { throw 'Unexpected fixture identity; no input sent.' }
  [uint32]$owner = 0
  [void][IsolatedF6Input]::GetWindowThreadProcessId($window,[ref]$owner)
  if ($owner -ne $ownerPid) { throw 'Fixture HWND changed; no input sent.' }
  Start-Sleep -Seconds 2
  [void][IsolatedF6Input]::SetWindowPos($window,[IntPtr](-1),40,40,800,600,0)
  [IsolatedF6Input]::Activate($window)
  Start-Sleep -Milliseconds 200
  if ([IsolatedF6Input]::GetForegroundWindow() -ne $window) { throw 'Fixture not foreground; no input sent.' }
  [IsolatedF6Input]::Click($window)
  Start-Sleep -Milliseconds 100
  [IsolatedF6Input]::Press($window,0x75)
  if (-not $Baseline) {
    foreach ($modifier in @(0x10,0x11)) { Start-Sleep -Milliseconds 100; [IsolatedF6Input]::Press($window,0x75,$modifier) }
    Start-Sleep -Milliseconds 100
    [IsolatedF6Input]::Press($window,0x77)
  }
  if ($Capture) {
    Add-Type -AssemblyName System.Drawing
    $bounds = [IsolatedF6Input]::Bounds($window)
    $size = [Drawing.Size]::new($bounds.right-$bounds.left,$bounds.bottom-$bounds.top)
    if ($size.Width -le 0 -or $size.Height -le 0 -or $size.Width*$size.Height -gt 20000000) { throw 'Invalid fixture capture bounds.' }
    $bitmap = [Drawing.Bitmap]::new($size.Width,$size.Height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen($bounds.left,$bounds.top,0,0,$size); $bitmap.Save("$log.png",[Drawing.Imaging.ImageFormat]::Png) }
    finally { $graphics.Dispose(); $bitmap.Dispose() }
    "CAPTURE=$log.png"
  }
  if (-not $process.WaitForExit(20000)) { throw 'Owned fixture watchdog expired.' }
  $output = Get-Content $log -Raw
  $output
  Get-Content "$log.err"
  if (-not $Baseline -and $output -notmatch 'RESULT passed=true') { throw "F6 native/DOM check failed: $log" }
} finally {
  # Only the process created above is allowed to close; never touch desktop/daemon.
  if (-not $process.HasExited) { [void]$process.CloseMainWindow(); if (-not $process.WaitForExit(5000)) { $process.Kill() } }
  [IsolatedF6Input]::Activate($previous)
  [void][IsolatedF6Input]::SetThreadDpiAwarenessContext($oldDpi)
}
