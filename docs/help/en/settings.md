# Settings and layout

## Open settings and identify the scope {#open-settings}

1. Open **Settings** with the **Open settings** gear in the tab bar (the title bar in the macOS desktop app) or on the home page. Shortcuts such as **Manage Providers** in the model selector, the Missions panel gear or **Settings** in the notification history open the matching section directly.
2. Select a section. Local Electron and Tauri windows open or focus one native Preferences window; browser and remote views use the embedded settings screen.
3. Check the setting's scope and any **Save** action before leaving.

Most choices apply immediately, including Mission preferences, which save each change as you make it. Speech, custom palette colors and Config Files keep an explicit **Save**. A failed save is not confirmation that the change took effect; reopen or refresh the relevant section before retrying. Explanations sit behind the **i** beside a setting's title: hover or focus it, or tap it on a touch screen.

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

## Panels and Status sections {#panels-status}

1. Use **Left panel** and **Right panel** at the outer header corners, or their **View** menu items, to show or hide each panel.
2. Open **Customize right panel** in the right panel. Use checkboxes to choose built-in tabs and Status sections; at least one Status section remains visible.
3. Drag right-panel tabs to reorder them. Use **Reset** to restore built-in layout choices.

Status includes token information, Yolo mode, provider Usage, background shells, MCP and Plugins. Hiding a section does not disable its service or revoke permissions. Narrow layouts float panels over the conversation instead of squeezing it; opening one floating panel closes the other.

Built-in layout is window layout, not a project mutation. Extension checkboxes are different: they activate code across all projects using the configuration. **Reset** does not change extension consent. See [Panel extensions](extensions.md).

## Transcript detail and composer size {#transcript-composer}

1. Open **Chat** to choose transcript detail defaults. Presets are **Nothing**, **Minimal**, **Balanced** and **Everything**; individual changes produce **Custom**.
2. Set each row's **Default state** (**Hidden**, **Collapsed** or **Expanded**) for thinking, diagnostics, tool inputs, tokens, system messages and each tool type, or use the conversation's **Message content** popup, which shares these choices.
3. In **General**, check **Show the message timeline**, **Split tool-call diffs** and **Queue sent prompts** (queue prompts sent while a session works instead of steering it) as needed.
4. Resize the composer using its resize control; long drafts scroll inside the field.

The timeline has one marker for each reply, thinking block, tool, compaction and system context shown in the conversation, in the same order. Its markers follow **Message content**: hiding a tool type, thinking or system messages there also hides their markers, except a tool with a pending permission, and **Nothing** hides every tool marker. Visibility and expansion settings only change presentation. They do not remove stored tools/reasoning or compact the model context. See [History and cleanup](history.md) for destructive operations.

Composer height follows the visible conversation, including the software keyboard: minimum 8% with a 44 px floor, maximum 60%. Manual height is remembered proportionally; narrow width and long text do not raise those limits. An expanded permission/question temporarily minimizes the composer without changing its saved height or draft. Collapse or settle the request to resume resizing.

## Notifications and badges {#notifications}

1. Open **Notifications**. For each kind of notification, check where it appears: **On screen** (a temporary bubble), **History** (kept in the notification history of the bell in the tab bar, or the title bar in the macOS desktop app) and **System** (an operating-system notification).
2. Checking a **System** box asks for permission if needed. Under **System notifications**, **Request** asks again while permission is missing.
3. Enable **Notify when the app is focused** to keep system notifications while this window is visible.

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

For keyboard configuration use [Keyboard shortcuts](shortcuts.md); for voice controls use [Voice input and playback](voice.md). Startup restore and deleting saved desktop profiles are covered in [Desktop windows and data](desktop.md).
