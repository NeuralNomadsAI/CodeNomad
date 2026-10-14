# Conversations

CodeNomad presents native OpenCode sessions as conversations, with a hierarchy for delegated work and separate controls for what you send next.

Messages render Markdown, code, diffs and supported tool-result images. Text copy, full-history search and speech use text projections, not embedded image bytes. **Message content** changes visibility without deleting stored parts; [History](history.md#operation-reference) distinguishes display controls from cleanup.

## Find and navigate conversations {#navigate-conversations}

1. Select a row under **Sessions**, or use **New session** to start a parent conversation.
2. Expand a parent's chevron to see its subsessions. A collapsed chevron can indicate working descendants or descendants needing input.
3. Use **Search sessions…**, **Main sessions** / **Subsessions**, the worktree filter and **Activity**, **Name** or **Worktree** sorting to narrow the list.
4. Use the sidebar's **Back** and **Forward** to revisit conversations you displayed.

Normal browsing is hierarchical; search/filter results are flat entries with each conversation's own identity and worktree. A newly working subsession is automatically revealed only beneath the active conversation's family. Collapsing that branch dismisses that automatic reveal for the currently running descendants.

Back/Forward is a per-project-tab, per-window visit history, not list order. It is kept in memory, skips unavailable/deleted conversations and is not restored after restart. Selecting a new conversation after going back replaces the forward path. The palette's **Previous Session** / **Next Session** instead cycle the visible list.

## Choose Agent, Model and Thinking {#agent-model-thinking}

1. Use the composer footer's agent and model selectors before sending.
2. If the model exposes variants, select its **Thinking** effort; **Default** leaves the native default in use.
3. Send the next prompt and check the response's agent/model metadata when diagnosing a result.

These are execution choices for subsequent sends, not edits to earlier responses. Reading an old timeline passage does not replace the composer's current choices with historical metadata. Model visibility, favorites and provider connections are managed in [Providers](providers.md).

## Drafts and attachments {#drafts-attachments}

1. Compose in the selected conversation. Switching conversations retains its draft rather than sending it.
2. Choose **Attach file…** for files from this device, or type `@` to select project files, agents or skills.
3. Review the attachment chips and remove anything not intended for the next send.

| Input | Source and effect |
| --- | --- |
| Device attachment | Picker, drop or clipboard reads bytes from the device running the UI; this is not a server path |
| Project `@` reference | Resolves in the conversation's project/Location on the backend, including its worktree |
| Agent mention | Attaches the selected agent reference rather than changing past messages |
| Skill | Searches the Location's skills by name/description and attaches a removable skill selection |

Device files must be readable and fit the attachment budget: at most 5 MiB each, 10 files and 20 MiB total. A rejected file is not attached; review the notice instead of assuming the whole selection succeeded.

Choosing a skill removes the `@query` token and adds a chip. Sending clears that composer selection, not the instructions already stored by OpenCode with the sent message. Historical messages retain skill labels. Removing a skill while editing a queued prompt keeps it removed from the replacement send.

Drafts are client-side working state, not shared native messages. Startup restoration can retain supported composer state, but do not treat an unsent draft or attachment as a backup or assume it appears on another device. Save important text before clearing startup data or closing a client whose restore policy is disabled; see [Desktop](desktop.md).

## Commands and Shell mode {#commands-shell}

1. Type `/` and select a discovered custom command, then supply its arguments.
2. For a direct shell command, type `!` at the start of an empty composer to enter **Shell mode**.
3. Send the command. To leave Shell mode without running it, use Escape, or Backspace in an empty field.

Only known slash-command names take the custom-command route; unknown `/text` is an ordinary prompt. Custom commands use their native definition. File/image attachments are not sent through that command route and remain available for a later prompt; pasted text used in arguments is resolved into the arguments.

Shell mode runs a native session shell request, not a request for the model to suggest a command. It can change files and start processes on the execution host. Profile environment settings apply before the next prompt, custom command or shell request; they do not restart an existing service. See [Integrations](integrations.md) and [OpenCode setup](opencode.md).

## Steer, Queue and edit follow-ups {#follow-ups}

1. In **Settings → General → Follow-up behavior**, choose **Steer** or **Queue**.
2. While the session is busy, send a follow-up using that behavior. The alternate-send shortcut uses the other behavior; inspect its current binding in [Shortcuts](shortcuts.md).
3. In the prompt queue, use **Steer now**, **Move to queue**, **Edit queued prompt** or **Remove queued prompt** while the entry is still pending.

| Delivery | Effect |
| --- | --- |
| Steer | Native steering input for the ongoing execution |
| Queue | Native queued follow-up, held for subsequent processing |

At rest, an ordinary send uses the normal immediate route regardless of the busy-session preference. Editing restores a pending prompt and its removable attachments into the composer; **Cancel editing** leaves the edit flow. A prompt already consumed by OpenCode is no longer an editable pending entry. Removing an entry does not undo work already performed.

If a queue update fails, inspect the live queue before trying again. Admission is not proof that the model has consumed a follow-up, and reconnecting is not permission to submit it again.

## Ask a side question with /btw {#side-question}

1. Send `/btw your question` in an existing conversation, or `/btw` to open the side-question window.
2. Read the answer, use **Copy answer**, or choose **Cancel question** while it is pending.
3. Close the window when finished.

This is one separate model request using the session context. It does not run a tool loop, take actions or append its question/answer to the conversation. File/image attachments stay in the composer; pasted text used in the question is included as text. It is not a new durable conversation or an alternate way to dispatch work.

Closing cancels the pending side request without interrupting the main session. Leaving the active conversation clears this ephemeral window; copy anything you need first. Empty/error responses appear here rather than becoming transcript messages.

## Fork, undo and recover a failed run {#fork-errors}

1. On a message, choose **Fork after this message** to create a conversation after that point without replacing the original.
2. For undo, review **Undo changes up to here (deletes messages)** carefully. The palette offers **Undo Last Message** and **Redo Last Message** for the staged undo.
3. If execution fails, inspect **Session error**, the response error and any **Send failed** details before sending again.

Forking copies conversation context through the selected point; it does not create a Git worktree or isolate files. Revert is not merely navigation. Review file effects and the undo boundary before continuing; use a fork when you want an alternative discussion without rewriting the original path.

A failed send restores the attempted draft and attachments when doing so would not overwrite newer typing. A failed run may already have executed tools: inspect [Files](files.md), pending [requests](permissions.md) and native activity before retrying. **Reload messages** or **Reload session** reads state; neither is an instruction to repeat a mutation. **Stop session** interrupts execution, not a rollback of file or external-service changes.
