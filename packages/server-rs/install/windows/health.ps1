# health.ps1 -Root <folder> [-TimeoutSeconds 45]
# The running backend must be releases\<current>\codenomad-rs.exe, answer an
# authenticated /api/meta with the persisted serverId and report its bundled
# plugins provisioned by this very process. Prints one JSON line; exit 1 otherwise.
param([Parameter(Mandatory)][string]$Root, [int]$TimeoutSeconds = 45)
. (Join-Path $PSScriptRoot 'common.ps1')
$L = Get-Layout $Root
$port = (Read-Env (Join-Path $L.Config 'install.conf'))['PORT']
$password = (Read-Env (Join-Path $L.Config 'codenomad-rs.env'))['CNRS_SERVER_PASSWORD']
$version = Get-Pointer $L 'current'
$expected = [IO.Path]::GetFullPath((Join-Path $L.Releases "$version\codenomad-rs.exe"))
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$reason = 'starting'
while ([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Seconds 1
  $id = Get-Pid $L 'rust'
  $process = if ($id) { Get-Process -Id $id -ErrorAction SilentlyContinue }
  if (!$process) { $reason = 'backend not running'; continue }
  if ($process.Path -ne $expected) { $reason = 'running binary is not the current release'; continue }
  try {
    $base = "http://127.0.0.1:$port"
    Invoke-RestMethod -NoProxy -Method Post "$base/api/auth/login" -ContentType 'application/json' -SessionVariable session `
      -Body (@{ username = 'codenomad'; password = $password } | ConvertTo-Json -Compress) -TimeoutSec 5 | Out-Null
    $meta = Invoke-RestMethod -NoProxy "$base/api/meta" -WebSession $session -TimeoutSec 5
  } catch { $reason = 'meta unavailable'; continue }
  $releaseVersion = ([IO.File]::ReadAllText((Join-Path $L.Releases "$version\VERSION"))).Trim()
  if ("$($meta.serverVersion)" -ne $releaseVersion) { $reason = 'serverVersion differs from the current release VERSION'; continue }
  $identity = Get-Content -Raw (Join-Path $L.State 'host.json') | ConvertFrom-Json
  if ($meta.serverId -ne $identity.serverId) { $reason = 'serverId differs from host.json'; continue }
  $statusFile = Join-Path $L.State 'host.data\plugin-provision.json'
  $status = if (Test-Path $statusFile) { Get-Content -Raw $statusFile | ConvertFrom-Json }
  if (!$status -or $status.state -ne 'provisioned' -or $status.pid -ne $id -or @($status.features).Count -ne $status.expected) { $reason = 'bundled plugins not provisioned'; continue }
  $field = { param($name) $p = $meta.PSObject.Properties[$name]; if ($p) { "$($p.Value)" } else { '' } }
  [ordered]@{ healthy = $true; version = $version; serverVersion = $meta.serverVersion; serverId = $meta.serverId; pid = $id; connections = $status.connections
    remoteUrl = & $field 'remoteUrl'; tlsFingerprint = & $field 'tlsFingerprint'
    plugins = @($status.features | ForEach-Object { [ordered]@{ feature = $_.feature; sha256 = $_.sha256; provider = $_.provider; ready = $_.ready } }) } |
    ConvertTo-Json -Compress -Depth 5
  exit 0
}
[ordered]@{ healthy = $false; version = $version; reason = $reason } | ConvertTo-Json -Compress
exit 1
