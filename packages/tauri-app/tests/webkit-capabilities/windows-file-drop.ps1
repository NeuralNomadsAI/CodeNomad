# Native mouse input, fenced to the owned source and the isolated fixture.
param([Parameter(Mandatory=$true)][int]$FixtureProcessId,
      [Parameter(Mandatory=$true)][int]$SourceProcessId)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-ui.ps1" -FixtureProcessId $FixtureProcessId | Out-Null
$source = Get-CimInstance Win32_Process -Filter "ProcessId=$SourceProcessId"
$sourceScript = Join-Path $PSScriptRoot 'windows-file-source.ps1'
if ($source.CommandLine.Replace('/', '\') -notlike "*$sourceScript*") { throw 'Expected the owned native file source' }
$sourceProcess = Get-Process -Id $SourceProcessId
$sourceRoot = [System.Windows.Automation.AutomationElement]::FromHandle($sourceProcess.MainWindowHandle)
$button = $sourceRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'Drag fixture file'))
$target = $roots | ForEach-Object { $_.FindAll([System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'Drop file')) } | Select-Object -First 1
if (!$button -or !$target -or $target.Current.IsOffscreen) { throw 'Visible fixture drag endpoints unavailable' }
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class NativeFileDrag {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$dpi = [NativeFileDrag]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
 $start=$button.Current.BoundingRectangle; $end=$target.Current.BoundingRectangle
 $sx=[int]($start.X+$start.Width/2); $sy=[int]($start.Y+$start.Height/2)
 $ex=[int]($end.X+[Math]::Min(30,$end.Width/2)); $ey=[int]($end.Y+$end.Height/2)
 if(![NativeFileDrag]::SetForegroundWindow($sourceProcess.MainWindowHandle)){ throw 'Source cannot receive input' }
 $null=[NativeFileDrag]::SetCursorPos($sx,$sy)
 [NativeFileDrag]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
 try {
  for($i=1;$i -le 40;$i++){
   $null=[NativeFileDrag]::SetCursorPos([int]($sx+($ex-$sx)*$i/40),[int]($sy+($ey-$sy)*$i/40))
   [Threading.Thread]::Sleep(25)
  }
 } finally { [NativeFileDrag]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
} finally { $null=[NativeFileDrag]::SetThreadDpiAwarenessContext($dpi) }
