# update.ps1 -Root <folder> -Release <release folder>
# Stages the release beside the others, keeps the running one in previous.txt,
# switches current.txt, restarts the backend (the OpenCode daemon keeps running)
# and rolls back automatically when the health check fails (exit 2).
param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Release)
. (Join-Path $PSScriptRoot 'common.ps1')
$L = Get-Layout $Root
Assert-PrivateTree $L
$version = Install-Release $L $Release
$running = Get-Pointer $L 'current'
if (!$running) { throw 'not installed: run install.ps1' }
$health = Join-Path $PSScriptRoot 'health.ps1'
if ($running -eq $version) { Write-Log "release $version is already current"; & $health -Root $L.Root; exit $LASTEXITCODE }
$priorPrevious = Get-Pointer $L 'previous'
Set-Pointer $L 'previous' $running
Set-Pointer $L 'current' $version
Write-Log "updating $running -> $version"
$ok = $true
try { Request-Restart $L } catch { $ok = $false; Write-Log $_.Exception.Message }
if ($ok) { & $health -Root $L.Root; $ok = $LASTEXITCODE -eq 0 }
if ($ok) { Write-Log "release $version healthy"; exit 0 }
Write-Log "release $version failed its health check: rolling back to $running"
Get-Content (Join-Path $L.Run 'logs\supervisor.log') -Tail 5 | ForEach-Object { Write-Log $_ }
# The failed release never becomes a rollback target.
Set-Pointer $L 'current' $running
if ($priorPrevious) { Set-Pointer $L 'previous' $priorPrevious } else { Remove-Item (Join-Path $L.Root 'previous.txt') }
Request-Restart $L 30
& $health -Root $L.Root
if ($LASTEXITCODE) { throw "rollback to $running is unhealthy too" }
Write-Log "rolled back to $running"
exit 2
