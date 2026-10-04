# Native interruption UX

Questions (native Forms) and permissions have one response surface: `InterruptionDock`,
immediately above the composer. The shell owns the component and slots it into the
active session or the no-session composer. Navigating sessions moves the surface;
it does not recreate its request editors. The composer remains mounted, retaining
its draft. The panel is non-modal and height-bounded. Request content scrolls
independently; reply, cancel and permission actions remain in a fixed footer
outside that scrolling content. Its square shared window chrome uses the existing
accent/surface tokens for the header, icon and leading border.

An expanded request takes priority over a manually enlarged composer. The composer
temporarily uses its minimum field height and disables resizing without overwriting
the saved height or draft; collapse or settlement restores the preference. The dock
does not flex-shrink into an unusable header. The shell bounds the conversation to
the visual viewport while a request is expanded, including Android keyboard resize
and pan. Request fields scroll within the dock while its actions remain reachable.
For keyboard heights too short to fit the whole stack, a measured minimum reserves
the header, footer and one usable input. The session stack then scrolls as a whole
instead of clipping controls; field scrolling can chain into that outer scroller.

## Ownership and navigation

- Native pending queues remain authoritative. No transcript scan decides whether
  a request can be answered. Requests without a tool source use the same panel.
- The visible queue includes only the open conversation and its recursive
  descendants. Parents, siblings and unrelated roots do not appear. Request
  arrival never navigates away from the active conversation. Off-scope editors
  remain hidden and inert while pending, preserving drafts when navigating back.
- Global Forms have no owning conversation. They remain explicitly reachable
  through the project badge on the no-session surface, rather than appearing
  inside unrelated conversations.
- The instance badge opens an in-scope request or explicitly navigates to a pending
  request's owning conversation when none is in scope. Global Forms take priority
  on this project-wide badge because they have no session row of their own.
  Session-row selection with pending requests
  targets that session's request through the `interruptionFocus` UI intent.
- The panel shows the request kind and source session. Previous/next controls and
  the position/count appear only when multiple requests are pending. Navigation is
  bounded: the first/last request disables the corresponding arrow without wrapping.
- Selection stays pinned to the current request kind/id through queue refreshes and
  newly arriving requests, including a permission inserted ahead of a question.
  Position, navigation and temporary composer compaction use the visible scope.
  Explicit navigation or settlement can change the selection. Editors stay keyed
  by request kind/id, preserving partial answers and rejection reasons through native
  object replacement, queue navigation and session navigation.
- Collapse only hides the panel body. It never cancels or refuses a request.
- Deferred session-activation focus must recheck the current input and modal owner
  when it runs, and expire when the pane deactivates or unmounts. An answer field
  focused during navigation retains keyboard input instead of yielding to the composer.
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

Question receipts retain the question, selected answers and matching option
descriptions. Other proposed choices are available through a native disclosure;
free-text answers stay verbatim. Native answers remain the authority.

Arbitrary Forms are not necessarily conversation artifacts. A provider/auth Form
does not acquire a synthetic transcript receipt.

Permission decisions have a separate CodeNomad-owned durable receipt: request,
resources, confirmed decision (`once`, `always`, `reject`), and the supplied reason
when known. Receipts are read-only transcript annotations, not synthetic native
messages. A source message anchors the receipt; requests without one remain
available as session receipts. Reads are bounded and ownership-checked.

Native permission events are ephemeral and replies omit the reason. CodeNomad
therefore captures confirmed replies and observed native settlements separately.
Native settlement does not imply a user click: it can come from another client
or a cascade. Yolo decisions are identified as automatic. A failed or ambiguous
reply never becomes a fabricated decision and is never replayed automatically.
Decisions lost before capture was available, or while CodeNomad was offline,
cannot be reconstructed from a tool's success/error or from saved permission rules.
These annotations are not part of native full-history search, copy or export.

Permission snapshots and receipts live under the CodeNomad profile's
`permission-receipts` directory, in atomic per-request files. The namespace uses
the execution host, native discovery root and authenticated service channel;
credential rotation starts a new namespace. Session deletion removes its receipts.
Stored text is capped at 4096 characters and resources at 64 entries; native
metadata and diffs are not copied. Reads return up to 100 receipts and scan at most
500 records per page, so an empty page can still have a continuation cursor.
Reconnect recovery enumerates loaded native Locations and filters them through
registered-only workspace ownership before querying pending permissions. This
includes descendant directories inside the project and its worktrees; it never
uses the daemon's default directory as a substitute or triggers strategy discovery.

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

`permissions/receipts.test.ts` exercises disk reload, all decisions, native versus
manual/Yolo provenance, cascades, ownership, deletion and mutation failure paths.
`tests/browser/permission-receipts.test.ts` covers reload, hidden tools, empty-page
pagination, SSE refresh, stale reads and long receipts in light/dark mobile layouts.
`node scripts/test-permission-receipts-native.mjs` runs isolated native recovery
against project/worktree roots and descendant Locations, with external replies
and disk reload. It never uses a shared daemon or user database.

`tests/browser/mobile-interruption.test.ts` exercises the real instance shell with
Android touch emulation, session navigation, saved maximum composer height,
portrait/landscape/short layouts, simulated keyboard resize/pan, global/background
Forms and permission actions. Width-only component captures do not replace this
shell-level geometry regression.
It also covers conversation scope and recursive descendants, excluding parents,
siblings and unrelated conversations, retaining hidden drafts, explicit project
badge navigation, global Forms and late-arriving ancestry on desktop and mobile.
