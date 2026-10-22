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
saved feed (stable: the latest release; preview, or a feed that could not be
read: the full releases list, which contains every offered release). The
native fallback and About link cannot read the saved feed and derive it from
the installed build label.

When a notification's check finds nothing installable, it opens that
notification's release page rather than reporting the application as current.

Supported installed formats:

| Target | Updater payload |
| --- | --- |
| Windows x64 NSIS | Signed `.exe` |
| macOS x64 | Signed `.app.tar.gz` |
| macOS arm64 | Signed `.app.tar.gz` |
| Linux x64 AppImage | Signed `.AppImage` |

Debian/RPM packages, loose Windows executables and builds without an embedded
public key open the release page. Linux requires both the native AppImage bundle
marker and a nonempty `APPIMAGE` path; `APPRUN` alone is insufficient.

`desktop_updater.rs` authorizes native callers against local application origins
and serializes checks/downloads across windows. A check while another window
checks or installs returns `busy`, shown as information rather than a failure
(a notification still opens its release page). Only the three guarded application
commands (check, install, take failure) are granted to local webviews; never
grant updater/process plugin permissions to previews, remote windows or
renderers generally.

The plugin verifies the complete download before shutdown admission. A prepared
installer and restart intent enter the shutdown coordinator under one lock.
Every renderer must flush and the owned CodeNomad backend must stop before
installation. A timeout or cleanup failure discards the pending installer; a
late acknowledgement or later ordinary quit cannot replay it. Windows logout
discards a waiting update. Installation never stops the shared OpenCode daemon.

On macOS/Linux, successful installation follows the normal native restart. On
Windows, the NSIS installer performs relaunch and the plugin exits. The vendored
2.12.0 plugin runs its exit callback only after a successful `ShellExecuteW`, so
a refused launch keeps client-state persistence ownership. On an installation
error, the application restores its owned backend without replaying installation.
That recovery reloads every window, so failures are recorded natively with the
webview whose install was accepted. That webview's document takes and reports
it, including after a reload; once that webview is closed, any local document
takes it. Download failures are recorded and emitted too, since the caller may
reload or close during a long download; the live caller reports each failure
once, whether its rejected request or the event arrives first.
Failures without a reload (flush timeout, cleanup failure, refused backend
recovery) are also emitted to live documents; another document merely checking
cannot take them.
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
minisign public key, with `requireSignedVersion`: the manifest itself is
unsigned, so the signed trusted comment must carry the announced version and an
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
writes a per-platform receipt. The receipt contains the verified signature, the
public key fingerprint and the payload digest, never private key material. The
signature is published only inside `latest.json`, which is where the updater
reads it; staging removes any separate `.sig` asset from a rebuilt tag.

The final publication job waits for all four platform jobs, merges their receipts
and checks the uploaded GitHub asset digests. Missing/duplicate targets, mixed
versions or keys, partial signing and missing or changed payloads fail
publication. Only then does it generate and upload that release's `latest.json`;
stable releases and dev prereleases each carry their own manifest. Receipt
artifacts and the publication job run only for tagged upload builds. PR builds
are unsigned: staging only records an unsigned receipt, and signature/manifest
logic is covered there by the script tests. Before a
platform replaces its signed payload on a rebuilt tag, staging deletes any
existing `latest.json`, so no published manifest pairs new bytes with an old
signature; until publication succeeds, the release is simply not installable.

Downloads have connect (30 s) and read-stall (60 s) limits but no total limit,
so slow connections can still fetch large installers. Fully unsigned builds
produce no update manifest. The release matrix has no Linux arm64 target.

The Linux build requests only `appimage`, with verbose linuxdeploy diagnostics;
the Linux deb is the Electron build. The Windows NSIS installer is published
directly as the download and updater payload, without a ZIP wrapper.
The CLI minimum is 2.11.5, the first release that records the app version in
updater signatures' trusted comments; `requireSignedVersion` and publication's
signed-version gate depend on it.

Linux desktop resources omit msgpackr's musl-only native modules. The official
bundled Node runtime is glibc-based; linuxdeploy otherwise runs `ldd` over the
unusable musl ELF and aborts. For local rebuilds after a failed packaging run, remove the generated
`target/release/bundle/appimage` and `target/release/bundle/appimage_deb` staging
directories: the latter can retain removed resources between bundle attempts.

Verification extracts via an absolute artifact path, checks `AppRun` and
`usr/bin/codenomad-tauri`, smoke-tests bundled Node/server/UI resources, resolves
ELF dependencies against bundled library directories and reports the binary's
glibc floor.

The AppImage runtime unmounts the bundle as soon as the main process exits, while
WebKit's helper processes started from it can outlive that process briefly; a
helper that then touches the vanished mount dies with SIGBUS and the desktop
reports a crash. On `RunEvent::Exit`, including updater restarts, the AppImage
host therefore stops its child processes that still run from the mount
(`appimage_exit.rs`): each is pinned with a pidfd and checked again as our child
running from the mount, then receives SIGTERM, and SIGKILL if it has not exited
after 1.5 s; waiting for exits stops after two seconds in total. Children running
from elsewhere, such as the shared OpenCode service, keep running.

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
- On Linux, `appimage_exit.rs` tests stop a child running from a temporary
  mount while sparing one running elsewhere. A real AppImage must quit without
  leaving WebKit helpers or a crash report in `/var/crash`.
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

Signed install/relaunch trials on real artifacts are also required: track
Windows, Linux and macOS trials in the PR; macOS guest access and Apple Silicon
hardware are required for their respective real-device evidence.

## Agent conventions

- The update feed (`server.updateFeed`: `stable`/`preview`, chosen in Settings → Info → Updates) only selects offered releases. It is read on every refresh in `releases/dev-release-monitor.ts`, never from `CODENOMAD_UPDATE_CHANNEL`, and must not touch desktop data scopes, singletons, backends or OpenCode state. Preview offers use publication order (dev builds carry the previous release number) and, like the native updater, consider only releases whose complete `latest.json` exists: release creation precedes the builds, and the manifest is uploaded after every platform build, so a notification is never shown before the release is installable. When the installed release is older than the fetched page, the server looks it up by tag before falling back to version order, and Settings → Info never substitutes a SemVer-ranked stable release on the preview feed. The native Tauri updater follows the same feed (`update_releases.rs`); Electron, remote, unsigned and unsupported installations open the release page.
