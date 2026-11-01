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

Scheduled Missions additionally require the consumed Schedule contract and enabled
`experimental.schedules` in the discovered global configuration and effective whole
Location block. Targeted, confirmed activation and exact read-back are described in
[Missions](MISSIONS.md) and [native contracts](MISSIONS_NATIVE_CONTRACTS.md).
Missing APIs, explicit OFF, a masking block, failed activation or missing exact
calendar registration keep the schedule paused or in an explained error state.
Immediate unconditional Play follows its own admission path.

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

## Service supervision primitives and native adapters

`host-lifetime/service-supervision-contract.ts` defines the private service-wide
preference and status projection. The key uses the execution host, native UID/SID,
canonical configuration/state roots and exact registration channel. Binary selection,
CodeNomad profiles and changing daemon incarnations remain separate from that key.
The acquired Settings execution host supplies the canonical namespace and validates
the absolute executable selection before using these internal APIs.

`ServiceSupervisionStore` stores a bounded 64 KiB manifest below a caller-provisioned
private service-wide root. Revision-checked controls persist intent before OS effects;
fresh adapter read-back acknowledges its revision separately. An exact retained
request receipt reconciles a lost reply. An absent receipt stays unknown. First Play
sets an unset choice to ON; explicit OFF persists across subsequent Plays. Reads and
binary selection preserve the preference. OFF can fence an unfinished ON; stale
acknowledgements and stale ON requests conflict.

Windows mutations and Start admission share an OS `FileShare.None` handle on
`admission.lock`. The transaction helper owns both that handle and the atomic
manifest replacement. Caller/helper exit releases the handle; a late caller callback
cannot write outside exclusion. Linux mutations and Start share a native `flock`
descriptor, released by the OS when its holder exits; a short pipe-owned helper
holds it across the asynchronous operation. macOS uses a bundled native helper's
advisory descriptor lock, also released on caller death. Its `proc_pidinfo` lookup
records the microsecond native start identity for health and guard ownership.

`readSupervisionHealth` reuses the bounded public registration projection and
official exact-file read-only discovery. PID start identity and incarnation are
rechecked after authenticated discovery. A live unresponsive process remains
unhealthy/unknown; a later healthy read preserves its identity. Status reaches
Running only with current-revision installed resources, an active guard and healthy
service. An absent guard with a responding service exposes a supervision failure.

`ServiceSupervisionSettings` sequences private intent, adapter attempts and exact
receipt reads. The acquired execution-host scope supplies its store/adapter and
current-context fence; controls additionally revalidate the live human at the
serialized preference write. Requests pin the displayed service key and revision.
Adapter failures persist a fixed `adapter-failed` cause and attempt timestamp with
ON still requested. Explicit Retry reconciles that same revision and preserves its
original receipt. A later OFF fences an older attempt's diagnostics. Passive reads
and acknowledged request replays observe supervision resources; Linux also completes
an already requested, deferred linger rollback when its safety checks allow it.
The internal first-Play
entry sets an unset preference to ON and preserves every existing explicit choice.

The Settings route registrar in `server/routes/service-supervision.ts` defines
`GET|POST /api/opencode/supervision`, using the existing live human-session check.
Responses expose the key, preference, revision, protection state, fixed cause,
responding-service flag, known attempt/backoff and optional exact receipt status.
Its POST input permits ON, OFF and Retry; executable paths, arbitrary commands and
internal first-Play/binary-selection controls stay behind the execution-host seam.
The production HTTP server registers these routes under its authentication hook.
The shared response/control types are exported by `api-types.ts`.

`service-supervision-resolver.ts` resolves the selected Settings executable without
project or session discovery. Windows native `debug paths` and the selected CLI's
credential identify exactly one service channel; canonical native roots, current SID
and host determine the service key. Native Linux uses its canonical roots and UID
through the POSIX resolver in `service-supervision-linux-resolver.ts`, shared with
native macOS. Windows UNC selections resolve the registered WSL distro spelling,
native account/UID and canonical Linux roots through the selected distro.
Missing/ambiguous namespaces, unqualified platforms and unsupported command wrappers return a fixed
unavailable response.
Mission Play additionally pins its already-authorized service connection, registration
PID/URL and credential. The immediate, daily and unified Play paths default only an
unset service preference to ON; paused creation, passive reads and other controls
preserve it. Human/connection/physical-root checks surround the operation. Signed
schedule proofs are issued after supervision preparation.

Focused checks: `node --import tsx --test
packages/server/src/host-lifetime/service-supervision.test.ts`. Native exact-file
health qualification: `node --import tsx
scripts/test-service-supervision-health-native.mjs ABSOLUTE_CLI`; its isolated roots
and service are removed after actual process exit.

`WindowsServiceSupervision` is the internal execution-host adapter. Its caller
supplies the acquired service namespace, private store, durable owned runtime and
native path-only environment. Its immutable private `windows.json` descriptor
contains the PowerShell/Node/probe paths and minimal host roots. The build target
`npm run build:supervision --workspace @neuralnomads/codenomad` bundles the read-only
probe and copies the PowerShell guard into `dist/host-lifetime/`. On acquisition,
the resolver provisions `%LOCALAPPDATA%/CodeNomadServiceSupervision` with a private
current-SID/SYSTEM DACL, preserving existing ACLs. Its service directory holds
immutable content-addressed copies of the bundled Node, probe and guard; the private
descriptor pins their paths across package replacement. Artifact size admission
uses a 256 MiB bound with the same complete ancestor/owner/DACL checks as metadata.
Unsafe storage leaves supervision unavailable. Explicit executable selection and
verified CodeNomad installation publish the validated target under the service-wide
revision/admission lock. Before an explicit service restart, publication completes
before the CLI stop/start operation. Passive reads preserve the selected target;
a different service channel resolves its own independent manifest and preference.

`service-supervision-target.ts` binds the absolute native executable to complete
SHA256 bytes and, for the exact published npm layout, the package manifest and
prefix installation lock. Missing/partial images, an active installation lock and
changed package provenance wait with the guard's capped backoff. Every spawn reads
the current manifest and verifies its target, with no command/PATH fallback.
A complete external npm upgrade at the same authorized package/path is admitted
after bounded CLI root/credential-channel checks and stable image/package rereads;
custom-image replacements require explicit selection publication. A healthy
incumbent survives installation and target publication unchanged. The shared server
selection/install/restart seams supply the same contract to Electron and Tauri.

Main uses PowerShell and native `CreateProcessW` with independent NUL stdio and a
foreground child handle. Main has IgnoreNew and unlimited execution time; Recovery
has Queue, event/logon/60-second triggers and a ten-second OS deadline. Ownership
read-back checks names, marker, action, principal, settings and trigger policy.
Recovery makes one bounded Start attempt under the shared admission handle; the
independent OS trigger keeps the retry obligation after an unavailable action.
Owned guard invocations use PowerShell's process-scoped `-ExecutionPolicy Bypass`,
matching native executable-wrapper launches; persisted execution-policy settings
remain untouched and enforced Group Policy still applies.
Main adopts an incumbent, retains live unhealthy children, backs off after actual
exit and rereads the manifest before each spawn. The native service `disabled`
configuration also gates spawn. Fixed error codes and non-secret status are bounded;
OpenCode owns its native logs.
The guard records its actual last spawn attempt and next backoff time; the adapter
exposes these only with a matching revision and live guard-start identity. A native
disabled/unknown service configuration appears as a supervision failure even while
an incumbent responds.

OFF persists before trigger removal, waits for Main to release handles and exit,
then unregisters the owned tasks. An incomplete release stays pending for retry.
The next ON adopts the surviving incarnation. Native qualification is
`node --import tsx scripts/test-service-supervision-windows-native.mjs ABSOLUTE_CLI`:
uniquely named tasks and isolated services are removed after confirmed exit. Its
private-leaf DACL policy isolates OS mechanics; production storage admission also
requires the full ancestor policy.

Platform packaging qualification remains separate
from these Windows checks. Windows native tests exercise the authenticated route
with real login sessions and the production resolver in an isolated namespace.
Their explicit private-leaf test policy qualifies OS mechanics; production retains
the complete ancestor/DACL policy. Settings-controller and HTTP-admission checks run with
`node --import tsx --test packages/server/src/host-lifetime/service-supervision-service.test.ts`.

Binary/package checks run with `node --import tsx --test
packages/server/src/host-lifetime/service-supervision-target.test.ts` and updater
ordering with `packages/server/src/opencode-update/service.test.ts`.
`node --import tsx scripts/test-service-supervision-binary-native.mjs OUTPUT_DIRECTORY`
uses real Windows tasks and an isolated npm prefix/home/service with paths containing
spaces. It exercises actual native upgrade, healthy-incumbent preservation, automatic
same-package replacement, explicit restart publication, installation-lock/missing/
partial/provenance backoff and concurrent OFF/selection revisions. The run removes
its OS resources and waits for its services to exit, retaining its bounded evidence.

### Native Linux systemd user supervision

`LinuxServiceSupervision` installs one exact, privately owned unit under the account's
`.config/systemd/user`, enabled for `default.target`. It runs the content-addressed
bundled Node/guard in the foreground, with `Restart=always`, two-second restart delay,
and five guard starts per sixty seconds. Retry resets a reached systemd StartLimit.
The guard's genuine child-exit retries have a separate 2–30 second capped delay.
Live but unreachable children and incumbents remain untouched; authenticated health
recovery preserves their identity. The native `disabled` flag gates every spawn.
Minimal HOME/XDG path roots live in the private descriptor. The unit carries only
fixed executable paths and the non-secret namespace key.

OFF writes its preference under the shared admission lock, stops the foreground
guard **while `KillMode=process` remains loaded**, checks it inactive, then disables,
unlinks and reloads the unit. Never use `disable --now` or unlink before stop. The
released OpenCode process keeps its independent stdio and its populated accounting
cgroup until natural exit; the next ON adopts it without a second daemon.

Linux ON requests `loginctl --no-ask-password enable-linger` for the acquired UID.
Linger starts **all enabled user services at boot and keeps them after logout**.
A private account-home registry, shared across service namespaces and independent
of profiles/XDG roots, records requests, enable intent/acknowledgement and the owned
root linger-marker fingerprint. Preexisting linger remains external. Lost enable
acknowledgement, altered markers and corrupt provenance preserve linger as uncertain.
Polkit refusal preserves ON and exposes `linux-linger-permission-required`; explicit
Retry repeats the same intent without sudo, passwords or an embedded auth agent.

The last OFF restores owned linger only with an active/online logind session or
proven exit of every released service and absence of a replacement at its registration.
Before guard removal, the account-wide registry retains each released service's exact
registration, PID, incarnation and native boot/start identity. Deferred reads compare
that identity directly with the OS; a missing registration without retained process
proof keeps rollback deferred. Otherwise supervision is removed while
the process and linger survive, with `linux-linger-deferred` visible on the OFF
status. Startup acquisition, status reads and ON/OFF reconciliation automatically
recheck the deferred rollback's requests, ownership and safety; explicit Retry is
also available. A new ON cancels deferred rollback. Unknown service/session evidence preserves linger.
The parent user manager's stop policy applies to all its remaining children.

Focused Linux logic checks run on every host with fake logind/health responses:
`node --import tsx --test packages/server/src/host-lifetime/service-supervision-linux.test.ts`.
The disposable Linux VM check is `scripts/test-service-supervision-linux-native.ts`;
bundle it and the production guard with esbuild, then run its explicit phases against
an isolated CLI/XDG sandbox. It covers real refusal, foreground hosting, OFF/adoption,
health loss/recovery, service and guard crashes, StartLimit, reboot boot/login timing,
and cleanup. Keep the personal installation and initial linger state intact.
`service-supervision-windows-recovery.ts` reads the exact owned Recovery task and
its native `NextRunTime` independently of the guard script. A missing guard/action
keeps ON, shows failure and exposes `recoveryNextTickAt` when its OS obligation is
verified. The guard's own backoff remains `retryAt`; stale revisions and OFF clear
the Recovery date. Missing action artifacts use the fixed `artifact-missing` cause.

### Native macOS LaunchAgent supervision

`MacosServiceSupervision` owns one exact plist per service namespace under the real
account's `Library/LaunchAgents`. It uses `gui/<uid>`, `RunAtLoad`, `KeepAlive`, a
five-second `ThrottleInterval` and `AbandonProcessGroup=true`. The adapter verifies
both private plist bytes and the loaded LaunchAgent's complete argv, path, type,
throttle and restart/release flags before mutation. Missing graphical domains and
incomplete ownership remain explicit failures with the requested preference intact.
The account's graphical login supplies the automatic startup boundary.

The shared POSIX foreground guard (`service-supervision-linux-guard.ts`) starts the
managed service with independent null stdio and the descriptor's minimal HOME/XDG
paths. Live unresponsive children and incumbents are retained; authenticated health
probes back off from one to sixteen seconds. Only confirmed process absence permits
another start, under the same native descriptor lock as ON/OFF. The native service
`disabled` setting gates each spawn. Fixed status records bind guard PID/start time
and preference revision; a loaded plist alone provides the Installed state.

OFF persists before `bootout`, waits for confirmed guard exit and removes the exact
owned plist. `AbandonProcessGroup` preserves the hosted service during normal removal
and guard crashes. ON adopts its surviving incarnation before considering a spawn.
OpenCode retains its own registration, authentication and logs.

`build:supervision` compiles a universal x64/ARM64 `service-supervision-macos-native.c`
helper with the macOS build toolchain and the desktop's 13.5 deployment target.
The packaged helper provides only `proc_pidinfo` identity and a pipe-owned
`flock`; the runtime provisions content-addressed private copies of it, Node and the
guard. The user installation consumes these built artifacts. Run focused logic
checks with `node --import tsx --test
packages/server/src/host-lifetime/service-supervision-macos.test.ts`.
`scripts/test-service-supervision-macos-native.ts`, bundled beside the production
guard and native helper, checks isolated foreground hosting, OFF/adoption, native
lock release, artifact recovery, service/guard crashes, CLI stop/restart and live
unreachable child/incumbent recovery. It requires an open graphical session and a
separate CLI/XDG sandbox. Real logout/login/reboot and desktop packaging remain
separate qualification gates; keep personal applications and services untouched.

### Windows-to-WSL supervision

`service-supervision-wsl-resolver.ts` acquires the selected UNC executable without
project discovery. It pins the registered distro name, Linux account and numeric
UID, canonical native HOME/XDG roots and exact credential-selected channel. The
service key uses Linux-native roots and UID plus the Windows host/SID, distinguishing
the per-Windows-user distro registry. The private descriptor and task principal also
pin that Windows owner. `wsl.exe --user` receives the acquired
account name, and each observation revalidates its numeric UID and physical roots.

The adapter reuses `WindowsServiceSupervision`, including Main/Recovery ownership,
the shared admission handle, IgnoreNew/Queue, the independent sixty-second backstop
and Recovery's ten-second deadline. Main keeps a native foreground handle to
`wsl.exe --distribution … --user … --exec /bin/sh …`. The fixed Linux shell bridge
waits for the managed `serve --service` child with independent null stdio and
inherited ignored SIGHUP. It observes the atomically published private preference
through its acquired mounted manifest path solely to release at OFF; Start admission
uses the Windows handle plus a native Linux `flock` shared with preference writes.
The final Linux ON/revision check and child fork hold that lock; the child closes
its inherited lock descriptor. This fences a cold WSL activation that reaches Linux
after OFF or a later ON. A pipe-owned Linux helper keeps preference writes excluded
through atomic publication of the mounted manifest. The Linux descriptor holder
performs the bounded read, temporary-file flush and rename itself; Windows sends
only the proposed bytes through its pipe. Holder exit closes publication authority,
including for a callback still awaiting validation. Every WSL manifest mutation,
including diagnostics and acknowledgements, uses this publisher and requires the
acquired distro to be available.
The bridge stays resident throughout ON and releases
the child without a signal at OFF, allowing its Windows client to exit before task
removal. A subsequent ON observes the same surviving service before considering
another spawn.

WSL OFF acknowledgement compares the exact registration PID/id/URL/version and
Linux boot/start identity before and after owned task removal, independently of
HTTP health. A live HTTP 500 or slow service survives removal with the same
incarnation. A lost, replaced or unreadable identity for an observed live service
keeps acknowledgement pending for the original OFF and explicit Retry;
installed-resource and namespace checks remain required.

Health uses exact native registration paths mapped through the selected distro,
Linux `/proc` boot/start identities and official read-only authenticated discovery
from Windows. This also verifies localhost forwarding. A live Linux PID with failed
forwarding or unknown health stays preserved; Windows process APIs only inspect
the Windows guard. Read-only native CLI status distinguishes an internally healthy
service with failed Windows discovery as `wsl-forwarding-unavailable`; ambiguous
native health remains unknown. The descriptor contains minimal paths rather than profile
environment or credentials. WSL follows the Windows login boundary; its distro
startup/idle/sleep policies apply independently. Linger stays under the distro's
own policy.

Focused checks: `node --import tsx --test
packages/server/src/host-lifetime/service-supervision-wsl.test.ts`.
`node --import tsx scripts/test-service-supervision-wsl-native.mjs OUTPUT_DIRECTORY`
uses an isolated downloaded Linux CLI and Ubuntu roots, private run-owned Windows
artifacts and unique tasks. It covers managed foreground
hosting, real health loss/recovery, guard/action loss and OS backstop, OFF survival
without Windows clients, adoption, crash/stop/restart and native disabled behavior.
It removes its tasks/service/Linux roots, preserves distribution lifetime under the
user's control and compares the shared Windows service registration fingerprint.
Stopped-distro startup requires a separately prepared, verified disposable distro.
Use an expendable Ubuntu distro
with the fixture's explicit account; real login/reboot and desktop packaging remain
host-release gates. The forwarding diagnostic check injects a failed Windows
discovery against real healthy Linux status. Physical forwarding disablement, an
occupied Windows port, running-distro shutdown and the Recovery kill/timeout/Start
refusal combinations have separate OS qualification gates.

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
