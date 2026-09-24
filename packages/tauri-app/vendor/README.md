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

Remove this override when the supported Tauri dependency range can resolve a
published Tao release containing the fix; run the same regression first. Merely
bumping within the unfixed 0.34.x/0.35.x release lines is insufficient.

[tao#1215]: https://github.com/tauri-apps/tao/pull/1215
