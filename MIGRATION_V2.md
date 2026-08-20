# OpenCode V2 Migration

## Summary

This branch replaces CodeNomad's OpenCode V1 SDK, custom plugin, and per-workspace runtime architecture with the experimental native OpenCode V2 client and one shared OpenCode service. It intentionally provides no V1 runtime fallback.

The work grew beyond an SDK swap. It also introduces location-based ownership, native Forms and Shell resources, project-wide session pagination, reconnect reconciliation, bounded virtualized timelines, multi-window desktop state, and a content-addressed restore format.

Server and UI pin `@opencode-ai/client` to `0.0.0-beta-17595`. The selected `opencode2` CLI is managed independently: CodeNomad's updater targets the reviewed client-compatible release, but startup accepts another compatible CLI after authenticated health and API validation instead of enforcing an exact version.

## Native V2 Adoption

- Use native locations and `SessionInfo.location` as the authority for workspace, session, file, event, Shell, PTY, and Git worktree ownership.
- Use native APIs for projects, sessions, messages, prompts, commands, models, agents, providers, MCP, permissions, Forms, files, VCS, instructions, Shells, and PTYs.
- Use native session lifecycle and output events, including `session.created`, `session.renamed`, `session.moved`, `session.status`, `session.idle`, `session.execution.*`, `session.compaction.*`, `session.text.*`, `session.reasoning.*`, and `session.tool.*`.
- Use `@opencode-ai/client/solid` `createData` for live message, tool, permission, and Form projection while preserving REST-loaded history and optimistic local sends.
- Replace the legacy Question request lifecycle with native Forms. Question tool output rendering and reviewed upstream compatibility routes remain where applicable.
- Replace shell-mode prompts with native `session.shell`.
- Replace CodeNomad background processes with native `shell.*` resources. The Status UI lists and removes Shells; create/output/timeout routes remain available through the ownership-checked proxy. Interactive `pty.*` terminals remain separate.
- Store voice-mode instructions with `session.instructions.entry` and synchronize them before prompts, commands, and session Shell calls.

## Shared Service Model

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

- Query a complete project-scoped session inventory across root and worktree subpaths without one request per parent.
- Follow native `cursor.next` values for session and message pagination. The proxy decodes session cursors only to validate embedded directory/project scope, strips competing selectors, and forwards the original cursor unchanged.
- Hydrate only missing ancestor chains with `session.get` and fetch active status for later session pages.
- Load message history lazily in native pages, prepend older pages without duplicate IDs, and reject delayed REST responses that would overwrite newer event state.
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

## Forms, Permissions, and Providers

- Merge pending permissions and Forms into one ordered interruption UI while preserving their separate native reply/cancel APIs.
- Reconcile pending requests from every owned root/worktree location after reconnect and remove stale local requests only from authoritative results.
- Carry location for global Forms through the proxy without inventing a synthetic session.
- Support native provider API-key, OAuth, command, and interactive Form authentication, including dynamic required fields and custom choices.
- Keep Yolo policy server-owned: persist enabled session families, inherit policy across descendants, deduplicate duplicate-instance delivery by permission ID, retry within a fixed bound, and synchronize state to every window.

## Worktree Safety

Before deleting a Git worktree, CodeNomad now:

1. Resolves the native project and inventories every session with native cursors.
2. Selects sessions whose native location belongs to the worktree.
3. Refuses deletion while affected sessions are active.
4. Moves affected sessions to the root location.
5. Re-inventories until the moves are authoritative.
6. Removes the Git worktree inside the same rollback boundary.
7. Restores moved sessions if verification or deletion fails.

Git status, diff, stage, unstage, commit, worktree creation, and worktree removal remain CodeNomad server operations where V2 does not provide equivalent transactional behavior.

## Proxy and Security Boundaries

- Expose only reviewed method/path pairs; new upstream APIs are unavailable until explicitly allowlisted.
- Verify workspace ownership for native locations, sessions, projects, cursors, Shell/PTY CWDs, imported session locations, and prompt file URIs before forwarding.
- Reject encoded path traversal, foreign locations/projects, forged cursors, and browser-supplied workspace selectors.
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

## Removed Legacy Architecture

The migration deletes rather than maintains these superseded systems:

- The complete `packages/opencode-plugin` package, its packaging script, desktop resources, setup hooks, environment plumbing, and plugin README.
- Plugin POST/SSE channels, handlers, voice synchronization routes, and the custom plugin-to-CodeNomad event bridge.
- Per-workspace OpenCode runtime processes, loopback servers, clients, authentication, binary selection, launch cleanup, process identity, process-tree signaling, and runtime tests.
- The `.codenomad/worktreeMap.json` mapping layer and UI-side OpenCode workspace/worktree-client matching.
- The custom background-process manager, persistence, HTTP routes, UI store, and output dialog.
- Legacy Question queues, request event handling, state, components, and tests, replaced by native Forms.
- The V1 message/delta buffer and periodic full-history event reload strategy, replaced by native events plus authoritative reconciliation.
- The duplicate Rust-native Tauri SSE transport, including batching, coalescing, cookie forwarding, pong handling, reconnect code, commands, managed state, and tests.
- The desktop native-event adapter made unnecessary by the shared browser `EventSource` path.
- Message/part deletion controls and compatibility companions for operations not offered by the pinned V2 protocol.
- The server and UI dependency on `@opencode-ai/sdk` and the runtime V1 compatibility path.

## Validation

At `DEV-v2@8fe238f5`:

- GitHub PR checks pass for the repository test job, Windows Tauri tests, Electron builds on Linux/macOS/Windows, and Tauri builds on supported Linux/macOS/Windows targets. Linux ARM64 Tauri is intentionally skipped by the workflow.
- The latest workspace/tab fixes pass the complete server suite (about 265 tests), targeted tab/restore tests, server and UI typechecks, 18 focused UI tests, and the production UI build.
- Earlier migration gates also passed Electron native tests, Tauri tests/checks, production desktop builds, and packaged Windows singleton/multi-window smoke coverage.
- `git diff --check` passes.

The remaining release gate is a final interactive smoke against the selected real OpenCode service: open a folder, open an existing session, send and receive a prompt, reload and restore it, exercise the background Shell proxy lifecycle, and verify that V1 and V2 can remain open without client-state interference.

## Review Notes

- The generated V2 client remains experimental. Review its installed declarations and release notes on every dependency upgrade; public `@opencode-ai/sdk` examples are not authoritative for this branch.
- Upgrade references: [OpenCode releases](https://github.com/anomalyco/opencode/releases), [OpenCode documentation](https://opencode.ai/docs/), and `node_modules/@opencode-ai/client/dist/promise/`.
- This branch intentionally has no OpenCode V1 fallback or private OpenCode database.
