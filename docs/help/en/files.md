# Files and Git

The **Files** right-panel tab combines checkout browsing, local changes and commit history. Selecting a row is separate from opening its central reader.

## Browse a checkout {#browse-workspace}

1. Open **Files** and choose **Workspace**.
2. Select **Worktree to browse** when you want a different checkout; expand folders as needed.
3. Click a file row to select it. Use its eye action to open or close the central preview.
4. Use **Refresh** if the visible snapshot needs rechecking.

| Mode | Reads | Effect on the conversation |
| --- | --- | --- |
| Workspace | Files in the browsed checkout | No session move or branch checkout |
| Changes | Index and working-tree changes | Git mutations happen only through explicit actions |
| Commits | Paginated commit history and revision contents | Read-only history; no checkout |

Expanded folders survive mode changes. Listings/status/history use cached snapshots and revalidate after relevant filesystem changes, activation or explicit refresh; focusing the panel is not a guarantee of a new read. Visible Workspace folders pick up files created, edited, renamed or deleted on the backend host by themselves, at most once every five seconds during continuous activity; collapsed folders and other worktrees are reread only when you show them.

Row actions include **Copy path** and, where the client supports opening backend paths, file-manager/editor/terminal actions such as **Open with default application**, **Show in folder**, **Open in file manager** and **Open terminal here**. Actions can move into **More actions for {name}** when space is limited; the file or folder name replaces `{name}`. A remote browser cannot assume a server path is a local-device path; see [Remote Control](remote-control.md).

## Edit source and save safely {#edit-save}

1. Open a Workspace text file with its eye action.
2. For Markdown, choose **Show source** to edit, or **Preview Markdown** to read the rendering.
3. Edit and choose **Save**, or press **Ctrl/Cmd+S** while the editor has focus.
4. If the file changed externally, review the overwrite confirmation; choose **Cancel** to keep your draft without overwriting that change.

Save writes the actual file in the browsed checkout, including a linked worktree; it does not send a prompt or stage/commit the edit. Saving rereads the authoritative file first. The conflict dialog says **File was modified by the agent. Overwrite agent's changes?**; treat any external writer's changes with the same care.

Dirty source drafts are retained in renderer memory by project instance, directory and path when readers are closed or switched. Filesystem refreshes do not silently replace them. This is not durable file storage: save or copy important edits before restarting/reloading the client. Read/write failures retain the draft. Explicit **Refresh** warns before discarding unsaved edits.

Closing the reader with its trailing close button returns to the conversation; the composer remains available below the reader. Changing session/worktree clears the selected reader, not a promise to save its draft. Opening a browser preview replaces the reader; opening a file returns that view to chat mode.

## Read-only and bounded previews {#preview-limits}

1. Open an image, binary file or historical change with the eye action.
2. For a diff, use **Switch to split view** / **Switch to unified view**, word wrap and unchanged-region controls as needed.
3. Close the reader to return to chat.

| Content | Available behavior |
| --- | --- |
| Workspace text, including Markdown source | Editable with explicit Save |
| Workspace image | Read-only image preview |
| Other binary content | Read-only unavailable-preview fallback |
| Changes/Commits text diff | Read-only comparison, not an editor for either side |
| Git image diff | Before/After images from the exact compared revisions |

Preview reads are bounded; large/unsupported content may be unavailable rather than loaded without limit. Historical images never substitute the current worktree file. A preview failure does not mean the underlying file is absent. Open the file with an appropriate external application where available, without changing its revision just to obtain a preview.

## Stage, unstage and commit {#stage-commit}

1. Choose **Changes** and inspect **Staged Changes** and **Changes**.
2. Use **Stage file** / **Unstage file**, select several rows for the corresponding selected-files action, or drag rows between the sections.
3. Enter a message at the top of **Staged Changes**, then choose **Commit**.

Collapsed section headers remain drop targets. Collapsing sections or changing modes preserves their state and the commit-message draft. A long section shows its first 200 files, then a line such as **480 files not shown** with **Show 200 more** to reveal the next ones in place; section counts remain full totals, and the current, previewed and selected files stay shown. Shift-click ranges cover shown rows only, so a bulk action never includes a file you cannot see. Staging/unstaging changes the index in the browsed worktree; committing records staged content only. Unstaging does not discard the worktree edit.

Review staged files before committing, especially when agents or another client also write there. A failed commit is not automatically replayed. Refresh status/history and inspect the error before retrying, because a lost reply is not proof that no commit was created.

## Read commit history {#commit-history}

1. Choose **Commits** and select a commit to read its message and changed files.
2. Use **Filter loaded commits…** to filter the loaded set, or **Load older commits** to fetch another page.
3. Open a changed file with its eye action.

Text history compares the commit with its first parent (or an empty base for a root commit). It does not switch HEAD or move sessions. Filtering loaded commits is not a server-wide Git log search. Refresh to start from current history after new commits; existing pagination retains its starting history snapshot.

## Whitespace and line endings {#whitespace-line-endings}

1. Open **Settings → Advanced → Hide whitespace-only changes**.
2. Turn it off if you need to inspect unstaged whitespace-only edits omitted from Changes.
3. Review the actual diff and staged content before committing.

The setting is on by default. Its main effect is hiding qualifying unstaged tracked text modifications from the Changes list, counts, selection, bulk staging and drag actions. Hidden files remain unstaged. Staged files remain visible, as do untracked, added/deleted/renamed and binary files. A failed/unsupported detection keeps files visible rather than guessing.

Git's list detection can ignore inner whitespace, CRLF-only changes and added/removed final newlines. The diff reader's whitespace comparison is narrower: indentation and trailing spaces/tabs, not all inner whitespace. Stage and Commit always act on exact content, regardless of the display preference.

Line-ending and byte-order-mark differences may produce a factual note instead of highlighted lines. Turning the setting off cannot make the editor draw every line-ending/BOM change or every same-length trailing-whitespace swap. A visually empty diff is not proof of identical bytes.

## Initialize Git {#initialize-git}

1. Open **Changes** or **Commits** in a folder that is not a repository.
2. Choose **Initialize Git**; it runs immediately without confirmation.
3. Wait for the project/session refresh, then stage and commit explicitly when ready.

Initialization creates `.git` in the explicitly opened folder; it does not initialize a parent directory or create a first commit. If Git is missing on the backend, directory-only conversations and Workspace browsing remain possible, but initialization and Git operations are unavailable. For an uncertain failure, refresh before retrying; no initialization request is automatically replayed. See [Projects](projects.md).
