# Settings and layout

Preferences uses the selected project's server for project settings, providers, statistics and memory, including **Tidy up**. An unavailable server keeps project controls inactive. Device settings and SideCars stay local. Images and Web search settings follow the project's server, including that server's global defaults.

## Open settings and identify the scope {#open-settings}

1. Open **Settings** with the **Open settings** gear in the tab bar. Shortcuts such as **Manage Providers** in the model selector, the Missions panel gear or the **Settings** gear in the notification history open the matching section directly.
2. Select a section. Local Electron and Tauri windows open or focus one native Preferences window; browser and remote views use the embedded settings screen.
3. Check the setting's scope and any **Save** action before leaving.

Most choices apply immediately, including Mission preferences, which save each change as you make it. Voice API settings, custom palette colors and Config Files keep an explicit **Save**. Hover or focus the **i** beside a setting's title for a short explanation. When it links to help, click, press Enter or tap to open the relevant section in your interface language, in the system browser or a separate browser tab. Tooltip-only icons show their explanation on tap. **Settings → Info** also holds the **Support CodeNomad** card: **Sponsor or contribute** opens the [Support CodeNomad](sponsor.md) page.

| State | What it controls |
| --- | --- |
| CodeNomad configuration | Shared UI preferences and **Server setting** controls, including Voice API settings, SideCars, Remote Control and Environment Variables. |
| Voice engines | The [desktop dictation engine](voice.md#desktop-dictation) applies across projects on this device. The [conversation engine](voice.md#conversation) is selected for the desktop profile or the browser profile and connected server. |
| Window/project-tab layout | Open panels, selected tabs, reader state and restorable drafts/layout. These are not OpenCode configuration. |
| Global/Project OpenCode settings | Native plugin/configuration changes at their displayed scope. Project controls require an active project/Location. |
| Desktop data profile | Native windows, restore state and browser storage, independently of the configuration file and shared OpenCode service. See [Desktop windows and data](desktop.md). |

The selected right-panel tab and Files mode are saved separately for each project tab. Your latest explicit choices supply defaults for new tabs; panel sizes, tab order, customization and appearance remain shared layout/preferences.

**Stats** covers the entire connected OpenCode service (all projects, independent clones and subsessions), not only the opened folder, for the last 7, 30, 90 or 365 days. It needs an open project and shows OpenCode's recorded tokens and cost, not provider invoices or subscription allowances; previous saved totals can appear while it refreshes. Plan quotas belong to the **Usage** Status section.

## Language and appearance {#language-appearance}

1. In **General**, select **Language**: English, Spanish, French, Russian, Japanese, Simplified Chinese, Hebrew, German, Nepali or Turkish.
2. In **Color scheme**, choose **Mode**: **Auto**, **Dark** or **Light**. Auto follows the operating system.
3. Beside **Mode**, choose **Contrast**: **Auto** (the default) follows the system's contrast preference; **On** increases contrast with any palette; **Off** uses normal contrast.
4. Choose a palette for the displayed appearance. Light and dark selections are saved independently; Auto uses the matching one.
5. For custom colors, use the swatches and **Save**; **Reset** restores a built-in palette's colors. Use **New** to name a separate palette and **Delete** to remove one you created.

Contrast applies and saves immediately, independently of **Save** for colors. It adapts rendering while preserving your selected palette, editable colors and conversation draft. The **i** shows the current contrast state in Auto.

The UI updates without restarting a conversation. Hebrew uses right-to-left layout; code and technical values remain readable in their own direction. Language selection changes interface text, not the language of existing messages or agent instructions. Native desktop menus switch to the interface language once a CodeNomad window has loaded.

If colors become hard to read, set **Contrast → On**. You can also select a built-in palette or reset the edited one. Switching palettes can ask you to discard unsaved color edits; your conversation draft is preserved.

## Keep the computer awake {#keep-computer-awake}

In **Settings → General**, **Keep the computer awake while CodeNomad is running** is off by default. Turn it on to prevent system sleep while a local CodeNomad window is open (including minimized), even when no session is working; the screen can still turn off. When off, CodeNomad keeps the computer awake only while a session is working. This option appears only in local desktop-app windows and Preferences; it is hidden in browser and remote views.

## New conversation permissions {#new-conversation-permissions}

In **Settings → General → New conversation permissions**, choose **Autonomous** (the default) or **Supervised** for new top-level conversations you create in CodeNomad. This leaves existing conversations unchanged. To change one, open [Status → Permissions](permissions.md#conversation-mode) in that conversation.

## Persistent agent memory {#agent-memory}

Authenticated users over Remote Control, verified HTTPS, LAN or an installed PWA can review, edit and **Tidy up** memory for the selected local or remote project.

CodeNomad attempts to remove the session's stale memory instructions; if that cleanup also fails, the previous instructions can remain until a successful refresh.

Open **Preferences → General → Memory** (or **Settings → General** in a browser). Memory is off by default. Enable it to let the agent keep useful facts and preferences across conversations. The switch applies to the connected CodeNomad configuration; disabling it retains saved entries and their history. While it is off, agents receive no memory tool; switching applies to running conversations within a few seconds, without restarting.

- **About you**: up to 60 entries shared across projects using this configuration.
- **Project**: up to 200 entries. This interface uses the project selected in Preferences, or the main window's active project in embedded Settings. The server identifies the repository by its normalized Git remote address, falling back to its local repository path; worktrees share this memory. Open a project to select this scope.

1. Select a scope, unfold its entry count (for example **7/200**) and select an entry. **New** and **Modified** mark changes since this browser or desktop view last showed that scope's entries; the folded count line repeats them, and they stay visible during the current visit.
2. Edit **Title**, **Type** (**Fact**, **Preference** or **Reference**) and **Text**, then **Save**. Titles allow 60 characters and text 2,000. **Cancel** restores the selected entry's saved content. If another writer changed it, use **Reload** and review before saving again.
3. To remove an entry, open its action menu and confirm **Forget**. It leaves active memory; local Git retains its history, including the old text. Treat forgetting as removal from agent use, not secure erasure.
4. If memory is full, merge or forget entries before retrying. Matching titles or strongly overlapping text replace an existing entry while Git keeps its previous text.

**Needs review** marks suspected instructions that could bypass safeguards or expose credentials. Such entries remain editable here, count toward the limit and are excluded from agent titles and reads. Checks run on every read; correct the content and save, or **Forget** it.

**Tidy up** asks for confirmation, then opens a new conversation in the project shown in Preferences to verify and merge the selected scope. It preserves unverifiable entries and external references and reports its changes. It requires an open project and enabled, readable, writable memory with at least one unflagged entry.

Memory is agent-maintained. An agent already keeping memory elsewhere, such as `.claude/…/MEMORY.md`, records a **Reference** to it; external memory files stay under their own management. Storage is local-only, without remote synchronization. See [Desktop windows and data](desktop.md) for configuration and profile boundaries.

## Panels and Status sections {#panels-status}

**Status** comes first by default; a saved tab order takes precedence. It stays available. In **Customize right panel**, its chevron folds or unfolds the list of section checkboxes without hiding the sections themselves.

Drag a docked panel's inner edge to resize it.

1. Use **Left panel** and **Right panel** at the outer header corners, or their **View** menu items, to show or hide each panel.
2. Open **Customize right panel** in the right panel. Use checkboxes to choose built-in tabs and Status sections; at least one Status section remains visible. Drag across these checkboxes to set several at once.
3. Drag right-panel tabs to reorder them. Use **Reset** to restore built-in layout choices.

Reorder any Status section by dragging its grip or with Up/Down keys. Visibility and order persist across reloads.

Status includes token information, Permissions, provider Usage, background shells, MCP and Plugins. While the conversation has a [goal](conversations.md#goal), a goal line above these sections shows it; that line is not a section and cannot be hidden or moved. Hiding a section does not disable its service or revoke permissions. Narrow layouts close panels that no longer fit instead of squeezing the conversation; a panel opened there floats over it, and opening one floating panel closes the other.

Built-in layout belongs to the window. The [Missions checkbox](missions.md#activation) also changes Global plugin activation and is skipped when dragging across checkboxes. Extension checkboxes activate code across all projects using the configuration. **Reset** does not change extension consent. See [Panel extensions](extensions.md).

## Transcript detail and composer size {#transcript-composer}

1. Open **Chat** to choose transcript detail defaults. Presets are **Nothing**, **Minimal**, **Balanced** and **Everything**; individual changes produce **Custom**.
2. Set each row's **Default state** (**Hidden**, **Collapsed** or **Expanded**), or use the conversation's **Message content** popup, which shares these choices. For **Tool groups**, **Disabled** gives each call its own card; **Collapsed** and **Expanded** set how groups open.
3. In **General**, check **Show the message timeline**, **Put the first/latest message arrows under the timeline**, **Split tool-call diffs** and **Queue sent prompts** (queue prompts sent while a session works instead of steering it) as needed.
4. Resize the composer using its resize control; long drafts scroll inside the field.

The timeline has one marker for each reply, thinking block, tool, compaction and system context shown in the conversation, in the same order. Its markers follow **Message content**: hiding a tool type, thinking or system messages there also hides their markers, except a tool with a pending permission, and **Nothing** hides every tool marker. Visibility and expansion settings only change presentation. They do not remove stored tools/reasoning or compact the model context. See [History and cleanup](history.md) for destructive operations.

Manual composer sizing uses the conversation height without the on-screen keyboard: minimum 8% with a 44 px floor, maximum 60%. Narrow width and long text do not raise those limits. When the keyboard opens, the field can shrink temporarily to leave room for controls and messages, without changing the saved height proportion. An expanded permission/question temporarily minimizes the composer without changing its saved height or draft. Collapse or settle the request to resume resizing.

## Notifications and badges {#notifications}

For a project tab on another CodeNomad server, notifications include the server name. **View conversation** opens that exact project and conversation; detaching the server clears its notices.

Compaction of technical Mission sessions is silent.

1. Open **Notifications**. For each kind of notification, check where it appears: **On screen** (a temporary bubble), **History** (kept in the notification history of the bell in the tab bar) and **System** (an operating-system notification). Drag across a row or column of boxes to set several at once.
2. Checking a **System** box asks for permission if needed. Under **System notifications**, **Request permission** asks again while permission is missing.
3. Enable **Notify when the app is focused** to keep system notifications while this window is focused. Otherwise they appear whenever it is not, even if it stays open on screen.

By default, **A session needs your answer** and **A session finished** go to System only, so passing session states do not pile up in History; they concern main sessions, not subagents, and a session you stop yourself is not announced. Errors always appear on screen and in History, whatever the table says, and short progress messages stay on screen only.

Browser/OS permission belongs to the device and application origin; a saved preference cannot override a denial. If blocked, enable notifications in browser or operating-system settings, then return here. Unsupported environments keep the System column disabled.

The bell/history unread count, which only counts notifications routed to History, drives the browser favicon dot and native application badge.

If your system supports notification actions, clicking a notification opens the conversation if it’s still open. Whether the window comes to the front depends on your desktop environment.

## Advanced options {#advanced}

In Rune, focus **i** beside an unavailable switch to learn why it is disabled. Config Files reports JSON/JSONC syntax errors by line and still lets you save.

1. Open **Advanced**.
2. Check or clear only the options you need; each change saves through CodeNomad preferences. To change the session execution environment, expand the folded **Environment Variables** group at the end.

| Option | Effect and caution |
| --- | --- |
| Auto-cleanup blank sessions | Cleans blank sessions when creating new ones; leave off if you want to retain them. |
| Keep subagent idle markers | Retains unseen idle markers until viewed rather than hiding them after five seconds. |
| Focus existing window on second launch | Native desktop only; changes second-launch window behavior, not tab creation. |
| Provider credit balance | Shows supplemental balances in Usage; it does not buy credits or switch accounts. |
| Hide whitespace-only changes | Omits whitespace/line-ending-only unstaged files from Changes and its bulk actions; staged files stay visible. See [Files](files.md). |
| Hold long assistant replies | Stops automatic following when a streaming reply grows beyond the viewport. |
| Environment Variables | Applied server-side before each prompt or session command; reads do not update already-running execution. See [OpenCode setup](opencode.md). |

For keyboard configuration use [Keyboard shortcuts](shortcuts.md); **Voice** groups [Dictation, Playback and Conversation](voice.md). Startup restore and desktop data profiles are covered in [Desktop windows and data](desktop.md).
