# Conversations

Messages render Markdown, code, diffs and supported tool-result images. Multi-file patches show per-file changes up to the display limit; copying the tool output includes all files. **Message content** changes visibility without deleting stored parts; [History](history.md#operation-reference) distinguishes display controls from cleanup.

Reasoning and tool headers show how long each step took, counting live while it runs; durations under one second are not shown. When **Tokens** is shown in **Message content** (the **Everything** preset shows it), each agent message ends with one token and cost line after its final text. That line adds up the message and the messages holding the tools and reasoning that its **Remove tools and reasoning from this response** action covers, within the loaded transcript; expand it for reasoning and cache counts.

## Mermaid diagrams {#mermaid}

Fenced `mermaid` and `mmd` blocks render with Mermaid Tiny after streaming finishes. Use **Show source** / **Show diagram** in the code header; Copy keeps the source text. Tiny excludes mindmaps, architecture diagrams and KaTeX. Rendering is local and network-disabled, with a 50,000-character and 500-edge limit.

## Find and navigate conversations {#navigate-conversations}

1. Select a row under **Sessions**, or use **New session** to start a parent conversation.
2. Click a parent's chevron to expand or collapse its subsessions while keeping their badges intact. Expanded or collapsed, the chevron shows its descendants' most urgent state: needing input, working, compacting or idle; its accessible label counts them. Right-click it and choose **Mark as read** to clear the **Idle** and **Interrupted** badges of the conversation and all its subsessions at once.
3. Use **Search sessions…**, **Main sessions** / **Subsessions**, the worktree filter and **Activity**, **Name** or **Worktree** sorting to narrow the list. In search results, drag across the rows' checkboxes to select or clear several conversations at once.
4. Use the sidebar's **Back** and **Forward** to revisit conversations you displayed.

Click an **Idle** or **Interrupted** badge (**Clear**) to acknowledge it without opening the conversation, or press Enter/Space while it is focused. With a mouse or pen, press a badge and drag across others to clear several; touch drags keep scrolling. Working and pending input/permission indicators stay visible. Viewing clears **Idle**; **Interrupted** requires an explicit clear gesture. Acknowledgements are saved with this window's session state; a new interruption shows the badge again.

Normal browsing is hierarchical; search/filter results are flat entries with each conversation's own identity and worktree. In **Settings → General**, **Automatically expand subsessions** is enabled by default. Visible branches in the selected conversation open when subsessions start working, compacting or awaiting input. Disable the option to keep activity from opening branches; manual expansion and explicit navigation remain available. Open branches, including automatically opened ones, are saved for restoration.

Back/Forward is a per-project-tab, per-window visit history, not list order. The palette's **Previous Session** / **Next Session** instead cycle the visible list.

## Keep conversations in favorites {#favorites}

Hover over or focus a session row to reveal its actions. On touch, the actions are visible without hovering. Use the star button or, when space is tight, open **More actions** (⋯) and choose **Add to favorites** or **Remove from favorites**.

In the tree, requests needing your input come first. Favorites move ahead of other sessions at the same level under the same parent. Each branch keeps its expanded or collapsed state. In search, **Activity** prioritizes matching favorites, including subsessions when shown. **Name** and **Worktree** use their own order.

In session search, choose **Favorites only**. **Show … hidden matches** enables both session types without changing the search, worktree or other filters. **Reset** restores the default filters and sort.

Windows on the same CodeNomad backend share favorites for the same opened folder. Session cleanup keeps favorites and their ancestors; you can still delete them explicitly.

## Archive and restore {#archive}

Choose **Archive session** in a session row's actions to keep its history while removing its idle branch from normal browsing. The selected conversation and conversations with running work or pending questions remain reachable. Archiving does not stop work, delete messages or change subsessions' own archive flags.

Open **Search sessions…** and choose **Archived sessions** or **All sessions** to find archived conversations. Rows show **Archived** and offer **Restore session**. Enable **Subsessions** to find children independently, including children beneath an archived parent. **Unarchived sessions** filters by each conversation's own flag. Restore an archived ancestor to bring its idle branch back into normal browsing.

## Choose Agent, Model and Thinking {#agent-model-thinking}

1. Use the composer footer's agent and model selectors before sending.
2. If the model exposes variants, select its **Thinking** effort; **Default** leaves the native default in use.
3. Send the next prompt and check the response's agent/model metadata when diagnosing a result.

A new conversation starts with the agent OpenCode resolves as its default, which a plugin can set, unless you choose another. The selectors' tooltips show their shortcuts.

These are execution choices for subsequent sends, not edits to earlier responses. Reading an old timeline passage does not replace the composer's current choices with historical metadata. Model visibility, favorites and provider connections are managed in [Providers](providers.md).

## Drafts and attachments {#drafts-attachments}

In Rune, hover over an image attachment to preview it, or use **Enlarge image** to open it at a larger size.

1. Compose in the selected conversation. Switching conversations retains its draft rather than sending it.
2. Choose **Attach file…** in the composer's **More actions** menu, or drop or paste, for files from this device; or type `@` to select project files, agents or skills.
3. Review the attachment chips and remove anything not intended for the next send.

| Input | Source and effect |
| --- | --- |
| Device attachment | Picker, drop or clipboard reads bytes from the device running the UI; this is not a server path |
| Project `@` reference | Resolves in the conversation's project/Location on the backend, including its worktree |
| Agent mention | Attaches the selected agent reference rather than changing past messages |
| Skill | Searches the Location's skills by name/description and attaches a removable skill selection |

Device files must be readable and fit the attachment budget: at most 5 MiB each, 10 files and 20 MiB total. A rejected file is not attached; review the notice instead of assuming the whole selection succeeded.

Choosing a skill removes the `@query` token and adds a chip. Sending clears that composer selection, not the instructions already stored by OpenCode with the sent message. Historical messages retain skill labels.

On desktop, sending moves keyboard focus to the conversation, so arrows, paging and Space scroll it; typing a character returns to the composer with that character. **Clear prompt text** in **More actions** (default **Ctrl/Cmd+K**) clears the composer's draft.

Drafts are client-side working state, not shared native messages. Startup restoration can retain supported composer state, but do not treat an unsent draft or attachment as a backup or assume it appears on another device. Save important text before clearing startup data or closing a client whose restore policy is disabled; see [Desktop](desktop.md).

## Open files from replies {#open-files-from-replies}

1. Agent replies link project files with relative and absolute paths.
2. A path written as plain text or inside inline code becomes a link too when the conversation's worktree is known to contain the file — file names in any writing system included; missing paths stay plain text. In the desktop app, for a project on this computer, folders become links too.
3. A plain click opens the linked file in the file preview, read from the conversation’s worktree.
4. In the desktop app, for a project on this computer, the file preview keeps the text files and images it can show. Folders, other files (videos, PDFs…), paths outside the worktree and `file:` links open with your system, as Ctrl/Cmd-click and middle-click always do; an error appears if they cannot be opened.
5. Elsewhere, modified clicks (Ctrl/Cmd-click, Shift-click, middle-click) and links outside the session's worktree keep normal link behavior.

## Commands and Shell mode {#commands-shell}

1. Type `/` and select a discovered custom command, then supply its arguments.
2. For a direct shell command, type `!` at the start of an empty composer to enter **Shell mode**.
3. Send the command. To leave Shell mode without running it, use Escape, or Backspace in an empty field.

Only known slash-command names take the custom-command route; unknown `/text` is an ordinary prompt. File/image attachments are not sent through that command route and remain available for a later prompt; pasted text used in arguments is resolved into the arguments.

Shell mode runs a native session shell request, not a request for the model to suggest a command. It can change files and start processes on the execution host. Profile environment settings apply before the next prompt, custom command or shell request; they do not restart an existing service. See [Integrations](integrations.md) and [OpenCode setup](opencode.md).

## Steer, Queue and edit follow-ups {#follow-ups}

1. In **Settings → General**, turn on **Queue sent prompts** to queue follow-ups sent while the session is busy; leave it off (the default) to steer the running task.
2. While the session is busy, send a follow-up using that behavior. For the other behavior, choose **Queue message** or **Steer now** in the composer's **More actions** menu, or use the alternate-send shortcut (default **Alt+Enter** on Windows and Linux, **Cmd+Shift+Return** on macOS; see [Shortcuts](shortcuts.md)).
3. In the prompt queue, use **Steer now**, **Move to queue**, **Edit queued prompt** or **Remove queued prompt** while the entry is still pending.

| Delivery | Effect |
| --- | --- |
| Steer | Native steering input for the ongoing execution |
| Queue | Native queued follow-up, held for subsequent processing |

At rest, an ordinary send uses the normal immediate route regardless of that switch, and the **More actions** alternative is unavailable. Editing restores a pending prompt and its removable attachments into the composer; **Cancel editing** leaves the edit flow. A prompt already consumed by OpenCode is no longer an editable pending entry. Removing an entry does not undo work already performed.

## Ask a side question with /btw {#side-question}

1. Send `/btw your question` in an existing conversation, or `/btw` to open the side-question window.
2. Read the answer, use **Copy answer**, or choose **Cancel question** while it is pending.
3. Close the window when finished.

This is one separate model request using the session context. It does not run a tool loop, take actions or append its question/answer to the conversation. File/image attachments stay in the composer; pasted text used in the question is included as text.

Closing cancels the pending side request without interrupting the main session. Leaving the active conversation clears this ephemeral window; copy anything you need first.

## Keep working toward a goal with /goal {#goal}

1. Send `/goal` followed by an objective, for example `/goal Make every test pass`. The session keeps working, turn after turn, until OpenCode's goal reviewer decides the objective is met.
2. While the conversation has a goal, **Status** shows it on one line above **Tokens**: its state (**Active**, **Paused** or **Complete**), the objective and the rounds used out of the allowed maximum. Hover or focus the objective to read it whole, with the reason for the last change, such as why the goal paused or was met.
3. Use **Pause goal** or **Resume goal** on that line, or send `/goal pause` or `/goal resume`. Use **Clear goal** or `/goal clear` to remove the goal.

A goal belongs to its conversation: subsessions and forks start without one. OpenCode also pauses a goal itself when you stop the session, when a run fails, when it stops making progress, at its round limit or when the service restarts; resume it to continue. Pausing or clearing does not undo work already done. Without a goal, or with an OpenCode service that has no goal support, the line does not appear.

## Track session automations with /automation {#automations}

1. Create or manage scheduled or event-driven automations in a conversation with `/automation` (or through the agent's automation tools).
2. While the conversation has automations, **Status** lists them above **Tokens** (below **Goal** when one is set): each row shows its state (**Active**, **Paused** or **Done**), name, next run or schedule, and run count. Completed automations stay folded under **Done (N)** until expanded.
3. Hover or focus a row to read its trigger, schedule and last output, or click it to open its details window. Use **Pause automation**, **Resume automation**, or **Delete automation** on a row to control it directly.

Only automations belonging to the active conversation are shown. Deleting an automation cannot be undone and does not revert work already performed. Without automations, or with an OpenCode service that does not expose the automation API, the block does not appear.

## Fork, undo and recover a failed run {#fork-errors}

In Rune, undo fills an empty composer with the original text. Use **Redo Last Message** above the conversation to restore the staged history. Undo and technical cleanup require server support.

1. On a message, choose **Fork after this message** to create a conversation after that point without replacing the original.
2. For undo, review **Undo changes up to here (deletes messages)** carefully. The palette offers **Undo Last Message** and **Redo Last Message** for the staged undo. Undo is disabled without an undoable user message; Redo is disabled without a staged undo.
3. If execution fails, inspect **Session error**, the response error and any **Send failed** details before sending again.

Forking copies conversation context through the selected point; it does not create a Git worktree or isolate files. Revert is not merely navigation. Review file effects and the undo boundary before continuing; use a fork when you want an alternative discussion without rewriting the original path.

A **Retrying** status with a countdown means OpenCode is retrying a provider error on its own; wait for it or stop the session rather than sending again. A failed run may already have executed tools: inspect [Files](files.md), pending [requests](permissions.md) and native activity before retrying. **Stop session** interrupts execution, not a rollback of file or external-service changes.

In Rune, disconnecting from the event stream keeps sending available for the open conversation. A rejected send leaves the draft intact with the error; an unconfirmed prompt stays held until its receipt arrives or history reconciles, an unconfirmed slash command stays held until its receipt arrives, and reconnecting never dispatches either again.
