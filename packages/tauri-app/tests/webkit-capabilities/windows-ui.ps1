# Native accessibility driver for the isolated Windows release fixture only.
param([Parameter(Mandatory=$true)][int]$FixtureProcessId, [string]$Invoke, [string]$Value, [switch]$NativePointer, [switch]$Activate, [switch]$Escape)
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
$roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $owned)
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
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixturePointer {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
}
'@
    $native = $element
    while ($native -and !$native.Current.NativeWindowHandle) { $native = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($native) }
    if (!$native -or !$ids.Contains($native.Current.ProcessId)) { throw 'Native target outside the fixture' }
    $bounds = $element.Current.BoundingRectangle
    if ($bounds.IsEmpty -or $element.Current.IsOffscreen) { throw 'Fixture control is offscreen' }
    $point = New-Object FixturePointer+Point
    $point.X = [int]($bounds.X + $bounds.Width/2); $point.Y = [int]($bounds.Y + $bounds.Height/2)
    $oldDpi = [FixturePointer]::SetThreadDpiAwarenessContext([IntPtr](-4))
    try {
      if ($Activate -and ![FixturePointer]::SetForegroundWindow($process.MainWindowHandle)) { throw 'Fixture cannot receive foreground input' }
      $hwnd = [IntPtr]$native.Current.NativeWindowHandle
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
