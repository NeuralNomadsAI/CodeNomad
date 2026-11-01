# Extract one entry of a ZIP archive. With -Original, also require every other
# entry to have the same contents (SHA-256 of the decompressed data) as in that
# archive, so a signed archive can differ from the unsigned build only in the
# signed entry. Archives with duplicate entry names are refused.
param(
  [Parameter(Mandatory)][string]$Zip,
  [Parameter(Mandatory)][string]$Entry,
  [Parameter(Mandatory)][string]$Destination,
  [string]$Original
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Open-Zip([string]$path) {
  [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $path).Path)
}

function Get-EntryIndex($archive, [string]$path) {
  $entries = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
  foreach ($item in $archive.Entries) {
    if ($entries.ContainsKey($item.FullName)) { throw "Duplicate entry $($item.FullName) in $path" }
    $entries[$item.FullName] = $item
  }
  $entries
}

function Get-EntryHash($item) {
  $stream = $item.Open()
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [Convert]::ToHexString($sha.ComputeHash($stream)) } finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

$archive = Open-Zip $Zip
try {
  $after = Get-EntryIndex $archive $Zip
  if (-not $after.ContainsKey($Entry)) { throw "$Entry is missing from $Zip" }

  if ($Original) {
    $source = Open-Zip $Original
    try {
      $before = Get-EntryIndex $source $Original
      $names = @($before.Keys) + @($after.Keys) | Sort-Object -Unique -CaseSensitive
      $changed = @(foreach ($name in $names) {
        if ($name -ceq $Entry) { continue }
        if (-not $before.ContainsKey($name) -or -not $after.ContainsKey($name) -or
            (Get-EntryHash $before[$name]) -ne (Get-EntryHash $after[$name])) { $name }
      })
      if ($changed.Count) { throw "Entries other than $Entry differ from the unsigned archive: $($changed -join ', ')" }
    } finally { $source.Dispose() }
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  [IO.Compression.ZipFileExtensions]::ExtractToFile($after[$Entry], $Destination, $true)
} finally { $archive.Dispose() }
