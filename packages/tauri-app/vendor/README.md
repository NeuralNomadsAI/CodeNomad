# Native runtime patches

## Embedded WebKit views

`tauri-runtime-wry-2.10.1/` and `wry-0.54.4/` are complete published
MIT/Apache-2.0 crates, including licenses, selected through `[patch.crates-io]`.

- Crates: https://static.crates.io/crates/tauri-runtime-wry/tauri-runtime-wry-2.10.1.crate
  and https://static.crates.io/crates/wry/wry-0.54.4.crate.
- Published SHA-256: runtime `e11ea2e6f801d275fdd890d6c9603736012742a1c33b96d0db788c9cdebf7f9e`;
  Wry `e5a8135d8676225e5744de000d4dff5a082501bf7db6a1c1495034f8c314edbc`.
- GTK: the runtime lazily installs a window-owned `GtkOverlay` inside Tao's
  content box, below its menu bar. Primary content stays boxed; child webviews use
  `GtkFixed`. The overlay passes uncovered input through to the primary view.
  Primary-only windows keep their ordinary box. Reparenting uses the destination
  window's own child container.
- Wry stores child positions in `GtkFixed` and sizes in GTK size requests, alongside
  immediate allocation, so resize/menu/hide-show allocations keep the rectangle.
  Bounds follow the actual parent after reparenting. IPC callbacks keep weak
  WebView references so destruction releases both the view and its IPC manager.
- WKWebView: the runtime supplies `with_id(&label)` to Wry. During construction,
  Wry derives a delegate-local `deny_permissions` flag for `browser-` and
  `embedded-remote-` labels. Camera/microphone requests are
  denied. File-upload panels retain their user-driven selection. Application views retain
  media grants and upload behavior.
- Permission inventory: Wry's WKUIDelegate implements media capture and
  upload decisions. New-window and download decisions use consumer callbacks.
  The public motion permission callback is unavailable on macOS. Location and web
  notifications have no grant handler in this delegate. Display-capture permission
  depends on the engine's default handling. Storage Access API
  consent depends on tracking-prevention settings; storage-access grants also have
  an automatic cookie-policy path. These routes bypass the public media callback.
  The macOS native preview uses these per-instance guards on macOS 14+.
  Requalify engine-default permission handling when updating the runtime or OS support.
  Never substitute JavaScript rejection shims for native permission enforcement,
  add a global permission denial or replace the delegate after construction.

Keep these overrides until the resolved upstream runtime supports the same child
layout, persistent geometry and per-instance permission policy. Requalify both GTK
backends and macOS permission behavior before removing either override.

The Linux native regression is
`python3 tauri-runtime-wry-2.10.1/examples/gtk-child-trial.py` from this directory,
with the GNOME session environment, Cargo dependencies cached and `python3-dbus`
installed. It compiles through a temporary manifest using the actual runtime layout
module and vendored Wry, then exercises Wayland and X11 with Mutter-seat input:
rectangles, relayout, menus, reparenting, hide/show, independent owning windows,
destruction, permission/download denial and distinct persistent data managers.
Full application checks additionally exercise Tauri's dispatch integration.

## Tao native window backports

`tao-0.34.6/` is the published Apache-2.0 crate (license included), with
the Windows input backport from upstream [tao#1215], the macOS
`is_zoomed` function from [tao#1182], and the local Windows runner refcount
compatibility correction below. It is selected by the Tauri workspace's
`[patch.crates-io]`; never mutate the registry cache or patch at build time. All
platforms keep the same dependency/API version.

- Crate: https://static.crates.io/crates/tao/tao-0.34.6.crate
- SHA-256: `6e06d52c379e63da659a483a958110bbde891695a0ecb53e48cc7786d5eda7bb`
- Upstream fix: `c704261c519c58cfdd0bc2d58ba24e06a0b71c92`
- Patch: `patches/tao-1215.patch` (upstream PR diff, Windows source hunks only applied)

`PeekMessageW` may synchronously dispatch sent messages and reenter the window
procedure. Tao 0.34.6 holds `KEY_EVENT_BUILDERS`, `LAYOUT_CACHE` or the IME window
state across peeking, causing same-thread mutex deadlocks. The upstream fix moves
the peeks before those locks and passes the results into the handlers.

Preserve the provenance above; never pump messages under these input mutexes,
replace non-reentrant mutexes with recursive locks or silently drop nested input.

The Windows native regression (`node scripts/test-tauri-input-deadlock.mjs
--baseline`) uses a hidden Tao window and cross-thread sent focus messages. Its
bounded watchdog fails against the unpatched published crate and passes with
this backport. It never opens CodeNomad profiles or OpenCode.
The runner additionally instruments a temporary crate copy at the IME callback
boundary and proves that moving only the IME peek back under its mutex fails.
Never instrument or mutate this checked-in crate.

## macOS read-only zoom detection

The macOS backport is the exact `window.rs` hunk from upstream commit
`2fb512315899973e2c64d00c0e34ed382d93c893` ([tao#1182]). Its patch is
`patches/tao-1182.patch`. It affects macOS only.

On borderless windows, the published 0.34.6 maximize getter temporarily changes
the native style mask twice. These writes generate resize/move events. CodeNomad's geometry
capture reads the getter again, sustaining a main-thread event feedback loop
before loading-screen navigation completes. The upstream getter uses read-only
AppKit frame/screen queries instead. It retains native `isZoomed` for ordinary
titled, resizable windows and when no screen is available.

Run `node scripts/test-tauri-macos-window.mjs --baseline` in a graphical macOS
session. The isolated native fixture checks that getters generate no geometry
events, including reads during geometry capture, and exercises maximize/restore,
fixed-size and decorated windows. Its unpatched-crate negative control reproduces
the feedback loop.

[tao#1215]: https://github.com/tauri-apps/tao/pull/1215
[tao#1182]: https://github.com/tauri-apps/tao/pull/1182

## Windows runtime handle lifetime

The pinned `tauri-runtime-wry` 2.10.1 exposes `Send + Sync + Clone` runtime
handles whose unsafe context graph contains Tao's non-atomic
`Rc<EventLoopRunner>`. Safe handle clones/drops on IPC workers race the main
thread's reference count, freeing the runner prematurely or leaking it.

The local correction makes **only this internal shared counter** an `Arc`
in `event_loop.rs` and `event_loop/runner.rs`. Never make
`EventLoopWindowTarget` Send/Sync, access the runner's `Cell`/`RefCell` state
from workers or rely on Tao window targets crossing threads: runner state stays
main-thread-only.

[tauri#15408](https://github.com/tauri-apps/tauri/issues/15408) and
[tauri#15793](https://github.com/tauri-apps/tauri/issues/15793) track the race.
Tao declined the same counter change ([tao#1290](https://github.com/tauri-apps/tao/pull/1290))
because Tauri's cross-thread use of the non-Send window target is the contract
violation, so this correction stays local to the runtime we ship.

`node scripts/test-tauri-runner-refcount.mjs --baseline` calls the real pinned
Wry runtime's safe public handle API on eight workers. The negative control
reverts only the counter in a temporary crate copy and stops at its first native
fault; a CI runner that never reproduces the timing-dependent race only warns
(local runs still fail). The corrected build must finish every run and tear down
cleanly. It uses no CodeNomad profile, page, backend or OpenCode service.
Individual negative-control processes can survive a race that leaks instead of
freeing early.

The race shows as `STATUS_HEAP_CORRUPTION` (0xc0000374) in `ntdll!RtlFreeHeap`
via a non-atomic `dec` refcount release from the native event callback. The
fixture performs 800,000 clones/drops; the
negative control runs up to fifty processes; in CI a fault-free negative series
only warns (naming the CPU), and corrected runs on that runner are no timing
evidence. Also run the input regression: its backport shares `event_loop.rs`.
Never commit or upload captured crash dumps: they contain application memory.

Remove the tao override only when the resolved dependencies contain the input
fix (a bump within the unfixed 0.34.x/0.35.x lines is insufficient) and the
read-only zoom getter, and the resolved Tauri runtime no longer races Tao's
runner reference count (or Tao handles that traffic safely). Qualify removal
with the input, macOS zoom and runner-refcount regressions.

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
paths stay upstream code. Remove this override when a published plugin provides the
same success-only handoff; rerun the regression and signed installer trial first.

## Agent conventions

- Tao's macOS zoom getter must remain read-only: synchronous temporary style-mask changes on borderless windows generate geometry-event feedback and can starve startup navigation. Keep the exact upstream tao#1182 backport beside the Windows fix. Run `node scripts/test-tauri-macos-window.mjs --baseline` in a graphical macOS session and retain the ARM64 CI regression. Do not disable window persistence or change the application chrome as a workaround.
