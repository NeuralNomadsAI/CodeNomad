# Worktrees and conversation placement

## Product/Git contract

- A Git worktree is a physical checkout with its own HEAD, index and working
  files. Branch refs and the object database are shared with its local repository.
  Multiple sessions can use one worktree.
- Selecting a session's worktree changes only its native execution location: it
  never runs `git switch`, moves the checkout, copies uncommitted files, merges
  branches or creates another conversation. Moving within the local repository keeps the
  conversation visible in its CodeNomad project.
- Creation and session movement are separate; the selector's create action does
  both and is labelled "Create and use worktree".
- Preserve the CodeNomad default parent `<local main checkout>/.codenomad/worktrees`
  for new worktrees. It is only a storage convention: externally located registered
  worktrees are equally members of the workspace. Resolve the
  main checkout from Git/native local identity, including when the opened folder
  is a linked worktree or a nested package. Do not recursively nest this default
  beneath whichever worktree happens to be current.
- Distinguish the new branch name, the worktree folder name and the starting
  revision. "From current branch" must refer to the session's selected checkout,
  never the project tab's checkout. Creation starts from a committed
  revision; uncommitted changes stay in the original worktree.
- Honor Git's ordinary refusal to check out a branch already used in another
  worktree. Support and identify detached worktrees, including multiple checkouts
  at the same commit.
- Worktree removal preserves branch refs and conversation history, observes Git's
  dirty/locked/main-worktree constraints, and preserves CodeNomad's session-family
  evacuation and resource fencing. Closing a conversation keeps Git data.
- UI and agent equivalence must be demonstrated for directory, starting revision,
  branch/detached state, native session location, local project visibility and Git
  panel target. Agent shell commands bypass UI policy, so equivalence relies on the
  session placement instructions below.

Implementation:

- `workspaces/native-worktrees.ts` calls OpenCode `worktree.refresh/list/create/remove`;
  never add a second production `git worktree list/add/remove` implementation. Git
  reads establish each checkout's physical common-directory identity (rejecting
  unrelated repositories) and annotate HEAD and branch. A registered entry whose
  folder or Git layout (`.git`, administrative directory) is missing, such as a
  checkout mid-removal, is omitted; any other identity failure fails the inventory.
- Opaque directory-derived identifiers remain stable when branches change; labels
  are separate. Main checkouts cannot be deleted. Nested workspace paths are mirrored
  over the same checkout roots, retaining host/service namespace separation for WSL.
- Creation carries the selected source worktree, an explicit starting revision and
  the local main checkout's `.codenomad/worktrees` parent. Native creation detaches HEAD;
  Git `switch -c` (or `switch` for an existing branch) establishes the requested branch
  without force/reset. Failed branch attachment removes only the newly created clean
  worktree through the native API; a cleanup failure is reported with the original error.
- The UI follows creation with the verified family transaction, using the
  returned identifier rather than guessing it from the branch name.
- Native worktree events invalidate ownership and UI state. Opening the selector also
  discovers external Git changes. Native session moves refresh the catalogue before
  list reconciliation. Search traverses every local worktree's native cursor chain.
- `scripts/test-native-worktree-management.mjs` (run by `test-opencode-location-native.mjs`,
  isolated: no shared daemon or user database) covers selected HEAD, default parent,
  named branches, externally-created checkouts, independent clones, branch rename,
  nested workspaces, dirty removal and checked-out branch refusal.

References: [Git worktree](https://git-scm.com/docs/git-worktree) and
[OpenCode V2 worktree configuration](https://opencode.ai/v2/docs/config/#worktrees).

## Shared model, explicit user choice

OpenCode's native session location is both an execution context and the source of
truth for CodeNomad's session projection. The concepts are related, but distinct:

| Concept | Meaning |
| --- | --- |
| Git worktree | A checkout with its own branch and working files. |
| Native project | Repository identity; more than one checkout, and even separate clones, can share it. Matching it never authorizes a directory. |
| Native session location | The session's execution context. It determines location-scoped services, defaults and native movement events. |
| CodeNomad workspace/instance | The folder opened by the user, its authorized locations, and their UI projection. Several tabs can open the same folder. |
| Tool working directory | A directory selected for one operation; the conversation's location stays put. |

### Local workspace scope

The CodeNomad tab is anchored to `Instance.folder` (`WorkspaceRecord.path` on the
server). Native `location.get().project.directory` describes the local checkout,
and `project.canonical` describes its canonical repository root; both are distinct
from `SessionInfo.location.directory`, the session's working directory.

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

CodeNomad keeps the one native session location and moves it only when the user
authorizes it:

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
working-directory override changes only that command's directory.

## Session placement instructions

The native `opencode.tools` plugin adds this general guidance through its session
context hook:

> When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.

This is core runtime behavior for every client. CodeNomad complements
it with its creation convention, explicit user intent and the distinction between
a one-off working-directory override and moving the conversation's execution context.

`packages/ui/src/stores/session-instructions.ts` supplies the named native entry
`codenomad.session-placement`. It explicitly distinguishes working elsewhere from
moving the conversation and qualifies the generic upstream recommendation.

The action admission path awaits synchronization before every prompt (including
queued/restored prompts), slash command and session shell command. Existing
sessions receive it on their next submission, as do newly created sessions on
their first submission.

The entry uses the user's current choice and appends the catalogue's default
creation parent when available. It survives independently of the voice-mode
entry and is reapplied on every submission, never skipped by a browser-side
success cache. A failed write propagates through the action failure path. Other
instruction keys and session metadata stay intact.

The entry is model guidance only: the native tool calls `ctx.session.move`
directly, outside the CodeNomad HTTP proxy, so a tool-initiated move is a
single-session native move outside CodeNomad's family transaction. An
agent-vs-user movement policy needs a supported native runtime control; never
block the proxy for it.

## Directory spelling

Do not lowercase paths globally (including case-sensitive hosts) or broaden
project authority to hide native directory-filter discrepancies. When diagnosing an absent
conversation, compare `session.get`, the actual directory-scoped list and the
authorized workspace spelling before changing UI state.

## Agent conventions

- Event ownership uses registered-only native worktree snapshots, isolated from display/request discovery scans (`ownsDirectory` / `ownsLocation` with the `event` purpose). Never run native strategy refresh from routing or join its pending inventory. Keep physical Git identity, nested-folder/WSL projection, native registration, invalidation and disposal checks shared with ordinary ownership; ordinary requests and explicit worktree discovery retain refresh semantics. Regression: `instance-event-ownership.test.ts` and the isolated native worktree fixture.
- Worktree discovery/create/remove use `workspaces/native-worktrees.ts` and the native OpenCode worktree API. CodeNomad supplies the `.codenomad/worktrees` default, named-branch policy and verified family transactions. Git common-directory identity scopes the native inventory to the opened local repository; opaque worktree identifiers are separate from mutable branch labels. Validate through `scripts/test-opencode-location-native.mjs` with an isolated CLI and `tests/browser/worktrees.test.ts` for selector gestures.
- Worktree inventory snapshots live in `workspaces/worktree-inventory.ts`: display reads serve cached data and lazily revalidate, directory authorization uses validated reads, and family transactions force fresh reads. Invalidation retains display data and fences pending scans; `workspace.worktreesChanged` refreshes UI consumers after a changed snapshot is published. Keep selector opening independent of refresh completion and suppress duplicate selection events during inventory reconciliation.
- Worktree branch/HEAD annotations use one NUL-delimited Git worktree snapshot, intersected with native inventory and verified Git identities; effective checkout roots must respect Git configuration as well as administrative backlinks. Pending move targets belong to the store's instance/family request identity and survive selector navigation/remounts until native reconciliation settles.
