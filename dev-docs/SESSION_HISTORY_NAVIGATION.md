# Global timeline and bounded navigation

The history-query plugin exposes three read-only navigation operations through dedicated
CodeNomad routes: `session-history/outline`, `session-history/outlinePreview` and `session-history/window`. They use
the same authenticated native RPC registration and daemon-storage identity
challenge as history queries. They do not expose generic RPC or SQL access.

## Read contract

- An outline page returns at most 16,384 structural entries: native ID, sequence,
  type and technical-part counts, with no excerpt or body. SQL projects counts
  directly; large content never enters JS/RPC/renderer just to draw the rail.
  Its sequence horizon excludes newly appended messages until the next refresh;
  `after` permits re-reading the small mutable tail and new arrivals. Cancellation
  yields every 128 entries. Cold assistant/tool indexes still inspect native JSON
  in SQLite, so first-load cost is not constant or free. Larger histories retain
  bounded pagination; the exact structural snapshot publishes once it is complete.
- `outlinePreview` reads at most 12 requested IDs, in priority order. Each reply
  contains up to 4,096 characters of Markdown and 4,096 of tool excerpt per message;
  source bodies over 16 MiB return empty excerpts. Preview data does not enter the
  transcript store or affect rail geometry. Cancellation yields between messages.
- A window targets `around`, `before`, `after`, `oldest` or `latest`. It reads at
  most 200 messages ordered by native `seq`, without traversing intervening pages.
  Neighbor windows overlap by 16 messages so the reading anchor can survive a
  boundary crossing. An around window includes up to 80 predecessors and 120
  messages starting at the target.
- Windows are reconstructed from native storage within a read transaction. The
  isolated OpenCode fixture compares their complete payloads with native export
  and single-message reads. Budgets are 16 MiB per message and 24 MiB per window;
  oversized windows fail explicitly instead of silently omitting content.
- Ownership includes directory, project and legacy workspace identity. Staged
  undo hides the same message-ID tail as the transcript. Missing/deleted targets
  return `anchor_missing`; the broker rechecks location, project, revert and workspace
  ownership before publishing either result.

## UI navigation

`history-window.ts` translates this contract into explicitly namespaced CodeNomad
window cursors. These are never forwarded to native `message.list`. Existing
native page cursors remain supported. A truncated newer-page path switches to a
direct resident-message anchor rather than replaying the path from the latest page.

Timeline clicks, current-session search hits and missing restoration anchors share
`loadMessageAnchor`. Window publication retains the existing request epoch,
connection generation, mutation revision and cancellation checks. Latest-window
reads retain the stronger live-message revision check. Reading an old window does
not overwrite the composer's model/agent from historical messages.

The old transcript stays visible during a jump. A newer target supersedes the
pending request, including when the new target is already resident. Cancellation,
leaving the view and manual transcript scrolling reject late navigation. Failed
jumps keep the visible page and retry the requested destination. Historical
windows remain isolated from live append events; returning to latest uses the
native latest-page loader.

`session-outline.ts` owns metadata independently of resident transcript windows.
It refreshes on activation, terminal status, undo/content mutation and reconnect;
hidden views cancel work. A refresh retains the last successful snapshot and
errors provide an explicit retry. The initial outline scan is proportional to the
session size; a subsequent jump loads only its bounded destination window.

The timeline uses the same standard native scrollbar as the transcript, with one
ordinary gutter. Marker rectangles give up width to it; fixed-size icons and
vertical geometry never scale with available width. `timeline-virtual-list.tsx`
measures the marker height and gap primitives, computes exact offsets (including
group spacing), and mounts only the visible range. Hidden tools are excluded from
the layout. Browsing offscreen rows cannot change the scrollbar extent.

Manual rail browsing suppresses active-marker reveals until an explicit transcript
gesture. Reveals wait one layout frame and are cancelled by a newer selection or
manual rail interaction. Intermediate transcript positions during window loading
cannot move the rail. Native transcript scrollbar drags escape following at press,
retain ownership beyond the ordinary wheel/key deadline, and postpone boundary
paging until release. A wheel gesture at an already-clamped boundary can request
the adjacent window even when no DOM scroll event is emitted. First/latest controls
also account for off-window messages, not just the local scroll offset.

Browser checks load the complete stylesheet and cover overflow, hover, keyboard
focus, RTL and 125% zoom, mixed text/tool/idle records, actual native thumb dragging,
and viewport anchor stability during streaming and distant jumps.

Hover and keyboard-focus previews render bounded Markdown (formatting, lists,
links and code) with escaped raw HTML and no syntax-highlighting work. They never
mount a message/tool card or load a transcript window. Visible-nearby excerpts load
in small batches, prioritizing hover; moving elsewhere cancels obsolete work.
An unloaded/empty excerpt shows no popup. Resident selected content can supply the
preview directly. A separate 512-excerpt cache retains results across view switches;
entries older than 30 seconds revalidate on demand, without timers/polling. The
opaque preview surface wraps text and stays inside the viewport;
Escape, rail scrolling, and viewport resizing dismiss it.

An absent/hidden native anchor returns `anchor_missing`, separately from ownership
or revert conflicts. Automatic restoration recovers once through the latest visible
page and replaces its saved anchor/cursor only on success. Explicit navigation still
reports the missing destination. Active-view initial reads cancel on hiding;
the lightweight structural index loads independently of transcript hydration. See
`SESSION_HISTORY_STRESS_REVIEW.md` for measured desktop switching costs and the
remaining streaming/memory work.

Outline scans retain accepted pages and their sequence-horizon cursor when a view
is hidden or unmounted. Up to 16 structural snapshots (200,000 entries across the
retained LRU, except a single larger active index) are retained in the renderer,
keyed by instance/session, connection generation, content-mutation revision and undo
boundary. Returning reuses the completed rail immediately. An unchanged return
performs no index read. Message changes observed on activation/status transitions
refresh the last 32 indexed rows and new arrivals, preserving the prefix and last
completed display. Destructive edits/reconnect/undo invalidate the full index.
A status transition during an incomplete scan cannot discard its progress.
There is no excerpt-loading countdown: structural geometry and preview availability
are independent. Cache retention is in renderer memory, not persisted across restart.

## Validation

- Server SQL and route tests cover distant windows, sequence gaps, overlap,
  cancellation, payload limits, staged undo and ownership/mutation races.
- `history-navigation.test.ts` exercises the real SessionView, transcript store,
  native event dispatcher and SQL readers on a 1,500-message Chromium fixture.
- `test-session-navigation-native.mjs`, included in the isolated pruning fixture,
  checks a 1,501-message session against real OpenCode 2.0.5 on Windows.
- These fixtures do not validate an installed Electron/Tauri application, WSL,
  Linux or macOS.
