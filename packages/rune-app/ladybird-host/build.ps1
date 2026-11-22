param([Parameter(Mandatory)][string]$Study, [Parameter(Mandatory)][string]$VcVars)
$ErrorActionPreference = 'Stop'
$Study = (Resolve-Path $Study).Path
if (-not $Study.StartsWith('D:\', 'OrdinalIgnoreCase')) { throw 'Use the isolated D: build' }
$bin = "$Study\build"
$env:Path = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer;$env:Path"
foreach ($line in (& cmd /d /c "call `"$VcVars`" >nul && set")) {
    if ($line -match '^([^=]+)=(.*)$') { Set-Item "env:$($Matches[1])" $Matches[2] }
}
$env:TEMP = "$Study\temp"
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:VCPKG_ROOT = "$Study\vcpkg"
$env:VCPKG_DEFAULT_BINARY_CACHE = "$Study\cache\vcpkg-binary-cache"
$env:VCPKG_DOWNLOADS = "$Study\downloads"
$env:X_VCPKG_REGISTRIES_CACHE = "$Study\vcpkg-registries"
$env:VCPKG_DISABLE_METRICS = '1'
$env:CARGO_HOME = "$Study\cargo"
$env:CARGO_TARGET_DIR = "$bin\cargo"
$env:RUSTUP_HOME = "$Study\rustup"
$env:Path = "$Study\tools\llvm\bin;$Study\rustup\toolchains\1.98.0-x86_64-pc-windows-msvc\bin;$env:Path"
$hook = "$PSScriptRoot\host.cmake".Replace('\', '/')
& cmake -S "$Study\src" -B $bin "-DCMAKE_PROJECT_ladybird_INCLUDE=$hook"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& cmake --build $bin --parallel 4 --target RuneLadybird Hub WebContent RequestServer Compositor ImageDecoder SystemProbe
exit $LASTEXITCODE
