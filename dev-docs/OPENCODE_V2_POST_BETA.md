# OpenCode V2 stable-runtime transition

**Implementation provenance:** PR #696, based on #695 and the client/plugin 2.0.11
alignment in #728. The corrected technical floor supersedes the initial version-only
policy. Current recommendation and dependency pins are defined by
[runtime support](../packages/server/src/opencode/runtime-support.ts), the
[server](../packages/server/package.json), [UI](../packages/ui/package.json) and
[pruning](../packages/server/src/opencode/session-pruning/package.json) manifests.

## Release contract

- The technical minimum is **2.0.7**. Published 2.0.4–2.0.6 events lack
  `session.step.started.data.started`; 2.0.7 introduces it. The pinned Solid
  reducer consumes that field directly for assistant-message creation times.
  Retiring the timestamp fallback therefore requires this native event contract.
- **2.0.11 was the transition's recommended, release-tested target**, independently
  of that minimum. The current recommendation is source-defined above; neither
  the latest publication nor the client/plugin pin justifies rejecting 2.0.7–2.0.10.
- Stable versions below 2.0.7 and historical `0.0.0-beta-*` publications are
  refused with a timestamp-contract explanation and HTTP 426. Unlisted versions,
  future majors and custom/prerelease labels are unverified rather than rejected
  by their label; they undergo authenticated bounded API recognition.
- Client/plugin dependency pins are separate from runtime admission.
- Authenticated daemon metadata, not an older selected discovery CLI, controls
  connection admission. Admission precedes functional requests and plugin
  provisioning. Replacement daemons are checked again, even at the same URL.
- API recognition checks canonical session/permission/Form/inbox shapes and
  the required `PUT /api/session/{sessionID}/environment` input. Missing required
  APIs are reported separately from an untested version. Optional configuration
  reload follows its own route presence. No speculative write establishes support.
- Native 2.0.7–2.0.10 tests with the 2.0.11 client/plugin passed prompt, Shell,
  environment replacement and RPC scenarios. Their 113 paths / 136 operations
  match 2.0.11. The 2.0.7/2.0.8 provider/model component schemas differ; these
  results are not a claim of universal settings-shape interchangeability.
- CLI `service status: stopped` is not sufficient absence evidence: a current
  CLI can miss an older daemon's metadata route. The lifecycle performs bounded,
  read-only native registration discovery through the selected execution host,
  authenticates the registered endpoint against historical metadata, and repeats
  discovery before `ensure()` may start. This lookup never supplies plugin roots
  and never writes registration, port or database files.

## Setup and recovery

The global setup dialog and Preferences reuse `OpenCodeSetupPanel` and its store.
This is an implementation reuse choice, not a user requirement that all failures
have the same screen. Missing installations, known incompatibility and optional
updates expose different actions. Installed/running/minimum/recommended versions
and the technical reason are shown separately, with retry and executable selection.
Dismissal leaves a recovery entry; optional updates do not force the dialog.
Connection changes, foreground entry and unsupported proxy responses refresh
recovery state. Stale responses cannot overwrite a changed executable or a
completed action. Only a pending folder open may resume; prompts are not replayed.

Automatic selection now follows PATH order (`opencode2`, then `opencode` within
each directory), then the conventional user npm installation. The retired private
CodeNomad installation is never a fallback. An explicit supported executable retains
priority. Both setup and binary validation use the same discovery. The UI shows
the effective path and source; “automatic” replaces the misleading “system PATH”
label. Recovery puts diagnosis and installation before executable selection;
Preferences keeps executable selection first, inline actions, collapsed version
details/troubleshooting and logs last.
Official npm packages from the beta and 2.0.0 transition advertised different
launcher targets: discovery checks their published `bin` map and real launcher
target, choosing `opencode` when `opencode2` is only the retired `.cjs` alias.
Known historical beta versions can migrate to a stable target without treating
their version label as an unrecognized custom build.
Discovery preserves terminal PATH/PATHEXT ordering even when a standalone
executable shares the npm command directory; such an executable remains
user-managed. On POSIX, only the prefix's actual `bin` directory is treated as
an npm command directory, not a neighboring folder. A standalone executable
replacing a POSIX npm symlink is still selected in PATH order and remains
user-managed; only an actual symlink to the package's retired `.cjs` alias is
skipped in favor of the working `opencode` command. On Windows, the same
retired alias is skipped only when the npm `.cmd` script positively invokes
the package's `.cjs` target; a customized `.cmd` wrapper keeps PATH priority
and cannot be overwritten through the automatic npm updater.

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

PATH registration failure leaves the installed package discoverable, and retry can
repair PATH without reinstalling or downgrading a newer shared version. The retired
`~/.local/share/codenomad/opencode` executable tree and selection receipts are ignored;
saved private selections resolve through current discovery, and validation/launch
reject that tree. No migration or automatic deletion is performed. Native user data
under `~/.local/share/opencode` is unrelated and remains owned by OpenCode.

An exclusive `.codenomad-opencode-install.lock` in the npm prefix serializes
CodeNomad backends; the version is re-probed under that lock. A competing backend
gets a retryable conflict. A lock left after a crash is deliberately not stolen
by time/PID heuristics: npm may outlive its backend. The server log gives the lock
path; remove it only after confirming the installer has exited. External package
managers do not participate in this lock. Verified npm installations at 2.0.15 or
later use the installed CLI's `upgrade <exact-version> --method npm` for version
changes. OpenCode owns Windows running-image retention (upstream #50819); opening
that image for writing first incorrectly rejects supported live upgrades. A private,
temporary npm command adapter supplies bundled Node/npm and pins the verified prefix
and registry, including when the desktop runtime has no npm launcher on PATH. It is
also the command's working directory, preventing cwd from shadowing npm on Windows.
Native failure is surfaced without replaying the mutation through direct npm.
If the outer supervisor is terminated by timeout, signal or output limit, descendant
exit cannot be established: retain the prefix lock and temporary npm adapter rather
than allowing a competing installation. The server error includes the lock path;
manual recovery must first verify installer processes have exited. Temporary cleanup
never masks the execution error. Bounded subprocess regressions cover a surviving
npm-like child, retry fencing and output-limit termination.
First installation, older CLI migration and same-version launcher repair still use
direct bundled npm with the Windows write preflight. This updater boundary does not
change the minimum supported runtime. Both paths verify version and launcher after
installation. CodeNomad never stops or restarts the shared daemon during an update.

`node --import tsx scripts/test-opencode-upgrade-native.mjs` qualifies the actual
installer against an isolated prefix/home/service. On Windows, 2.0.15 -> 2.0.16
succeeds while the old write preflight rejects the live image; authenticated
`/api/info` retains the same 2.0.15 PID and the installed executable reports 2.0.16.
`CODENOMAD_FIXTURE_NODE` selects a packaged Node with bundled npm. The fixture never
uses the shared daemon; service cleanup is through the isolated native CLI.

Explicit custom binaries remain selected. WSL and custom installations receive
execution-host instructions rather than a Windows-side Linux installation.
Remote setup runs on the CodeNomad server, not the browser machine.

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

Troubleshooting also keeps **Restart OpenCode service** available without an
installation or version change. The existing lifecycle may replace an authenticated
same-version daemon, but an older selected CLI still cannot replace a newer daemon
and unknown versions remain fail-closed. The control remains visible but disabled
when restart authority is unavailable or a fresh status check fails. It shares the
host/WSL service path and serialization with update activation; opening settings,
checking status, reconnecting and reloading configuration never restart implicitly.
The troubleshooting action confirms the all-client interruption, fences a changed
executable or unmounted view, and does not resume a pending workspace-open callback.
The inline post-update activation shortcut remains separate. Session history is not
deleted by either action; configuration reload preserves the daemon process and
must not be presented as a process restart or a guarantee of memory reclamation.

Mounted Windows discovery directories and Linux aliases are canonicalized through
the selected distro, then translated for host filesystem access. Native import
URLs and lease paths stay Linux-native; canonical outside-root storage is retained.
This does not repair OpenCode 2.0.11's mount/symlink watcher limitations. The existing
setup card therefore offers explicit **Reload OpenCode configuration** recovery.
Its copy explains that native reload rebuilds every loaded location and cancels
pending permissions/Forms and closes terminals/background commands for all clients. Reads, provisioning and ordinary
connect never invoke this disruptive operation automatically. Conflicting service
actions are refused while an explicit action is running.

## Historical migration

`scripts/test-opencode-history-migration.mjs OLD_CLI TARGET_CLI` creates synthetic
historical storage, closes it, copies its DB/WAL and lets the target runtime perform its
own migration. It retains seed exports, untouched seed storage, CLI versions,
executable SHA-256 hashes and logs in a fresh temporary fixture. It never connects
to the shared service or rewrites native tables.

Local Windows and Linux (Ubuntu/WSL) acceptance for
**0.0.0-beta-19271 / 2.0.3 → 2.0.11** covers:

- Three source location identities, including two workspace identities at one
  directory, with independently addressable session IDs and forks.
- 215 messages per seeded conversation: synthetic history, reasoning, text,
  completed tool output and a pre-compaction checkpoint. Export equality and
  native message pagination preserve complete history.
- Native session pagination, a moved worktree session and a pending inbox record.
- Historical provider/model configuration and a synthetic persisted provider
  credential connection, including its identity/label and active state.
- Pending session/global Forms, compared against a same-version restart control.
  These seeds lose pending Forms on an ordinary native restart too. Migration
  matches that native durability rule, lists no stale Forms, and supports newly
  created reply/cancel flows. This is not a claim of preserving ephemeral Forms.
- **Native identity rule:** the target migrates historical `workspaceID` values
  to the local directory scope while preserving session IDs and content. The
  fixture reports this explicitly; CodeNomad does not manufacture aliases.

The existing native pruning fixture independently verifies current Forms,
Shell/PTY scope, permission/Yolo replies, model payload, fork independence,
pre-compaction pruning, execution-claim races, plugin disposal and daemon restart.
The migration fixture compares seeded provider connections and pending Forms;
it does not claim exhaustive coverage of every provider's OAuth implementation.

## Retirement disposition

| Area | Implementation |
| --- | --- |
| Audited beta/old-stable live-support list | Removed. Reviewed 2.0.7–2.0.11 contracts are recognized; others negotiate. |
| Legacy routes, methods and payload translation | `compatibility/requests.ts` removed; old V2/beta and 2.0.0–2.0.3 HTTP family. |
| Legacy HTTP inbox/status conversions | Removed from transport; pre-2.0.4 response shapes. Discovery remains separate. |
| Permission-event rename | Removed; pre-2.0.4 event contract. |
| Step timestamp fallback | Removed; absent through 2.0.6, native field available from 2.0.7. This establishes the technical minimum. |
| Legacy live location/worktree/credential/Form serialization | Removed, including workspace selector injection and legacy-positive request/import/cursor branches. |
| `catalog.updated` alias | Removed; current catalogs use resource-specific events. `session.message.content.updated` remains in the current durable event union and is retained. |
| Authentication, cancellation, origin and connection generations | Retained and regression-tested at the existing shared seam. |
| Older discovery routes | Retained for authenticated diagnosis of an outdated running daemon, not functional live support. |
| Historical location/context, import/cursor and pruning checks | Retained for internal identity and current directory authorization. Obsolete public selectors are rejected unconditionally. Original cursor bytes and independent import-history ownership are preserved. |
| Legacy schema recognition | Retained to diagnose and reject a retired contract; no legacy serializer remains. |
| Existing CodeNomad plugin-entry/presence migration | Retained for upgrades/concurrent backends, independently of OpenCode runtime support. |
| Query-only pruning preview and TUI refresh synchronization | Retained: plugin 2.0.11 still lacks `session.message`, and publication races remain current. Stale beta-only comments were corrected. |

## Validation and release gates

Implemented checks include server/UI typechecks, server regressions, real Solid
browser setup tests and rendered captures, isolated bundled-Node installation,
native migration, native locations/worktrees, automation heartbeat/provisioning
and pruning acceptance. CI adds first installation and old-seed migration at
the fixed minimum and resolved latest stable on Windows, Linux and macOS ARM64.
The existing cross-platform native pruning gate remains in place.

### Retained acceptance evidence

The earlier implementation through `4a77d162` and corrected acceptance at
`781c3a42` establish these specific behaviors, not universal compatibility:

- Native 2.0.7–2.0.10 and the 2.0.11 control passed authenticated schema/config discovery, plugin/RPC loading, Shell/environment replacement, two-session isolation, synthetic provider prompt/wait/context and stable PID.
  Production environment, locations/worktrees/relay, pruning/proxy/rendered UI and automation passed at 2.0.7; environment/pruning also passed at 2.0.10, including real compaction and pre-compaction pruning.
  Differing provider/model settings are not emitted by CodeNomad; the raw editor saves runtime-specific user text.
- Windows and Linux/WSL beta-19271/2.0.3 migrations passed to 2.0.7 and 2.0.11 with the coverage above. Exact CLI archives/hashes and unchanged seed hashes were checked; no shared service or user storage was used.
- Bundled-Node installation passed without system Node on Windows/Linux, retaining the POSIX lifecycle shell.
  Both release hosts passed missing installation, optional activation, explicit incompatible-daemon restart, informed reload and activation failure after installation.
  At `781c3a42`, installing 2.0.11 retained a 2.0.10 daemon's PID/version and resumed the folder without restart; 2.0.3 required explicit restart. Captures/hashes were inspected and isolated windows/services cleaned up.
- Windows→WSL Linux/UNC, mounted and symlink-to-mount paths passed authenticated provisioning, heartbeats and reload/restart/reconnect.
  Reload kept the PID and completed the synthetic stream once without replay, while cancelling the pending Form and making the original Shell/PTY unavailable.
- Discovery covers absent WSL registration, forwarding failures, mounted/aliased metadata and `127.0.0.2`; configuration alone never proves a running process.
  Regression fixes retain stale-selection/cross-backend downgrade fences, same-version Windows and concurrent receipt publication, non-disruptive reconnect, cross-binary service serialization, overlapping WSL claim ownership and POSIX URL escaping.
  Fixtures enforce whole-run/request/cleanup bounds, child termination, cursor-cycle rejection and detached-consumer errors.
- CLI parsing preserves custom labels/`+build`; unorderable versions never auto-update/downgrade. Clean builds and desktop fixtures exclude stale generated adapters/installers.
  Body-portal recovery plus real-style pointer tests prevent the pending-folder overlay blocking setup reentry after dismissal.
- `306c2ba4` brought #723 history/navigation and #732/#734 README changes. Native 2.0.7 passed 241-message
  search/counts/batch cleanup, 1,501-message indexes, distant windows, exact payload/restoration, pruning,
  compaction, concurrency, discovery and leases. The pack-outside-checkout regression verifies `navigation-scope.ts`, `outline-index.ts` and `outline-preview.ts` distribution. Existing APIs/storage justify no higher floor.

Earlier CI test jobs at `419fe6a6` passed across configured platforms, but distribution
builds were still running at the recorded check. Final-head remote CI was unconfirmed;
historical local/native/packaged acceptance is not a substitute for the current head's CI.

### Reproduce desktop and WSL acceptance

Windows desktop fixtures launch only the specified worktree's built artifacts,
use isolated native profiles/service ports and dynamically discover instrumentation:

```text
node scripts/test-opencode-setup-desktop.mjs both ABSOLUTE_CURRENT_CLI
node scripts/test-opencode-setup-desktop.mjs both ABSOLUTE_CURRENT_CLI --resume-folder
node scripts/test-opencode-setup-desktop.mjs both ABSOLUTE_OLD_CLI --old-daemon --resume-folder
node scripts/test-opencode-setup-desktop.mjs both ABSOLUTE_2_0_10_CLI --compatible-daemon --resume-folder
node scripts/test-opencode-setup-wsl.mjs DISTRO ABSOLUTE_LINUX_CLI native
node scripts/test-opencode-setup-wsl.mjs DISTRO ABSOLUTE_LINUX_CLI mounted
node scripts/test-opencode-setup-wsl.mjs DISTRO ABSOLUTE_LINUX_CLI aliased reload-safety
```

Each desktop fixture emits `results.json`, artifact/resource hashes, per-host
logs/API responses and screenshots in its isolated output directory. Retain those
artifacts with the qualification PR/CI rather than documenting machine-local paths.

Do not remove the remaining historical authority checks based solely on this
synthetic seed. Keep the compatibility audit in
[OPENCODE_V2_COMPATIBILITY.md](OPENCODE_V2_COMPATIBILITY.md) as historical evidence.

## Policy correction provenance

#695 established connection-scoped compatibility on 2026-09-16. On 2026-09-20, #696's version-only 2.0.11 floor was rejected in favor of demonstrated dependencies, retained authority checks and non-blocking optional updates. The native timestamp establishes 2.0.7, not the publication/pin. CI qualification and migration read the source-defined minimum and resolved latest stable rather than duplicating a floor.
