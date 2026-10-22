# OpenCode runtime setup and admission

Minimum and recommendation: `packages/server/src/opencode/runtime-support.ts`;
pins: the server, UI and pruning `package.json`; rationale and qualification:
[OPENCODE_COMPATIBILITY.md](OPENCODE_COMPATIBILITY.md). Source changes
never upgrade or restart a user's service.

## Admission

- `0.0.0-beta-*` labels and versions below the minimum are refused with HTTP 426
  and a concrete reason (`runtime-support.ts`). Unlisted, future-major, custom
  and prerelease labels are unverified and admitted after authenticated bounded
  API recognition.
- Admission uses authenticated daemon metadata, never the selected discovery
  CLI's version, and precedes functional requests and plugin provisioning;
  replacement daemons are rechecked even at the same URL. Client/plugin pins
  are separate from admission.
- Recognition checks canonical session/permission/Form/inbox shapes and the
  required `PUT /api/session/{sessionID}/environment`; missing APIs are reported
  separately from an untested version. Optional configuration reload follows
  its own route presence. Never probe support with a write.

## Setup and recovery

Startup recovery and Preferences share `OpenCodeSetupPanel` and its store, but
missing installations, known incompatibility and optional updates expose
different actions; installed/running/minimum/recommended versions and the
technical reason show separately, with retry and executable selection. Dismissal
leaves a recovery entry; optional updates never force the dialog. Connection
changes, foreground entry and unsupported proxy responses refresh state; stale
responses cannot overwrite a changed executable or completed action. Only a
pending folder open may resume; prompts are never replayed.

Automatic selection follows PATH order (`opencode2`, then `opencode` within
each directory), then the conventional user npm installation. An explicit
supported executable keeps priority. Setup and binary validation share one
discovery. The UI shows the effective path and labels this source “automatic”.
Recovery puts diagnosis and installation before executable selection.
Discovery reads each npm package's published `bin` map and real launcher target,
choosing `opencode` when `opencode2` is only a `bin/*.cjs` alias.
Discovery preserves terminal PATH/PATHEXT ordering even when a standalone
executable shares the npm command directory; such an executable remains
user-managed. On POSIX, only the prefix's actual `bin` directory counts as an
npm command directory. A standalone executable replacing a POSIX npm symlink is
selected in PATH order and remains user-managed; only an actual symlink to
the package's `.cjs` alias is skipped in favor of the working `opencode`
command. On Windows, that alias is skipped only when the npm `.cmd` script
positively invokes the package's `.cjs` target; a customized `.cmd` wrapper
keeps PATH priority and the automatic npm updater never overwrites it.

Default host installation uses bundled Node/npm to run a standard global npm
installation of `@opencode/cli`. Existing writable npm installations on PATH are
reused after verifying their manifest and launcher identity; standalone/curl,
Homebrew and custom installations remain user-managed. With no PATH installation,
the user prefix is `%APPDATA%/npm` on Windows and `~/.local` on POSIX, or an explicit
absolute `NPM_CONFIG_PREFIX`. Existing npm prefixes on PATH are retained. npm
publishes the normal terminal commands; CodeNomad verifies the executable version
and launcher before registering the command directory. Windows registration preserves
the HKCU Path value's type and unexpanded variables and broadcasts the environment
change. Bash, zsh, sh and fish profiles receive idempotent entries. A new terminal
is needed; the backend's own PATH is updated immediately. Remote installation and
PATH changes apply on the server host. No system Node or administrator rights are
needed for the conventional user prefix. Direct npm execution is bounded to five
minutes and 1 MiB output; the native supervisor gets six minutes so native npm's
own five-minute deadline can finish cleanup before outer cancellation.

PATH registration failure leaves the installed package discoverable; retry repairs
PATH without reinstalling or downgrading a newer shared version. Native data under
`~/.local/share/opencode` belongs to OpenCode.

### Older OpenCode installations

OpenCode 1.x (`opencode-ai`) and 2.x (`@opencode/cli`) both declare an `opencode`
bin, and npm refuses (EEXIST) to link one over the other without `--force`, so
2.x cannot install beside a 1.x shim in the same prefix. The panel offers
"Replace OpenCode 1.x with OpenCode 2", also when 1.x cannot run (e.g. a
placeholder left by a skipped postinstall); confirmation sends the shown command
path and package version, the server refuses a mismatch under the prefix lock,
bundled npm uninstalls `opencode-ai`, then the ordinary path installs and
verifies `@opencode/cli`.

The Windows running-image preflight covers every native file of the package:
`bin/` and the nested `node_modules/opencode-<os>-<arch>[-variant]/bin/`. 1.0.0-1.15.0
declare a Node launcher bin (`bin/opencode`) that runs the nested platform
package's executable (or a `bin/.opencode` copy); 1.15.1+ declare `bin/opencode.exe`,
which postinstall links or copies from the nested package. If npm's uninstall
fails anyway, its symbolic error code (only) classifies the outcome: with the
package still intact, EPERM/EBUSY/EACCES report `installation_in_use`, other
codes a generic failure stating 1.x is still installed; a package npm already
changed reports `legacy_partially_removed` with manual `npm uninstall -g
opencode-ai` guidance. A failure after complete removal is reported as
`legacy_removed_install_failed`; the next attempt is an ordinary installation,
never an automatic replay. CodeNomad leaves the data directory untouched: the
OpenCode 2 server imports 1.x sessions from the same `opencode.db` at startup
(upstream `V1Migration`).

For a foreign installation below the minimum or unusable, resolution prefers
the verified side-by-side npm installation (`installationSource: "managed"`);
the UI says the terminal `opencode` may still start the older version. The user
npm prefix cannot take that installation when a non-npm command already holds
OpenCode's name in its bin directory (on macOS/Linux the prefix is `~/.local`,
so a `~/.local/bin/opencode` link to a curl installation qualifies, and npm
would refuse to link over it) or when the prefix is not writable. The plan then
reports `foreignInstallation.blocked` (`occupied` with that command, or
`unwritable` with the prefix), installation is not offered, and the panel says
how to clear the obstacle before an explicit Check. winget
portable packages are identified from default locations only:
`%LOCALAPPDATA%\Microsoft\WinGet\Links` or `%ProgramFiles%\WinGet\Links`
(symlink, or hardlink/copy fallback), or a target under a default `WinGet\Packages`
root. The package ID (for example `SST.opencode`) is shown with an optional manual
`winget uninstall` hint only when the resolved
`<PackageIdentifier>_Microsoft.Winget.Source_8wekyb3d8bbwe` directory proves it.

`opencode-update/foreign-probe.ts` results (5 s deadline) are cached by the
command's file identity (path, mtime and size, plus the executable an npm-style shim launches); any change
reads as unknown until reprobed. A timeout is cached as unknown for 60 s, so a
hanging wrapper reruns at most once a minute while a slow first run (for example
an antivirus scan) is retried later. At most one probe of a command runs at a
time; concurrent readers, including an explicit recheck, join it. The setup
panel's Check action sends `recheck=1`, which forces a fresh probe even within
that delay; automatic reads never do. Synchronous resolution (workspace launch,
binary validation) only reads the cache and starts a background probe on a miss or an expired unknown; status reads and
installation await the bounded probe first, and the backend warms it at startup.

`node --import tsx scripts/test-opencode-legacy-replacement-native.mjs` installs the
published `opencode-ai` (default 1.18.10, `CODENOMAD_FIXTURE_LEGACY_VERSION`) into
an isolated prefix/cache/home, checks that plain npm installation of
`@opencode/cli` fails with EEXIST and leaves 1.x in place, checks that a stale
consent is refused and that the native images are found, then performs the
confirmed replacement and verifies the installed 2.x command. It never runs a service.

An exclusive `.codenomad-opencode-install.lock` in the npm prefix serializes
CodeNomad backends; the version is re-probed under that lock. A competing backend
gets a retryable conflict. A lock left after a crash is never stolen through
time/PID heuristics: npm may outlive its backend. The server log gives the lock
path; remove it only after confirming the installer has exited. The lock covers
CodeNomad backends only. Verified npm installations at 2.0.15 or
later use the installed CLI's `upgrade <exact-version> --method npm` for version
changes. OpenCode retains Windows running images itself, so this path skips the
write preflight, which would reject a supported live upgrade. A private,
temporary npm command adapter supplies bundled Node/npm and pins the verified prefix
and registry, including when the desktop runtime has no npm launcher on PATH. It is
also the command's working directory, preventing cwd from shadowing npm on Windows.
If the outer supervisor is terminated by timeout, signal or output limit, descendant
exit cannot be established: retain the prefix lock and temporary npm adapter rather
than allowing a competing installation. The server error includes the lock path;
manual recovery must first verify installer processes have exited. Temporary cleanup
never masks the execution error. Native upgrade and direct npm both verify version
and launcher after installation.

`node --import tsx scripts/test-opencode-upgrade-native.mjs` runs the real
installer against an isolated prefix/home/service: the installed CLI upgrades
while the running daemon keeps its PID and version. `CODENOMAD_FIXTURE_NODE`
selects a packaged Node with bundled npm; cleanup uses the isolated CLI only.

Explicit custom binaries stay selected. WSL and custom installations receive
execution-host instructions.

Installation and service activation are separate. A technically incompatible running daemon requires
the explicit **Restart shared service** action, whose copy explains interruption
of other clients' active work. Activation uses official `service stop` and the
existing native-parent `service start` bridge, authenticates the daemon, validates
its contract and replaces local authority. Ordinary backend shutdown never stops
OpenCode. Unknown version labels/newer daemons cannot be downgraded by this action.
For an admitted but older daemon, `restart_available` keeps activation optional:
non-disruptive reconnect updates backend executable ownership so opening additional
workspaces remains possible while restart is deferred. Executable selection and
workspace execution-host eligibility are rechecked before service mutation.

Troubleshooting's **Restart OpenCode service** may replace an authenticated same-version daemon;
unknown versions stay fail-closed. It is disabled without restart authority or
after a failed fresh status check, shares the host/WSL path and serialization
with update activation, confirms the all-client interruption, fences a changed
executable or unmounted view and never resumes a pending workspace-open callback.
Opening settings, checking status, reconnecting and reloading never restart
implicitly; both actions keep session history.

Mounted Windows discovery directories and Linux aliases are canonicalized through
the selected distro, then translated for host filesystem access. Native import
URLs and lease paths stay Linux-native; canonical outside-root storage is kept.
Native watchers can miss changes through mounts and symlinks, so the setup card
offers explicit **Reload OpenCode configuration** recovery. Its copy names every
effect (all loaded locations rebuilt, pending permissions/Forms cancelled,
terminals/background commands closed for all clients) and never presents it as a
process restart or memory reclamation. Conflicting service actions are refused
while an explicit action runs.

## Stored-history migration

`scripts/test-opencode-history-migration.mjs OLD_CLI TARGET_CLI` seeds synthetic
older storage (location identities, forks, long histories with
reasoning/tool/compaction checkpoints, a moved worktree session, pending inbox,
provider configuration and a synthetic credential, pending Forms), copies its
DB/WAL and lets the target migrate it, retaining seeds, CLI hashes and logs in a
fresh fixture; it never touches the shared service or rewrites native tables. CI
seeds from 2.0.3, beta-19271 and 2.0.32. The target maps stored `workspaceID`
values to the local directory scope, keeping session IDs and content, and
CodeNomad uses that scope as is. Pending Forms end with a native restart, and
migration drops them the same way. Assertions compare old connection fields
fully and never discard unknown fields or relax history checks.

## Compatibility seams

- Authentication, cancellation, origin and connection generations are
  regression-tested at the shared connection seam.
- Older discovery routes serve only to diagnose an outdated running daemon; they
  are probed only after `/api/info` (served by every admitted daemon) returns 404.
- Internal identity and directory authorization keep the location/context,
  import/cursor and pruning checks for older stored identities. Public workspace
  selectors (`workspaceID`, `x-opencode-workspace`) are rejected unconditionally;
  original cursor bytes and independent import-history ownership are preserved.
- Unrecognised contracts receive the `canonical_api` refusal;
  `legacyContractFixture` (`compatibility/contract-fixture.ts`) is a rejection
  input.
- Catalogs update through resource-specific events. `session.message.content.updated`
  is replay-only (never published live), so live invalidation ignores it.
- Pruning preview stays query-only and TUI refresh synchronization stays in
  place: the plugin API has no `session.message`, and publication can race.
- Keep these older-identity authority checks; the synthetic migration seed alone
  never justifies removing them.

## Validation and release gates

Checks include server/UI typechecks, server regressions, real Solid browser
setup tests and rendered captures, isolated bundled-Node installation, native
migration, native locations/worktrees, automation heartbeat/provisioning and
pruning acceptance. On Windows, Linux and macOS ARM64, CI runs first
installation at the fixed minimum, old-seed migration at the fixed minimum and
resolved latest stable, plus the cross-platform native pruning gate.

### Reproduce desktop and WSL acceptance

Windows desktop fixtures launch only the specified worktree's built artifacts,
use isolated native profiles/service ports and dynamically discover instrumentation:

```text
node scripts/test-opencode-setup-desktop.mjs both ABSOLUTE_CURRENT_CLI
node scripts/test-opencode-setup-desktop.mjs both ABSOLUTE_CURRENT_CLI --resume-folder
node scripts/test-opencode-setup-desktop.mjs both ABSOLUTE_OLD_CLI --old-daemon --resume-folder
node scripts/test-opencode-setup-desktop.mjs both ABSOLUTE_OLDER_ADMITTED_CLI --compatible-daemon --resume-folder
node scripts/test-opencode-setup-wsl.mjs DISTRO ABSOLUTE_LINUX_CLI native
node scripts/test-opencode-setup-wsl.mjs DISTRO ABSOLUTE_LINUX_CLI mounted
node scripts/test-opencode-setup-wsl.mjs DISTRO ABSOLUTE_LINUX_CLI aliased reload-safety
```

Each desktop fixture emits `results.json`, artifact/resource hashes, per-host
logs/API responses and screenshots in its isolated output directory. Retain those
artifacts with the qualification PR/CI; never document machine-local paths.

## Agent conventions

- OpenCode settings start with the OpenCode version card (runtime status, install/update and service actions directly inline), followed by the executable selection card, which has only the selector's own "OpenCode binary" heading. Only version details and troubleshooting are collapsed disclosures at the bottom of the runtime panel; log levels remain the final settings card. Troubleshooting always exposes an explicit, confirmed shared-service restart independently of updates; retain the inline activation shortcut after an update, and never downgrade a newer daemon through an older selected CLI. Configuration reload remains a separate process-preserving action. Share controls with the startup recovery dialog; never route settings through a separate management modal. The disclosures use the shared `.settings-disclosure` (`styles/components/settings-disclosure.css`).
- Startup restoration remembers only definite `426 opencode_update_required` workspace refusals for the recovery dialog's successful action or explicit Continue. Keep this window-owned continuation separate from the latest manually requested folder: run the manual open first, then resume only still-unbound saved tabs under their original selection/order/removal guards. Read-only status refresh and settings maintenance do not replay restoration; disposal cancels it. Never replay uncertain creations, generic errors or session mutations.
- Verified shared npm OpenCode installations at 2.0.15+ delegate version changes to native `upgrade` through `opencode-update/native-upgrade.ts`, with bundled npm scoped to the verified prefix. Native Windows image retention replaces the write preflight only on that path; first install, older migration and same-version repair retain direct npm/preflight. Never retry a failed native mutation via npm or restart the daemon implicitly. Validate with the isolated `scripts/test-opencode-upgrade-native.mjs` fixture.
- OpenCode minimum requirements must follow demonstrated technical dependencies, never the latest published or solely tested version. Keep required, recommended/tested and unverified versions distinct in `opencode/runtime-support.ts` and setup diagnostics. Validate authenticated daemon metadata/contract before client use/plugin provisioning. Setup uses bundled Node/npm for a shared user npm installation and prefers PATH. Only a verified `@opencode/cli` npm installation is updated via npm; an OpenCode 1.x `opencode-ai` npm shim (identified by its manifest and shim target, never a version string) is replaced in its prefix only after explicit UI confirmation naming that exact installation (rechecked under the installation lock), with every native image of the package preflighted, npm failure states reported truthfully and failure after removal retryable rather than replayed. Foreign `--version` probes are asynchronous, bounded and tree-killed (`opencode-update/foreign-probe.ts`); unknown keeps PATH precedence and synchronous resolution never spawns. Foreign installations (winget, Homebrew, curl, manual) are never modified: when below the minimum or unusable, OpenCode 2 is installed in the user npm prefix beside them and the verified managed installation wins over that PATH command; valid foreign V2 and explicit custom executables keep their precedence. Detection lives in `opencode-update/legacy-installation.ts`. The CodeNomad-private `~/.local/share/codenomad/opencode` tree (`opencode-update/retired-installation.ts`) must never be discovered or launched; ignore its receipts and saved selections without migrating or deleting it. Keep installer locking and Windows live-executable preflight in `opencode-update/installation-lock.ts`; register terminal PATH only on explicit installation. A running daemon restart is a separate explicit action. Configuration reload is also explicit: native `location.reload` rebuilds every loaded location and cancels pending Forms/permissions, so never use it as an automatic watcher fallback.
- A selected CLI's `service status` can report `stopped` for a live older daemon. Preserve the bounded, read-only registration fallback in `workspaces/native-service-registration.ts` and authenticate that daemon's metadata before allowing start; `ensure()` repeats discovery. Native service lookup is separate from plugin-root discovery, which must still use the connected daemon's `config.get`. Never write service registration/configuration files from the backend.
