# OpenCode V2 post-beta preparation

**Status:** draft preparation; runtime support is unchanged.
**Starting point:** [PR #695](https://github.com/NeuralNomadsAI/CodeNomad/pull/695), merged into `dev` at `aa51cbb9` on 2026-09-16.
**Related register:** [current compatibility contracts and evidence](OPENCODE_V2_COMPATIBILITY.md).

## Objective

Prepare a small, deliberate retirement of earlier V2 wire contracts when OpenCode leaves beta. Continue ordinary CodeNomad development in parallel, merging compatible preparation in small increments. Keep the eventual support-policy change and deletion reviewable together.

Three versions must remain distinct:

| Version | Current baseline | Post-beta decision |
| --- | --- | --- |
| CodeNomad dependencies | Exact `@opencode/client@2.0.4` and `@opencode/plugin@2.0.4` | Select reviewed dependency versions and update their lockfile together. |
| Connected OpenCode daemon | Native acceptance on beta-19271, 2.0.3, 2.0.4 and 2.0.5 | Choose an explicit minimum runtime and supported release range. |
| CodeNomad release | Support established by #695 | Announce the release that adopts the new minimum. |

No minimum or retirement date is selected yet. A numeric `2.0.x` version or an npm dist-tag is not sufficient evidence of the product's exit from beta. Record the upstream announcement, exact packages and reviewed contracts before making that decision. A newer CLI installed on disk also does not prove the already-running daemon was upgraded.

## Permanent interface

Keep `OpenCodeSharedService.acquire()` as the shared seam for the guarded browser proxy and direct server callers, including Yolo. It binds authenticated endpoint/daemon identity, client, transport, connection lifetime and invalidation. Retiring one adapter must not move contract decisions into UI stores or individual callers.

The future single-contract implementation must preserve:

- Authentication, loopback/origin checks, credential-safe redirects, bounded discovery and absolute deadlines.
- Dispatch-generation checks after asynchronous body preparation; retired streams cannot publish or invalidate a replacement connection.
- Independent caller cancellation and connection-scoped negotiation/validation.
- Native error envelopes, especially streamed 401 responses; no mutation retry under another contract after failure.
- Location/session/path ownership, the proxy allowlist and worktree mutation fences.
- Exact project/destination directory identity, distinct from containing-worktree identity, with exact session rollback.
- Native `cursor.next`, scoped Forms and validated encoded global Form headers.
- Separate background `shell.*` and interactive `pty.*` behavior.
- Authoritative cache reconciliation, historical message access, and intentional handling of native idle control records.
- Pruning's fresh storage-identity challenge, synchronous SQLite execution-claim fence and explicit-request-only deletion.
- A standalone pruning package with complete local imports, plus bundled-plugin presence/disposal and late discovery.

The directory name `compatibility/` is not a deletion instruction. Some of its implementation provides these permanent guarantees.

## Retirement inventory

Paths below are relative to the repository root. This is a working deletion map, not authorization to remove code before its evidence is available.

| Area / entry points | Retirement candidate | Evidence required / behavior retained |
| --- | --- | --- |
| `packages/server/src/opencode/compatibility/runtime.ts` | Audited legacy release list and legacy profile classification | Keep authenticated daemon metadata. Introduce a support decision separately from wire-contract recognition. |
| `packages/server/src/opencode/compatibility/negotiate.ts` | Recognition of the retired contract family | Decide how future/unlisted releases are recognized. A version above the minimum is not blanket certification of future majors or snapshots. |
| `packages/server/src/opencode/compatibility/requests.ts` | Legacy route, method and payload translations | Verify all consumed operations against the selected minimum and latest validated runtime before deletion. |
| `packages/server/src/opencode/compatibility/transport.ts` | Legacy status-envelope and HTTP inbox timestamp conversions | Preserve authentication, lifetime/cancellation, origin checks, diagnostics and modern forwarding. Native SSE inbox timestamps remain a distinct schema. |
| `packages/server/src/opencode/compatibility/events.ts` | Legacy permission-event renaming | Prove supported runtimes emit the canonical event; preserve durable metadata and reconnect reconciliation. |
| `packages/server/src/workspaces/opencode-cli-service.ts` | `/api/health` fallback | Remove only when every supported daemon exposes authenticated `/api/status`; retain all discovery error/deadline guards. |
| `packages/server/src/opencode/compatibility/location.ts` and `proxy-locations.ts` | Legacy wire selectors and private-header reconstruction | Prove historical location identity remains representable and authorized. Keep import/cursor validation and global Forms scope. |
| `packages/ui/src/stores/request-locations.ts` and its callers | Legacy request options/private context | Review Forms, metadata/provider credentials, session creation/moves and Shell calls together. Do not collapse cache keys while distinct identities remain observable. |
| `packages/ui/src/stores/instance-invalidation.ts` and `session-pruning-events.ts` | Legacy-only catalog/content event branches | Keep current authoritative refresh, pruning events and in-flight invalidation coverage. |
| `packages/server/src/opencode/session-pruning/location.ts`, `service.ts`, `preview-store.ts` | No automatic deletion | Identity/storage validation concerns historical data, not only old HTTP clients. Preserve exact membership and package closure. |
| `.github/workflows/pr-build.yml` and native fixtures | Positive runtime-support jobs for retired releases | Replace with minimum + latest validated runtime coverage; retain migration seeds and former authority/race regressions where meaningful. |

Keep the original compatibility audit as historical evidence. Record which predicates/tests were removed, retained or replaced in the implementation PR rather than overwriting the old results.

## Work packages

### P0 — Establish the preparation register (this increment)

- [x] Base the draft on the merged compatibility implementation.
- [x] Distinguish dependency versions, daemon support and the CodeNomad release decision.
- [x] Map retirement candidates and permanent guarantees to current files.
- [x] Define historical-data acceptance, support-policy decisions and release gates below.

This increment adds documentation only. All implementation and native-validation checkboxes below are deliberately open.

### P1 — Make support policy an explicit connection decision

- [ ] Separate "recognized contract" from "supported runtime" at the shared connection seam, preserving today's accepted releases during preparation.
- [ ] Define the future minimum, supported release range and treatment of development/unlisted versions from publication evidence.
- [ ] Evaluate the actual authenticated daemon identity before functional calls or mutations, for both proxy and direct callers; re-evaluate on connection replacement.
- [ ] Surface a structured unsupported-runtime error with actual/required versions and an upgrade action explained in every UI locale. Authentication/transport errors retain their own classification.
- [ ] Verify below-minimum refusal, unknown-contract refusal, same-port replacement, independent cancellation and absence of speculative calls/retries.
- [ ] Review plugin provisioning order so rejecting an unsupported runtime does not bypass the existing explicit-request-only pruning rule or daemon ownership policy.

Do not add an inactive universal capability framework or a second client interface. The first implementation should keep the existing profile resolver and consumer seam, with the smallest support-policy decision needed by real callers. CodeNomad does not silently upgrade, restart or stop the shared daemon.

### P2 — Certify historical data on the replacement runtime

- [ ] Add reproducible synthetic-history seeds using the already-audited legacy runtimes; retain exact executable/package versions and integrity metadata.
- [ ] Keep an untouched seed copy, then let the official target runtime migrate an isolated copy through its normal startup path. Do not manually rewrite OpenCode tables to manufacture compatibility.
- [ ] Validate this matrix through the real shared connection, guarded proxy, generated client and reducer:

| Synthetic legacy history | Required result on target runtime |
| --- | --- |
| Root and worktree sessions, including two identities at the same directory | Every session remains distinguishable/accessible, or an explicit native migration rule is documented and tested; ambiguous identity collapse blocks retirement. |
| More than 200 messages and multiple native session pages | Full history remains reachable through native pagination; obsolete cursor state is discarded and reread without rewriting history. |
| Moved sessions and location-switched history | Current ownership and historical locations are preserved; exact evacuation/rollback and foreign import/cursor refusal still pass. |
| Tool/reasoning content, forks and pre-compaction history | Content and fork independence survive migration/restart; pruning affects only explicit selections and preserves model-context semantics. |
| Native pending inbox and control records | Reopened state converges from authoritative reads/events; idle outcomes do not become fabricated assistant text. |
| Global/session Forms, Shell/PTY scope and provider metadata | Location-sensitive operations retain their documented authority and current native lifecycle behavior. |

Old-runtime execution for generating migration fixtures is distinct from promising live support for those runtimes. Keep that purpose explicit when reducing the CI matrix.

### P3 — Simplify behind the existing interface

- [ ] Remove legacy request/response/event translations once P1 and P2 establish the supported replacement contract and data behavior.
- [ ] Remove the discovery fallback only with matching minimum-runtime evidence.
- [ ] Simplify private location context and UI callers only where the migration matrix proves it unnecessary; retain historical identity validation where the target still exposes it.
- [ ] Preserve and rerun the original authority, connection-generation, no-retry, import/cursor, rollback and pruning regressions against the supported contract.
- [ ] Review imports from both the bundled and separately packed pruning plugin; no dependency may escape the standalone archive.

### P4 — Publish the new support floor

- [ ] Record the upstream post-beta announcement and exact target contract/dependency versions.
- [ ] Choose and announce the CodeNomad release/minimum OpenCode runtime, including the distinction between updating the CLI and the running daemon.
- [ ] Run minimum + latest validated native acceptance, including packed/bundled pruning and rendered controls, on Windows, macOS and Linux.
- [ ] Verify Electron and Tauri startup/reconnect/refusal behavior, plus host-to-WSL traversal for supported WSL configurations.
- [ ] Resolve or explicitly scope the existing mounted-configuration late-discovery limitation and aliased config-root watcher behavior; canonical temporary fixtures alone do not certify those user environments.
- [ ] Update release notes, `MIGRATION_V2.md`, architecture references and `AGENTS.md` together with the implementation.
- [ ] Complete independent gatekeeper review, fix/retest findings, and obtain green CI for the final diff.

## Working in parallel

Use this draft as the maintained preparation register. Keep it close to `dev` and small: merge completed backward-compatible preparation as independent increments, then update this register's progress and links. Avoid accumulating an alternate application implementation for the rest of beta.

For each increment, record:

1. Base commit and the work package advanced.
2. Any change to the currently supported runtime set (normally none during preparation).
3. Contract/publication evidence, exact native artifacts and isolated migration results.
4. Which invariants/tests replace retired compatibility tests.
5. Remaining decisions or failed checks, without converting local evidence into a remote-CI claim.

The eventual retirement change is ready when the support-policy, historical-data and release gates are complete. Until then, the merged #695 compatibility behavior remains the product baseline.

## Decision log

| Date | Decision / open question | Disposition |
| --- | --- | --- |
| 2026-09-16 | Start from merged #695 rather than a parallel rewrite. | Adopted; preparation branch based on `aa51cbb9`. |
| 2026-09-16 | Runtime 2.0.5 and client/plugin 2.0.4 are different version axes. | Preserve that distinction in the draft and release communication. |
| 2026-09-16 | Remove legacy wire support separately from historical-data identity handling. | Adopted; P2 gates identity simplification. |
| 2026-09-16 | Which upstream release marks beta exit, and which CodeNomad release raises the minimum? | Open; no version/date selected. |
| 2026-09-16 | What supported range and future-version recognition replace two-profile negotiation? | Open; decide during P1 from the actual publication contract. |
