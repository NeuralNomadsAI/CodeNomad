# Tauri updates and Linux AppImage distribution

## Installation contract

The native Get Updates menu, the required-upgrade notification and the preview
release notification share `stores/desktop-updates.ts`. A check offers an
explicit **Install and restart** action. The renderer supplies only the saved
update feed and later the version it accepted; Rust selects the release, retains
the checked native `Update` and owns every URL and the verification key.
Each new check or install replaces the previous update notification so stale
install offers do not remain actionable after a failure or changed check result.

Update feeds follow the server notification rules (`server.updateFeed`, else
derived from the installed build label), implemented natively in
`update_releases.rs` from the GitHub releases list:

| Feed | Offered release |
| --- | --- |
| `stable` | GitHub's latest final release (`/releases/latest`, never displaced by prereleases) when it has a `latest.json` and a higher version |
| `preview` | Newest publication of any kind (dev prerelease or release) with a `latest.json`, newer by publication than the installed release |

Preview labels reuse their base version, so SemVer alone can rank a newer
preview below an older one; publication order decides, and builds unknown to
GitHub fall back to version order as on the server. Only the selected release's
manifest is fetched, and it must announce exactly the selected version. Releases
without a manifest (still building, partially failed or older than the updater)
are never offered, so a release in progress cannot break checks.

The native menu emits `menu:action` to the focused local webview only, and the
renderer listens on its own webview: untargeted Tauri listeners receive every
window's events. When Preferences or a remote window is focused, or no local
window remains, Get Updates opens the release page. Renderer fallbacks use the
saved feed (preview: the full releases list; stable: the latest release). The
native fallback and About link cannot read the saved feed and derive it from
the installed build label.

A notification announces any published release, while native checks only offer
releases whose manifest is already published. When a notification's check finds
nothing installable, it opens that notification's release page rather than
reporting the application as current.

Supported installed formats:

| Target | Updater payload |
| --- | --- |
| Windows x64 NSIS | Signed `.exe` |
| macOS x64 | Signed `.app.tar.gz` |
| macOS arm64 | Signed `.app.tar.gz` |
| Linux x64 AppImage | Signed `.AppImage` |

Debian/RPM packages, loose Windows executables and builds without an embedded
public key open the release page. Linux requires both the native AppImage bundle
marker and a nonempty `APPIMAGE` path. `APPRUN` alone is insufficient. Installer
signatures are independent of Apple code signing/notarization and Authenticode.

`desktop_updater.rs` authorizes native callers against local application origins
and serializes checks/downloads across windows. Only the three guarded application
commands (check, install, take failure) are granted to local webviews;
updater/process plugin permissions are not granted to previews, remote windows or
renderers generally.

The plugin verifies the complete download before shutdown admission. A prepared
installer and restart intent enter the shutdown coordinator under one lock.
Every renderer must flush and the owned CodeNomad backend must stop before
installation. A timeout or cleanup failure discards the pending installer; a
late acknowledgement or later ordinary quit cannot replay it. Windows logout
discards a waiting update. The shared OpenCode daemon remains externally owned.

On macOS/Linux, successful installation follows the normal native restart. On
Windows, the NSIS installer performs relaunch and the plugin exits. The vendored
2.12.0 plugin moves its exit callback after successful `ShellExecuteW`: a refused
launch must not release client-state persistence ownership. On an installation
error, the application restores its owned backend without replaying installation.
That recovery reloads every window, so the failure is recorded natively and the
first reloaded document takes and reports it. Failures without a reload (flush
timeout, cleanup failure, refused backend recovery) are reported by the document
whose install was accepted; another document merely checking stays silent.
Notification history retains install actions, so an offer from an earlier check
starts a fresh check instead of installing.

The loading, sign-in (`/login`, `/auth/*`) and pairing documents have no menu
listener: Get Updates opens the release page while the focused local window
shows one of them. Every other server path serves the application, whose
listener registers when it mounts.
See `packages/tauri-app/vendor/README.md` for provenance.

## Build and publication

`configure-updater.mjs` writes a Tauri V2 `plugins.updater` entry and
`bundle.createUpdaterArtifacts: true` when `TAURI_UPDATER_PUBKEY` contains a
minisign public key, with `requireSignedVersion`: the manifest itself is not
signed, so the signed trusted comment must carry the announced version and an
older signed artifact cannot be relabelled. It configures no endpoint; the
application selects the manifest per feed. Absent keys remove updater
configuration and explicitly disable artifact signing. The native host registers
the plugin only when that configuration exists; the plugin rejects a missing
configuration during initialization, before any check.

Release and dev prerelease uploads use these repository secrets in all four
platform jobs:

- `TAURI_UPDATER_PUBKEY` (job environment; public)
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (only the
  `tauri build` step, never dependency installation or upload steps). Prebuild
  runs earlier without them; `src-tauri/tauri.prebuilt.conf.json` replaces the
  `beforeBuildCommand` hook so JavaScript builds do not rerun with the key.
  Cargo build scripts inside `tauri build` still run in that environment.

PR builds receive none of these secrets. Never embed a test public key in a
production release.

`updater-artifacts.mjs stage` finds exactly one native updater payload, verifies
its minisign data and trusted-comment signatures, requires the trusted comment
to record the release version, copies it to the final release asset name, and
writes a per-platform receipt. The receipt contains public signature/key
fingerprints and the payload digest, never private key material.

The final publication job waits for all four platform jobs, merges their receipts
and checks the uploaded GitHub asset digests. Missing/duplicate targets, mixed
versions or keys, partial signing, changed signatures and missing payloads fail
publication. Only then does it generate and upload that release's `latest.json`;
stable releases and dev prereleases each carry their own manifest. Before a
platform replaces its signed payload on a rebuilt tag, staging deletes any
existing `latest.json`, so no published manifest pairs new bytes with an old
signature; until publication succeeds, the release is simply not installable.

Downloads have connect (30 s) and read-stall (60 s) limits but no total limit,
so slow connections can still fetch large installers.
`tauri build` is not expected to generate that manifest. Fully unsigned builds
produce no update manifest. Linux arm64 remains outside the existing release matrix.

The Linux build requests `deb,appimage` with verbose linuxdeploy diagnostics.
The CLI minimum is 2.10.0: 2.9.4 searches for an old unmangled bundle symbol,
while the pinned Rust library uses `__TAURI_BUNDLE_TYPE_VAR_UNK`. The newer CLI
patches that token and restores the original binary between package formats.
The workspace lock currently resolves CLI 2.11.5.

Linux desktop resources omit msgpackr's musl-only native modules. The official
bundled Node runtime is glibc-based; linuxdeploy otherwise runs `ldd` over the
unusable musl ELF and aborts. This failure was reproduced on Ubuntu 24.04 with
verbose output, independently of the earlier generic CI failure.
For local rebuilds after a failed packaging run, remove the generated
`target/release/bundle/appimage` and `target/release/bundle/appimage_deb` staging
directories: the latter can retain removed resources between bundle attempts.

Verification extracts via an absolute artifact path, checks `AppRun` and
`usr/bin/codenomad-tauri`, smoke-tests bundled Node/server/UI resources, resolves
ELF dependencies against bundled library directories and reports the binary's
glibc floor. Extraction mode does not prove the cause of a bundling failure:
Tauri 2.9.4 already invokes linuxdeploy in extraction mode itself.

## Validation

- Node tests exercise configuration, the four payload formats, manifest
  completeness, key/asset mismatch, payload/trusted-comment tampering and the
  signed release version.
- `update_releases.rs` tests feed resolution, stable/preview selection,
  same-day previews, publication order, drafts and repository-bound URLs.
- `desktop_updater_tests.rs` downloads a CLI-signed public-only fixture through
  the real updater plugin and rejects modified bytes without invoking installers.
  Its insecure HTTP exception exists only in the loopback mock application's config.
- Shutdown regressions verify all-window flushing, cancellation, atomic restart
  admission, conflict with an existing quit and Windows logout.
- The vendored Windows launch regression checks success-only ownership release.
- Browser tests exercise the real update store and toast actions, explicit install,
  duplicate gestures, failure recovery (including after a reload), feed
  forwarding and unsigned/Electron/remote fallback.

Commands (from the checkout, unless noted):

```text
node --test packages/tauri-app/scripts/configure-updater.test.mjs packages/tauri-app/scripts/updater-artifacts.test.mjs
npm run typecheck --workspace @codenomad/ui
cargo test --manifest-path packages/tauri-app/src-tauri/Cargo.toml --locked
# From packages/tauri-app on Windows:
cargo test --locked -p tauri-plugin-updater windows_launch_tests
# From packages/ui:
node --import tsx --test tests/browser/desktop-updates.test.ts
```

These automated checks do not replace signed install/relaunch trials. Track actual
Windows, Linux and macOS artifact trials separately in the PR; macOS guest access
and Apple Silicon hardware are required for their respective real-device evidence.

### Isolated Linux trial (2026-09-26)

Ubuntu 24.04.4 x64 / GNOME Wayland produced and ran the AppImage with bundled
Node 24.20.0. Extraction, server dependency imports, UI resources and ELF closure
checks passed; the application binary's measured glibc floor is 2.39. An unsigned
build reached the OpenCode setup UI and quit through its native menu, stopping
only its own CodeNomad backend.

Two loopback-only builds used the public test key and an isolated HOME/config
profile. Through the native Get Updates menu and rendered Install and restart
action, a modified download was rejected without replacing the installed image.
A fresh check against the valid signed AppImage then updated 0.20.1 to 0.20.2:
the About dialog showed 0.20.2 after relaunch, the native process changed from
38556 to 43069, and the old backend (38749) stopped before the new backend (43200)
started with the same isolated config path. The installed and served payloads
both hashed to `db256808279d2edccc7de4b3c2d25f7532c4443e1d18e2a164b6626cf928dba7`.
This establishes package replacement and profile identity across restart; it does
not establish restoration of an active conversation or multi-window drafts.

### Isolated Windows trial (2026-09-26)

CLI 2.11.5 built both signed NSIS packages and successfully patched their bundle
markers. The test-only product installed under `%LOCALAPPDATA%/CodeNomadUpdaterTrial`,
with its own `CLI_CONFIG` and `updater-trial` identity channel. A missing manifest
reported a recoverable check error. After the native Help / Get Updates action,
an explicitly accepted altered download reported failure, left process 46008
running and preserved the initial executable digest
`abd32c17fdc7aa729f9203dd88a7235cc00a6b5c64e357ef0ed32c47f7e8510b`.

A fresh check and explicit rendered install action downloaded the valid signed
installer, stopped the old application/backend launcher and relaunched process
45980 with launcher 22152. The native About dialog and NSIS registration both
reported 0.20.2. The updated executable digest was
`de79957e58afa1cbd3ccb855dc9b1de064cf0e3a271524559043ade720ff425b`.
Native scope `updater-trial-1b6b044d8285f85b` was retained across the restart.
Trial versions were native config overlays; the unchanged bundled server/UI and
PE metadata still reported their base 0.20.0. Actual releases set package versions
through the normal release workflow before compilation.

The final native suite passed 189 tests. The stale-notification fix discovered in
this trial subsequently passed four updater browser tests and the UI typecheck;
it was not present in these two already-built installer payloads. The complete
history-navigation suite had passed before that independent store-only change.
