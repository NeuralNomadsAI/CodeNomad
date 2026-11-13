# Vendored Tauri crates

## Embedded WebKit views

`tauri-runtime-wry-2.12.3/` and `wry-0.57.1/` are complete published
MIT/Apache-2.0 crates, including licenses, selected through `[patch.crates-io]`.

- Crates: https://static.crates.io/crates/tauri-runtime-wry/tauri-runtime-wry-2.12.3.crate
  and https://static.crates.io/crates/wry/wry-0.57.1.crate.
- Published SHA-256: runtime `e1aa9d8b7a120f879f44fdc1053f7b7dbf416bf0bbc6a72b714dec46b782b52f`;
  Wry `759c50ddad0ef9913bb5496cb9d509a50433a3b78cb0238d61105526589cf0e9`.
- Local changes: `patches/tauri-runtime-wry-gtk.patch` and
  `patches/wry-gtk.patch`, then `patches/wry-webkit-capabilities.patch`,
   `patches/wry-browser-isolation.patch`, `patches/runtime-browser-isolation.patch`
   `patches/wry-browser-print.patch` and `patches/wry-browser-download.patch`;
  native trials ship beside the runtime examples.
- GTK: the runtime lazily installs a window-owned `GtkOverlay` inside Tao's
  content box, below its menu bar. Primary content stays boxed, including a
  window's own webview in Tauri's multi-webview mode (it requests no bounds), so a
  visible menu bar never pushes it past the window; child webviews use `GtkFixed`.
  The overlay passes uncovered input through to the primary view.
  Primary-only windows keep their ordinary box. Reparenting uses the destination
  window's own child container.
- Wry stores child positions in `GtkFixed` and sizes in GTK size requests, alongside
  immediate allocation, so resize/menu/hide-show allocations keep the rectangle.
  Bounds reads use that retained layout while hidden, preserving position across
  Tauri's separate position and size updates before reveal.
  Bounds follow the actual parent after reparenting. IPC callbacks keep weak
  WebView references so destruction releases both the view and its IPC manager.
- WKWebView uses Tauri's per-webview `on_permission_request` callback, installed
  on the embedded-view builder before construction. Wry's native delegate routes
  media capture to it; file uploads retain user-driven selection. The application
  renderer keeps its own permission policy. Requalify WebKit's engine-default
  handling of location, notifications, display capture and storage access when
  changing runtime or OS support.
- Browser previews' WKWebView delegate presents native JavaScript dialogs labeled
  with the initiating host; the `browser-popup-` delegate closes its native window
  on `window.close()`. WebKitGTK closes the corresponding popup window before
  destroying its view, and scopes shared-context download callbacks to the
  originating view with overwriting disabled and native file-URI destinations.
  Rejected browser blob/data document requests become downloads, preserving the
  preview's HTTP(S)-only document policy.
  Browser pop-ups use Tauri's related-view/configuration API, retaining the native
  opener and shared site state. The backend-free fixture in
  `../tests/webkit-capabilities/` exercises these paths on both engines.
- Browser labels select a runtime fence around application initialization scripts,
  IPC and app resource protocols. Native browser globals and synchronous dialogs
  stay owned by the engine. Preview navigation gestures use Wry's native setting.
  WebView2 popup script closure disposes the top-level popup instead of only its
   child container; embedded roots remain host-owned.
- WKWebView preview printing and beforeunload use the native delegate selectors
   in WebKit's `WKUIDelegatePrivate.h`: both printFrame variants and the
   initiating-frame beforeunload completion. Printing uses the public
   `printOperationWithPrintInfo:` operation and system panel. Qualify these
    selectors on supported macOS/WebKit updates with the native fixture.
- WKWebView's `_webView:contextMenuDidCreateDownload:` callback, declared by
  `WKNavigationDelegatePrivate.h`, attaches the same download delegate as native
  navigation downloads. Both paths use the preview's Downloads-folder policy.

Keep these overrides until the resolved upstream runtime supports the same child
layout, persistent geometry policy. Requalify both GTK
backends and macOS permission behavior before removing either override.

The Linux native regression is
`python3 tauri-runtime-wry-2.12.3/examples/gtk-child-trial.py` from this directory,
with the desktop session environment, Cargo dependencies cached and `python3-dbus`
installed. KDE Wayland uses `GTK_TRIAL_UINPUT=1`, `python3-evdev` and a writable
`/dev/uinput`; an X11 desktop uses `GTK_TRIAL_X11=1` and `xdotool`. GNOME uses
Mutter's native seat. It compiles through a temporary manifest using the actual runtime layout
module and vendored Wry, then exercises Wayland and X11 with native input:
rectangles, relayout, menus, reparenting, hide/show, independent owning windows,
destruction, permission/download denial and distinct persistent data managers.
Full application checks additionally exercise Tauri's dispatch integration.
`cargo run --example menu-layout-linux` (from `packages/tauri-app`, in an unlocked
X11 and Wayland session) runs the runtime itself with a visible menu bar: the
window's page must match its allocation below the menu initially, after maximizing
and after a child webview joins at its requested rectangle. Its negative control
builds the window's own webview into the child `GtkFixed`, which overflows by the
menu bar's height.


The Tauri workspace's `[patch.crates-io]` (`packages/tauri-app/Cargo.toml`)
selects the published crates below, with focused local changes. Never mutate the
registry cache or patch at build time. Each directory is named after its crate
version; `packages/tauri-app/scripts/vendored-patches.test.mjs` fails when
`Cargo.lock` no longer resolves a vendored copy (for example after a dependency
update requires a newer release, which leaves the patch unused).

## Re-qualification on every Tauri update

Tauri, its runtime and plugin updates (proposed by Dependabot,
`dev-docs/RUNTIME_MAINTENANCE.md`) can require a newer Tao or updater release.
For each vendored crate:

1. Check whether the upstream release now contains the local change; then drop
   the copy, its `[patch.crates-io]` entry and its patch file.
2. Otherwise download the required published crate, record its URL and SHA-256
   below, extract it as `vendor/<crate>-<version>/` and re-apply the patch file
   in `patches/`, regenerating the patch against the new crate.
3. Run the regressions named in its section, including the negative controls.

## GLib variant string iteration

`glib-0.18.5/` is the complete published MIT crate, including its license,
selected through `[patch.crates-io]` for the GTK/WebKitGTK bindings resolved in
`Cargo.lock`.

- Crate: https://static.crates.io/crates/glib/glib-0.18.5.crate
- SHA-256: `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`
- Local change: `patches/glib-variant-str-iter.patch`, the two-line correction in
  [gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343) for
  [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
  ([GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)).

`VariantStrIter::impl_get` passes a mutable pointer out-argument to
`g_variant_get_child`, preserving the pointer written by GLib under optimization.
The crate keeps its published name and version. Version-based advisory checks
classify `0.18.5` within the affected range; GitHub alert tracking remains separate
from qualification of the source backport.

On Linux, `node --test scripts/vendored-patches.test.mjs` runs the workspace's
`tests/glib-variant-str` regression against the resolved crate in release mode,
with one Cargo job and a fresh temporary build directory. It checks forward,
reverse, indexed and mixed iteration, empty/Unicode strings, exhaustion, borrowed
string lifetime and rejection of a non-string-array variant. The shared vendor
check also requires a unique path-resolved glib in the lockfile.

Keep this override until the resolved GTK/WebKitGTK dependency family uses a
published corrected glib. Requalify the Linux build and both GTK backends when
changing that family.

## Tao Windows runtime handle lifetime

`tao-0.37.2/` is the published Apache-2.0 crate (license included).

- Crate: https://static.crates.io/crates/tao/tao-0.37.2.crate
- SHA-256: `d5777b06fe6435126ae8d816eba269e050e1e10d302cf5461e9c49eccabc3548`
- Local change: `patches/tao-runner-refcount.patch`

The Tauri runtime (`tauri-runtime-wry`, version in `Cargo.lock`) exposes
`Send + Sync + Clone` runtime handles whose unsafe context graph contains Tao's
non-atomic `Rc<EventLoopRunner>`. Safe handle clones/drops on IPC workers race
the main thread's reference count, freeing the runner prematurely or leaking it.

The local correction makes **only this internal shared counter** an `Arc`
in `event_loop.rs` and `event_loop/runner.rs`. Never make
`EventLoopWindowTarget` Send/Sync, access the runner's `Cell`/`RefCell` state
from workers or rely on Tao window targets crossing threads: runner state stays
main-thread-only.

[tauri#15408](https://github.com/tauri-apps/tauri/issues/15408) tracks the race
([tauri#15793](https://github.com/tauri-apps/tauri/issues/15793) is its
duplicate; the proposed runtime fix is
[tauri#15411](https://github.com/tauri-apps/tauri/pull/15411)). Tao declined the
same counter change ([tao#1290](https://github.com/tauri-apps/tao/pull/1290),
[tao#1334](https://github.com/tauri-apps/tao/pull/1334)) because Tauri's
cross-thread use of the non-Send window target is the contract violation, so
this correction stays local to the runtime we ship.

`node scripts/test-tauri-runner-refcount.mjs --baseline` calls the real Wry
runtime's safe public handle API on eight workers; its fixture resolves the
application's locked `tauri-runtime`/`tauri-runtime-wry`. The negative
control reverts only the counter in a temporary crate copy and stops at its
first native fault; a CI runner that never reproduces the timing-dependent race
only warns (local runs still fail). The corrected build must finish every run
and tear down cleanly. It uses no CodeNomad profile, page, backend or OpenCode
service. Individual negative-control processes can survive a race that leaks
instead of freeing early.

The race shows as `STATUS_HEAP_CORRUPTION` (0xc0000374) in `ntdll!RtlFreeHeap`
via a non-atomic `dec` refcount release from the native event callback. The
fixture performs 800,000 clones/drops; the negative control runs up to fifty
processes; in CI a fault-free negative series only warns (naming the CPU), and
corrected runs on that runner are no timing evidence. Never commit or upload
captured crash dumps: they contain application memory.

Remove the Tao override only when the resolved Tauri runtime no longer races
Tao's runner reference count (or Tao handles that traffic safely), qualified
with the runner-refcount, input and macOS zoom regressions.

### Upstream Tao fixes the application depends on

Published Tao contains the Windows input reentrancy fix
([tao#1215], commit `c704261c519c58cfdd0bc2d58ba24e06a0b71c92`) and the macOS
read-only `is_zoomed` getter ([tao#1182], commit
`2fb512315899973e2c64d00c0e34ed382d93c893`). Their regressions keep a negative
control against the last published Tao without them (`UNFIXED_TAO` in each
script):

- `node scripts/test-tauri-input-deadlock.mjs --baseline` (Windows): a hidden
  Tao window receives cross-thread sent focus messages while Tao peeks during
  key, character and system-character input; a bounded watchdog fails on a
  same-thread input-lock deadlock. Tao reads committed IME text with
  `ImmGetCompositionStringW` without peeking, so IME input has no reentrancy
  point. It never opens CodeNomad profiles or OpenCode.
- `node scripts/test-tauri-macos-window.mjs --baseline` (graphical macOS
  session): getters generate no geometry events, including reads during
  geometry capture, and maximize/restore, fixed-size and decorated windows work.
  The negative control reproduces the borderless style-mask feedback loop that
  starves startup navigation.

Never pump messages under Tao's input mutexes, replace non-reentrant mutexes
with recursive locks or silently drop nested input.

[tao#1215]: https://github.com/tauri-apps/tao/pull/1215
[tao#1182]: https://github.com/tauri-apps/tao/pull/1182

### Windows session end

Tao's hidden thread event target (window class `Tao Thread Event Target`) calls
`std::process::exit(0)` on `WM_ENDSESSION`, and Windows may deliver the message
to it before any application window. `windows_session_end.rs` subclasses that
window too: CodeNomad's bounded session-end flush and backend cleanup run first,
then the message reaches Tao. Application windows consume the message as before.
`windows_session_end_tests.rs` checks the ordering, the lookup and that the Tao
the application resolves (`cargo metadata`) still exits from the named target.

## Updater Windows launch handoff

`tauri-plugin-updater-2.14.1/` is the published MIT/Apache-2.0 crate (licenses
included).

- Crate: https://static.crates.io/crates/tauri-plugin-updater/tauri-plugin-updater-2.14.1.crate
- SHA-256: `d957abbcb3f9f6c76d22a3a0f012f30880640d0bccb5634d2b12a9937e4c872b`
- Local change: `patches/tauri-plugin-updater-launch-handoff.patch`.
  `src/updater.rs` runs `on_before_exit` only after a successful
  `ShellExecuteW`. Upstream calls it before launching, irreversibly releasing
  client-state ownership even when Windows refuses to start the installer.
- Regression: `node scripts/test-tauri-updater-handoff.mjs` (Windows) tests
  failed and successful native launch result codes in a temporary copy of the
  vendored crate, built with its published lockfile.

Extraction, signature checks, NSIS arguments, installer restart and Unix install
paths stay upstream code. Remove this override when a published plugin provides
the same success-only handoff; rerun the regression and signed installer trial
first.

## Agent conventions

- Tao's macOS zoom getter must remain read-only: synchronous temporary style-mask changes on borderless windows generate geometry-event feedback and can starve startup navigation. Run `node scripts/test-tauri-macos-window.mjs --baseline` in a graphical macOS session and retain the ARM64 CI regression. Do not disable window persistence or change the application chrome as a workaround.
- Re-vendor a crate only from its published `.crate` with a recorded SHA-256, and keep each local change a minimal, regenerated patch in `patches/`.
