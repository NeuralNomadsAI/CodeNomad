# Worktrees and conversation placement

## Product/Git contract

- A Git worktree is a physical checkout with its own HEAD, index and working
  files. Branch refs and the object database are shared with its local repository.
  Sessions are not Git objects; multiple sessions can use one worktree.
- Selecting a session's worktree changes its native execution location. It does
  not run `git switch`, move the checkout, copy uncommitted files, merge branches,
  or create another conversation. Moving within the local repository keeps the
  conversation visible in its CodeNomad project.
- Creation and session movement are separate operations. The existing selector's
  create action performs both and is labelled "Create and use worktree".
  Agent creation alone must not be confused with a request to continue the session
  there. Explicit instructions to preserve the current session location prevail.
- Preserve the CodeNomad default parent `<local main checkout>/.codenomad/worktrees`
  for new worktrees. This is a storage convention, not the definition of workspace
  membership: externally located registered worktrees remain valid. Resolve the
  main checkout from Git/native local identity, including when the opened folder
  is a linked worktree or a nested package. Do not recursively nest this default
  beneath whichever worktree happens to be current.
- Distinguish the new branch name, the worktree folder name and the starting
  revision. "From current branch" must refer to the session's selected checkout,
  not silently use the project tab's checkout. Creation starts from a committed
  revision; uncommitted changes stay in the original worktree.
- Honor Git's ordinary refusal to check out a branch already used in another
  worktree. Support and identify detached worktrees, including multiple checkouts
  at the same commit. A mutable branch name is a label, not physical identity.
- Worktree removal preserves branch refs and conversation history, observes Git's
  dirty/locked/main-worktree constraints, and preserves CodeNomad's session-family
  evacuation and resource fencing. Closing a conversation does not remove Git data.
- UI and agent equivalence must be demonstrated for directory, starting revision,
  branch/detached state, native session location, local project visibility and Git
  panel target. Native `session_move` alone does not provide CodeNomad's family
  transaction. An agent's shell command also does not inherit UI policy by itself.

Implementation:

- `workspaces/native-worktrees.ts` owns the local catalogue and native create/remove
  policy. It calls OpenCode `worktree.refresh/list/create/remove`. There is no second
  production `git worktree list/add/remove` implementation. Git reads annotate HEAD
  and branch and compare the physical common directory to exclude independent clones.
- Opaque directory-derived identifiers remain stable when branches change; labels
  are separate. Main checkouts cannot be deleted. Nested workspace paths are mirrored
  over the same checkout roots, retaining host/service namespace separation for WSL.
- Creation carries the selected source worktree, an explicit starting revision and
  the local main checkout's `.codenomad/worktrees` parent. Native creation detaches HEAD;
  Git `switch -c` (or `switch` for an existing branch) establishes the requested branch
  without force/reset. Failed branch attachment removes only the newly created clean
  worktree through the native API; a cleanup failure is reported with the original error.
- The catalogue supplies the same default parent to the agent instruction. Creation
  alone and a request to continue the conversation there are distinguished. The UI
  follows creation with the existing verified family transaction, using the returned
  identifier rather than guessing it from the branch name.
- Native worktree events invalidate ownership and UI state. Opening the selector also
  discovers external Git changes. Native session moves refresh the catalogue before
  list reconciliation. Search traverses every local worktree's native cursor chain.
- `scripts/test-native-worktree-management.mjs` runs through the isolated native
  contract fixture (and its CI callers), covering selected HEAD, default parent,
  named branches, externally-created checkouts, independent clones, branch rename,
  nested workspaces, dirty removal and checked-out branch refusal. It passes against
  real OpenCode 2.0.1 and 2.0.4; no shared daemon or user database is used.

References: [Git worktree](https://git-scm.com/docs/git-worktree) and
[OpenCode V2 worktree configuration](https://opencode.ai/v2/docs/config/#worktrees).

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

### Local workspace scope, not native project identity

The CodeNomad tab is anchored to `Instance.folder` (`WorkspaceRecord.path` on the
server). Native `location.get().project.directory` describes the local checkout,
and `project.canonical` describes its canonical repository root. Neither should
be confused with `SessionInfo.location.directory`, the session's working directory.
The native project ID can span independent local clones; matching it alone does
not establish membership in the opened CodeNomad workspace.

The UI uses the native project inventory to discover candidates, then projects
families using the opened folder and the server's registered worktree paths,
including their service-side paths for WSL. A separate clone sharing the native
project ID must not appear merely because of that ID. Family ancestry is retained
when a member belongs to the local scope. Moving within this workspace's worktrees
changes the execution directory and badge, while keeping the conversation in the
same CodeNomad project tab.

During refresh, the first directory page is partial: it must not replace existing
worktree rows before inventory reconciliation completes. An unavailable inventory
must likewise preserve those rows. `workspace-session-scope.test.ts` and the
session request-authority regressions cover local-clone separation, family
retention, WSL paths and repeated refreshes.

The integration does not require two competing session locations. CodeNomad keeps
native authority, while communicating when the user authorizes changing it:

- Creating a worktree alone or running a one-off test preserves the session location.
- A request to continue the conversation's task in a worktree authorizes a native move,
  unless the user explicitly requests preserving the current location.
- An explicit UI worktree selection uses CodeNomad's transactional family move.
- A native move is reflected faithfully, including one initiated outside CodeNomad.
- A confirmed explicit move becomes the new attachment to preserve.

Keeping the session attached means its default tools, catalogs and plugins remain
location-scoped to that attachment. The agent must use absolute paths/`workdir`
for work elsewhere and read the instructions applicable to the target files.
Changing every location-scoped service requires an explicit native move; a shell
working-directory override does not do that.

## Session placement instructions

The native `opencode.tools` plugin adds this general guidance through its session
context hook:

> When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.

This is core runtime behavior, not a TUI-only instruction. CodeNomad complements
it with its creation convention, explicit user intent and the distinction between
a one-off working-directory override and moving the conversation's execution context.

`packages/ui/src/stores/session-instructions.ts` supplies the named native entry
`codenomad.session-placement`. It explicitly distinguishes working elsewhere from
moving the conversation and qualifies the generic upstream recommendation.

The action admission path awaits synchronization before every prompt (including
queued/restored prompts), slash command and session shell command. Existing
sessions receive it on their next submission, as do newly created sessions on
their first submission. This is not a background migration of every stored session
or an intervention in an already-running turn initiated by another client.

The entry uses the user's current choice rather than an embedded initial session path,
and appends the catalogue's default creation parent when available. It
survives independently of the voice-mode entry, and is reapplied without a
browser-only success cache. A failed write propagates through the existing action
failure path. Other instruction keys and session metadata are not replaced.

This is model guidance, not a runtime permission. The inspected native tool calls
`ctx.session.move` directly, outside the CodeNomad HTTP proxy. Enforcing a distinct
agent-vs-user movement policy would require a supported native runtime control;
blocking the proxy would not provide that guarantee. A tool-initiated native move
also does not become CodeNomad's multi-session family transaction merely because
the instruction is present.

## Directory spelling

Do not lowercase paths globally (including case-sensitive hosts) or broaden
project authority to hide native directory-filter discrepancies. When diagnosing an absent
conversation, compare `session.get`, the actual directory-scoped list and the
authorized workspace spelling before changing UI state.
