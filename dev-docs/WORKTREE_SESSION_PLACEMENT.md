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
  A linked checkout lacking the mirrored folder (ignored, untracked or absent on its
  branch) stays in the inventory with `nestedFolderMissing`: it keeps owning the
  sessions placed there, but the selector offers it only while selected and it is no
  inventory-derived pending-recovery location (selected, active and known-request
  locations stay required). Creation refuses, before any native call, a source whose
  starting revision does not track the opened folder (`nested_folder_unavailable`;
  `__tests__/native-worktree-nested-workspace.test.ts`).
- Creation carries the selected source worktree, an explicit starting revision and
  the local main checkout's `.codenomad/worktrees` parent. Native creation detaches HEAD;
  Git `switch -c` (or `switch` for an existing branch) establishes the requested branch
  without force/reset. Failed branch attachment removes only the newly created clean
  worktree through the native API; a cleanup failure is reported with the original error.
- The UI follows creation with the verified family transaction, using the
  returned identifier rather than guessing it from the branch name.
- Native worktree events invalidate ownership and UI state. Opening the selector also
  discovers external Git changes. An in-scope move with a held display root
  adds that root directly when absent, preserving native parent links and
  the list cursor. A missing root still needs inventory reconciliation. When a
  move's destination does not exactly match the opened folder or a listed worktree,
  consult a fresh inventory, then use a workspace-scoped session read for any
  remaining miss. The proxy resolves aliases such as symlinks and junctions.
  Move and restore placement reads return a registered worktree slug only
  when the ownership resolver matches its exact list directory. Live admission
  and catalogue filtering use that slug against the workspace inventory, as does
  the worktree selector for its current option. Execution keeps the native
  directory. A complete catalogue retains a restored row while its current
  placement read settles. A typed departure remains authoritative across catalogue
  merges; a newer move or verified placement supersedes it. Nested independent repositories follow
  the same list rules as their canonical directories. Move and restore reads
  confirm the exact placement across catalogue refreshes for the current client
  generation. A complete catalogue rechecks expired placement evidence through
  the proxy for an absent alias, including an ancestor retained by a local descendant.
  A successful read applies the current placement and renews the evidence;
  a typed departure or native session-not-found removes the old list,
  selection and transcript
  projection (`removeSessionProjection`). Other read failures keep the move
  unresolved until a later worktree publication retries it. Confirmation updates
  the session list and selected composer catalogue. Drafts and attachments stay,
  and no deletion marker is set.
  The record keeps the session out
  of the scope (below) and makes a later published inventory serving the destination
  list it again. A current placement read confirming a registered checkout
  also clears the prior departure, including for a favorite reopened through
  an alias. If the inventory is still catching up, that confirmation stays
  pending until the registered checkout is listed, fenced by the client
  generation and the observed departure. A verified subfolder return without
  an exact checkout match uses the existing session-family scope. A session refresh at a served
  directory, deletion, another move, or closing the instance releases the record.
   Each instance settles moves from its own ordered relay stream, fencing each
   event and probe by the backend attachment, native client generation and latest
   move for that session. Reconnect replaces unsettled moves with exact
   workspace-proxy reads in the new generation. The last projection stays while
    ownership is unresolved; initial, continuation and search pages leave these
    placements to the point read. An unavailable point read retries on a later
    catalogue refresh or worktree publication. A verified arrival without a row
    waits for the inventory to publish its exact checkout slug. Publication uses
    the retained proof only for the current attachment, client generation and move.
  The relay checks the payload destination independently of the envelope. Without
  an envelope, it routes to the destination owner and prior recipients from that
  payload directly. Verified destination owners become prior recipients for the
  next move, even if no other session events arrive between moves.
  Family members left behind stay sessions of their own location
  (`stores/session-move-restore.test.ts`, `tests/browser/session-external-move.test.ts`).
  The workspace proxy's 403 for a session located outside the workspace carries
  `reason: "session_located_elsewhere"` (`opencode/session-access-contract.ts`).
  Strict ownership confirmation distinguishes a foreign session from an
  unavailable path translation or inventory; unconfirmed refusals stay generic.
  Parent and saved-workspace reads opt in through the instance adapter
  (`lib/sdk-manager.ts`, a client-side header never sent), which reads that refusal
  as absent and preserves the reason for projection cleanup. Restore applies
  departures after the selection's reads settle. A successful workspace-proxy
  read keeps the child selected while the display inventory catches up. Other
  403s stay errors
  (`stores/session-list-startup.test.ts`, `lib/sdk-manager.test.ts`).
  Search traverses every local worktree's native cursor chain. A move settled
  as missing excludes its row from both cache and result publication by the
  overlapping search in that instance. The exclusion lasts only for that search.
- `scripts/test-native-worktree-management.mjs` (run by `test-opencode-location-native.mjs`,
  isolated: no shared daemon or user database) covers selected HEAD, default parent,
  named branches, externally-created checkouts, independent clones, branch rename,
  nested workspaces, dirty removal and checked-out branch refusal.

References: [Git worktree](https://git-scm.com/docs/git-worktree) and
[OpenCode V2 worktree configuration](https://opencode.ai/v2/docs/config/#worktrees).

## Shared model, explicit user choice

Use the native session location for execution context and session projection:

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

Live sessions follow the same scope at display. An opened folder also receives the
events of a nested checkout of another repository it owns (a parent folder such as
the home directory); the store holds every session it receives, and the session
list, tab indicator, subsession chevrons, idle fade, and
completion, compaction and retry notices show only the workspace scope; a
needs-input notice of an out-of-scope session follows the interruption dock that
shows its request
(`stores/session-state.ts` `getWorkspaceSessionScope`, from
`selectWorkspaceFamilyIds`): complete families with a member in the opened folder
or a registered worktree, plus the active session's family, so a session opened
explicitly is shown where it was opened. A session located elsewhere (a directory
the workspace proxy does not serve) stays out of scope until its moved-away record
is released. A move, a typed restore/parent-read refusal or a project inventory row can
establish that placement, including when an independent clone shares the native
project ID and the row would otherwise be kept for a local descendant. Complete
catalogue reconciliation uses merged placement, deferring to pending native moves,
and clears the departed projection. A selected local child stays selected using
its surviving display root. Departure and catalogue absence preserve drafts and
attachments; authoritative deletion clears them. Rows, chevron activity and the tab indicator derive from one map
(`getListedSessionMap`): the
sessions in scope connected to a listed root, so a row under an ancestor outside the
scope is not shown, as for a missing parent. The scope is reactive, so a late worktree
inventory and either family order converge. An unread or failed inventory and a
Git-unavailable folder (which projects its own directory) keep every held session
in scope (`stores/session-workspace-scope.test.ts`).

The backend relay carries placement hints only on the workspace's exact session
GET. The destination proxy checks ownership, returns the exact registered slug
when available, and keeps the placement hint out of the native OpenCode request.

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

This runtime guidance applies to every client; CodeNomad qualifies it with the
creation and user-authorized placement rules above.

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

- Preference authority probes use `ownsLocation(id, location, client, { signal, purpose, strict: true })`: a successful read can establish a negative; physical-path, Git identity and WSL translation failures reject. Ordinary inventory preserves root-only fallback when Git reports a non-repository. Only strict ownership qualifies a cached fallback's checkout absence through filesystem discovery; its qualification state stays inside the ownership cache. Git-unavailable inventory retains its exact-folder `directoryOnly` authority. Strict reads validate each registered checkout root before omitting a missing projected project subfolder; registered-root and opened-root failures reject. Concurrent Git identity preflights retain all admitted reads through settlement.
- Session-media ownership captures the published workspace occurrence, root scalars,
  connection client and request signal before asynchronous reads. Non-root checks
  scan a private native inventory with physical Git validation and guards between
  dependent steps. Invalidation uses `WORKTREE_OWNERSHIP_RESTART_LIMIT` under that capture;
  retirement, replacement and repeated invalidation refuse the read.
  Missing nested project directories resolve through existing physical ancestors
  and retain the registered checkout's projection. Broken links, indeterminate
  physical errors and invalid checkout registrations refuse media ownership.

- Event ownership uses registered-only native worktree snapshots, isolated from display/request discovery scans (`ownsDirectory` / `ownsLocation` with the `event` purpose). Never run native strategy refresh from routing or join its pending inventory. Keep physical Git identity, nested-folder/WSL projection, native registration, invalidation and disposal checks shared with ordinary ownership; ordinary requests and explicit worktree discovery retain refresh semantics. Regression: `instance-event-ownership.test.ts` and the isolated native worktree fixture.
- Worktree discovery/create/remove use `workspaces/native-worktrees.ts` and the native OpenCode worktree API. CodeNomad supplies the `.codenomad/worktrees` default, named-branch policy and verified family transactions. Git common-directory identity scopes the native inventory to the opened local repository; opaque worktree identifiers are separate from mutable branch labels. Validate through `scripts/test-opencode-location-native.mjs` with an isolated CLI and `tests/browser/worktrees.test.ts` for selector gestures.
- Worktree inventory snapshots live in `workspaces/worktree-inventory.ts`: display reads serve cached data and lazily revalidate, directory authorization uses validated reads, and family transactions force fresh reads. Invalidation retains display data and fences pending scans; `workspace.worktreesChanged` refreshes UI consumers after a changed snapshot is published. Keep selector opening independent of refresh completion and suppress duplicate selection events during inventory reconciliation.
  Strict directory-cache and native-inventory reads permit two automatic restarts, then one fresh read; another invalidation rejects that demand and permits a later retry. Ordinary readers keep trailing reloads until a current scan settles. Pending strict demands have their own retry budget while sharing native single-scan work and validated snapshots with ordinary readers.
- Worktree branch/HEAD annotations use one NUL-delimited Git worktree snapshot, intersected with native inventory and verified Git identities; effective checkout roots must respect Git configuration as well as administrative backlinks. Pending move targets belong to the store's instance/family request identity and survive selector navigation/remounts until native reconciliation settles.
  Root verification snapshots shared config before Git reads it and checks both shared and enabled per-worktree config files again before publishing. A changed file rejects the scan. Existing per-worktree config, shared root overrides and conditional includes use Git to resolve the effective root. Ordinary includes use one final expanded-config read for the whole scan. Queued per-checkout probes yield to authority commands with bounded overtaking.
  After successful creation and branch attachment, a config change permits one retry of the result inventory only.
