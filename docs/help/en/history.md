# History, search and cleanup

Stored history, what the transcript currently displays and the model's compacted context are separate. Choose navigation or filtering before deleting anything.

## Search full history {#full-history-search}

1. Open **Search chat history** in the conversation header, or use its configured shortcut (default **Ctrl/Cmd+F**).
2. Select **Entire session** or **Entire workspace** and enter a search term.
3. Enable **Include tools and thinking** if you need technical content as well as readable text.
4. Select an excerpt, or use **Next results** to continue beyond the current page.

Search is literal and case-insensitive, over stored history rather than only mounted transcript rows. Workspace scope follows the opened project's authorized directory tree and worktrees, not every project on the OpenCode service. File/image attachment bytes and opaque provider state are not searchable text.

The progress line **This page: … results · … messages scanned** describes this result page, not workspace totals. Results arrive in batches. Skipped oversized or unsupported messages are reported; absence of a hit does not prove those messages contain no match. New messages arriving during a scan need a fresh search to be included consistently.

Opening an empty search does not scan history. Changing query/scope, closing the window or leaving the session cancels obsolete search work. If a read fails, use **Retry**; it does not submit a prompt or mutate history.

## Open results and use the timeline {#timeline-navigation}

1. Choose a current-session search result to jump to its surrounding passage.
2. Choose a result from another session to open a separate preview of that message.
3. In **Message timeline**, hover or focus a marker for an excerpt, then select it to navigate. Use the first/latest message controls to return to the ends of stored history.

The timeline represents full session structure even when the transcript holds only a bounded passage. Jumps load the destination rather than fetching every intervening message. Other-session search previews do not load that session's entire transcript or silently select it.

While a jump loads, the old passage stays visible. A newer jump or manual transcript interaction supersedes obsolete navigation; a failed jump leaves the visible passage intact. Retry the destination rather than repeatedly reloading the whole project. Historical reading does not change the composer agent/model selection.

The timeline is hidden when the conversation is too narrow (below 420 CSS pixels); use search and transcript controls there. Its saved visibility preference is not erased by that responsive change.

## Choose the right history operation {#operation-reference}

| Operation | Where | Scope and consequence |
| --- | --- | --- |
| Display filtering | **Message content**, or **Settings → Chat** | Shared transcript display preferences; hides/collapses content without deleting it |
| Compaction | Palette **Compact Session** | Native summary/context compaction for the selected session, not technical-output deletion |
| One-response cleanup | Message **More actions → Remove tools and reasoning from this response** | Permanently removes eligible completed technical parts; preserves final text |
| Session technical cleanup | Palette **Remove Session Tools and Reasoning** | Plans across full stored session history, including pre-compaction messages; preserves final text and message/session metadata |
| Delete session | Session row **Delete session**, or selected-session delete | Recursively deletes the native conversation and its descendant subsessions/history after confirmation; no undo |
| Scrub Sessions | Command palette | Broader session deletion, not a display or context-size setting |

**Message content** applies across conversations. Hiding tools does not disable tools, change permissions or remove stored output. Very large individual messages may also show **Show … more** at an omitted gap to keep rendering responsive; expanding that gap does not recover deleted content.

## Compact a session {#compact-session}

1. Select the intended conversation.
2. Run **Compact Session** from the command palette.
3. Wait for the native compaction result or inspect **Compact failed** before deciding whether to retry.

Compaction changes the context OpenCode uses to continue the session. It is not a promise to erase earlier stored messages: full-history search and technical cleanup can still reach pre-compaction content. Do not compact as a substitute for deleting sensitive stored history.

## Remove tools and reasoning {#technical-cleanup}

1. Choose the one-response action, or run **Remove Session Tools and Reasoning** for the selected session.
2. Review the planned tool/reasoning counts and any skipped-content warning.
3. Confirm **Remove**. For whole-session work, follow the progress above the transcript and use its cancellation control if needed.

Only eligible completed tools and reasoning are removed. Active/incomplete content is not pruned; changed content is refused rather than silently expanding what you confirmed. Final text and message/session metadata remain, but removed technical output has no undo. Preserve anything you need before confirming.

Session cleanup is not atomic across the whole session. Successful earlier removals remain if a later message conflicts or fails. **Cancellation stops future batches; it does not roll back an already dispatched batch**, which may still commit.

For a busy-storage error, wait for current execution/storage work to finish. For a changed-message error, reload and select again. For an unavailable plugin, reconnect/reopen CodeNomad and inspect the error before retrying. After an uncertain reply, refresh and assess the remaining content; do not assume either that nothing happened or that the whole session was cleaned.

## Delete and scrub sessions {#delete-scrub}

Deleting a parent session also deletes its descendant subsessions and their history. Inspect the conversation family before confirming. Mission specialist cleanup is different: it keeps sessions that have children.

1. Prefer a specific row's **Delete session** when you know exactly which conversation should go.
2. For broader maintenance, run **Scrub Sessions** and read the **Deep Clean Sessions** confirmation.
3. Confirm only if empty sessions, completed subagent sessions and unused forks may be removed.

Scrub operates on the current project's known session candidates and can remove more than blank main sessions. It is not an archive operation and has no undo. Do not use it merely to hide a busy sidebar. The independent **Auto-cleanup blank sessions** preference is narrower: it checks that a session is genuinely empty rather than treating an unloaded transcript as empty.

Deletion removes conversations, not Git commits or a rollback of filesystem/external effects. If cleanup only partly succeeds, already deleted sessions stay deleted. Review the remaining list and errors before retrying. See [Conversations](conversations.md) for forks/undo and [Projects](projects.md) for deleting temporary folders or worktrees.
