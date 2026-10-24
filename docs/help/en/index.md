# CodeNomad help

Use this guide to operate the current CodeNomad desktop or browser workspace with your OpenCode service. It focuses on CodeNomad's controls, execution boundaries and recovery—not OpenCode configuration tutorials or a version archive.

## Read this first {#read-this-first}

CodeNomad connects your workspace to one shared OpenCode background service. Sessions and messages belong to OpenCode; tabs, composer drafts and layout belong to the CodeNomad client. Closing a project tab closes that project in CodeNomad, while sessions continue in OpenCode. Reopen the project to find them again. Closing CodeNomad does not stop OpenCode.

1. Check the [host requirements](install.md#requirements) and [OpenCode setup](opencode.md).
2. [Open a project](projects.md), then choose the conversation's Agent, Model and Thinking controls.
3. Check the affected scope before changing credentials, restarting a service or deleting history. Other clients can use the same native service.

The public help site works without CodeNomad, its backend or a login. **Help → CodeNomad Help** on desktop and **Open help** in the command palette open it separately in the current UI language. Language changes do not translate stored conversations.

**Settings** opens the native **Preferences** window in a local desktop client; browser and remote clients use embedded settings. Paths such as **Settings → Providers** identify the same settings section in either surface.

For a standalone browser workspace on a prepared host, the [server guide](server.md) explains this launch and its authentication/TLS requirements:

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

## Choose your client {#choose-your-client}

| Capability | Local desktop | Direct browser or remote server window | Remote Control paired device |
| --- | --- | --- | --- |
| Projects, conversations, files and history | Backend's folders and native sessions | Connected server's folders and sessions | Host's authorized workspace surfaces |
| Native Preferences and desktop windows | Available | Browser/remote settings stay in the client | Host-only desktop controls unavailable |
| Session browser preview | Native in Electron and Windows Tauri; iframe on other Tauri platforms | Iframe where available | Host-only preview endpoints unavailable |
| Native desktop/browser automation | Owned local windows/previews | Not a substitute for native desktop automation | Host-only automation endpoints unavailable |
| Authentication | Local bootstrap or password session | Server password session | Paired-device credential |
| PWA installation | Use the native app or a browser | Browser-dependent; secure context required | Browser-dependent; pairing still required |

For precise limits, see [browser previews and SideCars](browser-sidecars.md), [Remote Control](remote-control.md) and [mobile/PWA](mobile.md). A remote window does not turn your device's filesystem into the server workspace.

## Know what owns the state {#state-and-scope}

| Term | Meaning in CodeNomad |
| --- | --- |
| Project tab / workspace / instance | A CodeNomad connection to an explicitly opened folder; multiple tabs can use the shared service. |
| Conversation / session | Native OpenCode history and execution associated with its directory. |
| Family | A conversation and its recursive subsessions; relevant to moves, activity, Yolo and Mission controls. |
| Worktree | An owned repository checkout selected for browsing or session placement. Browsing it does not move a conversation. |
| Location | OpenCode's directory-scoped native runtime context; CodeNomad never unloads it when a project closes. |
| CodeNomad backend | The server providing workspace, Git, authentication and client connectivity. Its account and environment determine backend filesystem access. |
| Configuration | CodeNomad settings under the server's config directory; Global/Project OpenCode settings have their own native scope. |
| Window | Its own tabs, navigation, drafts and restored view. Native history is shared, not copied for each window. |
| Desktop data profile | Native/client storage chosen in Settings; it does not automatically isolate OpenCode sessions or every shared configuration. |

The workspace root limits which folders CodeNomad opens; it is not an agent sandbox. Review [security](security.md) before exposing a host or allowing broad tool access.

## Explore by task {#explore-by-task}

| Task | Guide |
| --- | --- |
| Install or serve the workspace | [Install](install.md), [Server reference](server.md), [Network and TLS](remote-access.md) |
| Work across checkouts and conversations | [Projects](projects.md), [Conversations](conversations.md), [Files](files.md) |
| Find history or safely clean it up | [History](history.md) |
| Answer native questions and permissions | [Permissions](permissions.md) |
| Coordinate bounded or daily work | [Missions](missions.md) |
| Configure execution and integrations | [OpenCode](opencode.md), [Providers](providers.md), [Integrations](integrations.md) |
| Connect another device | [Remote Control](remote-control.md), [Security](security.md), [Mobile](mobile.md) |
| Adapt the workspace | [Settings](settings.md), [Shortcuts](shortcuts.md), [Voice](voice.md), [Extensions](extensions.md) |
| Manage the native application | [Desktop](desktop.md), [Browser previews and SideCars](browser-sidecars.md), [Updates](updates.md) |
| Diagnose or contribute | [Troubleshooting](troubleshooting.md), [Support and source builds](support.md) |

## Monitor work without changing it {#monitor-work}

The Status panel exposes the active session's provider usage and native background Shells. Conversation status and child activity identify working, compacting and input-waiting sessions. Monitoring a background Shell is distinct from sending a composer Shell request or using a separately hosted terminal SideCar.

1. Open **Status → Background Shells** for the selected conversation's Location (or the open workspace when no conversation is selected).
2. Inspect command, shell, directory, status, PID and exit code where provided; choose **View output** for the available native output.
3. To dispose of one, use **Stop and remove** while running, or **Remove** after exit, and confirm the target.

Removing a running Shell stops that process; closing its output window does not. Refresh/reconnect reads current native state rather than reconstructing missed output events.

Display snapshots refresh after native changes, reconnect and visible demand. They are not guaranteed replay logs. If a result is uncertain, refresh authoritative state before retrying a mutation; do not submit again merely because a notification or event was missed.
