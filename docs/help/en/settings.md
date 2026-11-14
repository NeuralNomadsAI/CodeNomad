# Settings and layout

With experimental multi-backend enabled, Preferences uses the selected project's server for project settings, providers, statistics and memory, including **Tidy up**. An unavailable server keeps project controls inactive. Device settings and SideCars stay local.

## Open settings and identify the scope {#open-settings}

1. Open **Settings** with the **Open settings** gear in the tab bar (the title bar in the macOS desktop app) or on the home page. Shortcuts such as **Manage Providers** in the model selector, the Missions panel gear or the **Settings** gear in the notification history open the matching section directly.
2. Select a section. Local Electron and Tauri windows open or focus one native Preferences window; browser and remote views use the embedded settings screen.
3. Check the setting's scope and any **Save** action before leaving.

Most choices apply immediately, including Mission preferences, which save each change as you make it. Speech, custom palette colors and Config Files keep an explicit **Save**. A failed save is not confirmation that the change took effect; reopen or refresh the relevant section before retrying. Hover or focus the **i** beside a setting's title for a short explanation. When it links to help, click, press Enter or tap to open the relevant section in your interface language, in the system browser or a separate browser tab. Tooltip-only icons show their explanation on tap. **Settings → Info** also holds the **Support CodeNomad** card: **Sponsor or contribute** opens the [Support CodeNomad](sponsor.md) page.

| State | What it controls |
| --- | --- |
| CodeNomad configuration | UI preferences, speech, SideCars and server settings for clients using that configuration. Preferences without a badge are not stored per device either; **Server setting** marks server-side configuration such as Speech, SideCars, Remote Control and Environment Variables. |
| Window/project-tab layout | Open panels, selected tabs, reader state and restorable drafts/layout. These are not OpenCode configuration. |
| Global/Project OpenCode settings | Native plugin/configuration changes at their displayed scope. Project controls require an active project/Location. |
| Desktop data profile | Native windows, restore state and browser storage, independently of the configuration file and shared OpenCode service. See [Desktop windows and data](desktop.md). |

**Stats** covers the entire connected OpenCode service (all projects, independent clones and subsessions), not only the opened folder, for the last 7, 30, 90 or 365 days. It needs an open project and shows OpenCode's recorded tokens and cost, not provider invoices or subscription allowances; previous saved totals can appear while it refreshes. Plan quotas belong to the **Usage** Status section.

Changing display preferences does not restart OpenCode or replay a prompt. Native configuration, service maintenance and credentials have separate effects: see [OpenCode setup](opencode.md), [Providers](providers.md) and [Integrations](integrations.md).

## Language and appearance {#language-appearance}

1. In **General**, select **Language**: English, Spanish, French, Russian, Japanese, Simplified Chinese, Hebrew, German, Nepali or Turkish.
2. In **Color scheme**, choose **Mode**: **Auto**, **Dark** or **Light**. Auto follows the operating system.
3. Choose a palette for the displayed appearance. Light and dark selections are saved independently; Auto uses the matching one.
4. For custom colors, use the swatches and **Save**; **Reset** restores a built-in palette's colors. Use **New** to name a separate palette and **Delete** to remove one you created.

The UI updates without restarting a conversation. Hebrew uses right-to-left layout; code and technical values remain readable in their own direction. Language selection changes interface text, not the language of existing messages or agent instructions. Native desktop menus switch to the interface language once a CodeNomad window has loaded.

If colors become hard to read, select a built-in palette or reset the edited one. Switching palettes can ask you to discard unsaved color edits; it does not discard a conversation draft.

## Keep the computer awake {#keep-computer-awake}

In **Settings → General**, **Keep the computer awake while CodeNomad is running** is off by default. Turn it on to prevent system sleep while a local CodeNomad window is open (including minimized), even when no session is working; the screen can still turn off. When off, CodeNomad keeps the computer awake only while a session is working. The **i** beside the title explains this behavior. This option appears only in local desktop-app windows and Preferences; it is hidden in browser and remote views.

## Persistent agent memory {#agent-memory}

Sending continues during a memory outage. CodeNomad attempts to remove the session's stale memory instructions; if that cleanup also fails, the previous instructions can remain until a successful refresh. Keep verifying memory claims against current files and commands.

Open **Preferences → General → Memory** (or **Settings → General** in a browser). Memory is off by default. Enable it to let the agent keep useful facts and preferences across conversations. The switch applies to the connected CodeNomad configuration; disabling it retains saved entries and their history. While it is off, agents receive no memory tool; switching applies to running conversations within a few seconds, without restarting.

- **About you**: up to 60 entries shared across projects using this configuration.
- **Project**: up to 200 entries. This interface uses the project selected in Preferences, or the main window's active project in embedded Settings. The agent's `codenomad_memory` tool and session instructions use that session's directory. The server identifies the repository by its normalized Git remote address, falling back to its local repository path; worktrees share this memory. Open a project to select this scope.

Each session, including subsessions, receives recording rules and a bounded list of titles and types (the instruction block is at most about 8,000 characters). The agent is instructed to read relevant entries with `codenomad_memory` before acting, verify claims against current files and commands, and acknowledge saves. Even an empty memory carries the recording rules. Unreadable scopes are omitted as unavailable. When OpenCode lacks the optional session-instructions capability, memory integration stays silently inactive and keeps your saved choice.

1. Select a scope and an entry. **New** and **Modified** mark changes since this browser or desktop view last successfully consulted that scope; they stay visible during the current visit.
2. Edit **Title**, **Type** (**Fact**, **Preference** or **Reference**) and **Text**, then **Save**. Titles allow 60 characters and text 2,000. **Cancel** restores the selected entry's saved content. If another writer changed it, use **Reload** and review before saving again.
3. To remove an entry, open its action menu and confirm **Forget**. It leaves active memory; local Git retains its history, including the old text. Treat forgetting as removal from agent use, not secure erasure.
4. If memory is full, merge or forget entries before retrying. Matching titles or strongly overlapping text replace an existing entry while Git keeps its previous text.

**Needs review** marks suspected instructions that could bypass safeguards or expose credentials. Such entries remain editable here, count toward the limit and are excluded from agent titles and reads. Checks run on every read; correct the content and save, or **Forget** it. A malformed or unreadable memory shows an error rather than an empty list; repair the cause before retrying.

**Tidy up** asks for confirmation, then opens a new conversation in the project shown in Preferences to verify and merge the selected scope. It preserves unverifiable entries and external references and reports its changes. It requires an open project and enabled, readable, writable memory with at least one unflagged entry. If startup cannot be confirmed, inspect the project's conversations before trying again.

Memory is agent-maintained. An agent already keeping memory elsewhere, such as `.claude/…/MEMORY.md`, records a **Reference** to it; external memory files stay under their own management. CodeNomad stores one Markdown file per entry under its configuration directory's `memory/global/` or `memory/projects/<id>/`, with a local Git commit for each saved change or deletion. Storage is local-only, without remote synchronization. See [Desktop windows and data](desktop.md) for configuration and profile boundaries.

## Panels and Status sections {#panels-status}

**Status** comes first by default; a saved tab order takes precedence. It stays available. In **Customize right panel**, its chevron folds or unfolds the list of section checkboxes without hiding the sections themselves.

**Tokens** uses the same metric chips as messages. Collapsed, input, output and cost stay on the header line; expanded, reasoning joins them there and the chips wrap as needed. Totals including subsessions appear below.

Drag a docked panel's inner edge to resize it. The handle stays highlighted and retains the pointer throughout the drag, including when the pointer moves beyond its edge. Release to finish.

1. Use **Left panel** and **Right panel** at the outer header corners, or their **View** menu items, to show or hide each panel.
2. Open **Customize right panel** in the right panel. Use checkboxes to choose built-in tabs and Status sections; at least one Status section remains visible. Drag across these checkboxes to set several at once.
3. Drag right-panel tabs to reorder them. Use **Reset** to restore built-in layout choices.

Recognised [integrations](integrations.md#integration-sections) also have Status sections. Hide them with the same checkboxes; reorder any Status section by dragging or with Up/Down keys. Visibility and order persist across reloads and temporary absence of an integration.

Status includes token information, Yolo mode, provider Usage, background shells, MCP and Plugins. While the conversation has a [goal](conversations.md#goal), a goal line above these sections shows it; that line is not a section and cannot be hidden or moved. Hiding a section does not disable its service or revoke permissions. Narrow layouts close panels that no longer fit instead of squeezing the conversation; a panel opened there floats over it, and opening one floating panel closes the other.

Built-in layout is window layout, not a project mutation. Extension checkboxes are different: they activate code across all projects using the configuration. **Reset** does not change extension consent. See [Panel extensions](extensions.md).

## Transcript detail and composer size {#transcript-composer}

1. Open **Chat** to choose transcript detail defaults. Presets are **Nothing**, **Minimal**, **Balanced** and **Everything**; individual changes produce **Custom**.
2. Set each row's **Default state** (**Hidden**, **Collapsed** or **Expanded**) for thinking, diagnostics, tool inputs, tokens, system messages and each tool type, or use the conversation's **Message content** popup, which shares these choices.
3. In **General**, check **Show the message timeline**, **Put the first/latest message arrows under the timeline**, **Split tool-call diffs** and **Queue sent prompts** (queue prompts sent while a session works instead of steering it) as needed.
4. Resize the composer using its resize control; long drafts scroll inside the field.

The timeline has one marker for each reply, thinking block, tool, compaction and system context shown in the conversation, in the same order. Its markers follow **Message content**: hiding a tool type, thinking or system messages there also hides their markers, except a tool with a pending permission, and **Nothing** hides every tool marker. Visibility and expansion settings only change presentation. They do not remove stored tools/reasoning or compact the model context. See [History and cleanup](history.md) for destructive operations.

Composer height follows the visible conversation, including the software keyboard: minimum 8% with a 44 px floor, maximum 60%. Manual height is remembered proportionally; narrow width and long text do not raise those limits. An expanded permission/question temporarily minimizes the composer without changing its saved height or draft. Collapse or settle the request to resume resizing.

## Notifications and badges {#notifications}

For a project tab on another CodeNomad server, notifications include the server name. **View conversation** opens that exact project and conversation; detaching the server clears its notices. Images and Web search settings follow the project's server, including that server's global defaults.

1. Open **Notifications**. For each kind of notification, check where it appears: **On screen** (a temporary bubble), **History** (kept in the notification history of the bell in the tab bar, or the title bar in the macOS desktop app) and **System** (an operating-system notification). Drag across a row or column of boxes to set several at once.
2. Checking a **System** box asks for permission if needed. Under **System notifications**, **Request** asks again while permission is missing.
3. Enable **Notify when the app is focused** to keep system notifications while this window is focused. Otherwise they appear whenever it is not, even if it stays open on screen.

By default, **A session needs your answer** and **A session finished** go to System only, so passing session states do not pile up in History; they concern main sessions, not subagents, and a session you stop yourself is not announced. Errors always appear on screen and in History, whatever the table says, and short progress messages stay on screen only.

Browser/OS permission belongs to the device and application origin; a saved preference cannot override a denial. If blocked, enable notifications in browser or operating-system settings, then return here. Unsupported environments keep the System column disabled.

The bell/history unread count, which only counts notifications routed to History, drives the browser favicon dot and native application badge. Native badges aggregate live main windows; they are not a count of running sessions or proof that an OS notification was delivered. PWA launcher badges are not provided by this feature.

## Advanced options {#advanced}

1. Open **Advanced**.
2. Check or clear only the options you need; each change saves through CodeNomad preferences. To change the session execution environment, expand the folded **Environment Variables** group at the end.
3. Check the resulting view or next send rather than restarting the shared service speculatively.

| Option | Effect and caution |
| --- | --- |
| Auto-cleanup blank sessions | Cleans blank sessions when creating new ones; leave off if you want to retain them. |
| Keep subagent idle markers | Retains unseen idle markers until viewed rather than hiding them after five seconds. |
| Focus existing window on second launch | Native desktop only; changes second-launch window behavior, not tab creation. |
| Provider credit balance | Shows supplemental balances in Usage; it does not buy credits or switch accounts. |
| Hide whitespace-only changes | Omits whitespace/line-ending-only unstaged files from Changes and its bulk actions; staged files stay visible. See [Files](files.md). |
| Hold long assistant replies | Stops automatic following when a streaming reply grows beyond the viewport. |
| Environment Variables | Applied server-side before each prompt or session command; reads do not update already-running execution. See [OpenCode setup](opencode.md). |

For keyboard configuration use [Keyboard shortcuts](shortcuts.md); for voice controls use [Voice input and playback](voice.md). Startup restore and desktop data profiles are covered in [Desktop windows and data](desktop.md).
