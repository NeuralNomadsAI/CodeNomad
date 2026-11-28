# Projects and worktrees

A project tab connects CodeNomad to a folder on the backend computer. Opening a tab, browsing a checkout and moving a conversation family are different operations.

## Open a project {#open-project}

When no tabs are restored or the last tab closes, CodeNomad shows an empty tab. Click **New instance** (`+`) or press `Ctrl/Cmd+N` to open a new empty tab. Pick a project from **Browse** or **Recent tabs**. **Temporary tab** and **Clone repository** use the local backend.

In Recents, **Open** switches to a tab in this window. The green **Open elsewhere** dot marks a connection on the project’s server outside this window. Selecting the row opens a separate tab.

[Open a remote project in a tab](remote-access.md#remote-project-tabs) · [SideCars](browser-sidecars.md#register-sidecar)

For a repository copy, choose **Clone repository**, enter **Repository URL** and **Destination folder**, then **Clone**. **Destination folder** is prefilled with the repository name in the folder that holds your last clone, or next to your most recent project. **Browse** chooses the folder that contains the clone; you can also edit the path, including the clone's folder name.

Browsing a remote server means browsing that server's filesystem, not your phone or laptop. Opening a project does not create a separate OpenCode daemon for each tab. Conversations are native OpenCode sessions; their lifetime is not the tab's lifetime.

Cloning writes a repository to the destination. **Remove the destination folder first if it already exists.** is destructive: enable it only when everything already there can be deleted. Use a fresh destination if unsure. A failed clone is not a reason to delete an existing project; inspect the reported destination and error before retrying.

Recent entries are shortcuts. The empty tab’s project-actions menu offers **Rename workspace** and **Remove from recent** where available; removal keeps files and conversations. In the empty tab and quick launcher, clicking a local project, remote project or SideCar creates a new occurrence, even when already open. Its separate **Open** action (**Switch to open project**) selects the existing occurrence instead.

The **Open** action also selects a tab waiting for its server and closes the originating empty tab.

## Use the new-instance launcher {#new-instance-launcher}

Long-press or right-click `+`; with keyboard focus there, use **Alt+Down**, **Shift+F10** or the Menu key.
Tab searches, arrows and Enter select, and Escape returns focus to `+`.

## Close a project tab {#close-stop}

1. Use the tab's close button or **Close Tab** in the command palette (`Ctrl/Cmd+W` in the renderer).
2. Closing the tab closes that project in CodeNomad: it stops following its events and requests. Sessions continue running in OpenCode.
3. Reopen the folder through Browse or Recents to find those conversations again.

| Action | Scope and effect | What it does not do |
| --- | --- | --- |
| Close Tab | Removes that tab's CodeNomad project connection; another tab opened separately on the same folder is unaffected | Does not delete project files or native history, stop sessions or unload OpenCode's Location |
| Stop session | The selected conversation's execution | Does not close the project or delete its history |

Unsent drafts and attachments of the closed tab return when you reopen the same folder in that window; the window keeps them for its 16 most recently closed projects until it reloads or closes. They are not part of startup restoration.

When you close or reload a window or browser tab, or quit the app, CodeNomad asks the servers to release its project connections. An unreachable server may keep the records. Other windows keep their tabs. Startup restoration reconnects saved tabs and keeps open temporary folders. Stop runs explicitly to end their execution; see [OpenCode setup](opencode.md) for shared-service maintenance.

With startup restoration enabled, each remaining tab restores its own panel choices, Mission selection/reader and chat/web preview choice. Browser URLs and history are shared per session; saved pages load only when the web preview is explicitly reopened. Closing one occurrence removes only its saved view; reopening the folder creates a new occurrence.

Duplicating a browser tab opens its own project connections. Only resuming the same tab after the browser discarded it can reuse a connection that's still open.

## Restore remote tabs {#restore-remote-tabs}

When you reload with restoration enabled, remote tabs keep their order, selection and drafts. An unavailable server leaves a waiting tab: choose **Retry** when it returns, or **Connect** with its username/password or a fresh link in **New pairing link**. Other servers remain usable. **Server not found** means the saved server is missing.

**Retry** reconnects the project on the saved server and recreates its connection if needed.

**Retry** also recovers waiting tabs when automatic startup restoration is off. Notifications select the existing waiting tab. Check an unconfirmed conversation action's outcome before sending it again.

## Temporary workspaces {#temporary-workspaces}

1. Choose **Temporary tab** at the top of the empty tab.
2. Work in the empty CodeNomad-managed folder; Git is not initialized automatically.
3. On closing the tab, choose **Keep**, **Discard** or **Cancel**. The tab menu also offers **Keep as project**.

| Choice | Effect | Recovery |
| --- | --- | --- |
| Keep | Closes the project in CodeNomad, retains the folder and conversations, removes its temporary status and adds a recent project | Reopen from Recents; the folder is not moved |
| Discard | Deletes the temporary workspace's conversations, files and unsent drafts | No undo; save anything needed elsewhere first |
| Cancel | Leaves the temporary workspace open | Continue working or decide later |

An untouched temporary tab, with no conversation, file or unsent draft, is discarded quietly on close. Open temporary tabs participate in normal startup restoration.

Discard refuses while a conversation is running or the folder is open in another tab/window. Stop the run and close the other views first. A failed discard remains temporary: resolve the reported problem and retry rather than manually deleting a parent directory.

## Select or create a worktree {#select-create-worktree}

1. Open a parent conversation and use its composer worktree selector. On narrow layouts it is an arrow-only control.
2. Select an existing discovered worktree, or choose **+ Create worktree**.
3. For creation, enter **Name** and choose **Create and use worktree**.

When the project is a folder inside a repository, only worktrees that contain that folder are listed. Creating a worktree from such a folder requires Git to track it. A new branch name starts at the selected checkout's HEAD. An existing branch name uses that branch's current revision; Git can refuse a branch already checked out elsewhere. Worktrees use the default `.codenomad/worktrees` location. Uncommitted changes remain in the original checkout; creation does not copy them into the new worktree.

The composer selector moves the parent conversation and its recursive descendants as a verified family. A subsession cannot independently change this selector. Active sessions block the operation: let the family finish or stop its execution first. Wait for a move to settle before requesting another; on error, inspect the refreshed conversation/worktree state before retrying.

By contrast, **Worktree to browse** in [Files](files.md) changes only which checkout the panel reads. It does not move a conversation, switch a branch or change where its next shell command runs.

## Remove a worktree {#remove-worktree}

1. In the composer worktree list, use **Delete worktree** for a removable branch worktree.
2. Review the target folder. Leave **Force delete (discard local changes)** off unless local changes may be lost.
3. Confirm deletion and check the resulting inventory.

Deletion removes the worktree's local folder. Git's main checkout is not a removable target. CodeNomad moves affected conversation families back to the root checkout and verifies their placement before removing the worktree; active sessions can block removal. Deletion is not an archive or a backup of uncommitted files.

If Git refuses modified/untracked files, preserve or clean those files before retrying. Force deletion explicitly discards them. For a locked directory, close terminals, editors, watchers and background processes using it. The error dialog offers **Copy sanitized** when sharing diagnostics; review even sanitized text first.

## Initialize Git or work without it {#initialize-git}

1. For an ordinary folder with Git available, open **Files → Changes** or **Commits**.
2. Choose **Initialize Git**. It acts immediately, without an extra confirmation.
3. Wait for project metadata and conversations to refresh; use **Refresh** if Git was initialized outside CodeNomad.

Initialization creates the repository in the explicitly opened folder, not its parent. It does not make a commit.

If the backend cannot run Git, conversations and bounded file browsing remain available for the explicitly opened folder in directory-only mode. Worktree operations and Git initialization require Git on that backend. See [installation](install.md) and [Files](files.md).
