# install.ps1 -Root <folder> -Release <release> -OpenCode <opencode.exe> -Tools <folder> -PublicKey <release.pub>
#   [-Port 47911] [-DaemonPort 47913] [-Plugins 1|<list>] [-HttpsBind IP:PORT -HttpsName NAME] [-TestMarkers <folder>]
# Idempotent first install of the per-user background service: a scheduled task
# of the current user (at logon, no elevation) starts bin\cnrs-supervisor.exe, a
# Windows-subsystem executable without console. -Tools holds cnrs-release.exe and
# cnrs-supervisor.exe; -PublicKey is pinned on the first install, every release
# must verify against the pinned key and carry a serial above the highest one
# accepted (see common.ps1 Install-Release). Everything lives under -Root.
param(
  [Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Release, [Parameter(Mandatory)][string]$OpenCode,
  [string]$Tools = '', [string]$PublicKey = '', [int]$Port = 0, [int]$DaemonPort = 0, [string]$Plugins = '',
  [string]$HttpsBind = '', [string]$HttpsName = '', [string]$TestMarkers = ''
)
. (Join-Path $PSScriptRoot 'common.ps1')
$L = Get-Layout $Root
# E1: the root is private before anything is created in it; children inherit that DACL.
Initialize-PrivateRoot $L.Root
foreach ($dir in $L.Run, $L.Bin, $L.OpenCode) { New-Item -ItemType Directory -Force $dir | Out-Null }
Protect-Folder $L.Config; Protect-Folder $L.State
if (!(Get-Trust $L | Where-Object { Test-Path $_ }) -and (!$PublicKey -or !$Tools)) { throw 'first install needs -PublicKey and -Tools' }
if ($Tools) {
  foreach ($name in 'cnrs-release.exe', 'cnrs-supervisor.exe') {
    $source = Join-Path $Tools $name; $target = Join-Path $L.Bin $name
    if (!(Test-Path $target) -or (Get-FileHash $source).Hash -ne (Get-FileHash $target).Hash) {
      # The running supervisor keeps its image; a changed one applies at its next start.
      if (Test-Path $target) { Move-Item -Force $target "$target.$([guid]::NewGuid()).old" }
      Copy-Item $source $target
    }
  }
}
if ($PublicKey) {
  # First install: pins the key at serial 0. Later: the key must be the pinned one
  # (after a rotation, the announced key); refused when releases are staged
  # without a trust state (restore it or -Purge).
  $pinned = "$(& (Join-Path $L.Bin 'cnrs-release.exe') pin $PublicKey @(Get-Trust $L) $L.Releases 2>&1)".Trim()
  if ($LASTEXITCODE) { throw "release key refused: $pinned" }
  if ($pinned) { Write-Log $pinned }
}
$version = Install-Release $L $Release
$before = (Get-ChildItem $L.Config -File | Sort-Object Name | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`0"

# Pinned copy of the native CLI, independent of any global OpenCode install.
$reported = "$(& $OpenCode --version)".Trim()
if ($reported -notmatch '^(?:opencode v)?(\d+\.\d+\.\d+)$') { throw "unexpected OpenCode version '$reported'" }
$nativeVersion = $Matches[1]
$nativeDir = Join-Path $L.OpenCode $nativeVersion
if (!(Test-Path "$nativeDir\opencode.exe")) {
  New-Item -ItemType Directory -Force "$nativeDir.tmp" | Out-Null
  Copy-Item $OpenCode "$nativeDir.tmp\opencode.exe"
  Rename-Item "$nativeDir.tmp" $nativeVersion
}
Set-Text (Join-Path $L.OpenCode 'current.txt') $nativeVersion

$secret = { [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) -replace '[/+=]', '' }
$conf = Read-Env (Join-Path $L.Config 'install.conf')
if ($Port) { $conf['PORT'] = "$Port" } elseif (!$conf.Contains('PORT')) { $conf['PORT'] = '47911' }
# Fixed daemon endpoint: the backend reconnects (and reprovisions) after a daemon restart.
if ($DaemonPort) { $conf['DAEMON_PORT'] = "$DaemonPort" } elseif (!$conf.Contains('DAEMON_PORT')) { $conf['DAEMON_PORT'] = '47913' }
Write-Env (Join-Path $L.Config 'install.conf') $conf

$oc = Join-Path $L.State 'opencode'
$daemon = Read-Env (Join-Path $L.Config 'opencode.env')
# One profile for every daemon, started by the supervisor or by the backend's CLI discovery:
# its database and service record keep their defaults inside the profile.
foreach ($pair in @(@('USERPROFILE', $oc), @('HOME', $oc), @('APPDATA', "$oc\AppData\Roaming"), @('LOCALAPPDATA', "$oc\AppData\Local"),
    @('TEMP', "$oc\tmp"), @('TMP', "$oc\tmp"), @('XDG_DATA_HOME', "$oc\data"), @('XDG_CONFIG_HOME', "$oc\config"),
    @('XDG_CACHE_HOME', "$oc\cache"),
    @('OPENCODE_DISABLE_MODELS_FETCH', '1'), @('OPENCODE_DISABLE_FFF', '1'), @('OPENCODE_CONFIG_PROJECT_DISABLE', '1'))) {
  $daemon[$pair[0]] = $pair[1]
}
foreach ($key in 'XDG_STATE_HOME', 'OPENCODE_DB') { $daemon.Remove($key) }
$db = "$oc\data\opencode\opencode.db"
if ((Test-Path "$oc\native.db") -and !(Test-Path $db)) {
  $supervisor = Get-Pid $L 'supervisor'
  $process = if ($supervisor) { Get-Process -Id $supervisor -ErrorAction SilentlyContinue }
  if ($process) {
    Set-Text (Join-Path $L.Run 'stop.request') ''
    if (!$process.WaitForExit(30000)) { throw 'supervisor did not stop' }
  }
  New-Item -ItemType Directory -Force (Split-Path $db) | Out-Null
  foreach ($suffix in '', '-wal', '-shm') { if (Test-Path "$oc\native.db$suffix") { Move-Item "$oc\native.db$suffix" "$db$suffix" } }
  Write-Log "moved the daemon database to $db"
}
if (!$daemon.Contains('OPENCODE_SERVER_PASSWORD')) { $daemon['OPENCODE_SERVER_PASSWORD'] = & $secret }
if ($TestMarkers) { $daemon['CNRS_TEST_PLUGIN_MARKERS'] = $TestMarkers; New-Item -ItemType Directory -Force $TestMarkers | Out-Null }
Write-Env (Join-Path $L.Config 'opencode.env') $daemon
foreach ($dir in "$oc\AppData\Roaming", "$oc\AppData\Local", "$oc\tmp", (Join-Path $L.State 'projects')) { New-Item -ItemType Directory -Force $dir | Out-Null }
# A daemon the backend starts listens where the supervisor's does.
$saved = @{}
foreach ($key in $daemon.Keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key); [Environment]::SetEnvironmentVariable($key, $daemon[$key]) }
try {
  foreach ($pair in @(@('port', $conf['DAEMON_PORT']), @('hostname', '127.0.0.1'))) {
    & "$nativeDir\opencode.exe" service set $pair[0] $pair[1] | Out-Null
    if ($LASTEXITCODE) { throw "opencode service set $($pair[0]) failed" }
  }
} finally { foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) } }

$rust = Read-Env (Join-Path $L.Config 'codenomad-rs.env')
if (!$rust.Contains('CNRS_SERVER_PASSWORD')) { $rust['CNRS_SERVER_PASSWORD'] = & $secret }
# The backend finds (or starts) the daemon through its CLI, which reads the daemon's profile.
$rust.Remove('CNRS_OPENCODE_SERVICE_FILE')
foreach ($key in 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_FFF', 'OPENCODE_CONFIG_PROJECT_DISABLE') { $rust[$key] = $daemon[$key] }
if ($Plugins) { $rust['CNRS_PROVISION_PLUGINS'] = $Plugins } elseif (!$rust.Contains('CNRS_PROVISION_PLUGINS')) { $rust['CNRS_PROVISION_PLUGINS'] = '1' }
$rust['CNRS_PLUGIN_PROFILE_ROOT'] = $oc
if ($HttpsBind) {
  if (!$HttpsName) { throw '-HttpsBind needs -HttpsName' }
  $rust['CNRS_HTTPS_BIND'] = $HttpsBind; $rust['CNRS_HTTPS_NAME'] = $HttpsName
}
Write-Env (Join-Path $L.Config 'codenomad-rs.env') $rust
$changed = $before -ne ((Get-ChildItem $L.Config -File | Sort-Object Name | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`0")

if (!(Get-Pointer $L 'current')) { Set-Pointer $L 'current' $version }
Assert-PrivateTree $L

$action = New-ScheduledTaskAction -Execute (Join-Path $L.Bin 'cnrs-supervisor.exe') -Argument "`"$($L.Root)`""
$task = Get-ScheduledTask -TaskName $L.Task -ErrorAction SilentlyContinue
if (!$task -or $task.Actions[0].Execute -ne $action.Execute -or $task.Actions[0].Arguments -ne $action.Arguments) {
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  # Interactive token of the current user, limited rights: no elevation needed.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $L.Task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "CodeNomad Rust backend ($($L.Root))" -Force | Out-Null
  Write-Log "registered task $($L.Task)"
}
$running = Get-Pid $L 'supervisor'
if ($running -and (Get-Process -Id $running -ErrorAction SilentlyContinue)) {
  if ($changed) { Write-Log 'configuration changed: restarting the backend'; Request-Restart $L }
} else {
  Start-ScheduledTask -TaskName $L.Task
}
& (Join-Path $PSScriptRoot 'health.ps1') -Root $L.Root
if ($LASTEXITCODE) { exit $LASTEXITCODE }
