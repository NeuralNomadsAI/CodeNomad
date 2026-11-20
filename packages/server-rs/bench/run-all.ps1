# Every comparison in sequence: pwsh -File run-all.ps1 -OpenCode <opencode.exe> [-Only http,links]. Summary in out\summary.txt.
param([Parameter(Mandatory)][string]$OpenCode, [string[]]$Only)
$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force out | Out-Null
$runs = 'http', 'files', 'contract', 'depth', 'worktree-gone', 'links', 'search', 'memory', 'design', 'solid', 'security', 'hardening', 'launch', 'roundtrip'
$summary = foreach ($name in $runs) {
  if ($Only -and $name -notin $Only) { continue }
  $cpu = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
  $started = Get-Date
  $script, $arguments = if ($name -eq 'launch') { 'launch.mjs', @() } elseif ($name -in 'security', 'hardening', 'roundtrip') { "$name.mjs", @($OpenCode) } else { 'compare.mjs', @($name, $OpenCode) }
  node $script @arguments *> "out\$name.out"
  '{0,-14} exit={1} {2:N0}s cpuBefore={3}%' -f $name, $LASTEXITCODE, ((Get-Date) - $started).TotalSeconds, $cpu
}
$summary | Set-Content out\summary.txt
$summary
