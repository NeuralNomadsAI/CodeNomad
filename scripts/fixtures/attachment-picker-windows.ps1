param([int]$OwnerPid, [string]$FilePath, [switch]$Cancel)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$dialog = $null
while ([DateTime]::UtcNow -lt $deadline -and !$dialog) {
  $owned = [System.Collections.Generic.HashSet[int]]::new()
  [void]$owned.Add($OwnerPid)
  $processes = Get-CimInstance Win32_Process
  do {
    $changed = $false
    foreach ($process in $processes) {
      if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($window in $windows) {
    if (!$owned.Contains($window.Current.ProcessId)) { continue }
    if ($window.Current.ClassName -eq '#32770') { $dialog = $window; break }
    $dialog = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770'))
    if ($dialog) { break }
  }
  if (!$dialog) { Start-Sleep -Milliseconds 100 }
}
if (!$dialog) { throw 'No owned native file dialog appeared' }
Write-Output "Native dialog: $($dialog.Current.Name), PID $($dialog.Current.ProcessId)"
function Find-Control([string]$id) {
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  return $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
if (!$Cancel) {
  $filename = Find-Control '1148'
  if (!$filename) { throw 'Native filename control missing' }
  $assigned = $false
  while (!$assigned -and [DateTime]::UtcNow -lt $deadline) {
    try {
      $value = $filename.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $value.SetValue($FilePath)
      $assigned = $true
    } catch { Start-Sleep -Milliseconds 100 }
  }
  if (!$assigned) { throw 'Native filename control did not become editable' }
  Write-Output "Filename: $($value.Current.Value)"
}
$buttonId = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $(if ($Cancel) { '2' } else { '1' }))
$buttonType = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$button = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.AndCondition]::new($buttonId, $buttonType))
if (!$button) { throw 'Native dialog action missing' }
Write-Output "Action: $($button.Current.Name)"
$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
