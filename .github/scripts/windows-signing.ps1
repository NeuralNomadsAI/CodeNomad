# Resolve whether this build signs its Windows artifacts with SignPath and the
# versions the artifact configurations expect. An empty policy builds unsigned
# (pull requests, forks, unconfigured releases); a requested policy without the
# API token fails instead of publishing unsigned files.
param(
  [AllowEmptyString()][string]$Policy,
  [Parameter(Mandatory)][string]$HasToken,
  [AllowEmptyString()][string]$Version,
  [Parameter(Mandatory)][string]$PackageJson
)
$ErrorActionPreference = "Stop"

$enabled = $false
if ($Policy) {
  if ($Policy -notin @("test-signing", "release-signing")) {
    throw "Unknown SignPath signing policy: $Policy"
  }
  if ($HasToken -ne "true") {
    throw "SignPath signing ($Policy) was requested but the SIGNPATH_API_TOKEN secret is not available"
  }
  $enabled = $true
}

if (-not $Version) { $Version = (Get-Content $PackageJson -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$') { throw "Invalid version: $Version" }
# electron-builder writes major.minor.patch.0 as the executable's ProductVersion.
$electronProductVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"

"enabled=$($enabled.ToString().ToLowerInvariant())" >> $env:GITHUB_OUTPUT
"version=$Version" >> $env:GITHUB_OUTPUT
"electron_product_version=$electronProductVersion" >> $env:GITHUB_OUTPUT
Write-Host ($(if ($enabled) { "Windows artifacts will be signed with SignPath policy $Policy" } else { "Windows artifacts stay unsigned" }))
