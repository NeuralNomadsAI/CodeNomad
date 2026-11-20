# uninstall.ps1 -Root <folder> [-Purge]: stop the supervisor and remove the
# scheduled task. Releases, secrets, identity and devices stay unless -Purge.
param([Parameter(Mandatory)][string]$Root, [switch]$Purge)
. (Join-Path $PSScriptRoot 'common.ps1')
$L = Get-Layout $Root
$supervisor = Get-Pid $L 'supervisor'
if ($supervisor -and (Get-Process -Id $supervisor -ErrorAction SilentlyContinue)) {
  Set-Text (Join-Path $L.Run 'stop.request') ''
  $process = Get-Process -Id $supervisor -ErrorAction SilentlyContinue
  if ($process -and !$process.WaitForExit(30000)) { throw 'supervisor did not stop' }
}
if (Get-ScheduledTask -TaskName $L.Task -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $L.Task -Confirm:$false }
if ($Purge -and (Test-Path $L.Root)) { Remove-Item -Recurse -Force $L.Root; Write-Log 'purged' }
Write-Log "uninstalled $($L.Task)"
