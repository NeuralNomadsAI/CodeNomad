# Worktrees and conversation placement

## Product/Git contract

The user review on 2026-09-17 requires evaluating #649 as a development workflow,
not merely replacing Git calls with similarly named native methods. The rules
below define the implementation and its verification surface.

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

## Why an instruction belongs in PR #649

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

### Final native/UI integration (2026-09-17)

Follow-up: search/filter mode presents independent flat rows. The "Show subsessions"
switch (off by default) includes children without requiring their parents in the
results. Text and worktree filters must match the same session; activity, names and
worktree labels also sort each session independently. Selection targets only the
displayed matches. Server search results no longer require ancestor hydration.
Closing search restores normal hierarchy and ignores its worktree filter. This
supersedes the temporary root-only worktree-filter fix in `3921ba08`.

The real-component browser regression covers the switch, cross-worktree children,
text plus directory filters, independent badges, bulk selection, direct child
navigation, results without loaded ancestors and returning to normal hierarchy.

The rebuilt UI was also loaded in the installed Windows Tauri renderer. An
existing child, "Analyze automation update", was verified through native reads
in `D:\CodeNomad` while its parent remained in `pr649-final`. With its title and
the Workspace filter selected, the child appeared alone only when subsessions
were enabled. Selecting the parent's checkout hid it; closing search restored
the hierarchy and preserved the active parent conversation. A first desktop wait
of 30 seconds expired; the completed repeat used a 90-second bound. Directory
search still traverses the local worktree catalogue, so this is not a latency
guarantee. No native session locations were changed by this check.

Merged `dev@e47e01c6` (PR #697) into this branch. Discovery and canonical
`server.status()` adaptation are now inherited from that independently merged
change. The native worktree/family fixture passed again against isolated official
2.0.0 and 2.0.7 daemons, including legacy health and modern info discovery.

Verified in the installed Windows Tauri application using dedicated disposable
sessions in the actual `D:\CodeNomad` repository:

- The separately created #697 checkout appears in the selector without moving
  the original conversation away from `D:\CodeNomad-worktrees\pr649-final`.
- Create/use creates a named branch under the main checkout's
  `.codenomad/worktrees`, at the selected checkout's HEAD. Native session location,
  composer selection and session-row badge all match the returned checkout.
- A dedicated untracked marker appears in the Git panel and the local Git/API
  inventories. Selecting the original checkout moves the test conversation back
  and removes that marker from the panel. Explicit refresh was exercised.
- A separate dedicated session moved with the agent's actual `session_move`
  tool to #697 and back; both composer and row badges followed the native event.
- Test sessions, marker files, temporary worktrees and branches were removed.
  The original conversation's attachment was preserved throughout.

The rendered test exposed stale native VCS rows being unioned into a complete
local Git inventory. Local staged/unstaged details now exclude native-only rows;
the status loader also rechecks request/worktree identity after its native wait.
A regression covers stale rows, a clean local snapshot and native-only callers.
The rebuilt UI/server resources were installed and CodeNomad restarted through
Developer Mode. One immediate post-restart run exceeded the 30-second refresh
button wait; the subsequent completed run verified the workflow and rendered
exactly the dedicated marker. This does not establish a startup latency bound.

Additional passing checks: server/UI typechecks, server build (including UI),
real-component browser selector gestures, ownership/proxy/route/cache suites,
session projection/request-authority suites, family evacuation/rollback suites,
and `git diff --check`.

### Installed-build recovery (2026-09-17)

The first installed native-catalogue build stalled while opening `D:\CodeNomad`.
This preceded the user's upgrade to OpenCode 2.0.7. The real repository contains
162 worktrees: serial Git annotations took about 21 seconds for one inventory.
Concurrent ownership misses also discarded pending cache loads and triggered
overlapping inventories; the installed UI showed permission/Form requests hitting
their 10-second timeout while the session list remained loading.

Recovery combines bounded parallel Git annotations (about 3 seconds for the same
inventory), manager-level sharing of in-flight catalogue requests, snapshot-aware
ownership refreshes, cached negative resolutions, and a physical-path fast path
for the opened root. The ownership regression exercises 40 concurrent misses,
one shared refresh, negative caching and explicit invalidation.

OpenCode 2.0.7 introduced a separate startup failure: `/api/status` and `/api/health`
returned 404, while authenticated `/api/info` worked. Lifecycle discovery now tries
that read after the two 404s, preserving credentials, the absolute deadline and
response validation. Contract negotiation recognizes the actual OpenAPI structure;
no 2.0.7 version exception was added. The isolated native worktree/family suite
also passed on 2.0.7 after exercising production lifecycle discovery.

After installing the corrected server modules, Developer Mode inspection and a
rendered capture confirmed the project session list, this conversation's messages,
and its worktree badge. A subsequent full application restart restored the same
session automatically. A fresh comparison of all 132 generated client HTTP
method/path pairs against the installed 2.0.7 OpenAPI document found 131 unchanged
pairs and only the `/api/status` to `/api/info` mismatch handled above. Experimental
routes were already supported by the merged adapter; they are not an outstanding
route migration. Real reads through the production shared-service adapter passed
for canonical `client.server.status()` and session instruction entries. These are
route-presence and targeted runtime checks, not complete payload/behavior parity
or complete UI/agent/Git-panel workflow coverage for #649.

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
