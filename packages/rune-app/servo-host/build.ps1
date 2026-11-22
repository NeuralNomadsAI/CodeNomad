param(
    [Parameter(Mandatory)][string]$LlvmBin,
    [string]$Python = 'C:\Python311\python.exe'
)
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$deps = Join-Path $workspace '.prototype-deps'
if ($deps -notmatch '^[Dd]:\\') { throw 'Use a prototype worktree on D:' }
New-Item -ItemType Directory -Force "$deps\tmp" | Out-Null
$env:TEMP = "$deps\tmp"
$env:TMP = $env:TEMP
$env:LIBCLANG_PATH = (Resolve-Path $LlvmBin).Path
$env:Path = "$env:LIBCLANG_PATH;C:\Program Files (x86)\Microsoft Visual Studio\Installer;$env:Path"
$env:CARGO_HOME = "$deps\cargo-servo-cache"
$env:CARGO_TARGET_DIR = "$deps\target-servo"
$env:UV_CACHE_DIR = "$deps\uv-cache"
$env:UV_PROJECT_ENVIRONMENT = "$deps\uv-venv"
$env:UV_PYTHON = $Python
$env:UV_PYTHON_DOWNLOADS = 'never'
$source = "$deps\servo"
if (!(Test-Path "$source\.git")) {
    git -c core.longpaths=true clone --depth 1 --branch v0.8.0 https://github.com/servo/servo.git $source
    if ($LASTEXITCODE) { throw 'Servo download failed' }
}
if ((git -C $source rev-parse --short=8 HEAD) -ne '4e136d8e') { throw 'Servo revision changed' }
if (!(Select-String -Path "$source\Cargo.toml" -Pattern '"study-probe",' -Quiet)) {
    git -C $source apply --ignore-whitespace "$PSScriptRoot\workspace.patch"
    if ($LASTEXITCODE) { throw 'Could not prepare Servo workspace' }
}
New-Item -ItemType Directory -Force "$source\study-probe\src" | Out-Null
Copy-Item "$PSScriptRoot\Cargo.toml" "$source\study-probe"
Copy-Item "$PSScriptRoot\src\*" "$source\study-probe\src"
Push-Location $source
try {
    cargo +1.99.1 build --locked --release -p study-probe --config 'profile.release.strip="symbols"'
    if ($LASTEXITCODE) { throw 'Servo build failed' }
} finally { Pop-Location }
