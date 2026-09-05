# OpenCode Desktop V2 Comparison

## Review Baseline

This review compares:

- CodeNomad `feat/ui-harmonization` after the `733f5bf9` merge of `DEV-v2` (2026-09-04).
- The initial official OpenCode Desktop V2 baseline at `eb1ac54d73` (2026-08-25), which produced `beta-18230`.
- The latest published OpenCode V2 beta source at `c9d240704d6eefc88b63a1eca2cb933b3eb70ed3` (2026-09-04), which produced `beta-19059`.
- The matching `upstream/beta` head, with no later unpublished contract delta at review time.

CodeNomad declares `@opencode-ai/client@beta`; UI and server resolve `beta-19059`. The independently managed runtime used to verify the compatibility fallback still reports `beta-18999`; startup intentionally has no exact client/runtime version gate.

The official reference is `packages/desktop` for the Electron host, `packages/app` for the shared UI, and the V2 client, protocol, schema, server, and core packages for wire behavior. Older `v2`, `opencode-2-0`, and intermediate `desktop-v2-*` branches are historical, not the current Desktop V2 reference.

This is an incremental review. It does not repeat issues already closed by CodeNomad parity commits including `4b96f462`, `4359b4bf`, `249a96e7`, `ef70a8b7`, `affdb96f`, `e1987b9c`, `5484f9c9`, `b5f3fc6e`, `2c9ced63`, and `db0464f7`.

## Result

CodeNomad implements the important V2 architecture rather than emulating the V1 desktop model. It uses the native client contract, locations, shared service, sessions, messages, Forms, permissions, providers, Shells, worktrees, and event stream. Its multi-window and cross-host restore implementation is broader than the official Electron-only desktop implementation.

The comparison and subsequent beta-contract audit found concrete CodeNomad defects in pagination, navigation, model projection, inbox delivery, follow behavior, background control, location selectors, plugin readiness, event handling, durable metadata, and proxy route coverage. The accompanying changes close the published-contract defects. The remaining differences are release hardening and optional Desktop workflows. None requires restoring V1 code or replacing native V2 cursors.

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

**Previous behavior:** Metadata projection first assumed every plugin had an ID, then accepted every string ID as active. The current contract permits failed plugins both with and without an ID, so a named failure could be displayed with the same healthy indicator as an active plugin.

**Official behavior:** `PluginInfo` has an optional `id` and a required `state` discriminator whose status is `active` or `failed`.

**Resolution:** CodeNomad projects only non-builtin plugins with a string ID and `state.status === "active"`. Failed records remain available in the native inventory but are no longer represented as healthy in the legacy name-only status list.

### Asynchronous plugin activation

**Previous behavior:** Initial agent, provider, model, command, and plugin reads could run while a Location's configured plugins were still installing or activating. CodeNomad could therefore retain a transiently incomplete catalog until another event forced a refresh.

**Official behavior:** `beta-18999` adds `POST /api/plugin/await-activation`; the official ACP client waits on it before caching a Location catalog. OpenCode also replaces `plugin.added` with the settled `plugin.updated` event.

**Resolution:** The proxy exposes only the non-mutating activation wait, catalog and plugin-status reads wait for it, concurrent waits for one client and Location coalesce, and an unsupported lagging runtime falls back to authoritative reads. `plugin.updated` now refreshes agents, providers, commands, and metadata; the obsolete `plugin.added` branch is removed. `plugin.check`, `plugin.update`, and generic plugin RPC remain blocked.

### Active-location MCP and plugin status

**Previous behavior:** Metadata requests and their loaded-state check used the instance root even when the selected session belonged to a worktree with different `.opencode` configuration.

**Official behavior:** Location-scoped status follows the selected session, and request inputs encode native `workspaceID` values as the wire-level `location[workspace]` selector.

**Resolution:** MCP, plugin activation, and plugin inventory reads now use the active `SessionInfo.location`; metadata readiness is keyed by the location returned from MCP; session switches trigger a new status load; and MCP toggles continue to use that same returned location. Replaced clients and superseded locations cannot commit stale metadata.

### Filesystem list ownership

**Previous behavior:** The proxy authorized the native Location for `fs.list` but did not separately authorize its `path` query. The official contract permits an absolute path or traversal to parents and siblings, so a workspace-scoped caller could ask the shared daemon to list an unrelated directory.

**Official behavior:** `fs.list` keeps the requested Location while resolving its optional path independently; returned entry paths remain relative to that Location.

**Resolution:** CodeNomad resolves relative targets against the authorized Location, rejects duplicate path selectors and targets outside owned worktrees, and translates accepted paths into the shared service namespace for WSL. Parent and sibling browsing remains possible only inside owned worktrees.

### Durable session and message additions

**Previous behavior:** The local session adapter reconstructed `SessionInfo` without its durable JSON `metadata`, `session.created` also dropped that metadata, and the local message-info time shape omitted the new `streamed` boundary. A recovered `session.step.streamed` event alone did not mark an idle local session as working.

**Official behavior:** Published V2 sessions carry optional `SessionMetadata`; assistant messages carry `time.streamed`; `session.step.streamed` and `session.message.content.updated` are native durable events reduced by `@opencode-ai/client/solid`.

**Resolution:** REST and event session projections retain metadata, message projection retains streamed time, a streamed step restores working status after an event gap, and focused tests verify authoritative assistant-content replacement through the generated Solid reducer.

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

## Latest Published Beta Audit

The official `anomalyco/opencode-beta` repository published 22 beta tags from `beta-18230` through `beta-19059`. Their GitHub release bodies are empty, so there are no prose release notes to review. This audit instead matched every successful publish workflow to its source commit, read the intervening official commits, compared npm artifacts and generated declarations, and checked the official V2 documentation index and relevant API/client pages.

The final refresh is exact:

- `beta-18866` was built from `519cd8c7712fc2ca6d2ca1d356d7f52cbd6d5808`.
- `beta-18999` was built from `887f319769c55718e3e64f64b32c9aafb13c5d66`.
- `beta-19059` was built from `c9d240704d6eefc88b63a1eca2cb933b3eb70ed3`.
- The ranges contain 114 commits from `beta-18866` to `beta-18999`, then 52 commits to `beta-19059`.
- The Promise client remains at 136 routes instead of 135: the only added route is `POST /api/plugin/await-activation`.
- The only added exported types are `PluginAwaitActivationInput` and `PluginAwaitActivationOutput`; `PluginAdded` is removed.
- `V2Event` removes `plugin.added`; `ConfigEntry.autoupdate?: boolean | "notify"` first becomes `update?: "disable" | "notify" | "auto"`, then `beta-19059` removes the `"auto"` value.
- `beta-19059` adds optional compaction `model` and `providerState`, the command-config `subagent` flag, and guarded Solid event refreshes with `onError`; it adds no route or exported type name.

CodeNomad consumes the activation boundary and current event/state shapes, preserves the new compaction metadata, logs bounded Solid refresh failures, authorizes the independently resolved filesystem-list target, and avoids falsely marking a parent busy when a command may spawn a background subagent. It has no OpenCode update-setting caller to migrate. Runtime-side fixes—plugin activation stability, session-entry readiness, configuration and symlink watching, abandoned-compaction settlement, provider identity/state preservation, Location retry, command-subagent backgrounding, and Windows interruption—are acquired from the independently updated OpenCode runtime rather than duplicated in CodeNomad. Official App/Desktop/TUI-only navigation, styling, terminal-pane, timeline-detail, and plugin-dialog changes were reviewed as product references, not treated as wire requirements.

### Beta 19059 delta

The previously failed publish was rerun successfully on 2026-09-04. The OpenAPI remains at 119 paths, 140 operations, and 229 schemas. The generated Promise surface remains at 136 methods. The full declaration delta from `beta-18999` is the optional compaction model/provider state, command-config `subagent` plus deprecated `subtask`, and removal of the `"auto"` update mode; the Solid helper separately adds connection/disposal guards and `onError` for event-triggered reads.

All 52 intervening commits were classified. Core and client correctness fixes flow through the upgraded client or independently updated runtime. The now-published official Desktop session-import action remains an optional CodeNomad product workflow because the ownership-validated native import route already exists without requiring UI parity. At review time `upstream/beta` points to the same source commit, so there is no unpublished head to represent as shipped behavior.

## Remaining Correctness Work

### Signed desktop releases

**Priority:** Medium. **Client upgrade required:** No.

The reviewed Windows release artifacts are not Authenticode-signed, and the macOS workflow does not establish a Developer ID and notarization identity. Official Desktop configures Windows signing and macOS signing/notarization in `packages/desktop/electron-builder.config.ts`.

This is distribution hardening rather than V2 API parity. Release jobs should fail unless Windows signatures, macOS identity, and notarization validate against the expected publisher.

## Beta Channel Policy

CodeNomad server and UI follow `@opencode-ai/client@beta`. The root workspace lock keeps each build reproducible after resolving that dependency; Electron selects npm optional dependencies for the requested OS/CPU target, while Tauri requires a completed root `npm ci --workspaces --include=optional` and never repairs dependencies during prebuild. The runtime CLI is managed independently, and startup validates its authenticated loopback health response without an exact version gate.

Generated types, proxy routes, events, plugin inventory, Forms, sessions, and real workspace behavior must be checked whenever the beta channel advances.

## Optional Feature Gaps

These are official Desktop or published native V2 capabilities, not migration blockers:

- **Interactive and persistent PTY UI:** CodeNomad proxies standard PTY lifecycle routes but has no embedded terminal, connect-ticket WebSocket, resize, reconnect, or restore UI. Published `experimental.persistentPty.*` session-terminal routes remain blocked because CodeNomad has no corresponding ownership lifecycle. The external terminal action and background Shell panel are not equivalent.
- **Session transfer UI:** The ownership-validated `session.import` route is allowlisted, but CodeNomad has no import action. Official Desktop now ships an import action and paginates before exporting a complete session; CodeNomad has no export command or allowlisted export route.
- **Native session analytics:** `session.stats` can provide server-side activity, model, token, and tool aggregates. CodeNomad has per-session usage presentation but no native statistics dashboard or allowlisted stats route.
- **Plugin package management:** `plugin.check` and `plugin.update` are not exposed. A future inventory UI can add the read-like check, while executable package updates require an explicit trusted confirmation and mutation policy.
- **Plugin diagnostics and capabilities:** The current status panel projects active non-builtin plugin names. It does not yet expose failed-plugin errors, sources, update state, or `PluginFeatures`; those require a richer typed inventory UI rather than treating failures as healthy names.
- **Typed plugin RPC:** Generic RPC remains blocked until CodeNomad intentionally installs a reviewed plugin contract and can authorize each method; exposing the wildcard endpoint would bypass the proxy's narrow capability model.
- **Review-base and non-Git diffs:** Published `vcs.base` plus committed/base diff inputs can support branch review and arbitrary VCS backends. CodeNomad currently keeps its validated Git status, diff, stage, unstage, and commit boundary.
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
