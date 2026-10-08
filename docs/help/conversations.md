# Conversations

The controls around your OpenCode sessions: composer context, pending requests, and full-history navigation.

## Composer controls

**Agent**, **model**, and **thinking** selectors live in the composer footer, alongside the session's worktree selector. Resize the composer without changing its draft; long drafts scroll within it.

The composer remains available during execution. Subsequent submissions may enter the session's pending queue; **Stop** targets the current execution.

## Context attachments

- **`@`** searches project files, agents, and skills available in the session's Location. Selecting a skill attaches a removable badge rather than inserting its instructions into your draft.
- The **attachment** action, drop, and paste use files from your client device. Project file references resolve on the execution host.
- **`/`** lists the Location's commands. **`/btw`** opens a temporary side-question window without replacing the main conversation.

## Requests across conversations

Pending questions and permissions are edited **above the composer**, not in transcript cards. Request drafts survive queue refreshes and session navigation.

The request area includes the open session, its descendants, and other conversations. Origin labels identify the source; **View conversation** navigates there. External requests start compact and can be answered in place. Arrival does not replace the request being edited or switch your session. Use previous/next controls when several requests are pending.

CodeNomad's **Yolo mode** applies to the session family: it automatically approves permissions, not questions or other Forms.

## History navigation

- **Search** queries full history, not just mounted transcript rows.
- **Timeline** markers jump to messages and tool activity. Hover/focus previews let you inspect a point without loading a whole transcript section. At narrow conversation widths, the rail is hidden and header actions move into overflow.
- **Message content visibility** controls reasoning and tool presentation without changing stored history.
- **Fork** continues from a history point in a separate session.

Subsessions appear beneath their parent in normal browsing. Session search uses flat results, with an option to include subsessions. View closure, session deletion, and history pruning are separate operations; the latter two can remove stored content.
