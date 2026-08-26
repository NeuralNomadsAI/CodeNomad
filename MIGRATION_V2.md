# OpenCode V2 Migration

## Summary

This branch replaces CodeNomad's OpenCode V1 SDK, custom plugin, and per-workspace runtime architecture with the experimental native OpenCode V2 client and one shared OpenCode service. It intentionally provides no V1 runtime fallback.

The work grew beyond an SDK swap. It also introduces location-based ownership, native Forms and Shell resources, project-wide session pagination, reconnect reconciliation, bounded virtualized timelines, multi-window desktop state, and a content-addressed restore format.

Server and UI declare `@opencode-ai/client@beta`; the root lock currently resolves `0.0.0-beta-18219`. The selected `opencode2` CLI is managed independently: CodeNomad's updater resolves and installs the latest published CLI beta, while startup accepts another healthy CLI instead of enforcing an exact version.

The incremental comparison with official OpenCode Desktop V2, including closed findings and remaining gaps, is recorded in [`DESKTOP_V2_COMPARISON.md`](DESKTOP_V2_COMPARISON.md).

## Native V2 Adoption

- Use native locations and `SessionInfo.location` as the authority for workspace, session, file, event, Shell, PTY, and Git worktree ownership.
- Use native APIs for projects, sessions, messages, prompts, commands, models, agents, providers, MCP, permissions, Forms, files, VCS, instructions, Shells, and PTYs.
- Use native session lifecycle and output events, including `session.created`, `session.renamed`, `session.moved`, `session.status`, `session.idle`, `session.execution.*`, `session.compaction.*`, `session.text.*`, `session.reasoning.*`, and `session.tool.*`.
- Use `@opencode-ai/client/solid` `createData` for live message, tool, permission, and Form projection while preserving REST-loaded history and optimistic local sends.
- Replace the legacy Question request lifecycle with native Forms. Question tool output rendering and reviewed upstream compatibility routes remain where applicable.
- Replace shell-mode prompts with native `session.shell`.
- Replace CodeNomad background processes with native `shell.*` resources. The Status UI lists, displays bounded output for, and removes Shells; create/output/timeout routes remain available through the ownership-checked proxy. Interactive `pty.*` terminals remain separate.
- Store voice-mode instructions with `session.instructions.entry` and synchronize them before prompts, commands, and session Shell calls.

## Shared Service Model

- OpenCode V2 explicitly confirms that the intended architecture is [one shared process for all workspaces and clients](https://github.com/anomalyco/opencode/issues/43898#issuecomment-5372607267); workload slowdowns must be profiled and fixed within that topology rather than worked around with private servers.
- Replace one OpenCode runtime per workspace with one externally owned global service in the selected host or WSL environment.
- Discover or start it through the selected CLI's official `service status`, `service start`, and `service get password` commands.
- Accept only bounded, authenticated loopback health endpoints and pin one service identity while connected.
- Use OpenCode's standard service registration, state, and database. CodeNomad owns no private daemon port, database, registration, or PID.
- Pass configured startup environment variables and `NODE_EXTRA_CA_CERTS` only when starting a missing service. Strip legacy `OPENCODE_DB` and `XDG_STATE_HOME` overrides rather than taking ownership of OpenCode storage.
- Never stop the global daemon during CodeNomad shutdown. Backend shutdown clears only CodeNomad's cached connection and logical workspace state.
- Run the Linux CLI inside the selected WSL distribution and require Windows localhost forwarding. No cross-namespace PID fallback or process signaling remains.

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
- Treat events as volatile projections, not durable history. Internal stream generations and browser reconnects trigger targeted authoritative refreshes for workspaces, sessions, active state, pending permissions/Forms, loaded messages, catalogs, and invalidated file/config state.
- Preserve the Solid projection controller across reconnects and merge live records into REST history rather than clearing usable state.

## UI and Memory Optimizations

- Virtualize session lists and message timelines with `virtua` to bound mounted DOM for large histories.
- Preserve user-controlled scroll position, bottom-follow intent, oversized streaming hold points, and anchor-based restore across live updates.
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
2. Rejects new session mutations and drains already admitted mutations through their upstream response, failing closed if the bounded drain cannot complete.
3. Resolves the native project and inventories every session with native cursors.
4. Selects sessions whose native location belongs to the worktree.
5. Refuses deletion while affected sessions are active.
6. Moves affected sessions to the root location.
7. Re-inventories until the moves are authoritative.
8. Removes the Git worktree inside the same rollback boundary.
9. Restores moved sessions if verification or deletion fails.

Git status, diff, stage, unstage, commit, worktree creation, and worktree removal remain CodeNomad server operations where V2 does not provide equivalent transactional behavior.

## Proxy and Security Boundaries

- Expose only reviewed method/path pairs; new upstream APIs are unavailable until explicitly allowlisted.
- Verify workspace ownership for native locations, sessions, projects, cursors, Shell/PTY CWDs, imported session locations, and prompt file URIs before forwarding.
- Reject encoded path traversal, foreign locations/projects, forged cursors, and mismatched workspace selectors. Preserve validated native location workspace identities, including global Form headers, across the proxy.
- Translate host/WSL paths only after ownership validation.
- Strip CodeNomad cookies, browser authorization, forwarding headers, and incoming `x-opencode-*` headers; inject shared-service authentication server-side.
- Block upstream cookies and authentication challenges and avoid logging unredacted secret-bearing request bodies.
- Sandbox native SideCar/browser previews without `allow-same-origin`; native hosts do not inspect embedded cross-origin DOM.

## Desktop and Restore Restructuring

- Run one native singleton and one CodeNomad backend per channel/config profile. Stable, development, and non-default config identities use isolated singleton, browser-storage, backend, and client-state scopes.
- Focus the most-recent local window on a second launch unless `--new-window` is supplied.
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
- Message/part deletion controls and compatibility companions for operations not offered by the V2 beta protocol.
- The server and UI dependency on `@opencode-ai/sdk` and the runtime V1 compatibility path.

## V1-to-V2 Capability Decisions

During stabilization, CodeNomad implements the public native V2 contract and removes V1 behavior that cannot be reproduced authoritatively. It does not use compatibility routes, private APIs, local-only transcript mutations, or a bundled OpenCode fork to simulate parity. Missing protocol capabilities are documented rather than proposed upstream until the V2 migration is complete and stable.

| Capability | Native V2 availability | CodeNomad `DEV-v2` decision | Revisit or complete when |
| --- | --- | --- | --- |
| Individual message or part deletion | No public authoritative mutation for delivered transcript messages or parts. | Removed the V1 deletion controls. A local hide would not reduce future model context. | V2 exposes a supported mutation and verifies that subsequent model context reflects it. |
| Bulk tool and reasoning cleanup | No native bulk operation; it depends on authoritative part deletion. | Removed transcript deletion selection and the V1 tool-companion cleanup for reasoning and `step-finish` parts. | V2 provides a native bulk operation, or safe composition of authoritative individual mutations. |
| Delete-to-boundary / undo | `session.revert.stage` and `session.revert.clear` use V2 staged-revert semantics instead of arbitrary deletion. | Undo uses `revert.stage`. Redo/clear remains a CodeNomad UI gap, not a reason to restore V1 deletion. | Expose `revert.clear` through the existing native contract. |
| Compaction | Native checkpoint compaction summarizes the older head and retains a server-selected recent tail controlled by `compaction.keep.tokens`. | Uses `session.compact`; there is no message-level selective compaction. CodeNomad displays the partial summary through the same reactive streaming path as text and reasoning, then replaces it with the terminal summary. | Add scoped controls only if V2 defines scoped compaction semantics. |
| Full-session search | Native message cursors exist, but there is no server search endpoint that returns message identity and position. | Retained through bounded cursor traversal while keeping only the 200-message resident window and collected matches. Large searches still fetch every page. | V2 exposes server search plus a rank/cursor navigation target. |
| Queued prompt management | Native inbox list, cancel, steer, and queue operations are available. | Implements a persisted primary `steer`/`queue` preference, inverse alternate shortcut, delivery switching, cancellation with draft restoration, and ordered timeline projection. | Add in-place editing or reordering only when V2 exposes an atomic inbox mutation; neither is currently implemented. |
| Background execution | Native `session.background` moves blocking tools out of the foreground; Shell resources separately support listing, bounded output, and removal. | Exposes `session.background` through the proxy and UI with `Ctrl/Cmd+B`, and replaces the custom process manager with native Shells. Unsupported controls such as rename remain removed. | Add controls only when the native session or Shell APIs support them. |
| Service lifecycle | V2 uses one shared externally owned service rather than one runtime per workspace. | CodeNomad discovers or starts the service but never exposes workspace stop or stops the daemon on shutdown. | No parity work planned unless V2 changes service ownership semantics. |

This table is release-facing and must remain synchronized with the open migration pull request description whenever a capability is removed, restored, or becomes available in the current V2 client.

## Review Notes

- The generated V2 client remains experimental. Review its current documentation, installed declarations, and proxy/API parity whenever the beta contract changes. The SDK documentation describes an alternative embedded host; CodeNomad uses the network client.
- Upgrade references: [OpenCode releases](https://github.com/anomalyco/opencode/releases), [OpenCode V2 documentation](https://opencode.ai/v2/docs/), and `node_modules/@opencode-ai/client/dist/promise/`.
- This branch intentionally has no OpenCode V1 fallback or private OpenCode database.
