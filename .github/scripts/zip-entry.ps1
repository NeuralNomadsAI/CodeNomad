# Extract one entry of a ZIP archive. With -Original, also require every other
# entry to match that archive (name, size and CRC-32), so a signed archive can
# differ from the unsigned build only in the signed entry.
param(
  [Parameter(Mandatory)][string]$Zip,
  [Parameter(Mandatory)][string]$Entry,
  [Parameter(Mandatory)][string]$Destination,
  [string]$Original
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Read-Entries([string]$path) {
  $archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $path))
  try {
    $entries = @{}
    foreach ($item in $archive.Entries) { $entries[$item.FullName] = "$($item.Length):$($item.Crc32)" }
    $entries
  } finally { $archive.Dispose() }
}

if ($Original) {
  $before = Read-Entries $Original
  $after = Read-Entries $Zip
  $names = @($before.Keys) + @($after.Keys) | Sort-Object -Unique
  $changed = @($names | Where-Object { $_ -ne $Entry -and $before[$_] -ne $after[$_] })
  if ($changed.Count) { throw "Entries other than $Entry differ from the unsigned archive: $($changed -join ', ')" }
  if (-not $after.ContainsKey($Entry)) { throw "$Entry is missing from $Zip" }
}

$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Zip))
try {
  $item = $archive.GetEntry($Entry)
  if (-not $item) { throw "$Entry is missing from $Zip" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  [IO.Compression.ZipFileExtensions]::ExtractToFile($item, $Destination, $true)
} finally { $archive.Dispose() }
