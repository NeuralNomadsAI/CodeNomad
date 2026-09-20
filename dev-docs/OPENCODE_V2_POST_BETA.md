# OpenCode V2 stable-runtime transition

**Implementation:** PR #696, based on #695 and the client/plugin 2.0.11 alignment
in #728. The first implementation was re-reviewed after the user challenged its
arbitrary version floor and incomplete cleanup. Earlier test/review results below
describe that earlier diff, not approval of its scope or the current correction.

## Release contract

- The technical minimum is **2.0.7**. Published 2.0.4–2.0.6 events lack
  `session.step.started.data.started`; 2.0.7 introduces it. The pinned Solid
  reducer consumes that field directly for assistant-message creation times.
  Retiring the timestamp fallback therefore requires this native event contract.
- **2.0.11 is recommended and release-tested**, independently of that minimum.
  Being the latest publication or matching the client/plugin pin is not a
  technical reason to reject 2.0.7–2.0.10.
- Stable versions below 2.0.7 and historical `0.0.0-beta-*` publications are
  refused with a timestamp-contract explanation and HTTP 426. Unlisted versions,
  future majors and custom/prerelease labels are unverified rather than rejected
  by their label; they undergo authenticated bounded API recognition.
- Client and plugin dependencies remain separately pinned at 2.0.11.
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

The global setup dialog and Preferences reuse `OpenCodeUpdateCard` and its store.
This is an implementation reuse choice, not a user requirement that all failures
have the same screen. Missing installations, known incompatibility and optional
updates expose different actions. Installed/running/minimum/recommended versions
and the technical reason are shown separately, with retry and executable selection.
Dismissal leaves a recovery entry; optional updates do not force the dialog.
Connection changes, foreground entry and unsupported proxy responses refresh
recovery state. Stale responses cannot overwrite a changed executable or a
completed action. Only a pending folder open may resume; prompts are not replayed.

Default host installations use bundled Node and the npm distributed in its pinned
official archive. Previously the packaging script retained only the Node binary
and discarded npm; the archive itself already contained npm. Both hosts now include npm's complete
dependency/license closure. npm installs an exact policy-compatible release into
a staging directory under `~/.local/share/codenomad/opencode`, verifies the real
executable, then publishes a versioned installation and an immutable version
receipt. The highest published version wins; old `current` markers remain readable.
The old unused global npm/pnpm/bun/yarn installer and legacy-package removal path
are deleted. If npm is unavailable beside the server runtime, automatic installation
is not advertised. No administrator rights, system Node, global npm install or application-resource
writes are required. Execution is bounded to five minutes and 1 MiB output.
Installation failures retain the previous selection. Concurrent requests coalesce;
another backend's same-version installation is accepted only after verification.
Exclusive receipt creation is idempotent on Windows; a slower old-version install
cannot downgrade the selection published by another backend.

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

### Earlier implementation evidence (through `4a77d162`)

These results predate the technical-floor correction and are retained as history:

| Check | Result |
| --- | --- |
| Complete final server suite | 621 passed, 2 skipped; no failures/cancellations. |
| Final managed-setup/API regressions | 22 covered in the final server suite, including real manager reconnect/reload, cross-selection serialization and concurrent receipt publication. |
| Setup browser regressions | 7 passed, including optional activation, explicit required restart, informed configuration reload and activation failure after successful installation. |
| Server/UI TypeScript | Passed. |
| Native old-seed migration | Both beta-19271 and 2.0.3 passed against 2.0.11 on Windows and Linux. |
| No-system-Node install | Passed Windows with packaged Node 24.20.0 and Linux with isolated Node/npm; POSIX lifecycle shell stays available without a system Node on PATH. |
| Feature gatekeeper | Three passes; five actionable findings corrected and regression-tested; final feature pass reports none. |
| Acceptance/CI gatekeeper | Added whole-run/request deadlines, bounded child termination and cursor-cycle rejection; three failure-guard tests pass and re-review reports none. |
| WSL path gatekeeper | Fixed stale overlapping-claim ownership and POSIX URL escaping; 19 path/install/lifecycle tests pass and re-review reports none. |
| Explicit reload gatekeeper | Fixed cross-binary serialization at shared-service authority scope; 16 focused service/route/manager tests pass and re-review reports none. |
| Real Windows→WSL | Native Linux/UNC, Windows mount and symlink-to-mount modes passed authenticated provisioning, heartbeat stability, explicit reload, restart and reconnect; all fixture daemons stopped. |
| Native reload effects | Active synthetic-provider stream completed with one request/no replay and unchanged daemon PID; pending Form was cancelled and original Shell/PTY became unavailable. |
| WSL fixture gatekeeper | Whole-run/request/cleanup bounds and immediate detached-consumer error handling are covered by seven guard regressions; final re-review reports none. |
| Windows release hosts | Rebuilt Electron and Tauri passed actual missing installation, bundled-Node setup, 2.0.3 daemon preservation until explicit restart, 2.0.11 activation, pending-folder continuation, and explicit configuration reload. Captures inspected and artifact/resource hashes retained. |
| Final discovery/desktop gatekeeper | Fresh WSL absence, alternate loopback, metadata translation and old-daemon detection are covered; 35 focused lifecycle tests pass. Independent final review reports no actionable findings and verifies the final artifact hashes/evidence. |
| Remote CI at `419fe6a6` | All test jobs passed: full tests, runtime contracts, cross-platform installation/migration and native pruning, Windows/macOS Tauri. Distribution builds were still running at the single follow-up check; later changes require their own CI result. |

Earlier remaining release result:

- Green remote CI for the final pushed diff. Earlier test jobs at `419fe6a6`
  passed across all configured platforms; that is not a substitute for the final
  head's CI. No continuous CI monitoring is performed.

The final discovery cross-check also covers a configured but absent WSL service,
registered-service forwarding failures, mounted/aliased metadata access and valid
non-default loopback addresses such as `127.0.0.2`. Registration absence and an
existing registered daemon remain distinct; configuration alone is not evidence
of a running process.

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

Final Windows desktop evidence directories (under the approved local temporary
`opencode/` directory) are `codenomad-setup-desktop-O0ScgO` (old daemon/restart/folder),
`codenomad-setup-desktop-FiVAai` (installation/reload), and
`codenomad-setup-desktop-Vk2RV8` (installation/folder). Each contains `results.json`,
artifact/resource hashes, per-host logs/API responses and screenshots. Final WSL
discovery runs are `codenomad-wsl-setup-6RvOIs`, `codenomad-wsl-setup-CqxLn8` and
`codenomad-wsl-setup-KSOQ1V`; the detailed reload characterization with final
consumer-error handling is `codenomad-wsl-setup-9tivGc`.

Autonomous gatekeeper review led to regression fixes for optional
activation, stale-selection restart, cross-backend downgrade, same-version
Windows publication, non-disruptive workspace reconnect, fixture timeout/error
cleanup, WSL canonical path/ownership/URL handling, cross-selection service-action
serialization and old-daemon/fresh-WSL discovery. Every reported actionable finding
was corrected, revalidated and independently re-reviewed; the final pass is clear.

Do not remove the remaining historical authority checks based solely on this
synthetic seed. Keep the compatibility audit in
[OPENCODE_V2_COMPATIBILITY.md](OPENCODE_V2_COMPATIBILITY.md) as historical evidence.

## Decision history

- 2026-09-16: #695 established connection-scoped compatibility; #696 began as a
  documentation-only retirement plan without selecting a floor.
- 2026-09-20: stable V2 publication is established. The user requested the actual
  implementation in #696. The plan-only status is superseded by the code above.
- 2026-09-20 initial implementation: minimum/client/plugin baseline 2.0.11.
  **The user rejected the minimum rationale and the assistant's attribution of
  implementation choices to an agreed scope.** That version-only policy is superseded.
- 2026-09-20 correction: the user accepts retiring older runtimes if a technical
  reason is demonstrated. Minimum 2.0.7 follows the native step timestamp;
  recommendation 2.0.11 remains separate. Complete the obsolete serializers'
  retirement, keep current authority checks, and make optional updates non-blocking.

## Correction evidence

- Direct native checks on 2.0.7, 2.0.8, 2.0.9, 2.0.10 and 2.0.11 control:
  13 scenarios each passed, covering authenticated schema, config discovery,
  current plugin/RPC loading, real local shell/environment snapshot replacement,
  two-session isolation, synthetic provider prompt/wait/context and stable PID.
  Evidence: approved temporary `opencode/pr696-native-207-210/REPORT.md` and
  `results-2.0.7_2.0.8_2.0.9_2.0.10_2.0.11.json`.
- Corrected final server suite: 622 passed, 2 skipped; server/UI typechecks passed.
- Production-boundary native suites passed on 2.0.7: session environment,
  locations/worktrees/relay, full pruning/proxy with rendered UI, and automation.
  Environment and full pruning/proxy also passed on 2.0.10. Both versions passed
  real compaction and pruning of pre-compaction history. CodeNomad does not emit
  the differing provider/model compaction-settings shapes; its raw config editor
  saves user-authored runtime-specific text. Evidence: `pr696-native-207-210/ACCEPTANCE.md`.
- Native 2.0.3→2.0.7 migration passed with 215-message histories, distinct old
  identities, forks, provider configuration/connections and same-version Form
  durability controls. Evidence: `codenomad-history-migration-IoFhtY`.
- Seven browser setup scenarios passed. Rendered captures distinguish minimum
  2.0.7 from recommendation 2.0.11 and keep 2.0.10 usable with optional update.
  Evidence: approved temporary `opencode/696-rigorous-browser/`.
- CI now runs runtime qualification at the source-defined technical minimum and
  latest, and migration targets read the same minimum rather than duplicating it.
- The independent review found a real CLI-parser mismatch: custom labels were
  lost and `+build` suffixes truncated. Production parsing and HTTP/updater tests
  now preserve those labels, with no automatic update/downgrade for unorderable
  versions. Re-review closed all source/docs/CI findings; a separate final review
  also approved the compatible-daemon fixture and generated-output clean step.
- Server builds clean generated `dist` before compilation; desktop acceptance
  checks that deleted adapters/installers do not survive incremental packaging.
- Rebuilt-host acceptance and final remote CI are recorded in the PR after
  completion; earlier green tests are not substituted for those results.
