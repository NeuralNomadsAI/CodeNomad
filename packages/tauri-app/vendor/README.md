# Tao Windows input deadlock backport

`tao-0.34.6/` is the published Apache-2.0 crate (license included), with only
the four Windows source files from upstream [tao#1215] changed. It is selected
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

[tao#1215]: https://github.com/tauri-apps/tao/pull/1215

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
