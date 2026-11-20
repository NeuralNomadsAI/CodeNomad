# package.ps1 -Version <v> -Binary <codenomad-rs.exe> -Plugins <plugins folder> -Out <parent> -Tool <cnrs-release.exe> -Key <release.key>
#   -Serial <n> [-NextKey <next release.pub>]
# Builds <parent>\codenomad-rs-<v>\: the binary (its --version must be <v>), the bundled
# plugins (session-pruning, automation, missions + provider, memory), VERSION,
# MANIFEST (serial, announced next key), SHA256SUMS and SHA256SUMS.minisig.
param([Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Binary, [Parameter(Mandatory)][string]$Plugins,
  [Parameter(Mandatory)][string]$Out, [Parameter(Mandatory)][string]$Tool, [Parameter(Mandatory)][string]$Key,
  [Parameter(Mandatory)][string]$Serial, [string]$NextKey = '')
. (Join-Path $PSScriptRoot 'common.ps1')
$built = "$(& $Binary --version)".Trim()
if ($LASTEXITCODE -or $built -ne $Version) { throw "binary version '$built' differs from release version $Version" }
$dest = Join-Path ([IO.Path]::GetFullPath($Out)) "codenomad-rs-$Version"
Remove-Item -Recurse -Force "$dest.tmp" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$dest.tmp\plugins" | Out-Null
Copy-Item $Binary "$dest.tmp\codenomad-rs.exe"
foreach ($feature in 'session-pruning', 'automation', 'missions', 'memory') {
  New-Item -ItemType Directory -Force "$dest.tmp\plugins\$feature" | Out-Null
  Copy-Item "$Plugins\$feature\plugin.mjs" "$dest.tmp\plugins\$feature\"
}
Copy-Item "$Plugins\missions\provider.mjs" "$dest.tmp\plugins\missions\"
[IO.File]::WriteAllText("$dest.tmp\VERSION", "$Version`n")
& $Tool manifest "$dest.tmp" $Serial @(if ($NextKey) { $NextKey }) | Out-Null
if ($LASTEXITCODE) { throw "invalid serial or next key" }
$lines = Get-ChildItem -Recurse -File "$dest.tmp" | ForEach-Object { $_.FullName.Substring("$dest.tmp".Length + 1) -replace '\\', '/' } |
  Sort-Object -CaseSensitive | ForEach-Object { "$((Get-FileHash -Algorithm SHA256 (Join-Path "$dest.tmp" $_)).Hash.ToLowerInvariant())  $_" }
[IO.File]::WriteAllText("$dest.tmp\SHA256SUMS", ($lines -join "`n") + "`n")
& $Tool sign "$dest.tmp" $Key | Out-Null
if ($LASTEXITCODE) { throw 'signing failed' }
if (Test-Path $dest) {
  if ([IO.File]::ReadAllText("$dest\SHA256SUMS") -ne [IO.File]::ReadAllText("$dest.tmp\SHA256SUMS")) { throw "$dest exists with other contents" }
  Remove-Item -Recurse -Force "$dest.tmp"
} else { Rename-Item "$dest.tmp" (Split-Path -Leaf $dest) }
$dest
