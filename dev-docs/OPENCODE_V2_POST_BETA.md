# OpenCode V2 stable-runtime transition

**Implementation:** PR #696, based on #695 and the client/plugin 2.0.11 alignment
in #728. Local/native acceptance includes both rebuilt Windows desktop hosts.
The autonomous correction/review loop finished with no remaining actionable
findings; remote CI for the final pushed diff is a separate release result.

## Release contract

- This development release fixes `MINIMUM_OPENCODE_VERSION` at **2.0.11**.
  npm `@opencode/cli@latest` resolved to 2.0.11 on 2026-09-20.
- Supported versions are stable `>=2.0.11 <3.0.0`. Prereleases, malformed
  versions, older releases and future majors are refused with
  `opencode_update_required` / HTTP 426.
- Client and plugin dependencies remain separately pinned at 2.0.11.
- Authenticated daemon metadata, not the selected executable's version, controls
  connection admission. Admission precedes functional clients and plugin
  provisioning. Replacement daemons are checked again, even at the same URL.
- Unlisted supported releases must also pass bounded authenticated OpenAPI
  recognition. A retired or unrecognized contract never receives speculative
  writes. The minimum is never fetched from npm at application startup.
- CLI `service status: stopped` is not sufficient absence evidence: a current
  CLI can miss an older daemon's metadata route. The lifecycle performs bounded,
  read-only native registration discovery through the selected execution host,
  authenticates the registered endpoint against historical metadata, and repeats
  discovery before `ensure()` may start. This lookup never supplies plugin roots
  and never writes registration, port or database files.

## Setup and recovery

The global setup dialog and Preferences share `OpenCodeUpdateCard` and the same
store. Missing and below-minimum installations use one screen with state-specific
actions, installed/running/minimum versions, retry and executable selection.
Dismissal leaves a recovery entry; optional updates do not force the dialog.
Connection changes, foreground entry and unsupported proxy responses refresh
recovery state. Stale responses cannot overwrite a changed executable or a
completed action. Only a pending folder open may resume; prompts are not replayed.

Default host installations use bundled Node and the npm distributed in its pinned
official archive. Both Electron and Tauri resources include npm's complete
dependency/license closure. npm installs an exact policy-compatible release into
a staging directory under `~/.local/share/codenomad/opencode`, verifies the real
executable, then publishes a versioned installation and an immutable version
receipt. The highest published version wins; old `current` markers remain readable.
No administrator rights, system Node, global npm install or application-resource
writes are required. Execution is bounded to five minutes and 1 MiB output.
Installation failures retain the previous selection. Concurrent requests coalesce;
another backend's same-version installation is accepted only after verification.
Exclusive receipt creation is idempotent on Windows; a slower old-version install
cannot downgrade the selection published by another backend.

Explicit custom binaries remain selected. WSL and custom installations receive
execution-host instructions rather than a Windows-side Linux installation.
Remote setup runs on the CodeNomad server, not the browser machine.

Installation and service activation are separate. A below-minimum running daemon requires
the explicit **Restart shared service** action, whose copy explains interruption
of other clients' active work. Activation uses official `service stop` and the
existing native-parent `service start` bridge, authenticates the daemon, validates
its contract and replaces local authority. Ordinary backend shutdown never stops
OpenCode. Unknown/newer daemons cannot be downgraded by this action.
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
| Audited beta/old-stable live-support list | Removed; fixed policy and current-contract admission replace it. |
| Legacy routes, methods and payload translation | `compatibility/requests.ts` removed. |
| Legacy HTTP inbox/status conversions | Removed from transport. |
| Legacy permission/step event normalization | Removed; admitted runtimes emit native canonical events. |
| Authentication, cancellation, origin and connection generations | Retained and regression-tested at the existing shared seam. |
| Older discovery routes | Retained for authenticated diagnosis of an outdated running daemon, not functional live support. |
| Historical location/context, import/cursor and pruning checks | Retained. Obsolete public selectors remain rejected; these are authority checks, not permission to run old daemons. |
| Legacy schema recognition | Retained to diagnose and reject a retired contract; no legacy serializer remains. |

## Validation and release gates

Implemented checks include server/UI typechecks, server regressions, real Solid
browser setup tests and rendered captures, isolated bundled-Node installation,
native migration, native locations/worktrees, automation heartbeat/provisioning
and pruning acceptance. CI adds first installation and old-seed migration at
the fixed minimum and resolved latest stable on Windows, Linux and macOS ARM64.
The existing cross-platform native pruning gate remains in place.

2026-09-20 follow-up evidence:

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

Remaining release result:

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
- 2026-09-20: minimum/client/plugin baseline 2.0.11; setup precedes admission
  recovery, updates never silently restart the externally owned daemon, and
  native historical identity validation remains independent of live support.
