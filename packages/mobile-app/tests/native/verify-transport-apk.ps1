param(
    [Parameter(Mandatory)][string]$Apk,
    [Parameter(Mandatory)][string]$Evidence
)
$ErrorActionPreference = 'Stop'
$Apk = (Resolve-Path $Apk).Path
New-Item -ItemType Directory -Force $Evidence | Out-Null
$Evidence = (Resolve-Path $Evidence).Path
$mobile = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path

function Capture([string]$Name, [string]$Tool, [string[]]$Arguments) {
    $output = & $Tool @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$Tool failed: $output" }
    $output | Set-Content -Encoding utf8 (Join-Path $Evidence $Name)
    return ($output -join "`n")
}

$manifestTree = Capture 'aapt-manifest.log' 'aapt' @('dump', 'xmltree', $Apk, 'AndroidManifest.xml')
$resources = Capture 'aapt-resources.log' 'aapt' @('dump', 'resources', $Apk)
$resource = [regex]::Match($resources, 'spec resource (0x[0-9a-f]+) [^\s]+:xml/codenomad_mobile_network_security:')
if (!$resource.Success) { throw 'Owned NSC resource missing' }
$id = $resource.Groups[1].Value
if ($manifestTree -notmatch "android:networkSecurityConfig\([^)]*\)=@$id") { throw 'Manifest NSC mismatch' }
Capture 'packaged-manifest.xml' 'apkanalyzer.bat' @('manifest', 'print', $Apk) | Out-Null
$policyTree = Capture 'aapt-network-security.log' 'aapt' @('dump', 'xmltree', $Apk, 'res/xml/codenomad_mobile_network_security.xml')
# SDK apkanalyzer's resources xml drops domain text nodes. Reconstruct only the
# strict NSC E/A/C grammar from aapt (which preserves them); never accept a
# blank-domain decode or substitute the source XML for the packaged resource.
$document = [System.Xml.XmlDocument]::new()
$document.AppendChild($document.CreateXmlDeclaration('1.0', 'utf-8', $null)) | Out-Null
$stack = @{}
$current = $null
foreach ($line in ($policyTree -split "`n")) {
    if ($line -match '^( *)E: ([a-z-]+) \(line=\d+\)$') {
        $depth = $Matches[1].Length / 2
        $element = $document.CreateElement($Matches[2])
        if ($depth -eq 0) { $document.AppendChild($element) | Out-Null }
        else { $stack[$depth - 1].AppendChild($element) | Out-Null }
        $stack[$depth] = $element
        $current = $element
    } elseif ($line -match '^ *A: ([a-zA-Z]+)=\(type 0x12\)(0x0|0xffffffff)$') {
        $current.SetAttribute($Matches[1], $(if ($Matches[2] -eq '0x0') { 'false' } else { 'true' }))
    } elseif ($line -match '^ *A: ([a-zA-Z]+)="([^"]*)" \(Raw: "[^"]*"\)$') {
        $current.SetAttribute($Matches[1], $Matches[2])
    } elseif ($line -match '^ *C: ("[^"]*")$') {
        $current.AppendChild($document.CreateTextNode(($Matches[1] | ConvertFrom-Json))) | Out-Null
    } elseif ($line.Trim()) { throw "Unrecognized packaged NSC tree line: $line" }
}
$document.Save((Join-Path $Evidence 'packaged-network-security.xml'))

Push-Location $mobile
try {
    Capture 'transport-packaged-xml.log' 'java' @('--source', '17', 'tests/native/TransportPolicyTest.java',
        (Join-Path $Evidence 'packaged-manifest.xml'), (Join-Path $Evidence 'packaged-network-security.xml'), "@ref/$id") | Out-Null
} finally { Pop-Location }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($Apk)
try {
    $zip.Entries | ForEach-Object { "$($_.FullName)`t$($_.Length)" } |
        Set-Content (Join-Path $Evidence 'apk-contents.tsv')
    if ($zip.Entries.FullName -contains 'res/xml/codenomad_mobile_network_security_debug.xml') { throw 'Unexpected debug NSC' }
    $native = @($zip.Entries | Where-Object { $_.FullName -match '^lib/.*\.so$' })
    if ($native.Count -ne 1 -or $native[0].FullName -ne 'lib/arm64-v8a/libcodenomad_mobile_lib.so') { throw 'ARM64-only native inventory changed' }
    if (@($zip.Entries | Where-Object { $_.FullName -match '(^|/)(node|node_modules|opencode|backend)(/|\.|$)' }).Count) { throw 'Unexpected desktop resources' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($native[0], (Join-Path $Evidence 'packaged-libcodenomad_mobile_lib.so'), $true)
} finally { $zip.Dispose() }

$code = Capture 'packaged-recovery-load.log' 'apkanalyzer.bat' @('dex', 'code', '--class',
    'ai.neuralnomads.codenomad.recovery.RecoveryPlugin', $Apk)
$load = [regex]::Match($code, '(?s)\.method public load\(Landroid/webkit/WebView;\)V.*?\.end method').Value
if ($load -notmatch 'const/4 (v\d+), 0x1\s+invoke-virtual \{v\d+, \1\}, Landroid/webkit/WebSettings;->setMixedContentMode\(I\)V') {
    throw 'Packaged mixed-content denial not found; inspect DEX before accepting APK'
}
foreach ($name in @('ConnectionAuthority', 'NavigationFence')) {
    Capture "packaged-$name.log" 'apkanalyzer.bat' @('dex', 'code', '--class',
        "ai.neuralnomads.codenomad.recovery.$name", $Apk) | Out-Null
}
Capture 'apksigner.log' 'apksigner.bat' @('verify', '--verbose', '--print-certs', $Apk) | Out-Null
Capture 'zipalign.log' 'zipalign' @('-c', '-P', '16', '-v', '4', $Apk) | Out-Null
$hash = (Get-FileHash $Apk -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $([IO.Path]::GetFileName($Apk))" | Set-Content (Join-Path $Evidence 'SHA256SUMS.txt')
Write-Output "Verified packaged NSC $id, XML denial/system trust, mixed-content DEX, recovery classes, ARM64 inventory, signature and ZIP alignment. SHA256 $hash"
Write-Output 'Static artifact inspection only: no device, WebView network, login/upload/SSE or renderer-recovery qualification.'
