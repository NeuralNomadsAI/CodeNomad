/** CIM supplies relationships; retained System.Diagnostics.Process handles supply
 * exact creation ticks and bind identity checks, Stop-Process and confirmation.
 * These cmdlets/properties also work under PowerShell ConstrainedLanguage. */
export function windowsCimProcessTreeScript(rootPid: number): string {
  return `$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process)
$queue = @(${rootPid})
$ticks = @{}
while ($queue.Count -gt 0) {
  $current = [int]$queue[0]
  $queue = @($queue | Select-Object -Skip 1)
  if ($ticks.ContainsKey($current)) { continue }
  $row = $rows | Where-Object { $_.ProcessId -eq $current } | Select-Object -First 1
  if ($null -eq $row) { continue }
  $target = Get-Process -Id $current -ErrorAction SilentlyContinue
  if ($null -eq $target) { continue }
  $handle = $target.Handle
  if (-not $handle) { throw 'Process handle unavailable' }
  $start = $target.StartTime.ToUniversalTime().Ticks
  $cimStart = ([datetime]$row.CreationDate).ToUniversalTime().Ticks
  # CIM truncates to microseconds. Publish the exact handle identity, preserving
  # the persisted 100 ns format and rejecting a PID reused since the CIM scan.
  if (($start - $start % 10) -ne $cimStart) { continue }
  $parent = [int]$row.ParentProcessId
  if ($current -ne ${rootPid} -and (-not $ticks.ContainsKey($parent) -or $ticks[$parent] -gt $start)) { continue }
  $ticks[$current] = $start
  '{0}|{1}|win32:{2}' -f $current, $parent, $start
  $queue += @($rows | Where-Object { $_.ParentProcessId -eq $current -and $_.ProcessId -ne $current } | ForEach-Object { $_.ProcessId })
}`
}

export function windowsManagedTerminateScript(members: Array<{ pid: number; startIdentity: string }>): string {
  const targets = [...members].reverse().map(({ pid, startIdentity }) => `@{ Id = ${pid}; Ticks = '${startIdentity.slice(6)}' }`).join(",")
  return `$ErrorActionPreference = 'Stop'
$confirmed = $true
$processes = @()
foreach ($member in @(${targets})) {
  $lookupError = $null
  $target = Get-Process -Id $member.Id -ErrorAction SilentlyContinue -ErrorVariable lookupError
  if ($null -eq $target) {
    if ($lookupError -and $lookupError[0].FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId*') { $confirmed = $false }
    continue
  }
  try {
    # Reading Handle makes Process retain it. StartTime, Kill (Stop-Process),
    # Wait-Process and HasExited then use that same handle, even after PID reuse.
    $handle = $target.Handle
    if (-not $handle) { throw 'Process handle unavailable' }
    if ($target.StartTime.ToUniversalTime().Ticks -ne [long]$member.Ticks) { continue }
    $processes += $target
    try { Stop-Process -InputObject $target -Force } catch { if (-not $target.HasExited) { $confirmed = $false } }
  } catch { $confirmed = $false }
}
if ($processes.Count -gt 0) { Wait-Process -InputObject $processes -Timeout 1 -ErrorAction SilentlyContinue }
foreach ($target in $processes) { if (-not $target.HasExited) { $confirmed = $false } }
if ($confirmed) { 'confirmed' } else { throw 'Process tree termination unconfirmed' }`
}
