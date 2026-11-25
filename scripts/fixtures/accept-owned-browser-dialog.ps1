param([Parameter(Mandatory)][int]$AppProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OwnedDialog {
  delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, System.Text.StringBuilder name, int size);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  // Electron's message box is a Win32 dialog whose buttons UI Automation may not expose: send it IDOK.
  public static bool AcceptDialog(IntPtr window) {
    var name = new System.Text.StringBuilder(64);
    GetClassName(window, name, name.Capacity);
    return name.ToString() == "#32770" && PostMessage(window, 0x0111, (IntPtr)1, IntPtr.Zero);
  }
  // The process's visible top-level windows: its main window may be another one than the dialog's owner.
  public static List<IntPtr> Windows(uint processId) {
    var windows = new List<IntPtr>();
    EnumWindows((window, _) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner == processId && IsWindowVisible(window)) windows.Add(window);
      return true;
    }, IntPtr.Zero);
    return windows;
  }
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(12)
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'OK')
do {
  foreach ($window in [OwnedDialog]::Windows([uint32]$AppProcessId)) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
    foreach ($button in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
      if ($button.Current.IsOffscreen -or !$button.Current.IsEnabled) { continue }
      $pattern = $null
      if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
        Write-Output 'Accepted owned native browser dialog'
        exit 0
      }
    }
    if ([OwnedDialog]::AcceptDialog($window)) {
      Write-Output 'Accepted owned native browser dialog'
      exit 0
    }
  }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Owned native browser dialog OK button was not found'
