# Tao native window backports

`tao-0.34.6/` is the published Apache-2.0 crate (license included), with
the Windows input backport from upstream [tao#1215], the macOS
`is_zoomed` function from [tao#1182], and the local Windows runner refcount
compatibility correction below. It is selected
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

The recorded CodeNomad dump matches this exact path. Do not
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
the feedback loop.

Remove the override only after the resolved dependencies cover the input,
read-only zoom and runner lifetime fixes and their native regressions pass.

[tao#1215]: https://github.com/tauri-apps/tao/pull/1215
[tao#1182]: https://github.com/tauri-apps/tao/pull/1182

## Windows runtime handle lifetime

The pinned `tauri-runtime-wry` 2.10.1 exposes `Send + Sync + Clone` runtime
handles whose unsafe context graph contains Tao's non-atomic
`Rc<EventLoopRunner>`. Safe handle clones/drops on IPC workers race the main
thread's reference count, freeing the runner prematurely or leaking it.

The local correction changes **only this internal shared counter** to `Arc`
in `event_loop.rs` and `event_loop/runner.rs`. It neither makes
`EventLoopWindowTarget` Send/Sync nor permits worker access to the runner's
`Cell`/`RefCell` state. Tauri's existing main-thread access discipline remains.

Provenance: [tauri#15408](https://github.com/tauri-apps/tauri/issues/15408),
[tauri#15793](https://github.com/tauri-apps/tauri/issues/15793) and the proposal
[tao#1290](https://github.com/tauri-apps/tao/pull/1290). **That PR was closed
unmerged**: the maintainer correctly identified Tauri's cross-thread use of a
non-Send window target as the contract violation. This is a deliberate local
compatibility correction for the runtime we ship, not a claimed upstream merge
or a general guarantee that Tao window targets are safe to use across threads.

`node scripts/test-tauri-runner-refcount.mjs --baseline` calls the real pinned
Wry runtime's safe public handle API on eight workers. The negative control
reverts only the counter in a temporary crate copy and stops at its first native
fault; a CI runner that never reproduces the timing-dependent race only warns
(local runs still fail). The corrected build must finish every run and tear down
cleanly. It uses no
CodeNomad profile, page, backend or OpenCode service. Individual negative-control
processes can survive a race that leaks instead of freeing early.

Keep this correction until the resolved Tauri runtime no longer races Tao's
reference count (or the resolved Tao implementation safely handles that traffic).
Qualify removal with the same regression and the existing Windows input tests.
Captured crash evidence is recorded in `dev-docs/TAURI_WINDOWS_RUNNER_REFCOUNT.md`.

## Updater Windows launch handoff

`tauri-plugin-updater-2.12.0/` is the published MIT/Apache-2.0 crate (licenses
included), selected through the workspace's `[patch.crates-io]`.

- Crate: https://static.crates.io/crates/tauri-plugin-updater/tauri-plugin-updater-2.12.0.crate
- SHA-256: `7a5cad8ed5948d988e1018ecd31e27cacedbf72ce3fb972940c3e4bf51639e4b`
- Local change: `src/updater.rs` runs `on_before_exit` only after a successful
  `ShellExecuteW`. Upstream calls it before launching, irreversibly releasing
  client-state ownership even when Windows refuses to start the installer.
- Regression: `cargo test -p tauri-plugin-updater windows_launch_tests` from
  `packages/tauri-app` checks failed and successful native launch result codes.

Extraction, signature checks, NSIS arguments, installer restart and Unix install
paths remain upstream. Remove this override when a published plugin provides the
same success-only handoff; rerun the regression and signed installer trial first.
