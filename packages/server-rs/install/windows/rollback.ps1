# rollback.ps1 -Root <folder>: swap current.txt and previous.txt, restart the backend, check health.
param([Parameter(Mandatory)][string]$Root)
. (Join-Path $PSScriptRoot 'common.ps1')
$L = Get-Layout $Root
$running = Get-Pointer $L 'current'; $target = Get-Pointer $L 'previous'
if (!$target) { throw 'no previous release to roll back to' }
if (!(Test-Path (Join-Path $L.Releases "$target\codenomad-rs.exe"))) { throw "previous release $target is missing" }
# A staged release could have been altered since: it must be one accepted here,
# unchanged. The serial counter only gates new releases: it stays where it is.
if ((Test-StagedRelease $L (Join-Path $L.Releases $target)) -ne $target) { throw "previous release $target does not verify" }
Set-Pointer $L 'current' $target
Set-Pointer $L 'previous' $running
Write-Log "rolling back $running -> $target"
Request-Restart $L
& (Join-Path $PSScriptRoot 'health.ps1') -Root $L.Root
exit $LASTEXITCODE
