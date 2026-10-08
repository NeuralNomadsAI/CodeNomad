# Projects and worktrees

CodeNomad groups an opened repository and its registered Git worktrees into one project. Session placement still follows its execution directory.

## Switch projects and sessions

Use project tabs to switch folders and the session list to switch conversations. Selecting another conversation does not move its files or change its working directory.

The session list normally shows parent sessions and their subsessions. Search and filters let you find sessions directly, including subsessions when that option is enabled.

Desktop windows can show different projects or sessions. Tabs, drafts, and layout are restored per window; session history belongs to the shared OpenCode service.

## Use a Git worktree

In the composer's worktree selector, select an existing checkout or choose **Create and use worktree**. Both actions move the session and its subsessions to the destination.

Uncommitted file changes stay in the original checkout; they are not copied to the destination. Creating a worktree outside this selector, for example with Git, does not by itself move a CodeNomad session.

CodeNomad's default worktree location is **`.codenomad/worktrees`** inside the main project checkout. The Files panel can browse another worktree without moving your session or checking out a branch.

## Know where execution happens

Prompts and session commands run in the session's working directory on its execution host. A remote desktop client or browser is only the interface: your project files and tools live on the server host.

On Windows, a configured WSL OpenCode executable runs inside its selected distribution. Keep its tools and paths available there; Git must also be available to the CodeNomad backend for repository features.

## Close without stopping work

Closing a project tab or CodeNomad window detaches that view. It does not shut down the shared OpenCode service.

**Stop**, workspace-stop actions, and shared-service restarts have different scopes. Read the confirmation before interrupting work beyond the selected session.
