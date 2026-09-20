# OpenCode V2 stable-runtime transition

**Implementation:** PR #696, based on #695 and the client/plugin 2.0.11 alignment
in #728. This register describes code and local evidence; remote CI and packaged
desktop acceptance are separate release gates.

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
executable, then publishes a versioned installation and atomic `current` marker.
No administrator rights, system Node, global npm install or application-resource
writes are required. Execution is bounded to five minutes and 1 MiB output.
Installation failures retain the previous marker. Concurrent requests coalesce;
another backend's same-version installation is accepted only after verification.

Explicit custom binaries remain selected. WSL and custom installations receive
execution-host instructions rather than a Windows-side Linux installation.
Remote setup runs on the CodeNomad server, not the browser machine.

Installation and service activation are separate. An old running daemon requires
the explicit **Restart shared service** action, whose copy explains interruption
of other clients' active work. Activation uses official `service stop` and the
existing native-parent `service start` bridge, authenticates the daemon, validates
its contract and replaces local authority. Ordinary backend shutdown never stops
OpenCode. Unknown/newer daemons cannot be downgraded by this action.

## Historical migration

`scripts/test-opencode-history-migration.mjs OLD_CLI TARGET_CLI` creates synthetic
2.0.3 storage, closes it, copies its DB/WAL and lets the target runtime perform its
own migration. It retains seed exports, untouched seed storage, CLI versions,
executable SHA-256 hashes and logs in a fresh temporary fixture. It never connects
to the shared service or rewrites native tables.

Local Windows acceptance for **2.0.3 → 2.0.11** covers:

- Three source location identities, including two workspace identities at one
  directory, with independently addressable session IDs and forks.
- 215 messages per seeded conversation: synthetic history, reasoning, text,
  completed tool output and a pre-compaction checkpoint. Export equality and
  native message pagination preserve complete history.
- Native session pagination, a moved worktree session and a pending inbox record.
- **Native identity rule:** the target migrates historical `workspaceID` values
  to the local directory scope while preserving session IDs and content. The
  fixture reports this explicitly; CodeNomad does not manufacture aliases.

The existing native pruning fixture independently verifies current Forms,
Shell/PTY scope, permission/Yolo replies, model payload, fork independence,
pre-compaction pruning, execution-claim races, plugin disposal and daemon restart.
This is not a claim that every old pending Form or provider configuration has
been tested across the storage migration.

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

Open release gates, not completed local claims:

- Green remote CI for the final diff and independent review.
- Packaged Electron/Tauri startup, update/restart and reconnect interaction on
  release artifacts. Native desktop automation was unavailable in this session.
- Windows→WSL traversal and mounted/aliased configuration-root watcher coverage.
- Broader old-runtime seeds and old pending Forms/provider-state migration.

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
