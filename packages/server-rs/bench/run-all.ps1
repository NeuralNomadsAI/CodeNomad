# Every comparison in sequence: pwsh -File run-all.ps1 -OpenCode <opencode.exe> [-Only http,links]. Summary in out\summary.txt.
param([Parameter(Mandatory)][string]$OpenCode, [string[]]$Only)
$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
Set-Location $PSScriptRoot
node --input-type=module -e 'import { assertPrivateOpenCodeExecutable } from "./private-profile.mjs"; await assertPrivateOpenCodeExecutable(process.argv[1])' -- $OpenCode
if ($LASTEXITCODE -ne 0) { throw "Refused OpenCode executable: $OpenCode" }
New-Item -ItemType Directory -Force out | Out-Null
$runs = 'http', 'mutation-fence', 'files', 'contract', 'history-bytes', 'history-search', 'workspace-claims', 'remote-session-controls', 'command-admission', 'depth', 'worktree-gone', 'links', 'search', 'memory', 'design', 'automation', 'missions', 'missions-family', 'missions-calendar', 'missions-wayfinder', 'mission-permissions', 'host', 'sidecars', 'usage', 'providers', 'previews', 'remote-previews', 'solid', 'security', 'hardening', 'launch', 'service', 'roundtrip', 'opencode-install'
if ('static-assets' -in $Only) { $runs += 'static-assets' }
if ('attachment-history' -in $Only) { $runs += 'attachment-history' }
if ('receipt-worktree' -in $Only) { $runs += 'receipt-worktree' }
if ('receipt-reconnect' -in $Only) { $runs += 'receipt-reconnect' }
if ('meta-update' -in $Only) { $runs += 'meta-update' }
$summary = foreach ($name in $runs) {
  if ($Only -and $name -notin $Only) { continue }
  $cpu = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
  $started = Get-Date
  $script, $arguments = if ($name -eq 'launch') { 'launch.mjs', @() } elseif ($name -eq 'opencode-install') { 'opencode-install.mjs', @() } elseif ($name -in 'security', 'hardening', 'service', 'roundtrip') { "$name.mjs", @($OpenCode) } else { 'compare.mjs', @($name, $OpenCode) }
  node $script @arguments *> "out\$name.out"
  '{0,-14} exit={1} {2:N0}s cpuBefore={3}%' -f $name, $LASTEXITCODE, ((Get-Date) - $started).TotalSeconds, $cpu
}
$summary | Set-Content out\summary.txt
$summary
