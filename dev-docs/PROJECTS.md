# Projects and tabs

Closing project tabs, temporary workspaces, the new-instance launcher and the Git-unavailable degraded mode.

## Durable execution identity

Saved workspace tabs carry an optional `serverId`; absence selects `local-shared`.
Reconciliation, occurrence numbering, close/reopen preservation and recent-project
metadata use server ID plus directory. Explicit directories keep their exact case,
separators and trailing characters; local paths keep the local normalization.
The live backend descriptor supplies the binding when capturing a tab.

Local tab lifecycle events carry that same server/directory identity and a
server-qualified occurrence. An accepted close captures the window's remaining
membership and fallback selection immediately, independently of the backend
DELETE result. Other windows keep their own membership until a backend event.
Rename dialogs capture the initiating tab's server and directory when opened;
submission updates names for that binding's open occurrences and recent metadata.
The path-only home-page rename explicitly targets `local-shared`.

Explicit tabs whose backend occurrence is absent stay in the saved restoration
graph with their drafts, attachments, selection and optional catalogs. Restoration
reopens registered explicit targets through their saved server/directory binding.
Unknown/deleted profiles retain the same saved binding for repair.
The home page and the launcher show one recent list, local and explicit entries
together (`getLaunchableRecentFolders`); a click reopens server and path. Both
mount `RemoteProjectMenu` (`components/remote-project-menu.tsx`): an inline
"Remotes" disclosure (Recents heading typography, leading chevron) listing explicit OpenCode servers, whose "+ Project" action and whole row open folders
browsed in place through `listOpenCodeFolders` (Backspace parent, Escape servers,
then collapse). Its existing navigation row reserves space for the bidi-isolated server name and the folder path; the full name remains in its text and tooltip. The server row is a single button, including its visible action. The disclosure has a host-only paste field reusing the add-server path and a
host-only row context menu to remove a server. Browse, Clone and Temporary stay local. Model recents and favorites
carry server identity, with absent IDs selecting the shared local service.

## Explicit session inventory

The internal explicit-project reader uses the binding's exact native directory,
including case, separators and trailing characters. Its first native session page
includes roots and descendants, with a 200-row request limit; subsequent demand
passes only the opaque `cursor.next`. Each page must contain sessions in that exact
Location. Project IDs, parents, nested directories and worktrees grant no expansion.
The sidebar loads the next page when its end becomes visible, without explanatory text;
after three automatic pages that add no visible row it waits for the user to scroll
again, and a failed page waits for Retry. Sorting works on the loaded subset. Native title search reads one bounded page and
identifies incomplete matches so the user can refine the query.

Partial pages and errors retain saved display rows. Absence reconciliation requires
the qualified exact inventory's terminal page, including an empty terminal page,
and preserves rows changed concurrently. Targeted restored-session reads validate
the returned identity and exact Location; ancestry reads are bounded to 200 IDs.
An in-directory child with an unavailable parent becomes a display root while
retaining its native parent metadata. The inventory is exercised by store and browser
regressions and an isolated native inventory qualification.

## Internal server attachment observations

`WorkspaceManager.readServerAttachments()` captures unpublished workspace records
and the connection owner's occurrence leases before awaiting the private native
parent transport. The two views overlap and retain independent receipts. Lease
publication adds the real backend instance ID; failure, cancellation and release
retire their snapshots. Each view returns at most 512 reservations, with overflow
reported as unknown. An unresolved local path appears as in-flight coverage.

Electron and Tauri project retained tab identities from their accepted window
records and verified session manifests, preserving unknown server IDs and exact
directories. Opaque memory-only handles bind to the native owner and manifest tab
index. The union of live native registrations and retained windows includes
ephemeral windows; Preferences and remote CodeNomad windows have separate owners.
Global coverage remains `unknown`. Browser application tabs publish bounded positive
declarations through their authenticated event-stream capability. The backend
captures this participant owner alongside both reservation owners before native
awaits and includes its epoch in current checks. Retained manifest coverage and
backend reservation coverage have their own complete/unknown states. Host removal
closes known project tabs, disconnects the target and forgets its secret and profile;
these internal observations retain their separate unknown global-coverage contract.

`ProjectParticipants` holds at most 32 stream owners and 512 declared references,
with at most 32 references per update. Each reference carries exact server/directory
metadata and a memory-only tab-membership lifetime; supplied backend occurrence IDs
must match their current immutable binding. Reattaching a tab rotates its lifetime.
Native retained entries keep their separate handles and manifest-index identity.
Transport loss preserves bounded references and an unresolved owner; unknown slots
remain held until backend restart. Overflow retains unknown coverage. Declaration
observations and native observations share the reader's 32-owner/512-reference
ceiling; an excess returns an explicit overflow with unknown coverage while the
source owners retain their bounded observations. Declaration
admission rejects either raw query delimiter (`?` or `;`), including an empty query,
before body parsing or capability admission. Accepted declarations fence older pending updates and have a five-second
monotonic acceptance deadline. Revisions and stream capabilities fence replay.

Live native coverage awaits sender/document-bound publication with pre-mutation
admission on both hosts. The synchronous tab and binding mutators require an awaited
native fence to qualify this coverage; post-mutation effects retain unknown. Global
participant coverage also requires admission on every project-use path, including
authenticated callers without an event stream. Current declarations qualify their
own metadata observations while these independent gaps stay unknown.

Verified manifest reads accept at most 1 MiB, using 64-KiB scratch blocks and a
single overflow sentinel before retaining or decoding excess bytes. The private
read and current requests each have a five-second deadline; settlement checks a
captured monotonic expiry as well as the scheduled cleanup timer.

## Agent conventions

- Native workspace opening reads the occurrence's descriptor from the authenticated local backend and accepts only `local-shared` (or a legacy descriptor without binding) before worktree lookup, filesystem resolution or application launch. Every explicit binding, including loopback profiles and homonymous host paths, returns `explicit_capability_unavailable` with capability `files` and reason `localOnly`. Unknown/stale occurrences fail closed. Electron and Tauri enforce this independently of renderer state.

- `WorkspaceManager.requireWorkspaceCapability(workspaceId, capability)` is the synchronous shared admission gate for closed `ServerCapability` product operations, called before connection acquisition or adapter effects. It uses private workspace policy and returns the occurrence's abort signal; published capability descriptors are display snapshots. Explicit refusals carry `explicit_capability_unavailable`, the typed capability and `reason.code`. Each admitted native operation still captures and validates its current connection contract, generation and exact session Location. Local unknown initial capabilities retain the local admission behavior; host adapters keep their local-workspace guard.
- Explicit `list()`/`get()` descriptors snapshot the connection owner's existing validated connection synchronously. Native E1 features carry that connection's generation; absent, pending or revoked connections carry generation `0` and `unknown/contractUnverified`. Qualified reconnection restores E1 availability for every attached occurrence. Issued snapshots retain their captured capabilities; explicit request fences use the occurrence's immutable binding reference, abort signal and captured connection assertions. Local descriptors retain their existing identity semantics.
- The renderer instance owner installs a non-enumerable, memory-only `renderBinding` origin at occurrence admission and preserves it through metadata updates. Retained media consults that origin across component remounts and display-cache eviction; a changed live binding receives the unknown-source policy. Closing and opening a new occurrence installs its own origin. This field stays outside captured/persisted project metadata.
- Yolo admission uses `yolo` through the workspace-owned persistence adapter before state reads, native session access and automatic permission replies. Explicit occurrences are admitted on a validated connection: replies use that connection without permission receipts. Direct routes return the structured capability refusal when the capability is not available.
- A validated explicit connection also makes `files`, `git`, `backgroundShells`, `yolo`, `providerUsage` and `plugins` available. Files and Changes read the server through `opencode/servers/remote-workspace.ts` (`dev-docs/FILES_PANEL.md`); background shells go through the explicit proxy's closed operations with a working-directory filter. Host readers and every write (`worktrees`, host Git, file writes, configuration documents) stay refused; the UI-only `hostGit`, `fileWrite` and `pluginWrite` features are never granted to an explicit project. Temporary Keep/Discard require `worktrees` before consulting the host folder registry; Create/Abandon accept only the local target. Homonymous folders and native session IDs on explicit targets retain their separate authority.

- The execution-binding parser (`opencode/servers/registry.ts`) preserves `serverId + directory` independently of workspace occurrence IDs. A missing server ID defaults to `local-shared`; an unknown ID remains a repairable reference. Explicit directories retain their exact spelling, separators and case. Public project opening selects the named server through `POST /api/workspaces`.
- Workspace creation accepts `WorkspaceCreateOptions.serverId`. Each explicit occurrence owns an immutable binding and a target lease acquired before asynchronous admission, retained through publication and released on failure, cancellation or closure. Occurrences share target admission across backend windows. `workspaces/explicit-workspace.ts` requires the captured connection's native Location and readable-directory proof with exact returned directory spelling, a five-second validation deadline and eight-MiB per-response limit. Missing, unreadable, mismatched or unqualified paths fail closed; host filesystem, Git, WSL, binary discovery and environment setup stay outside this branch. Attachment is exercised by `explicit-workspace.test.ts` and `scripts/test-opencode-explicit-location-native.mjs` with an isolated CLI.
- Closing a project tab detaches it immediately and requests deletion of that occurrence's logical backend workspace record; failures notify and never retry automatically. Separate occurrences of the same folder are independent. A `workspace.stopped` deletion closes the same record in other windows and notifies only windows displaying it that did not initiate the close. CodeNomad never evicts native Locations; OpenCode sessions keep running and reopening finds them. Whole-window close, app quit, renderer reload and backend shutdown keep existing restoration behavior. Temporary discard and server stop events use local-only tab detachment, not another DELETE; Keep closes the retained project normally.
- Git is a full-functionality prerequisite, with directory-only degraded conversations when the backend cannot find Git. Only the explicitly opened physical folder is session authority in that mode; never infer sibling worktrees from native project IDs. Keep ancestor/descendant mutation identities covered by the deletion fence across Git availability changes. Inform agents through the owned native `codenomad.git-availability` instruction before prompts/custom commands, remove stale context after recovery, and keep this advisory separate from fail-closed environment synchronization. Do not add a blocking Git setup UI. Validate with `scripts/test-git-degraded-native.mjs` using an isolated CLI/database and provider.
- Temporary instances (`workspaces/temporary-workspaces.ts`, UI `stores/temporary-instances.ts`) are ordinary non-Git workspaces on CodeNomad-created direct children of `<config>/temporary-workspaces`. Registry membership (`temporary-workspaces.json`), not location, makes a folder temporary; keeping only unregisters it and adds a named recent project. Discard deletes only registered children of that root, refuses running conversations and other open tabs of the folder, removes conversations deepest-first, closes the workspace before deleting the folder and keeps failed removals registered; such a folder is reachable only by browsing to it. Closing a temporary tab from the UI asks Keep/Discard/Cancel, except that an untouched one (no conversation, file or unsent draft) closes and is discarded silently (`onlyIfEmpty`: the server refuses with `temporary_has_conversations`/`temporary_not_empty`, and any failure of that quiet discard returns the choice without an error). Before the server stops it, a visible temporary tab yields to its neighbour (or closes if alone) and a refusal restores it in place; `workspace.stopped` likewise closes the tab first and clears the instance in a microtask, because clearing a visible shell's state in the same update as its tab freezes the window. Same-minute names get a `(n)` suffix. Registry changes broadcast `workspace.temporaryChanged`, which clears kept marks in every window. Open temporary tabs are saved and restored with the app state like any project tab (still marked temporary). Only the choice dialog overrides initial focus (to its last, non-destructive choice); confirms keep focus on Cancel. Refusals use stable `temporary_*` codes localized by the client. Validate with `scripts/test-temporary-workspaces-native.mjs` against an isolated CLI.
- The tab-bar new-instance button follows the last tab like a browser: the instance `TabScroll` frame only spans its tabs and the button sits after it, outside the scroller (so focusing it never scrolls the strip), ending up at the strip's end once tabs overflow. Dragged tabs stay visually within the tab list like a browser's (`KeepDraggedTabInStrip`), while the drop slot follows the pointer's unbounded position (`closestUnboundedCenter`). The button keeps its click (full home page, Cmd/Ctrl+N) while a long press, right-click, Alt+Down, Shift+F10 or Menu opens the anchored `NewInstanceLauncher` (`lib/long-press.ts`; only Escape returns focus to the button, never over another surface or the home page): search-first recent projects (an open project switches to its tab), Browse/Temporary/Clone and the shared "Remotes" disclosure. Remote CodeNomad servers, SideCar and management (rename/remove recents, servers, settings) stay on the home page. Browse/clone flows live once in `components/new-instance-dialogs.tsx` (with optional home-only add-server setup) and recent-folder display helpers in `lib/recent-folder-display.ts`, shared with `FolderSelectionView`; styles in `styles/components/new-instance-launcher.css`.
- The clone dialog (`components/new-instance-dialogs.tsx`) suggests the repository's `git clone` folder name (`lib/clone-destination.ts`) inside a parent: the folder chosen with Browse, else the server-scoped `ui` state `lastCloneParent` (the folder above the last successful clone), else the folder above the most recent project. A destination the user types is kept as entered and sent unchanged; the server creates it.
