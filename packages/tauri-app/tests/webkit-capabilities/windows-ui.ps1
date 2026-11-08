# Native accessibility driver for the isolated Windows release fixture only.
param([Parameter(Mandatory=$true)][int]$FixtureProcessId, [string]$Invoke, [string]$Value, [switch]$NativePointer, [switch]$Activate, [switch]$Escape, [switch]$Popup)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$process = Get-Process -Id $FixtureProcessId
if ($process.ProcessName -ne 'codenomad-webkit-capabilities-fixture') { throw 'Expected the isolated fixture process' }
$expected = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../target/release/codenomad-webkit-capabilities-fixture.exe'))
if ($process.Path -ne $expected) { throw 'Fixture belongs to another checkout' }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
if (!$root) { throw 'Fixture window unavailable' }
$ids = New-Object 'System.Collections.Generic.HashSet[int]'
$null = $ids.Add($FixtureProcessId)
$birth = @{ $FixtureProcessId = $process.StartTime.ToUniversalTime() }
$processes = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate
do {
  $changed = $false
  foreach ($candidate in $processes) {
    if ($ids.Contains([int]$candidate.ParentProcessId) -and $candidate.CreationDate -and ($candidate.CreationDate.ToUniversalTime() -ge $birth[[int]$candidate.ParentProcessId]) -and $ids.Add([int]$candidate.ProcessId)) {
      $birth[[int]$candidate.ProcessId] = $candidate.CreationDate.ToUniversalTime()
      $changed = $true
    }
  }
} while ($changed)
$conditions = @($ids | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$_) })
$owned = if ($conditions.Count -eq 1) { $conditions[0] } else { [System.Windows.Automation.OrCondition]::new([System.Windows.Automation.Condition[]]$conditions) }
$roots = @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $owned))
# WebView2 can present a browser-process dialog outside the native process tree.
# Admit it only through its live HWND owner chain, never by executable name.
if (!('FixtureWindowOwnership' -as [type])) { Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class FixtureWindowOwnership {
 delegate bool EnumCallback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback c,IntPtr p);
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h,uint command);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 public static int Process(IntPtr h){uint p;GetWindowThreadProcessId(h,out p);return (int)p;}
 public static IntPtr[] Owned(uint pid) {
  var result=new List<IntPtr>();
  EnumWindows((h,p)=>{
   if(!IsWindowVisible(h))return true;
   IntPtr owner=h;
   for(int depth=0;owner!=IntPtr.Zero && depth<32;depth++,owner=GetWindow(owner,4)){
    if(Process(owner)==pid){result.Add(h);break;}
   }
   return true;
  },IntPtr.Zero);
  return result.ToArray();
 }
}
'@ }
$seen = New-Object 'System.Collections.Generic.HashSet[long]'
foreach ($r in $roots) { $null=$seen.Add([long]$r.Current.NativeWindowHandle) }
foreach ($handle in [FixtureWindowOwnership]::Owned([uint32]$FixtureProcessId)) {
  if ($seen.Add($handle.ToInt64())) {
    $ownedElement=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $roots += $ownedElement
    $null=$ids.Add([int]$ownedElement.Current.ProcessId)
  }
}
if ($Popup) {
  $condition=[System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'http://127.0.0.1:18741'))
  $popups=@($roots | ForEach-Object { $_.FindAll([System.Windows.Automation.TreeScope]::Subtree,$condition) })
  $handles=@($popups | ForEach-Object { $_.Current.NativeWindowHandle } | Sort-Object -Unique)
  if($handles.Count -ne 1){throw 'Expected one owned fixture popup'}
  $roots=@($popups | Select-Object -First 1)
}
if ($Invoke) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Invoke)
  $element = $null
  foreach ($window in $roots) {
    $element = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($element) { break }
  }
  if (!$element) { throw "Fixture control unavailable: $Invoke" }
  $element.SetFocus()
  if ($NativePointer) {
    if (!('FixturePointer' -as [type])) { Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixturePointer {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
}
'@ }
    $native = $element
    while ($native -and !$native.Current.NativeWindowHandle) { $native = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($native) }
    if (!$native -or !$ids.Contains($native.Current.ProcessId)) { throw 'Native target outside the fixture' }
    $bounds = $element.Current.BoundingRectangle
    if ($bounds.IsEmpty -or $element.Current.IsOffscreen) { throw 'Fixture control is offscreen' }
    $point = New-Object FixturePointer+Point
    $point.X = [int]($bounds.X + $bounds.Width/2); $point.Y = [int]($bounds.Y + $bounds.Height/2)
    $oldDpi = [FixturePointer]::SetThreadDpiAwarenessContext([IntPtr](-4))
    try {
      $hwnd = [IntPtr]$native.Current.NativeWindowHandle
      if ($Activate) {
        $top = [FixturePointer]::GetAncestor($hwnd, 2)
        [uint32]$topProcess = 0
        $null = [FixturePointer]::GetWindowThreadProcessId($top, [ref]$topProcess)
        if (!$ids.Contains([int]$topProcess)) { throw 'Native target outside the fixture' }
        if ([FixturePointer]::IsIconic($top)) { $null=[FixturePointer]::ShowWindow($top,9) }
        if (![FixturePointer]::SetForegroundWindow($top)) { throw 'Owned fixture window cannot receive foreground input' }
        if ($Escape) {
          [FixturePointer]::keybd_event(27,0,0,[UIntPtr]::Zero)
          [FixturePointer]::keybd_event(27,0,2,[UIntPtr]::Zero)
          return
        }
        $hit = [IntPtr]::Zero
        for ($attempt=0; $attempt -lt 20; $attempt++) {
          $bounds=$element.Current.BoundingRectangle
          $point.X=[int]($bounds.X+$bounds.Width/2); $point.Y=[int]($bounds.Y+$bounds.Height/2)
          $hit=[FixturePointer]::GetAncestor([FixturePointer]::WindowFromPoint($point),2)
          if ($hit -eq $top) { break }
          [Threading.Thread]::Sleep(25)
        }
        if ($hit -ne $top) { throw 'Fixture control is covered' }
        $null = [FixturePointer]::SetCursorPos($point.X,$point.Y)
        [FixturePointer]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
        [FixturePointer]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
        return
      }
      if ($Escape) {
        if (![FixturePointer]::PostMessage($hwnd,0x100,[IntPtr]27,[IntPtr]0x10001)) { throw 'Fixture Escape refused' }
        if (![FixturePointer]::PostMessage($hwnd,0x101,[IntPtr]27,[IntPtr](-1073676287))) { throw 'Fixture Escape release refused' }
        return
      }
      if (![FixturePointer]::ScreenToClient($hwnd,[ref]$point)) { throw 'Invalid fixture coordinates' }
      $position = [IntPtr](($point.Y -shl 16) -bor ($point.X -band 65535))
      foreach ($message in @(0x200,0x201,0x202)) {
        $button = if ($message -eq 0x201) { [IntPtr]1 } else { [IntPtr]0 }
        if (![FixturePointer]::PostMessage($hwnd,$message,$button,$position)) { throw 'Native fixture input refused' }
      }
    } finally { $null = [FixturePointer]::SetThreadDpiAwarenessContext($oldDpi) }
  } elseif ($PSBoundParameters.ContainsKey('Value')) {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $pattern.SetValue($Value)
  } else {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
  }
} else {
 foreach ($root in $roots) {
  'WINDOW | ' + $root.Current.Name
  $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  for ($i=0; $i -lt [Math]::Min($elements.Count, 100); $i++) {
    $item = $elements.Item($i)
    '{0} | {1}' -f $item.Current.ControlType.ProgrammaticName, $item.Current.Name
  }
 }
}
