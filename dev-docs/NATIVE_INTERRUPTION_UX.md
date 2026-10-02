# Native interruption UX

Questions (native Forms) and permissions have one response surface: `InterruptionDock`,
immediately above the composer. The shell owns the component and slots it into the
active session or the no-session composer. Navigating sessions moves the surface;
it does not recreate its request editors. The composer remains mounted, retaining
its draft. The panel is non-modal and height-bounded. Request content scrolls
independently; reply, cancel and permission actions remain in a fixed footer
outside that scrolling content. Its square shared window chrome uses the existing
accent/surface tokens for the header, icon and leading border.

## Ownership and navigation

- Native pending queues remain authoritative. No transcript scan decides whether
  a request can be answered. Global Forms and requests without a tool source work
  in the same panel.
- The instance badge opens the panel; session-row selection with pending requests
  targets that session's request through the `interruptionFocus` UI intent.
- The panel shows the request kind and source session. Previous/next controls and
  the position/count appear only when multiple requests are pending. Navigation is
  bounded: the first/last request disables the corresponding arrow without wrapping.
- Selection stays pinned to the current request kind/id through queue refreshes and
  newly arriving requests, including a permission inserted ahead of a question.
  Explicit navigation or settlement can change the selection. Editors stay keyed
  by request kind/id, preserving partial answers and rejection reasons through native
  object replacement, queue navigation and session navigation.
- Collapse only hides the panel body. It never cancels or refuses a request.
- Pending questions appear only in the dock. There are no “View in discussion” or
  “Answer in dock” links and no interruption-specific transcript reveal state.
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
Pending questions are not duplicated in transcript tool cards. Native completed
answers remain readable there; native errors continue to use the tool error renderer.

Arbitrary Forms are not necessarily conversation artifacts. A provider/auth Form
does not acquire a synthetic transcript receipt. Similarly, this change does not
invent durable permission-decision history when the native tool lacks that data.

## Validation

`tests/browser/interruption-dock.test.ts` exercises real Solid session, transcript,
composer and panel components, the native event dispatcher and isolated HTTP fixtures:
native answer rendering and history rehydration, dock-only pending questions,
draft retention, stable selection, bounded navigation, failure/retry, in-flight
submission, remote settlement, source-less permissions, global Forms and narrow-screen
geometry with reachable footer actions.

`permission-fallback-diff.test.ts` now targets the panel, retaining full-source
access, changed-diff and late-copy regressions. No shared daemon or user database
is used by these tests.
