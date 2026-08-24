# OpenCode Desktop V2 Comparison

## Review Baseline

This review compares:

- CodeNomad `DEV-v2` at `f03a17a4`, plus the fixes recorded below.
- Official OpenCode Desktop V2 from `anomalyco/opencode` branch `upstream/v2` at `cc15c2a488` (2026-08-20).
- CodeNomad pins one reviewed `@opencode-ai/client` beta build; the managed CLI updater resolves the latest beta and installs that concrete version.

The official reference is `packages/desktop` for the Electron host, `packages/app` for the shared UI, and the V2 client, protocol, schema, server, and core packages for wire behavior. The old `upstream/opencode-2-0` branch and the intermediate `desktop-v2-*` branches are historical, not the current Desktop V2 reference.

This is an incremental review. It does not repeat issues already closed by CodeNomad parity commits including `4b96f462`, `4359b4bf`, `249a96e7`, `ef70a8b7`, `affdb96f`, `e1987b9c`, `5484f9c9`, `b5f3fc6e`, `2c9ced63`, and `db0464f7`.

## Result

CodeNomad implements the important V2 architecture rather than emulating the V1 desktop model. It uses the native client contract, locations, shared service, sessions, messages, Forms, permissions, providers, Shells, worktrees, and event stream. Its multi-window and cross-host restore implementation is broader than the official Electron-only desktop implementation.

The comparison found five concrete CodeNomad defects and one obsolete configuration block. All six are fixed in the commits accompanying this document. The remaining differences are either an SDK/runtime upgrade, a scoped workflow defect, release hardening, or optional Desktop features. None requires restoring V1 code or replacing native V2 cursors.

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

## Existing Parity

The review reconfirmed these areas and found no current incompatibility:

- Shared authenticated OpenCode service discovery and one daemon per host or WSL environment.
- Multiple logical CodeNomad workspaces over one native location, including duplicate-folder instances.
- Project-wide session inventory, native session and message cursors, lazy history, and ancestor hydration.
- Optimistic prompt admission with client-minted identity and authoritative event reconciliation.
- Native Forms, permissions, provider authentication, commands, agents, variants, attachments, and instructions.
- One upstream event stream with reconnect generation fencing and targeted authoritative refresh.
- Native background Shell listing/removal and ownership-checked Shell/PTY proxy routes.
- Root/worktree location ownership, session evacuation before worktree deletion, and WSL translation.
- Independent multi-window tabs and content-addressed restore state across Electron and Tauri.
- Strict proxy route allowlisting, traversal protection, selector stripping, authentication isolation, and location ownership checks.

Service stop removal is intentional: CodeNomad does not own the shared daemon. Upstream session sharing is disabled, so its absence is not a parity gap. Upstream's temporary SSE heartbeat change was reverted and requires no CodeNomad change.

## Remaining Correctness Work

### Active-location MCP and plugin status

**Priority:** Medium. **Client upgrade required:** No.

`packages/ui/src/lib/hooks/use-instance-metadata.ts` currently queries MCP and plugin state with the instance root. The active session may belong to a worktree or nested location with different `.opencode` configuration. Official Desktop derives the status location from the selected session in `packages/app/src/pages/session.tsx` and `status-popover-body.tsx`.

The CodeNomad metadata request and cache authority should be keyed by the active `SessionInfo.location`, and MCP toggles should use that same location. This needs a focused state change rather than a root fallback patch because switching tabs must not display or mutate another location's MCP state.

### Undo without redo

**Priority:** High. **Client upgrade required:** No.

CodeNomad exposes native `session.revert.stage` for undo but does not expose `session.revert.clear` for redo. Official Desktop implements both in `packages/app/src/pages/session/use-session-commands.tsx`. An accidental undo can therefore only be reversed indirectly; submitting another prompt commits the staged boundary.

Add a redo command that clears the staged revert and restores the prompt/viewport behavior. The proxy allowlist must admit only the matching native clear route.

### Signed desktop releases

**Priority:** Medium. **Client upgrade required:** No.

The reviewed Windows release artifacts are not Authenticode-signed, and the macOS workflow does not establish a Developer ID and notarization identity. Official Desktop configures Windows signing and macOS signing/notarization in `packages/desktop/electron-builder.config.ts`.

This is distribution hardening rather than V2 API parity. Release jobs should fail unless Windows signatures, macOS identity, and notarization validate against the expected publisher.

## Beta Channel Policy

CodeNomad pins the same reviewed `@opencode-ai/client` beta build in server and UI. The integrity-pinned root workspace lock is authoritative for CI and desktop server packaging; Electron selects npm optional dependencies for the requested OS/CPU target, while Tauri requires a completed root `npm ci --workspaces --include=optional` and never repairs dependencies during prebuild. The managed updater resolves the CLI beta channel for status checks, installs the concrete advertised version, and requires exact post-install version equality; startup still accepts another API-compatible CLI after authenticated validation.

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

## Validation

- Electron native suite: 158 passed.
- Tauri Rust suite: 104 passed.
- Focused server suites: 62 passed, plus 18 spawn tests after final cleanup.
- Focused UI suites: 22 passed, plus 2 filesystem tests after final cleanup.
- UI, Electron, and server TypeScript typechecks passed.
- UI production build passed.
- `cargo fmt --check` and `git diff --check` passed.
- Final independent diff review found no production correctness or security finding.
