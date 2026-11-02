# Check the version metadata SignPath restricts and the Authenticode signature
# of Windows executables. -Unsigned checks a file before submission; otherwise
# the file must carry a timestamped signature from the expected policy:
# release-signing requires a trusted SignPath Foundation signature, while the
# test certificate's untrusted root is accepted for test-signing.
param(
  [Parameter(Mandatory)][string[]]$Path,
  [Parameter(Mandatory)][string]$ProductVersion,
  [string]$Policy,
  [switch]$Unsigned
)
$ErrorActionPreference = "Stop"

$failures = @()
foreach ($file in $Path) {
  $item = Get-Item -LiteralPath $file
  $info = $item.VersionInfo
  $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
  Write-Host "$($item.Name): ProductName='$($info.ProductName)' ProductVersion='$($info.ProductVersion)' FileVersion='$($info.FileVersion)' Signature=$($signature.Status)"
  if ($info.ProductName -ne "CodeNomad") { $failures += "$($item.Name): product name is '$($info.ProductName)', expected 'CodeNomad'" }
  if ($info.ProductVersion -ne $ProductVersion) { $failures += "$($item.Name): product version is '$($info.ProductVersion)', expected '$ProductVersion'" }

  if ($Unsigned) {
    if ($signature.Status -ne "NotSigned") { $failures += "$($item.Name): expected an unsigned file, found $($signature.Status)" }
    continue
  }

  $signer = $signature.SignerCertificate
  if (-not $signer) { $failures += "$($item.Name): no Authenticode signature ($($signature.Status))"; continue }
  Write-Host "  Signer: $($signer.Subject) [$($signer.Thumbprint)]"
  Write-Host "  Status: $($signature.StatusMessage)"
  if ($signature.TimeStamperCertificate) {
    Write-Host "  Timestamp: $($signature.TimeStamperCertificate.Subject)"
  } else {
    $failures += "$($item.Name): signature is not timestamped"
  }

  switch ($Policy) {
    "release-signing" {
      if ($signature.Status -ne "Valid") { $failures += "$($item.Name): signature is $($signature.Status)" }
      if ($signer.Subject -notmatch '(^|,\s*)CN=SignPath Foundation(,|$)') { $failures += "$($item.Name): unexpected signer $($signer.Subject)" }
      $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
      if (-not $signtool) { $failures += "signtool.exe not found"; break }
      & $signtool.FullName verify /pa /tw $item.FullName
      if ($LASTEXITCODE -ne 0) { $failures += "$($item.Name): signtool verify exited with $LASTEXITCODE" }
    }
    "test-signing" {
      # The test certificate chains to a root Windows does not trust.
      if ($signature.Status -notin @("Valid", "UnknownError", "NotTrusted")) { $failures += "$($item.Name): signature is $($signature.Status)" }
    }
    default { $failures += "Unknown signing policy: $Policy" }
  }
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  throw "Authenticode verification failed"
}
