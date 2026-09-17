# Worktrees and conversation placement

## Shared model, explicit user choice

OpenCode's native session location is both an execution context and the source of
truth for CodeNomad's session projection. The concepts are related, but distinct:

| Concept | Meaning |
| --- | --- |
| Git worktree | A checkout with its own branch and working files. |
| Native project | Repository identity; more than one checkout, and even separate clones, can share it. It is not sufficient to authorize a directory. |
| Native session location | The session's execution context. It determines location-scoped services, defaults and native movement events. |
| CodeNomad workspace/instance | The folder opened by the user, its authorized locations, and their UI projection. Several tabs can open the same folder. |
| Tool working directory | A directory selected for one operation. It does not inherently move the conversation. |

The integration does not require two competing session locations. CodeNomad keeps
native authority, while communicating when the user authorizes changing it:

- Creating a worktree or implementing/testing code there preserves the conversation's attachment.
- An explicit request to move or reattach the conversation authorizes a native move.
- An explicit UI worktree selection uses CodeNomad's transactional family move.
- A native move is reflected faithfully, including one initiated outside CodeNomad.
- A confirmed explicit move becomes the new attachment to preserve.

Keeping the session attached means its default tools, catalogs and plugins remain
location-scoped to that attachment. The agent must use absolute paths/`workdir`
for work elsewhere and read the instructions applicable to the target files.
Changing every location-scoped service requires an explicit native move; a shell
working-directory override does not do that.

## Why an instruction belongs in PR #649

The native `opencode.tools` plugin adds this general guidance through its session
context hook:

> When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.

This is core runtime behavior, not a TUI-only instruction. It is reasonable for
an execution-oriented workflow, but working in a checkout is not implicit consent
to reorganize a CodeNomad conversation. The mismatch is in the default interaction
policy, rather than evidence that the underlying worktree models are incompatible.

`packages/ui/src/stores/session-instructions.ts` supplies the named native entry
`codenomad.session-placement`. It explicitly distinguishes working elsewhere from
moving the conversation and qualifies the generic upstream recommendation.

The action admission path awaits synchronization before every prompt (including
queued/restored prompts), slash command and session shell command. Existing
sessions receive it on their next submission, as do newly created sessions on
their first submission. This is not a background migration of every stored session
or an intervention in an already-running turn initiated by another client.

The entry uses the user's current choice rather than an embedded initial path,
survives independently of the voice-mode entry, and is reapplied without a
browser-only success cache. A failed write propagates through the existing action
failure path. Other instruction keys and session metadata are not replaced.

This is model guidance, not a runtime permission. The inspected native tool calls
`ctx.session.move` directly, outside the CodeNomad HTTP proxy. Enforcing a distinct
agent-vs-user movement policy would require a supported native runtime control;
blocking the proxy would not provide that guarantee. A tool-initiated native move
also does not become CodeNomad's multi-session family transaction merely because
the instruction is present.

## Windows spelling observation (2026-09-17)

During this review, the shared runtime stored the conversation's location as
`D:\codenomad`, while the open workspace used `D:\CodeNomad`. Native location
resolution returned the same project ID for both spellings. However, native
`session.list` with `directory=D:\CodeNomad` and a matching title search returned
no session; the same request with `directory=D:\codenomad` returned it. Moving
the session to the exact open-folder spelling restored that native list result.

This is independent of the placement instruction: preserving user intent cannot
fix an exact-string directory filter. Do not claim that this PR fixes native path
canonicalization, lowercase paths globally (including case-sensitive hosts), or
broaden project authority to hide this discrepancy. When diagnosing an absent
conversation, compare `session.get`, the actual directory-scoped list and the
authorized workspace spelling before changing UI state.

## Evidence and regression coverage

- [Official V2 API](https://opencode.ai/v2/docs/api/): native session moves, instructions and locations.
- [V2 plugin context](https://opencode.ai/v2/docs/build/plugins/): location-scoped plugin context and session APIs.
- Native source inspected at `f91c6d8b25a040cc952db0c43fc5352bcab7f42d`:
  `packages/core/src/tool/plugin/opencode.ts`, `session/move.ts`,
  `session/instruction-entry.ts`, and `project.ts`. This is a source reference,
  not an assertion that every supported runtime has identical internals.
- Client contract: the declarations pinned by this branch (`@opencode/client@2.0.4`).
- `session-actions.test.ts`: command/shell ordering, voice-mode changes during
  synchronization, and delayed placement failures before prompt/command/shell.
- `session-send-lifecycle.test.ts`: prompt ordering, repair on existing sessions,
  preservation of other named entries and a new native attachment, optimistic sends.
- Existing native-move, restored-session and worktree-family tests continue to
  cover reconciliation and transactional movement; model obedience is not a test assertion.
