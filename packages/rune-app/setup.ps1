$ErrorActionPreference = 'Stop'
$runeRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (!$env:CARGO_TARGET_DIR) { throw 'Set CARGO_TARGET_DIR to the existing Rune build cache before compiling.' }
node (Join-Path $runeRoot 'scripts/rune/prepare.mjs')
if ($LASTEXITCODE) { throw 'Pinned Rune source verification failed' }
cargo +1.99.1 build --locked --manifest-path (Join-Path $runeRoot 'Cargo.toml') --package codenomad-rune-app --bin codenomad-rune
if ($LASTEXITCODE) { throw 'Rune application build failed' }
