# Every comparison in sequence: pwsh -File run-all.ps1 -OpenCode <opencode.exe> [-Only http,links]. Summary in out\summary.txt.
param([Parameter(Mandatory)][string]$OpenCode, [string[]]$Only)
$ErrorActionPreference = 'Stop'

function Test-WithinPath([string]$Root, [string]$Candidate) {
  $r = $Root.TrimEnd('\', '/')
  $c = $Candidate.TrimEnd('\', '/')
  if ($c.Equals($r, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $c.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase) -or $c.StartsWith($r + '/', [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-LocalDrive([string]$PathValue, [string]$MessagePrefix) {
  if ($PathValue -notmatch '^[A-Za-z]:[\\/]') {
    throw "$MessagePrefix ($PathValue)"
  }
  $letter = $PathValue.Substring(0, 1).ToUpperInvariant()
  $driveType = [System.IO.DriveInfo]::new($letter).DriveType.ToString()
  if ($driveType -notin @('Fixed', 'Ram')) {
    throw "Refused: OpenCode executable must reside on a local volume ($PathValue, drive ${letter}: is $driveType)"
  }
}

function Resolve-CanonicalPath([string]$Target, [int]$Hops = 0) {
  if ($Hops -ge 64) { throw "Refused: OpenCode executable path could not be resolved ($Target)" }
  $full = [System.IO.Path]::GetFullPath($Target)
  $root = [System.IO.Path]::GetPathRoot($full)
  if (-not $root) { return $full }
  $segments = @($full.Substring($root.Length) -split '[\\/]+' | Where-Object { $_ -ne '' })
  $current = $root
  for ($i = 0; $i -lt $segments.Count; $i++) {
    $current = [System.IO.Path]::Combine($current, $segments[$i])
    $info = [System.IO.DirectoryInfo]::new($current)
    $linkTarget = $info.LinkTarget
    if ($null -eq $linkTarget) {
      $info = [System.IO.FileInfo]::new($current)
      $linkTarget = $info.LinkTarget
    }
    if ($null -ne $linkTarget) {
      $resolvedLink = $info.ResolveLinkTarget($true)
      $nextTarget = if ($null -ne $resolvedLink) {
        $resolvedLink.FullName
      } elseif ([System.IO.Path]::IsPathRooted($linkTarget)) {
        $linkTarget
      } else {
        [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($current), $linkTarget)
      }
      $combined = $nextTarget
      for ($j = $i + 1; $j -lt $segments.Count; $j++) {
        $combined = [System.IO.Path]::Combine($combined, $segments[$j])
      }
      return Resolve-CanonicalPath $combined ($Hops + 1)
    }
  }
  return $full
}

Assert-LocalDrive $OpenCode 'Refused: OpenCode executable must be a drive-qualified local path'
$normalizedOpenCode = [System.IO.Path]::GetFullPath($OpenCode)
$rawHomes = @(
  [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile),
  $env:USERPROFILE,
  $env:HOME
) | Where-Object { $_ -and [System.IO.Path]::IsPathRooted($_) } |
  ForEach-Object { [System.IO.Path]::GetFullPath($_) } |
  Select-Object -Unique
$forbiddenHomes = @(
  $rawHomes
  foreach ($homeDir in $rawHomes) {
    try { Resolve-CanonicalPath $homeDir } catch { $homeDir }
  }
) | Select-Object -Unique

foreach ($homeDir in $forbiddenHomes) {
  if (Test-WithinPath $homeDir $normalizedOpenCode) {
    throw "Refused: OpenCode executable must be outside the user's home ($OpenCode)"
  }
}

$resolvedOpenCode = Resolve-CanonicalPath $normalizedOpenCode
Assert-LocalDrive $resolvedOpenCode 'Refused: OpenCode executable resolves to a non-local path'
foreach ($homeDir in $forbiddenHomes) {
  if (Test-WithinPath $homeDir $resolvedOpenCode) {
    throw "Refused: OpenCode executable resolves inside the user's home ($resolvedOpenCode)"
  }
}

$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
Push-Location $PSScriptRoot
try {
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
    $script, $arguments = if ($name -eq 'launch') { 'launch.mjs', @() } elseif ($name -eq 'opencode-install') { 'opencode-install.mjs', @() } elseif ($name -in 'security', 'hardening', 'service', 'roundtrip') { "$name.mjs", @($resolvedOpenCode) } else { 'compare.mjs', @($name, $resolvedOpenCode) }
    node $script @arguments *> "out\$name.out"
    '{0,-14} exit={1} {2:N0}s cpuBefore={3}%' -f $name, $LASTEXITCODE, ((Get-Date) - $started).TotalSeconds, $cpu
  }
  $summary | Set-Content out\summary.txt
  $summary
} finally {
  Pop-Location
}
