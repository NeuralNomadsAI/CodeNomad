param([Parameter(Mandatory)][int]$AppProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OwnedDialog {
  [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr window);
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  $process = Get-Process -Id $AppProcessId
  $handle = $process.MainWindowHandle
  foreach ($window in @($handle, [OwnedDialog]::GetLastActivePopup($handle))) {
    if ($window -eq [IntPtr]::Zero) { continue }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'OK')
    $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    foreach ($button in $buttons) {
      if ($button.Current.IsOffscreen -or !$button.Current.IsEnabled) { continue }
      $pattern = $null
      if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
        Write-Output 'Accepted owned native browser dialog'
        exit 0
      }
    }
  }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Owned native browser dialog OK button was not found'
