$ErrorActionPreference = 'Stop'
$prototypeRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runeCheckout = Join-Path $prototypeRoot '.prototype-deps/rune'
$pinnedRune = '21e5342b9a4cc33eeee88071b4b1f0eafb1247d4'
if (!(Test-Path -LiteralPath $runeCheckout)) {
    git clone --no-checkout https://github.com/anomalyco/rune.git $runeCheckout
    if ($LASTEXITCODE) { throw 'Rune clone failed' }
    git -C $runeCheckout checkout --detach $pinnedRune
    if ($LASTEXITCODE) { throw 'Rune checkout failed' }
}
if ((git -C $runeCheckout rev-parse HEAD) -ne $pinnedRune) { throw 'Unexpected Rune revision' }
if (git -C $runeCheckout status --porcelain) { throw 'Rune checkout must be clean' }
cargo +1.99.1 build --locked --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml')
if ($LASTEXITCODE) { throw 'Rune prototype build failed' }
