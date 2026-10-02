# Native interruption UX

Questions (native Forms) and permissions have one response surface: `InterruptionDock`,
immediately above the composer. The shell owns the component and slots it into the
active session or the no-session composer. Navigating sessions moves the surface;
it does not recreate its request editors. The composer remains mounted, retaining
its draft. The panel is non-modal, height-bounded and independently scrollable.

## Ownership and navigation

- Native pending queues remain authoritative. No transcript scan decides whether
  a request can be answered. Global Forms and requests without a tool source work
  in the same panel.
- The instance badge opens the panel; session-row selection with pending requests
  targets that session's request. Inline tools offer the same explicit action.
- The panel shows request count and source session, with previous/next controls.
  It keeps editors keyed by request kind/id, preserving partial answers and rejection
  reasons through native object replacement and queue navigation.
- Collapse only hides the panel body. It never cancels or refuses a request.
- Source links retain the native message/call identity even when that message is
  absent from the resident transcript. They use the existing bounded history-window
  navigation and its cancellation/fencing. The target tool is revealed and highlighted.
- Only the panel submits replies. Transcript tools no longer register document-wide
  permission shortcuts or independently render response forms.
- Replies/cancellations continue through the existing native stores, retaining
  mutation error handling, pending-request reconciliation and global location headers.
  A failed request remains editable. No mutation is replayed automatically.
- Large permission diffs keep their existing bounded source access and approval
  rules. Request/diff identity fences late clipboard completions.

## Transcript history

The `question` renderer displays question/answer pairs from native tool input and
`metadata.answers`. It works for live tool completion and rehydrated history; it
does not invent a local assistant/user message or persist a parallel transcript.
Native errors continue to use the tool error renderer.

Arbitrary Forms are not necessarily conversation artifacts. A provider/auth Form
does not acquire a synthetic transcript receipt. Similarly, this change does not
invent durable permission-decision history when the native tool lacks that data.

## Validation

`tests/browser/interruption-dock.test.ts` exercises real Solid session, transcript,
composer and panel components, the native event dispatcher and isolated HTTP fixtures:
off-window source navigation, native answer rendering and history rehydration,
draft retention, refresh/navigation, failure/retry, in-flight submission, remote
settlement, source-less permissions, global Forms and narrow-screen geometry.

`permission-fallback-diff.test.ts` now targets the panel, retaining full-source
access, changed-diff and late-copy regressions. No shared daemon or user database
is used by these tests.
