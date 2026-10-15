# Projects and worktrees

A project tab connects CodeNomad to a folder on the backend computer. Opening a tab, browsing a checkout and moving a conversation family are different operations.

## Open a project {#open-project}

1. Click **New instance** (`+`) to open the home page.
2. Choose **Browse Folders**, select the backend folder and open it; or choose an entry under **Recent Folders**.
3. For a repository copy, choose **Clone Git Repo**, enter **Repository URL** and **Destination folder**, then **Clone**.

Browsing a remote server means browsing that server's filesystem, not your phone or laptop. Opening a project does not create a separate OpenCode daemon for each tab. Conversations are native OpenCode sessions; their lifetime is not the tab's lifetime.

Cloning writes a repository to the destination. **Remove the destination folder first if it already exists.** is destructive: enable it only when everything already there can be deleted. Use a fresh destination if unsure. A failed clone is not a reason to delete an existing project; inspect the reported destination and error before retrying.

Recent entries are shortcuts. **Rename workspace** changes its displayed name; **Remove from recent** removes the shortcut, not its files or conversations. Clicking an already-open recent project opens a new tab; its **Switch to open project** button selects the existing tab instead.

## Use the new-instance launcher {#new-instance-launcher}

1. Long-press or right-click `+`; with keyboard focus there, use **Alt+Down**, **Shift+F10** or the Menu key.
2. Search recent projects, or select **Browse…**, **Temporary** or **Clone…**.
3. Use **Remote servers**, **SideCar** or **Full home page** for the other destinations.

A normal click still opens the full home page. The launcher is a shortcut, not the management surface: rename/remove recent projects and manage server bookmarks on the home page. Escape dismisses the launcher and returns focus to `+`.

## Close a project tab {#close-stop}

1. Use the tab's close button or **Close Tab** in the command palette (`Ctrl/Cmd+W` in the renderer).
2. Closing the tab closes that project in CodeNomad: it stops following its events and requests. Sessions continue running in OpenCode.
3. Reopen the folder through Browse or Recents to find those conversations again.

| Action | Scope and effect | What it does not do |
| --- | --- | --- |
| Close Tab | Removes that tab's CodeNomad project connection; another tab opened separately on the same folder is unaffected | Does not delete project files or native history, stop sessions or unload OpenCode's Location |
| Stop session | The selected conversation's execution | Does not close the project or delete its history |

If another window displays the same project connection, its tab closes too and that window shows a notification. The initiating window shows none. Closing is immediate; if the backend cannot close the project, an error appears and **Switch to open project** on the home page still reaches it. There is no automatic retry. Unsent drafts from the closed tab are not retained in startup restoration.

Closing a whole window, quitting or reloading does not close its project connections; normal startup restoration still applies. Stop relevant runs explicitly if you need to verify execution ended. CodeNomad never unloads native Locations; shared-service maintenance is described in [OpenCode setup](opencode.md).

## Temporary workspaces {#temporary-workspaces}

1. Choose **Temporary** in the launcher or **New temporary instance** on the home page.
2. Work in the empty CodeNomad-managed folder; Git is not initialized automatically.
3. On closing the tab, choose **Keep**, **Discard** or **Cancel**. The tab menu also offers **Keep as project**.

| Choice | Effect | Recovery |
| --- | --- | --- |
| Keep | Closes the project in CodeNomad, retains the folder and conversations, removes its temporary status and adds a recent project | Reopen from Recents; the folder is not moved |
| Discard | Deletes the temporary workspace's conversations and files | No undo; save anything needed elsewhere first |
| Cancel | Leaves the temporary workspace open | Continue working or decide later |

An untouched temporary tab, with no conversation, file or unsent draft, is discarded quietly on close. Open temporary tabs participate in normal startup restoration, but the home page has no separate list for resuming closed temporary folders.

Discard refuses while a conversation is running or the folder is open in another tab/window. Stop the run and close the other views first. A failed discard remains temporary: resolve the reported problem and retry rather than manually deleting a parent directory.

## Select or create a worktree {#select-create-worktree}

1. Open a parent conversation and use its composer worktree selector. On narrow layouts it is an arrow-only control.
2. Select an existing discovered worktree, or choose **+ Create worktree**.
3. For creation, enter **Name** and choose **Create and use worktree**.

CodeNomad discovers worktrees through OpenCode and verifies that they belong to the opened repository. A new branch name starts at the selected checkout's HEAD. An existing branch name uses that branch's current revision; Git can refuse a branch already checked out elsewhere. Worktrees use the default `.codenomad/worktrees` location. Uncommitted changes remain in the original checkout; creation does not copy them into the new worktree.

The composer selector moves the parent conversation and its recursive descendants as a verified family. A subsession cannot independently change this selector. Active sessions block the operation: let the family finish or stop its execution first. Wait for a move to settle before requesting another; on error, inspect the refreshed conversation/worktree state before retrying.

By contrast, **Worktree to browse** in [Files](files.md) changes only which checkout the panel reads. It does not move a conversation, switch a branch or change where its next shell command runs.

## Remove a worktree {#remove-worktree}

1. In the composer worktree list, use **Delete worktree** for a removable branch worktree.
2. Review the target folder. Leave **Force delete (discard local changes)** off unless local changes may be lost.
3. Confirm deletion and check the resulting inventory.

Deletion removes the worktree's local folder. Git's main checkout is not a removable target. CodeNomad moves affected conversation families back to the root checkout and verifies their placement before removing the worktree; active sessions can block removal. Deletion is not an archive or a backup of uncommitted files.

If Git refuses modified/untracked files, preserve or clean those files before retrying. Force deletion explicitly discards them. For a locked directory, close terminals, editors, watchers and background processes using it. For a missing record, refresh worktrees and inspect the path before trying again. The error dialog offers **Copy sanitized** when sharing diagnostics; review even sanitized text first.

## Initialize Git or work without it {#initialize-git}

1. For an ordinary folder with Git available, open **Files → Changes** or **Commits**.
2. Choose **Initialize Git**. It acts immediately, without an extra confirmation.
3. Wait for project metadata and conversations to refresh; use **Refresh** if Git was initialized outside CodeNomad.

Initialization creates the repository in the explicitly opened folder, not its parent. It does not make a commit. On failure, inspect the message and refresh before retrying: an uncertain reply is not automatically replayed.

If the backend cannot run Git, conversations and bounded file browsing remain available for the explicitly opened folder in directory-only mode. Worktree operations and Git initialization require Git on that backend. See [installation](install.md) and [Files](files.md).
