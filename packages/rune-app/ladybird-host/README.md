# Ladybird preview trial (Windows x64)

Trust only the disposable local fixtures. This trial uses no OS web view or WebDriver listener.
The owned C++ process speaks bounded JSON over inherited stdin/stdout. It reuses `LibWebView`
for helper startup, Windows handle brokering, view lifecycle, native input and LibWeb's
accessibility tree. A Rust implementation of the internal Ladybird IPC would duplicate those
contracts. A DLL ABI would move the same host into Rune's process.

The Compositor finishes its producer GPU work before publishing a frame. Rune duplicates its
NT handle from the child, imports the RGBA8 D3D12 texture into wgpu and samples it in place.
The latest surface, draw preparation and wgpu completion callback own the loan; the backing store
can be repainted only when it has been superseded **and** the loan has returned. Superseded frames
that were never drawn return without a GPU wait. The copy/readback path is for explicit screenshots.

## Build and run

1. Use `scripts/rune/prepare.mjs` at the pinned Rune revision, then apply `rune-d3d12.patch`
   inside `.prototype-deps/rune`. Keep Cargo and TEMP on `D:`. Build `codenomad-rune-app`
   with Rust 1.99.1 and `--release --locked --features test-support`.
2. Reuse the no-Qt release build of Ladybird `6ecdb35ef4f81aec0428d02c21ea7a8e87c30bfa`.
   Its six CMake changes are in `ladybird-windows.patch`; apply `ladybird-hit-test.patch` for
   the private hit-test callback. Run `build.ps1 -Study <study root> -VcVars <vcvars64.bat>`.
   Copy the built host and rebuilt binaries/DLLs to a copy of the no-Qt runtime package.
3. Build `packages/server-rs/Cargo.toml` at the same base revision. Use the Servo React/Vite
   fixture, built native plugins and an installed dependency tree for the Solid UI. Supply a
   private OpenCode CLI; the runner verifies a fresh state directory before starting its service.

```powershell
$env:RUNE_LADYBIRD_AGENT = '1'
$env:RUNE_LADYBIRD_WOFF2 = $fontFixture
node packages/rune-app/tests/ladybird-live.mjs $rune $ladybirdHost $rustServer $privateOpenCode `
  $plugins $servoReactFixture $solidUi
```

Set `RUNE_LADYBIRD_PROBE_DPI=2` for HiDPI. The probe uses the Rune Runtime and offscreen DX12
compositor; it does not show a window, qualify OS IME candidate placement or measure scanout.
The run writes its evidence under `TEMP`. A screenshot is an explicit readback, not the frame transport.

The Windows Job controls the lifetime of the guest and its services. They retain the rights of
the OS account. The preview discards application credentials; a SideCar that requires the
application session cookie must sign in separately.
