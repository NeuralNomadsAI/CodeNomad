# macOS startup: borderless maximize getter event feedback

## Captured failure

The published development release `v0.20.0-dev-20261001-77692a73` reproduces a
startup hang in a graphical macOS 15.8 (24H23) Intel Hyper-V guest. Its main
thread stays busy in this chain:

`setup_local_window` geometry event → `capture_window_in_memory` →
`read_window_geometry` → `Window::is_maximized` → Tao `is_zoomed` →
`set_style_mask_sync` → AppKit `-[NSWindow setStyleMask:]`.

The process remains near one full CPU core. The backend starts independently,
but the native event loop cannot complete loading-screen navigation. The hang
also occurs in a fresh scoped CodeNomad profile with an intentionally missing
OpenCode executable, before OpenCode can connect. The previously installed
0.20.1 application shows the same sampled path.

This is not the writer-lock/thread explosion fixed for #676. That fix remains
necessary: native getters still run outside client-state locks, and geometry
publication still uses the single debounced worker.

## Narrow fix and provenance

Backport the exact macOS source hunk from Tao upstream commit
`2fb512315899973e2c64d00c0e34ed382d93c893` (tao#1182) into the existing
`packages/tauri-app/vendor/tao-0.34.6/` override. The old getter temporarily
changed the borderless window's style mask twice, generating new geometry
events whose capture called the same getter again. The new getter reads the
window and screen frames instead. Titled/resizable windows and missing-screen
fallback retain AppKit's native `isZoomed` query.

No Tauri dependency/API upgrade, application chrome change, persistence
workaround or shared OpenCode lifecycle change is involved. The Windows input
backport remains intact; Electron uses its own native read-only getter and
requires no production change.

## Validation

- `node scripts/test-tauri-macos-window.mjs --baseline` requires a graphical
  macOS session. It builds the original published Tao as a negative control in
  a temporary workspace and the backport in the real workspace. Both use the
  same native fixture, with a bounded watchdog and no application/backend data.
  The baseline has its own target directory; the patched artifact is warmed
  before it and rechecked afterwards. CI runs the command twice consecutively.
  Only a normal getter/read-event assertion or a watchdog in that exact phase
  with at least 100 capture callbacks counts as feedback reproduction. Setup,
  later-phase and low-evidence timeouts fail the negative control.
- The fixture checks read-generated move/resize events, getters inside geometry
  capture, normal bounds, maximize/restore, fixed-size and decorated windows.
- The PR macOS ARM64 job runs the regression in addition to the Tauri crate
  tests. Packaging success alone does not qualify this event-loop behavior.
- Run the existing Windows input regression with `--baseline` and the Electron
  window/persistence tests to protect cross-host behavior.

Local non-macOS checks passed: 188 Tauri crate tests on Windows, all six
Windows input cases with their negative controls, and 44 Electron
window/restore/navigation/startup tests. The upstream source patch also passes
`git apply --check --reverse` against the vendored file.

The native macOS fixture passed in the Intel 15.8 VM: the original published
crate reproduced geometry-event feedback, and the backport passed all
read-only getter and maximize/restore checks. The release Tauri binary was
rebuilt from the `fb2ae42a` development source plus the backport, using the
published release's bundled Node/server/UI resources in a separate test tree.

The rebuilt package-mode application reaches the interface in the VM (confirmed
in the Hyper-V console by the tester), with the native process at 0.0% CPU at
idle. A second native launch opens a separate window and a synthetic project
using OpenCode 2.0.21 in a separate HOME/XDG/database environment. After a native
AppleScript Quit and relaunch, two retained V3 window records are restored and
the isolated service remains on the same endpoint. No shared daemon or existing
application installation is modified. Guest `screencapture` returns white
frames in this Hyper-V display setup, so those captures are not visual evidence.

The available local VM is Intel, not Apple Silicon. Direct local ARM64
reproduction is unavailable; keep that distinction when reporting validation.

## Override removal

Remove the workspace override only when the supported resolved Tao release
includes both tao#1182 and tao#1215 and both native negative-control regressions
pass. Do not replace registry-cache sources or patch them at build time.
