# Tao native window backports

`tao-0.34.6/` is the published Apache-2.0 crate (license included), with only
the four Windows source files from upstream [tao#1215] and the macOS
`is_zoomed` function from [tao#1182] changed. It is selected
by the Tauri workspace's `[patch.crates-io]`; there is no registry-cache mutation
or build-time patching. All platforms keep the same dependency/API version.

- Crate: https://static.crates.io/crates/tao/tao-0.34.6.crate
- SHA-256: `6e06d52c379e63da659a483a958110bbde891695a0ecb53e48cc7786d5eda7bb`
- Upstream fix: `c704261c519c58cfdd0bc2d58ba24e06a0b71c92`
- Patch: `patches/tao-1215.patch` (upstream PR diff, Windows source hunks only applied)

`PeekMessageW` may synchronously dispatch sent messages and reenter the window
procedure. Tao 0.34.6 holds `KEY_EVENT_BUILDERS`, `LAYOUT_CACHE` or the IME window
state across peeking, causing same-thread mutex deadlocks. The upstream fix moves
the peeks before those locks and passes the results into the handlers.

The recorded CodeNomad dump matches this exact path. See
`dev-docs/TAURI_WINDOWS_INPUT_DEADLOCK.md` for diagnosis and validation. Do not
replace non-reentrant mutexes with recursive locks or silently drop nested input.

The Windows native regression uses a hidden Tao window and cross-thread sent
focus messages. Its bounded watchdog fails against the original published crate
and passes with this backport. It never opens CodeNomad profiles or OpenCode.
The runner additionally instruments a temporary crate copy at the IME callback
boundary and proves that moving only the IME peek back under its mutex fails.
No instrumentation or mutation is applied to this checked-in crate.

Remove this override when the supported Tauri dependency range can resolve a
published Tao release containing the fix; run the same regression first. Merely
bumping within the unfixed 0.34.x/0.35.x release lines is insufficient.

## macOS read-only zoom detection

The macOS backport is the exact `window.rs` hunk from upstream commit
`2fb512315899973e2c64d00c0e34ed382d93c893` ([tao#1182]). Its patch is
`patches/tao-1182.patch`. Windows and Linux behavior is unchanged.

On borderless windows, the old maximize getter temporarily changed the native
style mask twice. These writes generate resize/move events. CodeNomad's geometry
capture reads the getter again, sustaining a main-thread event feedback loop
before loading-screen navigation completes. The upstream getter uses read-only
AppKit frame/screen queries instead. It retains native `isZoomed` for ordinary
titled, resizable windows and when no screen is available.

Run `node scripts/test-tauri-macos-window.mjs --baseline` in a graphical macOS
session. The isolated native fixture checks that getters generate no geometry
events, including reads during geometry capture, and exercises maximize/restore,
fixed-size and decorated windows. Its original-crate negative control reproduces
the feedback loop. See `dev-docs/TAURI_MACOS_STARTUP.md` for real application tests.

Remove the override only after both native backports are available in the
resolved supported release and both native regressions pass.

[tao#1215]: https://github.com/tauri-apps/tao/pull/1215
[tao#1182]: https://github.com/tauri-apps/tao/pull/1182
