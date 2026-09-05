# OpenCode V2 Migration

## Summary

This branch replaces CodeNomad's OpenCode V1 SDK, custom plugin, and per-workspace runtime architecture with the experimental native OpenCode V2 client and one shared OpenCode service. It intentionally provides no V1 runtime fallback.

The work grew beyond an SDK swap. It also introduces location-based ownership, native Forms and Shell resources, project-wide session pagination, reconnect reconciliation, bounded virtualized timelines, multi-window desktop state, and a content-addressed restore format.

Server and UI declare `@opencode-ai/client@beta`. The latest published beta is always the source of truth. Refreshing that dependency updates `node_modules` and rewrites `package-lock.json`; the lock is only the generated snapshot of the last dependency resolution, never a compatibility authority. Refresh it before migration audits or builds. It does not constrain the independently managed runtime CLI. The 2026-09-04 client snapshot is `beta-19059`; the independently managed runtime used for backward-compatibility validation still reports `beta-18999`.

The incremental comparison with official OpenCode Desktop V2, including closed findings and remaining gaps, is recorded in [`DESKTOP_V2_COMPARISON.md`](DESKTOP_V2_COMPARISON.md).

## Native V2 Adoption

- Use native locations and `SessionInfo.location` as the authority for workspace, session, file, event, Shell, PTY, and Git worktree ownership.
- Use native APIs for projects, sessions, messages, prompts, commands, models, agents, providers, MCP, permissions, Forms, files, VCS, instructions, Shells, and PTYs.
- Use native session lifecycle and output events, including `session.created`, `session.renamed`, `session.moved`, `session.status`, `session.idle`, `session.execution.*`, `session.compaction.*`, `session.step.streamed`, `session.message.content.updated`, `session.text.*`, `session.reasoning.*`, and `session.tool.*`.
- Use `@opencode-ai/client/solid` `createData` for live message, tool, permission, and Form projection while preserving REST-loaded history and optimistic local sends.
- Replace the legacy Question request lifecycle with native Forms. Question tool output rendering remains. The proxy still contains inert legacy Question allowlist entries, but `beta-19059` declares no Question client API and its runtime does not serve those routes.
- Replace shell-mode prompts with native `session.shell`.
- Replace CodeNomad background processes with native `shell.*` resources. The Status UI lists, displays bounded output for, and removes Shells; create/output/timeout routes remain available through the ownership-checked proxy. Interactive `pty.*` terminals remain separate.
- Store voice-mode instructions with `session.instructions.entry` and synchronize them before prompts, commands, and session Shell calls.
- Inherit native durable JSON `SessionMetadata` directly from `SessionInfo`. Do not widen it to arbitrary `unknown` values or maintain a parallel CodeNomad-only metadata contract.
- Wait for location-scoped plugin activation before retaining agent, provider, model, command, or plugin catalog reads. Treat `plugin.updated` as the settled catalog invalidation; `plugin.added` no longer exists.
- Keep the narrow project-local `codenomad.automation` exception on the V2 `setup` and `tool.transform` contract; it remains active under `beta-19059`.

### Beta 18866 Contract Review (Historical)

The `beta-18414` to `beta-18866` review found these additive client surfaces:

| Native addition | CodeNomad decision | Reason |
| --- | --- | --- |
| `plugin.check` | Deferred candidate for a future plugin inventory UI. | It is read-like and location-scoped, but CodeNomad currently has no plugin-management workflow. |
| `plugin.update` | Keep blocked. | It installs or replaces executable plugin code and requires an explicit trusted update flow, confirmation, and mutation fencing. |
| `rpc.call` and typed plugin RPC/events | Keep the generic route blocked; permit only reviewed RPC definitions through a constrained broker if a concrete integration needs them. | A blanket RPC proxy would bypass the method-specific allowlist. The existing Developer Mode bridge has different process and authentication boundaries and is not automatically replaced by plugin RPC. |
| `experimental.persistentPty.read` | Keep blocked. | CodeNomad uses native Shell resources for background output and has no owned persistent-session-terminal lifecycle. |
| `vcs.base` and diff base selection | Deferred read-only candidate. | The current Git Changes UI displays working-tree and index changes and does not yet offer base-branch comparison. |
| `Service.stop({ pty })` handoff/clear behavior | Do not adopt. | CodeNomad does not own or stop the shared OpenCode service. |

### Beta 18999 Contract Review (Historical)

The 21 official beta releases from `beta-18230` through `beta-18999` have empty GitHub release bodies. The 2026-09-04 review therefore matched official publish workflows to source commits, read the intervening repository history, compared npm tarballs and generated Promise declarations, and checked the official V2 docs instead of relying on nonexistent prose release notes.

The final published range from `beta-18866` (`519cd8c7712fc2ca6d2ca1d356d7f52cbd6d5808`) to `beta-18999` (`887f319769c55718e3e64f64b32c9aafb13c5d66`) contains 114 commits. Its complete generated-contract delta is:

| Published change | CodeNomad decision |
| --- | --- |
| Add `POST /api/plugin/await-activation` and its input/output types. | Allowlist only this non-mutating plugin route. Coalesce waits by client and Location before catalog and plugin-status reads, with authoritative reads as the fallback for a lagging runtime. |
| Remove `PluginAdded` and `plugin.added`. | Delete the obsolete invalidation branch. Refresh agents, providers, commands, and metadata from the settled `plugin.updated` event. |
| Rename `ConfigEntry.autoupdate` to `update: "disable" \| "notify" \| "auto"`. | No migration is required because CodeNomad has no OpenCode `autoupdate` caller or projection. Runtime CLI updates remain independently managed. |

The same audit reconfirmed the cumulative published additions already in use: native `session.messageUpdate`, durable session metadata, `time.streamed`, `session.step.streamed`, `session.message.content.updated`, current plugin state records, and the generated Solid event reducer. Provider/model canonical resolution and materialized skill text remain upstream runtime concerns; CodeNomad sends native IDs and prompt attachments without duplicating that lowering. Plugin package checks/updates, generic RPC, persistent PTYs, VCS review-base reads, and session transfer UI remain explicit product/security decisions rather than accidental omissions.

### Beta 19059 Contract Review

The successful 2026-09-04 publish from `c9d240704d6eefc88b63a1eca2cb933b3eb70ed3` produced `beta-19059`, the 22nd official beta in the reviewed range. Its release body is also empty. The audit therefore reviewed all 52 commits after `beta-18999`, compared both npm tarballs, refreshed the installed declarations and lock, and compared the official V2 OpenAPI and documentation.

No route or schema was added or removed: the OpenAPI remains at 119 paths, 140 operations, and 229 schemas, while the generated Promise client remains at 136 methods. The complete published client delta that affects CodeNomad is:

| Published change | CodeNomad decision |
| --- | --- |
| Completed compaction messages and `session.compaction.ended` now carry optional `model` and `providerState`. | Preserve both fields in normalized compaction parts; the upgraded Solid reducer also retains them for live events. |
| `createData` fences event-driven refreshes while disconnected or disposed and adds an `onError` callback. | Keep the existing connection signal and route refresh failures through the CodeNomad logger. The lifecycle fencing is inherited from the upgraded client. |
| Command config adds `subagent`; `subtask` remains as a deprecated alias. | `CommandInfo` exposes neither flag, so the runtime remains authoritative. Command submission stays serialized but no longer marks the parent optimistically busy; native events now distinguish current-session execution from a background child. |
| `ConfigEntry.update` narrows from `"disable" | "notify" | "auto"` to `"disable" | "notify"`. | No migration is required because CodeNomad does not read or write this setting; update checks moved to CLI/TUI clients and the runtime CLI remains independently managed. |

The renewed OpenAPI review also made explicit that `fs.list` accepts absolute paths and `..` traversal relative to a Location. The CodeNomad proxy now resolves that target, rejects duplicate selectors and paths outside owned worktrees, and translates an accepted path for WSL before forwarding it.

Runtime changes in the same release—settling abandoned compactions before resume, retrying failed Location initialization, disabling plugins after transform failures, backgrounding command subagents, restoring Windows terminal interruption, detecting new ecosystem config roots, and live provider/model fixes—are acquired automatically when the independently managed `opencode2` runtime is updated. CodeNomad does not duplicate those internals and does not reject an older healthy runtime at startup. At the time of this audit `upstream/beta` equals the published `beta-19059` source, so there is no later unpublished contract delta.

## Shared Service Model

- OpenCode V2 explicitly confirms that the intended architecture is [one shared process for all workspaces and clients](https://github.com/anomalyco/opencode/issues/43898#issuecomment-5372607267); workload slowdowns must be profiled and fixed within that topology rather than worked around with private servers.
- Replace one OpenCode runtime per workspace with one externally owned global service in the selected host or WSL environment.
- Discover or start it through the selected CLI's official `service status`, `service start`, and `service get password` commands.
- Accept only bounded, authenticated loopback health endpoints and pin one service identity while connected.
- Use OpenCode's standard service registration, state, and database. CodeNomad owns no private daemon port, database, registration, or PID.
- Pass configured startup environment variables and `NODE_EXTRA_CA_CERTS` only when starting a missing service. Strip legacy `OPENCODE_DB` and `XDG_STATE_HOME` overrides rather than taking ownership of OpenCode storage.
- Never stop the global daemon during CodeNomad shutdown. Backend shutdown clears only CodeNomad's cached connection and logical workspace state.
- Run the Linux CLI inside the selected WSL distribution and require Windows localhost forwarding. No cross-namespace PID fallback or process signaling remains.
- OpenCode PR [#46085](https://github.com/anomalyco/opencode/pull/46085), included since `beta-18721`, bounds post-exit pipe draining so detached Windows GUI descendants no longer leave the parent session permanently running. Late output may be discarded; `session.background` remains a user action rather than a required workaround.

## Workspace, Location, and Tab Model

- A CodeNomad workspace is now a logical UUID-backed instance over a native OpenCode location, not an OpenCode process.
- A normal folder launch always creates a new logical instance and tab, even when the same or canonically equivalent directory is already open.
- The explicit **Open** action selects an existing instance instead of creating another one.
- Duplicate-folder instances share the same daemon and native location but keep independent logical IDs, tabs, selection, drafts, and view state.
- The workspace catalog is shared by the backend. Tab membership, order, active selection, SideCars, drafts, attachments, and view state are local to each native window.
- Closing a tab or window detaches only local UI state. **Stop Workspace** deletes the selected logical instance and evicts the native location only after its final logical owner is removed.
- Restore matches duplicate-folder tabs by normalized-path occurrence rather than collapsing them into one instance.
- Owned Git worktrees are resolved server-side and participate in the same location, request, and event-routing rules as the root directory.

## Sessions, Streaming, and Reconciliation

- Query a complete project-scoped session inventory across root and worktree subpaths without one request per parent; native `global` projects remain scoped to the selected workspace directory.
- Follow native `cursor.next` values for session and message pagination. The proxy decodes session cursors only to validate embedded directory/project scope, strips competing selectors, and forwards the original cursor unchanged.
- Hydrate only missing ancestor chains with `session.get` and fetch active status for later session pages.
- Load message history lazily into a replace-in-place 200-message resident window. Older, newer, oldest, and latest navigation swaps authoritative pages without accumulating the transcript, while delayed REST responses cannot overwrite newer event state.
- Route location-scoped events to every owning logical workspace and resolve locationless session, permission, Form, Shell, and PTY events through native ownership.
- Use one upstream event subscription and browser `EventSource` for web, Electron, and Tauri.
- Treat events as volatile projections, not durable history. Browser `EventSource` recovery refreshes the workspace catalog and per-instance authoritative state, reloads the active transcript, and invalidates other loaded transcripts for lazy refresh. Upstream instance-stream recovery performs only the per-instance reconciliation.
- Preserve Solid projection controllers across browser transport reconnects and merge live records into REST history rather than clearing usable state. A native `server.connected` generation change disposes and recreates those controllers before reconciliation.

## UI and Memory Optimizations

- Virtualize session lists and message timelines with `virtua` `0.51.0` to bound mounted DOM for large histories.
- Preserve user-controlled scroll position, bottom-follow intent, oversized streaming hold points, and anchor-based restore across live updates, pagination, tab changes, and desktop restarts.
- Shift ordered slides of the capped 200-message window in place. Reordered, paginated, and otherwise non-aligned key changes advance a measurement epoch and remount the virtualizer so stale measurements cannot be reused.
- Finalize the temporary `200 -> 201 -> 200` shift in a generation-guarded microtask before paint, and compensate followed content growth from a `ResizeObserver` attached to the mounted Virtua content root. Only explicit user scroll intent disables following.
- Keep native cursors authoritative; do not infer completion from page length.
- Bound instance logs and validate restore-state counts, IDs, paths, snapshots, string budgets, partition sizes, and graph sizes.
- Reconcile only affected resources after native events or reconnects instead of periodically reloading full message history.
- Keep optimistic prompts visible before native admission and replace temporary parts with authoritative native parts without duplicating output.
- Keep every pending inbox prompt after delivered transcript messages in native inbox admission order. A local send pins the new prompt to the bottom, while pagination and remote updates preserve a user's escaped follow state.
- Project every native streaming delta through the shared reactive message path, while limiting timeline reconstruction for text, reasoning, and compaction by the same streamed-content buckets.

## Forms, Permissions, and Providers

- Merge pending permissions and Forms into one ordered interruption UI while preserving their separate native reply/cancel APIs.
- Reconcile pending requests from the root, active catalog, known session, worktree, and queued Form locations after reconnect and during bounded liveness checks while sessions or prompts are active.
- Treat successful permission and Form replies or cancellations as local authority so stale events and partial scans cannot resurrect settled interruptions; failed mutations trigger authoritative reconciliation.
- Carry location for global Forms through the proxy without inventing a synthetic session.
- Support native provider API-key, OAuth, command, and interactive Form authentication, including dynamic required fields and custom choices.
- Expose read-only quota usage for the supported provider registry, including xAI, Claude, Command Code, CrofAI, DeepSeek, and NeuralWatt, without returning, refreshing, or mutating provider credentials.
- Keep Yolo policy server-owned: persist enabled session families, inherit policy across descendants, deduplicate duplicate-instance delivery by permission ID, retry within a fixed bound, and synchronize state to every window.

## Worktree Safety

Before deleting a Git worktree, CodeNomad now:

1. Resolves and fences the canonical physical worktree identity across nested paths, aliases, junctions, symlinks, and WSL paths.
2. Rejects new OpenCode, file, and Git mutations and drains already admitted mutations, failing closed if the bounded drain cannot complete.
3. Resolves the native project and inventories every session with native cursors.
4. Selects sessions whose native location belongs to the worktree.
5. Refuses deletion while affected sessions are active.
6. Moves affected sessions to the root location.
7. Re-inventories until the moves are authoritative.
8. Removes the Git worktree inside the same rollback boundary.
9. Restores moved sessions if verification or deletion fails.

Git status is hybrid: native `vcs.status` is augmented with CodeNomad server detail data. Selected-file diff, stage, unstage, and commit remain server operations. Although `beta-18866` exposes native worktree creation and removal, CodeNomad retains its server workflow for ownership fencing, session evacuation, verification, and rollback semantics.

## Proxy and Security Boundaries

- Expose only reviewed method/path pairs; new upstream APIs are unavailable until explicitly allowlisted.
- Verify workspace ownership for native locations, sessions, projects, cursors, Shell/PTY CWDs, imported session locations, and prompt file URIs before forwarding.
- Reject encoded path traversal, foreign locations/projects, forged cursors, and mismatched workspace selectors. Preserve validated native location workspace identities, including global Form headers, across the proxy.
- Translate host/WSL paths only after ownership validation.
- Strip CodeNomad cookies, browser authorization, forwarding headers, and incoming `x-opencode-*` headers; inject shared-service authentication server-side.
- Block upstream cookies and authentication challenges and avoid logging unredacted secret-bearing request bodies.
- Treat each unguessable preview token as a route-scoped capability. Loopback HTTP native previews use `<token>.preview.localhost` so applications retain normal root paths; HTTPS, LAN, and web clients use the equivalent capability path. SideCar/browser previews remain opaque-origin sandboxes without `allow-same-origin`, and element comments cross a source-checked message bridge.

## Desktop and Restore Restructuring

- Run one native singleton and one CodeNomad backend per channel/config profile. Stable, development, and non-default config identities use isolated singleton, browser-storage, backend, and client-state scopes.
- Open another local window on a second launch by default; an Advanced preference restores most-recent-window focus, while `--new-window` always opens another window.
- Give each Electron or Tauri window a UUID and independent tab/restore record while sharing the backend and global OpenCode data.
- Persist one record per window in a V3 envelope over a V2 content-addressed partition graph.
- Split workspace/session documents and chunk attachments so unrelated state does not rewrite one monolithic snapshot.
- Validate hashes, canonical JSON, allowed fields, graph references, and size/count limits. A corrupt leaf can be discarded while valid sibling state survives.
- Prepare immutable partitions before atomically publishing the root; serialize and fence writes against ownership loss, renderer-token mismatch, shutdown, and migration races.
- Coordinate Electron/Tauri ownership with participant markers, process-start identity, stale-owner recovery, and verified release.
- Copy legacy Electron/Tauri client state non-destructively on first migration and refuse to overwrite unsupported future formats.
- Store the stable/default cross-host state under `~/.codenomad/client-state/v2`; development and non-default profiles use derived profile-specific locations.
- Restore every persisted UUID window, exact active tab/session selection, drafts, attachments, expansion, scroll/follow state, idle markers, interrupted generations, bounds, and zoom.
- Fence late workspace creation and cleanup so cancelled restore requests cannot leak or delete the wrong logical instance.
- Build Electron and Tauri server resources reproducibly from the integrity-pinned root workspace lock for the requested OS/CPU target; no independent server lockfile or prebuild dependency repair remains.

### Native Release Debug Launch

For interactive validation of the native V2 application, use the existing release binary rather than `tauri dev`, which compiles and runs a different debug environment. Enable **Developer Mode** from the session tab bar and restart CodeNomad when prompted. The native host then selects its derived persistent developer profile, enables Rust backtraces and Node source maps, and opens CDP on a dynamically assigned loopback port.

```powershell
& "$PWD\packages\tauri-app\target\release\codenomad-tauri.exe"
```

The Developer Mode bridge discovers and verifies the actual dynamic `cdpUrl`; do not set or assume port `9223`. Stop the running instance before rebuilding this release path, then relaunch it from the independent OpenCode TUI or through the pinned `codenomad.act({ action: "restart" })` workflow.

## Removed Legacy Architecture

The migration deletes rather than maintains these superseded systems:

- The complete `packages/opencode-plugin` package, its packaging script, desktop resources, setup hooks, environment plumbing, and plugin README.
- Plugin POST/SSE channels, handlers, voice synchronization routes, and the custom plugin-to-CodeNomad event bridge.
- Per-workspace OpenCode runtime processes, loopback servers, clients, authentication, binary selection, launch cleanup, process identity, process-tree signaling, and runtime tests.
- The `.codenomad/worktreeMap.json` mapping layer and UI-side OpenCode workspace/worktree-client matching.
- The custom background-process manager, persistence, HTTP routes, and UI store; native Shell listing, bounded output display, and removal replace them.
- Legacy Question queues, request event handling, state, components, and tests, replaced by native Forms.
- The V1 message/delta buffer and periodic full-history event reload strategy, replaced by native events plus authoritative reconciliation.
- The duplicate Rust-native Tauri SSE transport, including batching, coalescing, cookie forwarding, pong handling, reconnect code, commands, managed state, and tests.
- The desktop native-event adapter made unnecessary by the shared browser `EventSource` path.
- Arbitrary whole-message deletion and local-only transcript mutation companions for operations not offered by the V2 beta protocol. Technical tool/reasoning cleanup now uses native `session.messageUpdate`.
- The server and UI dependency on `@opencode-ai/sdk` and the runtime V1 compatibility path.

## V1-to-V2 Capability Decisions

During stabilization, CodeNomad implements the public native V2 contract and removes V1 behavior that cannot be reproduced authoritatively. It does not depend on compatibility routes, private APIs, local-only transcript mutations, or a bundled OpenCode fork to simulate parity; inert legacy Question allowlist entries remain pending cleanup. Missing protocol capabilities are documented rather than proposed upstream until the V2 migration is complete and stable. The current V2 TUI is the minimum user-facing behavior reference where its workflow can be reproduced through the public contract; CodeNomad may add conveniences and product-specific capabilities beyond that baseline.

| Capability | Native V2 availability | CodeNomad decision | Revisit or complete when |
| --- | --- | --- | --- |
| Assistant content mutation | `session.messageUpdate` authoritatively replaces the text, reasoning, and tool content of a completed assistant message. There is still no generic deletion of a complete delivered message or mutation of user messages. | Restores individual tool/reasoning deletion through the native update route. Arbitrary whole-message deletion remains absent rather than locally simulated. | Add broader deletion only if V2 exposes an authoritative operation for the required message type. |
| Bulk tool and reasoning cleanup | No native bulk operation, but `session.messageUpdate` can safely compose cleanup one assistant message at a time. | Restores selected-group and full-session technical-part cleanup through authoritative per-message updates. | A native bulk operation is only needed if per-message updates become a measured performance problem. |
| Delete-to-boundary / undo | `session.revert.stage` and `session.revert.clear` use V2 staged-revert semantics instead of arbitrary deletion. | Command-palette Undo uses `revert.stage`; Redo clears the staged revert through `revert.clear`. | Revisit only if V2 adds broader authoritative transcript deletion. |
| Compaction | Native checkpoint compaction summarizes the older head and retains a server-selected recent tail controlled by `compaction.keep.tokens`. | Uses `session.compact`; there is no message-level selective compaction. CodeNomad displays the partial summary through the same reactive streaming path as text and reasoning, then replaces it with the terminal summary. | Add scoped controls only if V2 defines scoped compaction semantics. |
| Transcript pagination authority | Message pages expose only opaque previous/next cursors. They provide no transcript revision, total, absolute range, position, or random seek target. | Uses bounded cursor traversal and a 200-message resident window, with defensive reconciliation after destructive events. It cannot prove that pages loaded across compaction or revert belong to one snapshot. | V2 adds snapshot revision authority ([#43766](https://github.com/anomalyco/opencode/issues/43766)) and navigable position metadata ([#44660](https://github.com/anomalyco/opencode/issues/44660)). |
| Full-session search | `session.list(search)` filters session titles only. There is no server transcript-search endpoint returning message identity, excerpt, navigable position, and transcript revision. | Retained through exhaustive message-cursor traversal while keeping only the 200-message resident window and collected matches. Large searches still fetch every page. | V2 exposes transcript search ([#45801](https://github.com/anomalyco/opencode/issues/45801)) with a target that composes with transcript revision and seek metadata. |
| Queued prompt management | Native inbox list, cancel, steer, and queue operations cover authoritative follow-up delivery. The TUI's edit action removes a locally queued prompt before restoring it to the composer; it is not an atomic inbox update. | Implements a persisted primary `steer`/`queue` preference, inverse alternate shortcut, delivery switching, cancellation, cancel-first composer restoration with the structured payload retained, and native-order timeline projection. Earlier automatic replacement and reorder experiments were removed because they could change identity and position, duplicate prompts, or race with a concurrent drain. | Revisit atomic editing or reordering only if a concrete product need is established. |
| Background execution | Native `session.background` moves blocking tools out of the foreground; Shell resources separately support listing, bounded output, and removal. | Exposes `session.background` through the proxy and UI with `Ctrl/Cmd+B`, and replaces the custom process manager with native Shells. Unsupported controls such as rename remain removed. | Add controls only when the native session or Shell APIs support them. |
| Service lifecycle | V2 uses one shared externally owned service rather than one runtime per workspace. | CodeNomad discovers or starts the service. Stop Workspace evicts the native location after its final logical owner is removed; application shutdown never stops the daemon. | No parity work planned unless V2 changes service ownership semantics. |

This table is release-facing and must remain synchronized with the open migration pull request description whenever a capability is removed, restored, or becomes available in the current V2 client.

## Validation

At the 2026-08-28 migration gate (`878550ca`), UI and server typechecks, 86 focused UI tests, 64 focused server tests, the production UI/server build, Tauri `cargo check`, all 121 Rust tests, and `git diff --check` passed.

At the 2026-09-03 timeline stabilization head (`dea20996`):

- UI TypeScript typecheck passed.
- All 68 focused timeline, pagination, request-authority, and restore tests passed.
- The Tauri release build passed against the `beta-18999` lock; `beta-19059` validation is recorded with the final branch checks.
- Native Developer Mode validation observed in-place capped-window shifts with no remount or empty frame, same-cycle growth compensation, preserved manual escape, and inactive-tab anchor restoration within 0.3125 px.

At the 2026-09-04 `beta-19059` branch gate:

- The installed UI/server Promise client, protocol, schema, npm metadata, 119 paths, 140 operations, 229 schemas, and 136 Promise methods all resolve to `0.0.0-beta-19059`. The 22 beta publications from `beta-18230` through `beta-19059`, the 52 commits after `beta-18999`, generated declarations, OpenAPI snapshot, official repository head, and V2 documentation were reviewed; no later unpublished contract delta existed.
- UI, Electron, and server TypeScript typechecks passed. The pure UI suite passed 323 tests, the browser-runtime UI suite passed 148, and the server suite passed 373 with the two expected Windows skips.
- Desktop resource integrity passed 3 tests, the complete Electron native suite passed, and Tauri passed all 139 Rust tests serially. The 14 cross-host election tests also passed eight consecutive Windows runs after replacing the slow WMI process-identity probe with `Get-Process.StartTime` on both hosts.
- The production UI build and Tauri release/NSIS build passed. The rebuilt release was relaunched without stopping the shared OpenCode daemon.
- Native Developer Mode validation covered the `system` palette merge reset, the 14-color custom palette, notification anchoring/outside-click/`Escape` focus restoration, active-composer agent/model/thinking shortcuts, and the responsive/touch layout at `320x800`; document width remained 320 px, all five native menus remained available, and both drawers remained reachable.
- The independent compatibility runtime still reports `beta-18999`. It exercised the intentional authoritative-read fallback without an exact startup gate; updating that globally managed CLI to `beta-19059` remains independent of this client/build gate.

## Review Notes

- The generated V2 client remains experimental. Review its current documentation, installed declarations, proxy/API parity, runtime health, and `/api/plugin` failures whenever the beta contract changes. The SDK documentation describes an alternative embedded host; CodeNomad uses the network client.
- V1-style global plugins are outside the CodeNomad client migration. Under the reviewed V2 contract through `beta-19059`, the installed After Effects, Blender, Microsoft 365, Resolve, Unreal, Ponytail, and Gemini Auth integrations require independent migrations to a V2 definition with an `id` and `setup` or `effect`.
- Upgrade references: [OpenCode beta releases](https://github.com/anomalyco/opencode-beta/releases), [OpenCode V2 documentation](https://opencode.ai/v2/docs/), `packages/server/node_modules/@opencode-ai/client/dist/promise/`, and `packages/ui/node_modules/@opencode-ai/client/dist/promise/`.
