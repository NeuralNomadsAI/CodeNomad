# OpenCode V2 Migration

## Summary

This branch migrates CodeNomad from the OpenCode V1 SDK and custom plugin architecture to the native OpenCode V2 client and shared service model.

The migration removes the V1 compatibility layer rather than maintaining both integrations. It substantially reduces custom runtime code and aligns CodeNomad with OpenCode's supported V2 APIs.

## Main Changes

- Replace `@opencode-ai/sdk` with the experimental `@opencode-ai/client` protocol, pinned exactly to `0.0.0-next-17353`. This contract is distinct from the current public `@opencode-ai/sdk` documentation.
- Use one shared OpenCode V2 service instead of one runtime per workspace.
- Represent CodeNomad workspaces as logical instances associated with absolute directories.
- Use native `Location` and `SessionInfo.location` data to associate sessions, files, events, and Git worktrees.
- Migrate sessions, messages, streaming events, permissions, questions, files, VCS, commands, MCP, providers, models, and agents to native V2 APIs.
- Handle native session lifecycle and output events, including `session.created`, `session.renamed`, `session.moved`, `session.status`, `session.idle`, `session.execution.*`, `session.compaction.*`, `session.text.*`, `session.reasoning.*`, and `session.tool.*`.
- Use browser `EventSource` as the single desktop and web event transport; the duplicate Rust-native Tauri transport was removed.
- Treat the native event stream as volatile. Reconnect has no replay guarantee, so clients must reconcile authoritative session and pending-request state after reconnect; file/config consumers must also refetch rather than assume every `filesystem.changed` or `config.updated` event was observed.
- Route events from owned Git worktrees to their corresponding logical CodeNomad workspace.
- Query native sessions for every known root and worktree directory instead of relying on an unsupported project-scope parameter.
- Resolve locationless session events through native session ownership so prompt status and output reach the correct logical workspace.

## Removed Legacy Components

- Remove the custom `packages/opencode-plugin` package.
- Remove V1 plugin communication channels and per-workspace runtime management.
- Replace interactive shell-mode requests with native V2 Shell and expose native V2 PTYs in the Status panel.
- Replace per-workspace OpenCode binary selection with one global `opencode2` binary.
- Migrate the persisted V1 default command `opencode` to `opencode2` during workspace launch.
- Remove message and part deletion controls because V2 currently has no equivalent API.
- Keep Git mutation operations on the CodeNomad server where V2 does not yet provide sufficient parity.

## Provider Authentication and Voice Mode

- Support native V2 API-key, OAuth, interactive form, and command-based provider authentication.
- Display required provider fields and submit answers in the native V2 format.
- Store voice-mode instructions through `session.instructions.entry`.
- Synchronize voice instructions before prompts, slash commands, and shell requests.

## Security and Service Lifecycle

- Restrict proxied Shell and PTY working directories to workspace-owned roots and Git worktrees; PTY controls also verify the native PTY `cwd` before forwarding ID-scoped requests.
- Remove CodeNomad authentication cookies before forwarding requests to OpenCode.
- Prevent OpenCode `Set-Cookie` headers from being relayed to the browser.
- Avoid logging unredacted secret-bearing proxy request bodies.
- Expose only an explicit method/path allowlist through the OpenCode proxy. New upstream APIs require an intentional proxy and ownership review; future OpenCode functionality is not automatic.
- Share a consistent service registration location between Windows and WSL.
- Require the shared service to match the pinned `0.0.0-next-17353` version.
- Use CodeNomad's hardened discovery/launch lifecycle in production rather than direct `Service.ensure`/`Service.stop` calls. A lifecycle lease records the registration, authenticated endpoint, daemon PID plus process-start identity and host/WSL namespace, and a hash of the launch command/environment/version. Proof can transfer between live CodeNomad processes through peer leases; the final process stops the daemon only after proving there are no live peers and every recorded identity still matches.
- Queue location eviction when its final logical owner is removed, then perform it only during proven final shared-service shutdown so another CodeNomad process cannot lose active upstream state.
- Require the user to configure a non-empty `OPENCODE_DB` before V2 service startup. CodeNomad supplies no default path, and V1 and V2 must never point at the same database because their schemas are incompatible. Environment changes apply when the shared service next starts or restarts, not to an already-running daemon.
- Isolate V2 restore state under `~/.codenomad/client-state/v2` and copy V1 state non-destructively on first launch, preserving downgrade history.

## Expected Benefits

- Less custom integration code and fewer long-running processes.
- Closer alignment with the supported OpenCode V2 architecture.
- A smaller native integration surface without maintaining V1 compatibility code.
- Consistent behavior between root workspaces and Git worktrees.
- Simpler service startup, event handling, and client-side API access.

## Current Status

- The server/UI client dependency and required `opencode2` protocol baseline are pinned to `0.0.0-next-17353`.
- The current working tree includes hardened lifecycle proof, launch-configuration matching, required `OPENCODE_DB` validation, deferred location eviction, proxy path/location validation, and reconnect reconciliation changes.
- Native PTY V1 parity is limited by `@opencode-ai/client@0.0.0-next-17353`: it provides list/get/title-or-size update/remove and PTY lifecycle events, but no output/read/stream API and no separate stop API. Removing a running PTY is therefore the only native stop action, and PTY output is not displayed.
- The migration remains a Draft. The full validation matrix and a real current-tree OpenCode V2 startup/session/event/Shell/shutdown smoke test are not yet recorded complete.

## Remaining Work

- Run the complete test and build matrix after the fixes.
- Run the real-service smoke test before marking the PR ready for review.

## Validation

The final validation should include:

- Server and UI typechecks.
- Server and UI test suites.
- Server and UI production builds.
- Electron native tests and typecheck when its local dependencies are available.
- `git diff --check`.
- A real OpenCode V2 startup, session, event, Shell, and shutdown smoke test.

## Review Notes

- The pinned OpenCode V2 protocol client is experimental and may change; public `@opencode-ai/sdk` examples are not authoritative for this build.
- This branch intentionally provides no OpenCode V1 fallback.
- The branch should remain a Draft Pull Request until gatekeeper review, the validation matrix, and the real-service smoke test are complete.
