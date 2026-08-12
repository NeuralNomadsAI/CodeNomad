# OpenCode V2 Migration

## Summary

This branch migrates CodeNomad from the OpenCode V1 SDK and custom plugin architecture to the native OpenCode V2 client and shared service model.

The migration removes the V1 compatibility layer rather than maintaining both integrations. It substantially reduces custom runtime code and aligns CodeNomad with OpenCode's supported V2 APIs.

## Main Changes

- Replace `@opencode-ai/sdk` with the pinned native V2 client, `@opencode-ai/client@0.0.0-next-17288`.
- Use one shared OpenCode V2 service instead of one runtime per workspace.
- Represent CodeNomad workspaces as logical instances associated with absolute directories.
- Use native `Location` and `SessionInfo.location` data to associate sessions, files, events, and Git worktrees.
- Migrate sessions, messages, streaming events, permissions, questions, files, VCS, commands, MCP, providers, models, and agents to native V2 APIs.
- Handle native text, reasoning, tool, status, and terminal session events.
- Reconcile session state through `session.active()` after reconnecting so missed events do not leave stale working states.
- Route events from owned Git worktrees to their corresponding logical CodeNomad workspace.

## Removed Legacy Components

- Remove the custom `packages/opencode-plugin` package.
- Remove V1 plugin communication channels and per-workspace runtime management.
- Replace the custom background-process implementation with native V2 Shell and PTY APIs.
- Replace per-workspace OpenCode binary selection with one global `opencode2` binary.
- Remove message and part deletion controls because V2 currently has no equivalent API.
- Keep Git mutation operations on the CodeNomad server where V2 does not yet provide sufficient parity.

## Provider Authentication and Voice Mode

- Support native V2 API-key, OAuth, interactive form, and command-based provider authentication.
- Display required provider fields and submit answers in the native V2 format.
- Store voice-mode instructions through `session.instructions.entry`.
- Synchronize voice instructions before prompts, slash commands, and shell requests.

## Security and Service Lifecycle

- Restrict Shell and PTY working directories to workspace-owned roots and Git worktrees.
- Remove CodeNomad authentication cookies before forwarding requests to OpenCode.
- Prevent OpenCode `Set-Cookie` headers from being relayed to the browser.
- Avoid logging unredacted secret-bearing proxy request bodies.
- Share a consistent service registration location between Windows and WSL.
- Stop a shared service only when CodeNomad can prove that its own process started it.

## Expected Benefits

- Less custom integration code and fewer long-running processes.
- Closer alignment with the supported OpenCode V2 architecture.
- Native access to future OpenCode functionality without maintaining V1 compatibility code.
- Consistent behavior between root workspaces and Git worktrees.
- Simpler service startup, event handling, and client-side API access.

## Current Status

- Server and UI typechecks pass.
- Focused tests for service ownership, proxy security, worktree event routing, provider authentication, and voice instructions pass.
- UI tests and builds passed earlier in the migration.
- A real service smoke test is blocked because `opencode2` is not installed in the current `PATH`.
- The migration is not merge-ready yet. The final security review found unresolved proxy isolation issues that must be fixed first.

## Remaining Work

- Fix the encoded-path proxy issue that can redirect an authenticated upstream request to another host.
- Restrict or filter global V2 endpoints that are not scoped by `Location`.
- Enforce session ownership for experimental session log routes.
- Validate embedded locations when importing sessions.
- Harden shared service registration and multi-process shutdown behavior.
- Complete the remaining high-priority event and provider-auth security fixes.
- Run the complete test and build matrix after the fixes.
- Run an end-to-end smoke test with the actual `opencode2` binary.

## Validation

The final validation should include:

- Server and UI typechecks.
- Server and UI test suites.
- Server and UI production builds.
- Electron native tests and typecheck when its local dependencies are available.
- `git diff --check`.
- A real OpenCode V2 startup, session, event, Shell, and shutdown smoke test.

## Review Notes

- The OpenCode V2 client is still a beta contract and may change.
- This branch intentionally provides no OpenCode V1 fallback.
- The branch should remain a Draft Pull Request until the security findings and real-service smoke test are complete.
