# OpenCode Desktop V2 Comparison

## Review Baseline

This review compares:

- CodeNomad `DEV-v2` at `44a1816b` (2026-09-04), merged with the worktree-session changes reviewed here.
- Published OpenCode V2 `beta-18999` at `887f319769c55718e3e64f64b32c9aafb13c5d66`, including an operation-by-operation and generated-declaration comparison from `beta-18684` at `106629aa118086be7def6123241a9bf056ba77b6`.
- CodeNomad declares `@opencode-ai/client@beta`; UI and server resolve `beta-18999`, the independently managed runtime CLI reports `beta-18999`, and the official V2 documentation is rooted at <https://opencode.ai/v2/docs/>.

The official reference is `packages/desktop` for the Electron host, `packages/app` for the shared UI, and the V2 client, protocol, schema, server, and core packages for wire behavior. Older `v2`, `opencode-2-0`, and intermediate `desktop-v2-*` branches are historical, not the current Desktop V2 reference.

This is an incremental review. It does not repeat issues already closed by CodeNomad parity commits including `4b96f462`, `4359b4bf`, `249a96e7`, `ef70a8b7`, `affdb96f`, `e1987b9c`, `5484f9c9`, `b5f3fc6e`, `2c9ced63`, and `db0464f7`.

## Result

CodeNomad implements the important V2 architecture rather than emulating the V1 desktop model. It uses the native client contract, locations, shared service, sessions, messages, Forms, permissions, providers, Shells, worktrees, and event stream. Its multi-window and cross-host restore implementation is broader than the official Electron-only desktop implementation.

The comparison and subsequent beta-contract audit found concrete CodeNomad defects in pagination, navigation, model projection, inbox delivery, follow behavior, background control, location selectors, and proxy route coverage. Those defects are fixed in the commits accompanying this document. The remaining differences are scoped workflow defects, release hardening, or optional Desktop features. None requires restoring V1 code or replacing native V2 cursors.

## Published Beta 18684 to 18999 Impact

The generated OpenAPI surface grows from 136 to 140 operations. It adds only `plugin.awaitActivation`, `plugin.check`, `plugin.update`, and `rpc.call`; it removes nothing and does not change the session, message, location, worktree, Shell, or PTY operation sets. Session pages retain the `{ data, cursor }` envelope, exclusive opaque cursors, and native ordering semantics.

- **Pagination:** all session continuations now send only the returned cursor. This includes UI inventory, worktree family transactions, proxy validation, and server-side Yolo restoration. Repeated-cursor and bounded-inventory checks remain where destructive worktree operations require a complete snapshot.
- **Locations:** OpenCode's unavailable-location change is official-app recovery UI, not an API change. CodeNomad preserves unavailable restored tabs and native session locations but does not weaken logical-workspace ownership to recover a session whose source is outside every owned root/worktree.
- **Moves:** session-aware execution and chained-move continuation improve the native server. CodeNomad still refuses worktree family moves while any member is active, serializes the project transaction, rechecks before each move, verifies the complete inventory, and rolls back on failure.
- **Events:** the client now isolates cancellation among consumers of its lazy shared stream, which CodeNomad inherits through `OpenCode.make()`. Typed `rpc.*` events require a native location and are routed only to owning logical workspaces. Raw `/api/event`, generic RPC calls, and plugin lifecycle mutations remain blocked by the workspace proxy.
- **PTY and Shell:** socket detach, post-exit drain, and fast-output fixes are runtime-only. CodeNomad inherits them without changing its HTTP proxy or introducing an embedded terminal; owned running PTYs, persistent PTYs, and Shells continue to block unsafe worktree deletion.
- **Generated types:** the new plugin state shape is safe because plugin IDs are narrowed before projection. The config update-policy rename is unused, provider/model canonical fields are additive, and native `SessionInfo.location`, `workspaceID`, and durable JSON `metadata` remain preserved.

## Closed Findings

### Message history pagination

**Previous behavior:** `packages/ui/src/stores/session-api.ts` sent both `order: "desc"` and `cursor` when loading older messages. The V2 server rejects that combination with `InvalidCursorError`, so transcripts longer than 200 messages could not load their older pages.

**Official behavior:** `packages/client/src/solid/data.ts` sends `order` only for the initial page and follows the opaque native cursor without another ordering selector. OpenCode fixed its own caller in `28b4cade9e`.

**Resolution:** CodeNomad now omits `order` on continuation requests and retains `cursor.next` as the sole pagination authority. A regression test rejects any cursor request that also includes `order`.

### External navigation schemes

**Previous behavior:** Electron treated every scheme except `file:`, `data:`, and `javascript:` as external. Tauri sent every rejected navigation to the privileged native opener. Renderer-controlled links could therefore invoke handlers such as `vscode:` or `ms-settings:`.

**Official behavior:** `packages/desktop/src/main/files/external-url.ts` permits only `http:`, `https:`, and `mailto:` external URLs.

**Resolution:** Both CodeNomad hosts now use the same scheme allowlist. Registered renderer origins still navigate internally; permitted web and mail links open externally; all other schemes are denied.

### Wildcard service endpoints

**Previous behavior:** CodeNomad rejected a healthy OpenCode service that advertised `0.0.0.0`, even though the CLI supports wildcard binding.

**Official behavior:** `packages/desktop/src/main/service/background-service.ts` connects to a wildcard-bound service through `127.0.0.1`.

**Resolution:** CodeNomad rewrites only the advertised wildcard hostname to loopback before authenticated health checks and client construction. Existing loopback URL strings retain their previous identity and formatting. Non-loopback remote addresses remain rejected.

### Failed plugin inventory

**Previous behavior:** Metadata projection called `startsWith` on every plugin ID. Current OpenCode V2 can report a failed plugin without an ID, which would break metadata refresh after a client upgrade.

**Official behavior:** `packages/schema/src/plugin.ts` defines active and failed plugin variants, with an optional ID for failures.

**Resolution:** CodeNomad now accepts only string IDs when projecting its current plugin-name list. An ID-less failed record can no longer prevent project, MCP, and plugin metadata from loading.

### Deprecated models

**Previous behavior:** CodeNomad discarded model status and exposed deprecated models in the selector.

**Official behavior:** `packages/app/src/context/global-sync/utils.ts` excludes models whose status is `deprecated`.

**Resolution:** Deprecated models are filtered while building the CodeNomad provider catalog. Active, alpha, beta, current default, and newly discovered models retain their existing behavior.

### Inactive Tauri asset configuration

`tauri.conf.json` declared an unrestricted asset protocol scope even though the asset protocol feature is disabled and CodeNomad has no asset URL caller. It was not an exploitable file-read path in the reviewed build, but the unused broad scope was misleading and unsafe if the feature were enabled later. The configuration block has been deleted.

### Native undo and redo

CodeNomad maps command-palette Undo to staged `session.revert.stage` semantics and exposes Redo through `session.revert.clear`. It intentionally does not recreate arbitrary local message deletion.

### Pending prompt correction

Pending inbox prompts expose delivery switching, removal, and editing. Editing first awaits authoritative `session.inbox.cancel`, then restores text, structured payload metadata, files, and agent references to the composer. This matches the safe native correction workflow without simulating an atomic inbox update.

### Bounded timeline continuity

The 200-message resident window distinguishes ordered capped-window slides from unsafe key changes. Ordered slides use Virtua's shift path and settle before paint; pagination, reorder, and non-aligned replacement remount with a fresh measurement epoch. A content-root `ResizeObserver` compensates followed growth in the same observer cycle, while explicit user scroll intent remains authoritative across remote updates and tab restore.

## Existing Parity

The review reconfirmed these areas and found no current incompatibility:

- Shared authenticated OpenCode service discovery and one daemon per host or WSL environment.
- Multiple logical CodeNomad workspaces over one native location, including duplicate-folder instances.
- Project-wide session inventory with directory scoping for native `global` projects, native session and message cursors, replace-in-place resident history windows, and ancestor hydration.
- Optimistic prompt admission with client-minted identity and authoritative event reconciliation.
- Native inbox queue/steer delivery with a persisted primary preference, inverse alternate shortcut, cancellation, cancel-first composer editing, and pending prompts ordered at the transcript tail.
- User-controlled follow state across older-page positioning, capped-window shifts, remote updates, and tab restore, with bottom pinning reserved for a local send.
- Native Forms, permissions, provider authentication, commands, agents, variants, attachments, and instructions.
- One upstream event stream with reconnect generation fencing and targeted authoritative refresh.
- Native `session.background` control plus background Shell listing, bounded output, removal, and ownership-checked Shell/PTY proxy routes.
- Root/worktree location ownership, physical-identity mutation fencing and session evacuation before worktree deletion, and WSL translation.
- Independent multi-window tabs and content-addressed restore state across Electron and Tauri.
- Strict proxy route allowlisting, traversal protection, validated native workspace selectors, authentication isolation, and location ownership checks.

Service stop removal is intentional: CodeNomad does not own the shared daemon. Upstream session sharing is disabled, so its absence is not a parity gap. Upstream's temporary SSE heartbeat change was reverted and requires no CodeNomad change.

## Remaining Correctness Work

### Active-location MCP and plugin status

**Priority:** Medium. **Client upgrade required:** No.

`packages/ui/src/lib/hooks/use-instance-metadata.ts` currently queries MCP and plugin state with the instance root. The active session may belong to a worktree or nested location with different `.opencode` configuration. Official Desktop derives the status location from the selected session in `packages/app/src/pages/session.tsx` and `status-popover-body.tsx`.

The CodeNomad metadata request and cache authority should be keyed by the active `SessionInfo.location`, and MCP toggles should use that same location. This needs a focused state change rather than a root fallback patch because switching tabs must not display or mutate another location's MCP state.

### Signed desktop releases

**Priority:** Medium. **Client upgrade required:** No.

The reviewed Windows release artifacts are not Authenticode-signed, and the macOS workflow does not establish a Developer ID and notarization identity. Official Desktop configures Windows signing and macOS signing/notarization in `packages/desktop/electron-builder.config.ts`.

This is distribution hardening rather than V2 API parity. Release jobs should fail unless Windows signatures, macOS identity, and notarization validate against the expected publisher.

## Beta Channel Policy

CodeNomad server and UI follow `@opencode-ai/client@beta`. The root workspace lock keeps each build reproducible after resolving that dependency; Electron selects npm optional dependencies for the requested OS/CPU target, while Tauri requires a completed root `npm ci --workspaces --include=optional` and never repairs dependencies during prebuild. The runtime CLI is managed independently, and startup validates its authenticated loopback health response without an exact version gate.

Generated types, proxy routes, events, plugin inventory, Forms, sessions, and real workspace behavior must be checked whenever the beta channel advances.

## Optional Feature Gaps

These are official Desktop capabilities, not migration blockers:

- **Interactive PTY UI:** CodeNomad proxies native PTY lifecycle routes but has no embedded terminal, connect-ticket WebSocket, resize, reconnect, or restore UI. The existing external terminal action and background Shell panel are not equivalent.
- **Session export:** Official Desktop paginates and exports a complete session. CodeNomad has no export command or allowlisted export route.
- **References and MCP resources:** Official prompt suggestions can attach configured references and MCP resources. CodeNomad's picker currently offers agents, files, and commands only.

Implement these when product scope requires them. They should use the existing native V2 APIs; no compatibility abstraction or V1 fallback is needed.

## Ponytail Cleanup

The same change removes dead migration-era code without changing persistence, restore, daemon ownership, or multi-window behavior:

- Unused client connection subscription records and notification machinery.
- Unread spawn classification and WSL metadata.
- One-element event type sets.
- Unread workspace creation state and parameters.
- Dead reasoning, preview, timeline, filesystem-event, preload, and render imports/helpers.
- Obsolete background Shell rename translations for a UI action that does not exist.
- Assigned-but-unread test request captures.

The implementation and tests finish at 109 added and 282 deleted lines, a net reduction of 173 lines.
