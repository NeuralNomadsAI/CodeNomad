# OpenCode V2 compatibility: audit and implementation roadmap

## Current qualification policy

Qualify against the latest published stable OpenCode runtime (`@opencode/cli@latest`).
For each CodeNomad release, the minimum supported OpenCode version is the latest
stable OpenCode version available at the time of that CodeNomad release. Record
the resolved version in the release notes; that minimum stays fixed for that
CodeNomad release and is reassessed at the next release.

CI records the resolved runtime version. Pin client/plugin dependencies together
to the release target and qualify them before publishing CodeNomad. Retained
compatibility code and historical-data handling do not imply support for older
runtimes. Keep detailed results in the change's PR and CI logs, not in per-version
reports. Update this reference in place.

PR #696 implements a fixed minimum of **2.0.11** for this development release:
stable `>=2.0.11 <3.0.0`, with separate authenticated contract recognition for
unlisted releases. Missing/outdated runtimes share installation and recovery UI;
the bundled Node/npm installer and explicit daemon restart are distinct actions.
Legacy request/response/event translations have been retired. Historical
identity, import/cursor, cancellation and connection-authority checks remain.
The isolated 2.0.3→2.0.11 seed confirms native workspace-selector collapse while
preserving session IDs and complete history. See the
[transition register](OPENCODE_V2_POST_BETA.md) for actual coverage and release gates.

The audit and implementation record below is historical context, not a runtime
qualification matrix to maintain.

**Audit date:** 2026-09-16. **CodeNomad baseline:** PR #695 at `bcfe4d24`.
**Status:** connection-scoped compatibility is implemented. Autonomous gatekeeper loops approved transport, identity, scripts/CI and rendered-fixture scopes with no remaining actionable findings. The original audit findings below remain as the change rationale; the implementation results section records their current disposition.

## Decision summary

The [OpenCode V2 stable-runtime transition register](OPENCODE_V2_POST_BETA.md) supersedes the earlier live-support set and records implementation and acceptance evidence. The sections below preserve the original #695 audit.

At `bcfe4d24`, CodeNomad had a working modern-client path and backward-compatible service discovery, **not a complete backward-compatible V2 integration**. The follow-up change keeps that discovery fix and addresses the remaining issues through one connection-scoped integration module and one cross-runtime acceptance matrix.

The primary split is the pre-2.0.4 V2 contract versus the 2.0.4 contract. Earlier changes also matter, particularly message editing, catalog activation, location identity and native cache behavior. Support should be defined by tested contract families and features, not inferred from a healthy daemon, a package name, a beta-number comparison or a passing TypeScript build.

Recommended initial acceptance targets:

- `2.0.4` and `2.0.5`: modern contract; both have native integration evidence.
- `2.0.3`: immediately preceding stable contract; known incompatibilities must be fixed.
- `beta-19271`: the client previously pinned by CodeNomad; known incompatibilities must be fixed.
- `beta-19059` and `beta-18866`: historical/early-window contract candidates. Audit their native behavior before claiming support; they are not certified by this review.
- Development snapshots: diagnostic evidence only until a particular contract is explicitly supported.

These were the audit's initial acceptance targets. The following matrix records the actual completed checks. A runtime can support normal conversations while lacking a particular optional feature; pruning additionally requires independently verified storage capabilities.

### Implementation results

The adapter lives in `packages/server/src/opencode/compatibility/`. `OpenCodeSharedService.acquire()` pins endpoint, canonical client, authenticated runtime identity, forwarding transport and invalidation to one connection. Generation checks run again at actual dispatch after asynchronous body preparation. Unknown version numbers undergo authenticated, bounded `/openapi.json` recognition; they are not rejected solely because their version is absent from a list.

The native fixture runs the **same scenarios** against beta-19271, 2.0.3, 2.0.4 and 2.0.5 with client/plugin 2.0.4. All four pass. It uses the production shared-service connection, real guarded proxy and real UI fetch adapter. It covers voice instruction removal/addition before prompt, commands, session Shell, background Shell cursor output/removal, UI permissions, server Yolo, rejection, busy inbox delivery/cancellation, interrupt/wait, staged revert clearing, global/session Forms, native session cursors, export/import and pruning concurrency/payload/fork/restart. Native identity cases additionally cover same-directory legacy identities, worktree/global Forms, scoped SSE, Shell/PTY location checks, foreign cursor/session refusal and exact move rollback.

HTTP inbox responses are normalized before the stable Solid reducer, including compaction admission. **SSE enqueued items have a different shape:** their timestamp comes from `event.created`; the integration preserves that native event schema. An actual stable reducer regression exercises both paths. Legacy permission events are renamed without changing durable metadata, and legacy catalog/content edits trigger authoritative invalidation.

An explicit private location-context header preserves legacy identity through the modern generated client's field selection. The proxy authorizes it before reconstructing upstream selectors, directory translation and forwarding. Move rollback and pruning retain exact identity. Modern public selectors remain directory-only. Native `idle` records retain identity/outcome but no longer become invented assistant text.

The CI matrix retains modern cross-platform packaging/pruning validation and adds Windows runs for beta-19271, 2.0.3 and 2.0.5. Typechecks/mocks are supplemental to those real-runtime scenarios.

| Runtime / check | Declaration-reviewed | Native-verified | Packaged-verified |
| --- | --- | --- | --- |
| beta-19271 | Yes | Full shared fixture; non-null identity pruning rerun | Shipped pruning bundle in isolated runtime; desktop resources checked separately |
| 2.0.3 | Yes | Full shared fixture; non-null identity pruning rerun | Shipped pruning bundle in isolated runtime; desktop resources checked separately |
| 2.0.4 | Yes | Full shared fixture; modern selector rejection | Shipped pruning bundle in isolated runtime; desktop resources checked separately |
| 2.0.5 | Yes | Full shared fixture; modern selector rejection | Shipped pruning bundle in isolated runtime; desktop resources checked separately |
| Other audited beta/stable publications | Yes | Not certified individually | Not certified individually |
| Unknown publication | Authenticated structural negotiation required | Not certified by version alone | Not certified by version alone |

Current issue disposition:

| Issues | Result |
| --- | --- |
| C01 | Discovery fallback preserved, bounded/authenticated, no downgrade except 404. |
| C02–C04 | Shared request adaptation; native prompt/voice/command/Shell/permission/Yolo/inbox/revert/Form scenarios pass on both families. |
| C05 | HTTP list/admission/compaction normalization plus real stable reducer pending/SSE regressions. |
| C06 | Legacy catalog/content invalidation and permission-event translation; original durable metadata retained. |
| C07 | Full internal identity, private context serialization, proxy/native authorization, original cursor bytes, exact rollback. |
| C08 | Native full pruning suite also passes with **non-null workspace identity** on beta-19271 and 2.0.3 (`--legacy-pruning`); no claim-fence relaxation. |
| C09 | Use current `plugin.updated` and restored `catalog.updated` invalidation, not removed activation-wait calls. Existing in-flight/trailing catalog regressions and real late plugin installation/disposal/reopening pass. |
| C10 | Idle control records retain ID/time/outcome without fabricated assistant text or a pending spinner. |
| C11 | Method/path/status/profile diagnostics; mutation no-retry, dispatch fencing, cancellation and native 401 envelope regressions. |
| C12 | Common four-runtime CI/native matrix added; remaining environment-specific validation boundaries are stated below. |

### Gatekeeper record

The autonomous loop corrected full-location authority/serialization, generation pinning, dispatch-after-body-read races, compaction admission normalization, subscriber cancellation during negotiation, first-request negotiation ordering, native 401 envelope truncation, and direct Shell/PTY scope propagation. Final independent reviews approved both server transport/lifecycle/proxy and identity/UI/events/pruning/rollback scopes with **zero remaining actionable findings**. Their final focused suites passed 90 server tests and 101 identity/server plus 39 identity/UI tests respectively. This is approval of the current compatibility change, not a closure of the historical architecture findings below.

The final rendered run exposed a fixture sequencing error: it awaited only the first prune of a cross-message group, then started response cleanup against stale selected content. Production guards correctly rejected that selection. The fixture now waits for every message's commit/projection, has a gated regression and independently tests whole-response confirmation counts. The final rendered-fixture review approved the correction; modern 2.0.5 and beta-19271 with non-null identity both pass. A further modern rerun passes using the exact shared connection throughout browser proxy and event transport. Test cleanup was also hardened so an import failure cannot leave the proxy listening or be replaced by a cleanup 404.

### First published CI run and corrective follow-up

The first CI run of the completed implementation (`a0c1c943`, [run 35142559235](https://github.com/NeuralNomadsAI/CodeNomad/actions/runs/35142559235)) failed despite the local bundle validation. It exposed two gaps:

- The standalone npm pruning package imported identity helpers from the sibling `compatibility/` directory, which was absent from its archive. All three packaged-plugin jobs failed to load it. Pure identity validation/equality now live inside the pruning package and are re-exported by the HTTP adapter. A fast packaging regression resolves every exported entrypoint from only the files selected by `npm pack`, outside the checkout. The actual packed/installed native test reproduced the failure before the fix and passes afterward on Windows 2.0.4 and Linux-under-WSL 2.0.4/2.0.5.
- The Windows legacy jobs encountered NTFS short-path TEMP directories while Git returned the long canonical project root. Project selection compared strings before evacuation could reach its rollback test. It now resolves exact owned directories through `getServiceDirectoryForPath`, preserving aliases and WSL translation. The review rejected an initial attempt to reuse containing-worktree identity: that could select a nested repository and miss the intended project's active sessions. Exact project/sandbox/destination comparisons are now separate from descendant-session ownership. Regressions cover nested projects listed first, active-session refusal through the real route, unresolved/foreign destinations, short/long paths, real junction/symlink aliases and WSL translation.

The corrected 2.0.4 shipped bundle also passes the full rendered/native suite on Windows. Fresh full beta-19271 and 2.0.3 runs with `--legacy-pruning` pass under a reproducing NTFS short-path TEMP root **after** the exact-directory correction. Independent final packaging/documentation and worktree-identity reviews approve the follow-up with zero actionable findings. The final full server suite passes **500 tests, with 2 skipped**, including the new packaging and directory-identity regressions. The `comment` job failed only because the required build-validation run failed; it did not expose an additional defect. These follow-up results are local evidence, not a claim that the next remote CI run has completed.

### macOS late-discovery follow-up

The next remote run at `486e856d` ([35146390688](https://github.com/NeuralNomadsAI/CodeNomad/actions/runs/35146390688)) passes the general tests, all runtime-contract jobs, both Tauri checks, all service-compatibility jobs, and the Windows/Linux native pruning jobs. macOS passes the installed-package suite and presence tests, then times out discovering the bundle installed after the daemon/location already exist. The dependent artifact-comment job reports that failure.

Source review of OpenCode `v2.0.4` (`466b3e594d3df396a57340249590a70c5c358c8a`) identifies an alias-path mismatch consistent with this failure: global configuration retains `OPENCODE_CONFIG_DIR` verbatim, while Parcel's macOS FSEvents backend emits native physical paths. Plugin-source filtering uses lexical `FSUtil.contains`. A `/private/var/...` event therefore falls outside a configured `/var/...` root. Parcel watcher 2.5.1 itself canonicalizes temporary roots in its tests. Linux inotify constructs paths from the watched alias, so a passing Linux symlink experiment does not validate macOS event spelling.

The native fixture now resolves its temporary root with `realpath` **before** constructing any daemon paths. Installation still happens after daemon/location startup; an explicit assertion verifies that the bundled plugin was absent beforehand. Discovery failures retain the last plugin inventory and phase context. CI uploads only these isolated fixtures' daemon logs, discovery snapshots and rendered captures on failure.

The corrected full native suite passes on Linux/WSL 2.0.4 with a symlinked TEMP root, and the Windows 2.0.4 rendered/native suite passes. Script syntax, workflow YAML parsing and whitespace checks pass; an independent gatekeeper review reports no actionable findings. This corrects the fixture namespace rather than preinstalling the plugin, restarting the daemon, or extending the timeout. Actual macOS confirmation requires the next CI run; the prior runner's raw watcher paths were not retained. Existing user daemons configured through symlinked config roots remain an upstream watcher limitation, not a production fix claimed by this fixture change.

### Server-info discovery follow-up (2026-09-17)

The installed 2.0.7 daemon returns 404 for both `/api/status` and `/api/health`,
and exposes authenticated `/api/info`. Lifecycle validation now tries the three
read routes in that order, advancing only on 404 and sharing the same credentials,
response-size bound and absolute deadline. Redirects are rejected. Earlier V2
services still stop at `/api/health`; no minimum release or new version exception
is introduced. Unknown versions still negotiate their actual OpenAPI contract.

The connection records `info` discovery so canonical `client.server.status()`
uses `/api/info` too. Translation is limited to GET and does not retry a failed
request with another route. A comparison of the 132 pinned-client HTTP method/path
pairs with the installed 2.0.7 schema found 131 unchanged pairs and this single
status/info difference. Experimental paths were already part of the merged modern
contract; this is not another experimental-route migration.

Host/WSL regressions cover the third probe, credentials, body validation and shared
deadline. Client regressions cover 2.0.0 health, 2.0.4 status, negotiated 2.0.7 info
and an unknown future version. The isolated location fixture exercises production
lifecycle validation and canonical `client.server.status()` before location tests.
On Windows, that fixture passes against real isolated 2.0.0 and 2.0.7 daemons:
2.0.0 takes the health route and passes the legacy identity/Form/Shell/PTY/SSE/
cursor/rollback cases; 2.0.7 takes the info route and passes modern location and
obsolete-selector checks. The 44 focused lifecycle/transport/negotiation tests
and server typecheck also pass.
Route presence and these targeted checks do not certify every runtime behavior.

### Validation boundaries

UI/server/Electron typechecks and production builds pass. The Windows Tauri release executable also builds (`npm run build --workspace @codenomad/tauri-app -- --no-bundle`). Electron and Tauri packaged-resource smoke checks pass. Full desktop interaction through Developer Mode could not run: the visible application reports Developer Mode inactive. Interactive TUI validation is not claimed. No shared daemon or user database is used by the native fixtures.

The full 2.0.5 native suite also passes inside Ubuntu/WSL using an isolated Linux Node 22.20.0 (verified against the published SHA-256) and a temporary Linux filesystem root. This is a native Linux-under-WSL result, not a full Windows-host/WSL desktop traversal. A preceding run with the **configuration directory on `/mnt/c`** passed conversations, Forms, permissions and the proxy suite, but timed out discovering a plugin installed after location startup. The otherwise identical native-filesystem run passed late discovery, presence disposal/reopening and pruning. Mounted-drive late-plugin discovery remains an explicit environment limitation, not a claimed fix. Host/WSL lifecycle and path-translation regressions pass.

## 1. Scope and evidence

### Publication inventory

Compared **all 44 beta/stable client publications** from 2026-09-02 through the audit's 2026-09-16 registry snapshot, plus `beta-18743` (2026-08-31) as the preceding release baseline:

- `@opencode-ai/client`: 23 publications, `beta-18866` through `beta-19271`.
- `@opencode/client`: 21 publications, `beta-19275` through `2.0.5`.
- Tarball SHA-512 integrity was checked against npm metadata before inspecting files.
- Compared generated Promise operations, exported type declarations and native Solid `data.js`.
- Operation comparisons ignore ordering-only changes in declared HTTP status arrays. Textual type changes are investigation signals, not automatically breaking changes.
- This is a client-contract census of release channels. It is not a source-level review of every runtime commit or every `dev-*` publication, nor a native test of all 44 releases.

Official reference sources:

- [V2 client documentation](https://opencode.ai/v2/docs/build/client)
- [V2 API reference](https://opencode.ai/v2/docs/api) and [OpenAPI](https://opencode.ai/v2/openapi.json)
- [V2 plugin RPC documentation](https://opencode.ai/v2/docs/build/plugins/rpc)
- npm metadata: [old client namespace](https://registry.npmjs.org/@opencode-ai/client), [current client namespace](https://registry.npmjs.org/@opencode/client)
- Exact published tarballs, especially `@opencode-ai/client@0.0.0-beta-19271`, `@opencode/client@2.0.3`, `2.0.4` and `2.0.5`. Current website documentation cannot establish historical contracts.

### Reproductions

1. Ran official Windows CLIs `beta-19271`, `2.0.3` and `2.0.4` against separate synthetic directories/configs/databases. Exercised the real CodeNomad proxy and actual UI `createInstanceFetch` with client 2.0.4.
2. Discovery HTTP validation used the real isolated daemon, with synthetic CLI status/password command results. This did not discover or modify the user's shared service.
3. Confirmed the native Solid reducer throws on a pre-2.0.4 inbox response; the equivalent modern response succeeds.
4. Confirmed a matching non-null legacy workspace identity is rejected by the current pruning service in an isolated synthetic SQLite fixture; the fence accepts the same identity when it is actually supplied.
5. Ran the existing complete native proxy/pruning fixture against **CLI 2.0.5** using CodeNomad's pinned client 2.0.4 and shipped plugin bundle. It passed catalogs, sessions, native cursors, active envelope, instructions, wait, session/global Forms, storage/claim refusal, retry, concurrency, next-model payload, fork isolation, pre-compaction history, restart, backend presence and crash expiry.
6. Confirmed the local message normalizer turns native `idle/outcome: failed` into synthetic text `idle` with status `complete`. Visible treatment needs a rendering decision/test.

No native WSL, interactive TUI or fresh packaged desktop validation was performed in this audit. Earlier host/WSL service unit coverage remains valid; it is not a substitute for those runtime checks.

## 2. Timeline: the changes are not one migration

Dates below are npm client publication times in UTC.

| First relevant publication | Change | CodeNomad consequence |
| --- | --- | --- |
| Sep 2, `beta-18866` | `plugin.check/update`; plugin state/source and provider/model/config types evolve | Plugin inventory must follow actual states. New upstream APIs do not automatically enter the proxy allowlist. |
| Sep 3, `beta-18955` | Add `plugin.awaitActivation`; remove `plugin.added` in favor of current plugin lifecycle | Initial catalog readiness is part of the contract, not just a route name. |
| Sep 4, `beta-19059` | Compaction model/provider state; reducer connection/disposal handling; config changes | Preserve compaction data and cancellation/reconnect semantics. |
| Sep 4–5, `beta-19124`, `19133`, `19135` | Worktree routes change project-path to location-scoped, revert, then change again | A monotonic beta-number heuristic is insufficient. CodeNomad-owned Git worktree operations should remain independent. |
| Sep 7, `beta-19215` | Project update input; additional interruption reason | Review consumers rather than assuming every declaration change is a failure. |
| Sep 7, `beta-19266` | Provider compaction/context provenance types | Preserve provider state; execution semantics remain native. |
| Sep 7, `beta-19275` | `@opencode-ai` to `@opencode` namespace | Generated HTTP operations/types are unchanged from `beta-19271`; package rename is not the HTTP compatibility split. |
| Sep 9, `beta-19365` | Remove `session.messageUpdate` and its public event-union membership | Direct content editing needs the reviewed pruning RPC; HTTP name translation cannot recreate a removed capability. |
| Sep 9, `beta-19398` / `19419` | More compaction accounting/state and native reducer changes | Client cache behavior changes even when URLs do not. |
| Sep 10, `beta-19422` | Add message-list type filter | Retain native cursor authority; do not derive pagination from displayed/filtered row counts. |
| Sep 11, `2.0.0` | Session permissions/create inputs and permission-rules operation | New permission event/input shapes join the legacy HTTP family. |
| Sep 12, `2.0.2` | Config preferences/shell catalog; typed file-not-found response | Mostly optional surfaces; errors are also part of the client contract. |
| Sep 12, `2.0.3` | `session.diff`; native `idle` transcript record | A new message union member can compile through a generic fallback while losing its meaning. |
| Sep 16, `2.0.4` | Broad route, payload, response, event and location changes | Main current compatibility break; see matrix below. |
| Sep 16, `2.0.5` | No delta in generated Promise operations/types or Solid `data.js` versus 2.0.4 | Same inspected client contract. Native 2.0.5 integration also passes. Other runtime changes are not ruled out. |

The generated client has 142 leaf operations in 2.0.3 and 132 in 2.0.4: 11 new names, 21 removed names and 36 changed existing operation implementations. These are client-method counts, not a count of broken CodeNomad features or of OpenAPI routes.

## 3. Original audit issue register (`bcfe4d24`)

Evidence: **Native** = real isolated runtime/proxy; **Fixture** = actual module with synthetic inputs; **Contract** = published declarations/generated code plus caller inspection. P1 blocks intended compatibility; P2 is narrower correctness/feature work.

| ID | Priority / state | Finding and effect | Evidence / implementation locations |
| --- | --- | --- | --- |
| C01 | Fixed | Discovery used only `/api/status`, rejecting healthy earlier V2 services with 404. `bcfe4d24` adds authenticated health fallback only after status 404, retaining bounds/deadline. | Native on 19271, 2.0.3, 2.0.4; 35 lifecycle tests. `workspaces/opencode-cli-service.ts`. |
| C02 | P1 open | Earlier runtimes return 404 for experimental instruction/wait paths. Every prompt/command/session-shell send first synchronizes the voice instruction, including removing it when voice mode is off. Discovery can succeed while ordinary sending still fails. | Native + caller inspection. UI `stores/session-actions.ts:111-130,375-436`; server `server/http-server.ts`. |
| C03 | P1 open | Permission `decision` vs `reply`, command `name` vs `command`, fork optional `before` vs required `boundary`; session rename/inbox/revert methods and paths differ. UI permission replies **and server Yolo replies** are affected. `resume` vs `continue` also needs behavioral validation on a busy session. | Native 400 missing `reply`, `command`, `boundary`; 404 rename/revert. UI `stores/instances.ts`, `stores/session-actions.ts`, `stores/session-api.ts`, `components/session/session-view.tsx`; server `permissions/opencode-replier.ts`. |
| C04 | P1 open | Pending Forms list moved from `/api/form/request` to `/api/form`; cancel changed POST `.../cancel` to DELETE resource. Earlier runtimes cannot list/cancel through the current client. Reply's session URL itself remains compatible. Global Forms require the correct location headers. | Native list/cancel failures and session reply success; modern session/global Forms suite passes. UI `stores/instances.ts`, `stores/forms.ts`; guarded proxy. |
| C05 | P1 open | Earlier inbox responses contain `timeCreated`; stable reducer dereferences `item.time.created`. Reopening/reconciling a session with queued user/synthetic input throws even if all URLs are translated. | Fixture reproduced with real `@opencode/client/solid`. UI `stores/opencode-data.ts:156-170`; native `data.js` materialization. |
| C06 | P1 open | Older `catalog.updated` is dropped when global and ignored by UI invalidation when scoped. Stable reducer also expects `session.permissions`, not earlier `session.permissions.updated`. Pre-removal content-update events need authoritative message invalidation. | Contract + dispatch inspection. Server `workspaces/instance-events.ts`; UI `stores/instance-invalidation.ts`, `opencode-data.ts`; native Solid reducer. |
| C07 | P1 open, conditional | Legacy `workspaceID` identity is discarded/rejected in request locations, ownership, cursor/import checks, catalog/request keys and move rollback. A directory-only patch must not silently collapse distinct legacy locations. Existing default-directory probes do not validate these cases. | Contract; current code deliberately rejects non-null selectors. Server `workspaces/manager.ts`, `workspaces/worktree-session-evacuation.ts`, proxy cursor/import guards; UI `stores/request-locations.ts`, `stores/forms.ts`, `stores/session-api.ts`. |
| C08 | P2 open, conditional | Current pruning omits the legacy workspace identity passed to the SQLite fence, which then requires `workspace_id = NULL`. Legitimate non-null legacy sessions are refused; the broker may reject them even earlier. This is a refusal, not evidence of unauthorized deletion. | Fixture reproduced. Server `opencode/session-pruning/service.ts:39-42`, `claim-fence.ts:26-28`, `server/routes/session-pruning.ts:18`. |
| C09 | P2 validation gap | Activation-wait removal needs an older-runtime readiness policy. A successful early catalog read need not mean plugins have settled. Current `plugin.updated` refreshes help but need a race test. | Contract + removed `plugin-activation.ts`; catalog callers. Not reproduced as a permanent missing catalog. |
| C10 | P2 open | Native `idle` records introduced in 2.0.3 lose their outcome in CodeNomad normalization and become generic assistant text. Decide whether these are control records or explicit status rows; test all outcomes. | Fixture confirmed projection; visible rendering not yet established. UI `stores/message-v2/normalizers.ts:112-205`. |
| C11 | P2 open | Empty route-404 responses surface as `UnsupportedContentType` for several generated operations, concealing the real mismatch. Diagnostics should retain method/path/status and selected contract. Such errors must not trigger speculative mutation retries. | Native old-runtime rename/wait/cancel failures. Generated Promise error handling + both transports. |
| C12 | P1 coverage gap | CI pins a single modern native runtime. Updated mocks and typechecks confirm the modern interface, not compatibility with independently managed earlier daemons. | `.github/workflows/pr-build.yml`, `scripts/test-opencode-proxy-native.mjs`, `scripts/test-session-pruning-native.mjs`. |

Paths in this historical table are relative to `packages/server/src` or `packages/ui/src` as labeled. C02–C12 were not fixed by the discovery commit; their follow-up disposition is recorded above.

### The two main wire families

| Concern | Earlier V2 / 2.0.3 | 2.0.4 / 2.0.5 | Treatment |
| --- | --- | --- | --- |
| Discovery | `/api/health` plus `/api/server` metadata | `/api/status` | Already fixed for discovery; preserve authenticated runtime identity for negotiation. |
| Instructions, wait, import/export, stats; MCP connect/disconnect | Non-experimental paths | Experimental paths | Explicit route mapping for consumed operations after ownership checks. |
| Rename | POST `session/:id/rename` | PATCH `session/:id` | Translate supported title mutation, not arbitrary PATCH fields. |
| Permission reply | `{ reply }` | `{ decision }` | Map once for UI and Yolo. |
| Command | `{ command }` | `{ name }` | Preserve all other prompt fields/delivery. |
| Fork | `{ boundary: {type:'before',messageID} }` or `{ boundary: {type:'through'} }` | `{ before? }` | Preserve exact cut semantics; never silently fork all history. |
| Interrupt | `continue` query | `resume` query | Map before sending and test interruption/cleanup/inbox behavior. |
| Inbox delivery | POST `.../steer` or `.../queue` | PATCH `{ delivery }` | One operation; no trial mutation sequence. |
| Clear staged revert | POST `.../revert/clear` | DELETE `.../revert` | Keep ownership and worktree mutation fencing. |
| Inbox response | `timeCreated` | `time.created` | Normalize list and admission responses before the stable reducer sees them. |
| Forms | Location list `form/request`; POST cancel | Location list `form`; DELETE cancel | Preserve session/global distinction and validated encoded location headers. |
| Project metadata | `location.get().project` already exists; also `project.current` | `location.get().project` | Current metadata read is compatible in native probes; no fallback is needed for this read. |
| Location | Public directory + optional workspace selectors | Public directory only | Preserve internal legacy authority; never invent a modern workspace selector. |
| Credentials | Location query accepted | Global ID-only mutation | Inspect earlier native invalidation/location behavior; do not infer semantics from unchanged URL. |
| Catalog invalidation | `catalog.updated` | `provider.updated`, `model.updated` | Normalize to internal refresh intent covering both affected resources. |
| Message lookup | `session.message(...)` | `session.message.get(...)` | Same HTTP GET URL; this name change alone needs no wire fallback. |
| Pruning | Direct edit removed starting beta-19365 | Reviewed plugin RPC | Keep one pruning implementation with independently verified storage/claim semantics. |

Background `shell.*`, interactive `pty.*`, basic project/session/message reads and native cursor continuation remain distinct concerns. Removed Shell timeout, workspace provisioning, native Git worktree management, generic RPC/plugin management and unused experimental APIs should not be exposed merely to mirror the upstream surface.

## 4. Why the patch-by-patch approach fails

1. **Discovery and application compatibility are conflated.** A valid status response establishes reachability/authentication, not the meaning of the next POST or SSE event.
2. **There are two native HTTP paths.** UI calls go through Fastify's proxy, while Yolo, ownership checks and worktree evacuation use the server's shared client. Fixing only the proxy leaves direct callers inconsistent.
3. **The native Solid reducer is executable contract logic.** It depends on response shapes, events, cache publication and pagination; it is not just a set of TypeScript definitions.
4. **Authority is mixed with serialization.** Dropping a now-absent public field also removed information used for older location identity, cache keys and rollback.
5. **A newer lockfile can make mocks agree with one another.** Native tests must deliberately cross client/runtime generations and exercise the real transports.
6. **Our earlier migration widened the change while narrowing validation to modern V2.** Its modern-runtime results are useful, but they did not justify a backward-compatibility claim. The discovery fallback fixes only C01.

## 5. Recommended design: one integration module

### External seam

Place the integration module under `packages/server/src/opencode/compatibility/`, connected at `OpenCodeSharedService`. Its interface should expose a **single connection-scoped integration**: authenticated runtime identity/capabilities, the canonical client used by server callers, and the transport/event adaptation needed by the guarded proxy/event bridge.

Keep the current modern Promise client and Solid reducer as the canonical consumer contract. The legacy adapter performs the measured translations. Do not spread `if (version...)`, endpoint retries or legacy casts through stores, dialogs and Yolo code.

```text
UI stores/components + pinned native Solid reducer
                    |
          canonical CodeNomad-facing contract
                    |
         guarded Fastify proxy -- authorization / mutation fence
                    |                         |
                    +---- integration module -+---- server callers (Yolo, inventory)
                                  |
                    selected runtime-contract adapter
                                  |
                    existing shared OpenCode daemon

Native SSE --> same integration module --> CodeNomad refresh intents / compatible events
```

This module earns its depth by keeping route/payload/response/event variations behind one interface. Internally separate connection negotiation, explicit HTTP translations, response normalization and event adaptation; callers should not coordinate those pieces themselves.

### Runtime selection and lifetime

- Use the **authenticated daemon's** version/identity, not merely the selected CLI executable's version. An already-running shared service can differ from the CLI on disk.
- Recognize verified contract profiles from recorded declarations/OpenAPI signatures. Investigate daemon `/openapi.json` availability as a read-only capability check; do not assume it exists on every supported release.
- Health/status chooses a discovery route, not every capability. Earlier releases sharing health can differ in message editing, permissions or plugin/cache APIs.
- Resolve capabilities before mutations. A resource 404, 400 validation failure, timeout or 401 must not cause a second speculative write using another contract.
- Bind selection to connection generation plus daemon identity. On restart/upgrade/reconnect, revalidate and discard stale capability state even if URL/password stay the same.
- On an unknown contract, surface an explicit unsupported capability/error for the operation; do not pretend compatibility by silently dropping required fields. Avoid an exact-version-only production startup gate.

### Data and authority rules

- Normalize old inbox objects on **all relevant responses**, including list and admission. Validate required fields rather than blindly decorating arbitrary JSON.
- Preserve the exact native `cursor.next`. Cursor authorization may understand each supported family, but cannot recreate or strip the continuation token.
- Preserve legacy location identity in the internal model and validate it using the selected native adapter. Adapt public modern requests to directory-only at serialization time. Finalize this representation before implementing legacy global Forms or move rollback.
- Keep Form listing location-scoped. Resolve ordinary session Forms by session, and global Forms by their validated, translated, encoded directory and any supported legacy identity.
- Convert obsolete catalog/content-change notifications into explicit CodeNomad invalidation/re-read intent. Do not manufacture upstream durable event IDs or replay old writes to resemble a modern event stream.
- Keep worktree deletion fences and native session/directory/path ownership checks ahead of forwarding. Translation must not expand the externally exposed route allowlist.
- Keep pruning's DB identity challenge, SQLite transaction and execution claim verification independent of the HTTP profile. Plugin loading successfully is not proof that a destructive write is supported.

### Architecture tradeoff

The recommendation is a server-side normalization adapter because both transport paths can share it and the UI already has a pinned reducer. This avoids maintaining two browser state machines. It requires adapting responses and events as well as requests, and explicitly resolving the legacy location-identity representation.

Do not wrap the entirety of OpenCode or implement a speculative universal compatibility framework. Start with CodeNomad's consumed operations and the two demonstrated families. Only add a distinct feature capability when a measured difference requires it. The native acceptance matrix must exercise callers through the module's real interface, including proxy and direct-client paths.

## 6. Work packages and completion criteria

| Order | Work package | Issues | Completion criterion |
| --- | --- | --- | --- |
| 0 | Record this audit, exact profiles, support targets and evidence | C12 | One maintained register; runtime evidence separated from declaration comparisons. |
| 1 | Extract isolated runtime fixture and add a common acceptance matrix | C02–C08, C12 | Same scenario suite runs old and modern runtimes; current old-runtime failures are reproducible. Model traffic uses a local deterministic provider. |
| 2 | Introduce connection-scoped profile selection and internal location identity | C07, C11 | Reconnect/same-port upgrade invalidates profiles; old identity is retained; unknown capability and auth failures are explicit. |
| 3 | Integrate request/response adaptation through proxy **and** direct client | C02–C05 | Normal prompt, voice off/on, command, session Shell, Yolo, permission reply, rename, fork, interrupt/wait, inbox delivery and restart-with-pending-input pass on both families. |
| 4 | Complete location-sensitive Forms/import/cursors/moves and event/cache convergence | C04, C06, C07, C09 | Global/worktree Forms settle correctly; foreign locations are denied; native cursors unchanged; failed move restores full identity; delayed HTTP/SSE/reconnect converges. |
| 5 | Validate optional pruning/storage and modern transcript control records | C08, C10 | Non-null legacy identity has an explicit supported/refused outcome; storage/concurrency/payload/fork tests pass wherever pruning is advertised; idle records have intentional rendering. |
| 6 | Validate packaged hosts and make contract review a release practice | C12 | Electron/Tauri and WSL smoke results recorded; oldest supported/latest runtimes covered in CI; new publication deltas classified before dependency upgrades. |

Work packages are reviewable increments of one design, not independent fallback patches. Package 3 depends on the identity decision in package 2; package 4 must not be marked complete by testing only default-directory sessions.

### Required acceptance scenarios

- Fresh and already-running service; authentication errors; missing status; bounded responses; deadline exhaustion; reconnect to a changed daemon at the same URL.
- Fresh project, existing sessions, native session/message pagination, messages older than 200, moved sessions and multiple worktrees.
- Prompt, command and session Shell with voice mode enabled/disabled; attachments; pending input restored after reconnect.
- Permission acceptance/rejection and server Yolo; session/global Forms including worktree directory translation.
- Rename, full/partial fork, busy interrupt followed by wait, staged revert/clear, inbox queue/steer/cancel.
- Provider/model/plugin catalog changes while initial reads are in flight; credentials and MCP connect/disconnect; raw legacy events reaching stable cache reconciliation.
- Background Shell list/output/remove with native cursors; separate interactive PTY creation/connect lifecycle.
- For supported pruning: actual native storage identity, busy claim refusal, idempotency, concurrent admission, next-model payload, independent fork, pre-compaction content, restart, backend shutdown/expiry and TUI cache convergence.
- Negative cases: foreign session/directory/cursor/Form, obsolete selectors on modern APIs, malformed payloads, unsupported capabilities and transport failure without duplicate mutation.

### Release discipline

Maintain a feature/profile matrix with four explicit states: **declaration-reviewed**, **native-verified**, **packaged-verified**, **unsupported**. A successful health probe only fills the discovery cell. Do not label the entire application compatible because that cell is green.

For an OpenCode update: snapshot exact package versions/integrities; compare paths/methods, request fields, response shapes, errors, events and reducer behavior; map deltas to this register; run the oldest-supported/current/latest acceptance targets; update the matrix. No automatic import/allowlist expansion for unused native APIs.

The current PR's fallback can remain committed. The remaining compatibility work should follow this register, with a complete older-runtime conversation scenario required before describing PR #695 as backward-compatible.

## 7. Evidence archive and reproducibility

Research files on the audit machine live under `C:/Users/Admin/AppData/Local/Temp/opencode/`:

- `v2-fortnight-audit/`: extracted integrity-checked client tarballs, `contracts.json`, `changes.json`, normalized `inventory.json`.
- `audit-v2-contracts.mjs`: read-only registry/tarball inventory script used for this census.
- `pr695-review-native-results.json`: real-proxy failures on earlier runtimes and modern comparison, before the discovery-only fix.
- `pr695-discovery-fallback-results.json`: discovery fixed on beta-19271, 2.0.3 and 2.0.4.
- `review-pr695-reducer.mjs`: real stable reducer with old/new inbox response fixtures.
- `review-pr695-pruning.mts`: isolated legacy-identity refusal fixture.
- `v2-fortnight-native-205.log` and `codenomad-pruning-native-Xgg9tK/`: passing CLI 2.0.5 integration output and synthetic fixture.
- `compat-native-beta.log`, `compat-native-203.log`, `compat-native-204.log`, `compat-native-205.log`: passing integrated four-runtime compatibility/location/pruning matrix.
- `compat-pruning-identity-beta.log`, `compat-pruning-identity-203.log`: passing full pruning suite with non-null native workspace identity.
- `compat-server-tests.log`: 493 passed, 2 skipped; `compat-ui-stores.log`: 441 passed. Final targeted `session-actions.test.ts`: 33 passed. Electron native suite: 194 passed, 4 skipped.
- `compat-tauri-build.log`, `compat-electron-build.log`, `compat-tauri-smoke.log`, `compat-electron-smoke.log`: desktop build/resource evidence.
- `compat-rendered-ui.log`: final 2.0.5 rendered suite using the exact shared connection; captures in `codenomad-pruning-native-2Fea1N/` (`ui-before.png`, `ui-busy.png`, `ui-after.png`).
- `compat-rendered-ui-agent-legacy.log`: beta-19271 rendered suite with non-null identity; captures in `codenomad-pruning-native-rGgcVF/`.
- `compat-wsl-native-linuxfs.log`: passing Ubuntu/WSL native 2.0.5 suite. `compat-wsl-native.log` records the mounted-configuration late-discovery limitation.
- `pr695-ci-failed.log`: first published CI failures; `pr695-packed-before.log` and `pr695-packed-fixed.log`: failing then passing standalone packed-plugin native runs. `pr695-packed-linux.log` and `pr695-packed-linux204.log`: passing installed-plugin native suites under Linux/WSL. `pr695-ci-ui204.log`: passing corrected 2.0.4 rendered/native bundle run.
- `pr695-ci-server-final.log`: full server suite after the packaging/exact-project corrections, 500 passed and 2 skipped.
- `pr695-final-exact-short-beta19271-legacy.log` and `pr695-final-exact-short-203-legacy.log`: full native suites with non-null legacy identity and short-path TEMP, after the final exact-directory correction.
- `pr695-ci-macos-failed.log`: macOS late-discovery failure after the standalone package suite passes. `pr695-macos-symlink-before.log`: Linux inotify preserves alias-path discovery; this does not reproduce macOS FSEvents semantics.
- `pr695-macos-symlink-after.log`: Linux/WSL full native 2.0.4 with the fixture canonicalized from a symlinked TEMP root. `pr695-canonical-ui204.log`: passing Windows 2.0.4 rendered/native suite after canonicalization and the explicit pre-install absence assertion.

The tarball inventory is reproducible with `npm view <package> time --json` and `npm pack <package>@<exact-version> --ignore-scripts`, then comparison of `dist/promise/generated/client.js`, `types.d.ts` and `dist/solid/data.js`. Downloading a tarball does not require launching its CLI or loading a user database.

Portable native regression already in the repository:

```text
node scripts/test-session-pruning-native.mjs <absolute-isolated-cli-path>
node scripts/test-session-pruning-native.mjs <absolute-isolated-cli-path> <absolute-installed-plugin-directory>
node scripts/test-session-pruning-native.mjs <absolute-legacy-cli-path> --legacy-pruning
node scripts/test-session-pruning-native.mjs <absolute-isolated-cli-path> --ui
```

The full publication set inspected (beta versions abbreviated):

- Old namespace beta set: `18866, 18955, 18965, 18985, 18992, 18999, 19059, 19086, 19124, 19129, 19133, 19135, 19151, 19157, 19187, 19192, 19215, 19213, 19228, 19234, 19242, 19266, 19271`.
- Current namespace beta set: `19275, 19278, 19283, 19288, 19289, 19296, 19365, 19378, 19381, 19398, 19419, 19422, 19425, 19500, 19507`; stable set: `2.0.0, 2.0.1, 2.0.2, 2.0.3, 2.0.4, 2.0.5`.
- Additional preceding baseline: old namespace `beta-18743`.

## 8. Preserved historical architecture findings

Review target: `upstream/DEV-v2@f03a17a4`, covering `5484f9c9..f03a17a4`. These findings are preserved for follow-up, not asserted as current regressions or marked fixed by this compatibility change:

- High: Tauri shutdown races already-authorized navigation (`shutdown.rs`, `client_state/navigation.rs`).
- High: Non-authoritative workspace disappearance overwrites current drafts/attachments (`use-app-session-capture.ts`, `app-session-snapshot-merge.ts`).
- High: Tauri removes persisted state before native close succeeds (`client_state.rs`).
- Medium: Refresh/reconnect may remove transcript pages older than the latest 200 (`message-v2/instance-store.ts`).
- Medium: Session-list reset may hide roots concurrently added by SSE/restoration.
- Medium: Scroll restoration cannot find anchors older than the initial 200-message page (`message-section.tsx`, `virtual-follow-list.tsx`).
- Medium: Electron swallows persisted-record deletion failure before close, enabling ghost restoration (`multiwindow-lifecycle.ts`).
- Medium: Windows `NODE_EXTRA_CA_CERTS` paths are passed literally into WSL (`wsl-opencode-service.ts`).
- Medium: Conversation search excludes unloaded transcript pages.

Initial failed-service-identity pinning is historical only; the current base already includes recovery tests. The isolated partitioned-restore prototype and unrelated worktrees were not modified or published.
