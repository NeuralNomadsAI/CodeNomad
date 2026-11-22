# Servo preview prototype on Windows

Trusted loopback pages only; use an isolated `trial-servo` profile. The guest has its own Windows Job and no Rune or OpenCode handles. A Job controls lifetime, not filesystem or network permissions.

Build from a worktree on `D:` with the pinned Rune source under `.prototype-deps/rune`, Rust 1.99.1, MSVC, the Windows SDK, LLVM and Python 3.11 + `uv`:

```powershell
$deps = "$PWD\.prototype-deps"
$env:TEMP = "$deps\tmp"
$env:TMP = $env:TEMP
$env:CARGO_HOME = "$deps\cargo-cache"
$env:CARGO_TARGET_DIR = "$deps\target-rune"
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
./packages/rune-app/servo-host/build.ps1 -LlvmBin $llvmBin
cargo +1.99.1 build --release --locked -p codenomad-rune-app --features test-support --config 'profile.release.strip="symbols"'
cargo +1.99.1 run --locked -p rune-style-policy -- packages/rune-app/src
```

Qualification uses the real application state, Rune DX12 offscreen compositor, the Rust server, a private OpenCode daemon and the existing browser plug-in rebuilt without modifying the Rust server checkout. Pass the absolute paths of the prebuilt `$rustServer`, private `$opencode`, Rust worktree `$plugins` (`packages/server/dist/plugins`), the React/Vite `$reactFixture` (the Servo study's `fixture/`), and the Rust worktree's `$solidUi` (`packages/ui`). Set `RUNE_SERVO_PROBE_DPI=2` for HiDPI. `RUNE_SERVO_AGENT=1` executes the workflow through a native OpenCode session with a deterministic local model provider. The runner writes evidence below `TEMP` and owns the frontend/test services; it does not use the installed application's profile.

```powershell
$env:RUNE_SERVO_AGENT = '1'
node packages/rune-app/tests/servo-live.mjs "$env:CARGO_TARGET_DIR\release\codenomad-rune.exe" `
  "$deps\target-servo\release\study-probe.exe" $rustServer $opencode $plugins $reactFixture $solidUi
```

For interactive trial use, set `CODENOMAD_PROFILE=trial-servo`, `RUNE_SERVO_BIN`, `RUNE_SERVER_BIN`, `RUNE_HOST_ROOT` (new directory), `RUNE_TRIAL_OPENCODE_BIN` and `RUNE_TRIAL_OPENCODE_PROFILE` (private daemon already running). Leave the `RUNE_SERVO_TEST_FILE` probe exception unset. Opening the session shows the preview button; a browser tool `open` request can also create that session's one preview. Do not share these trial settings with the installed host.
