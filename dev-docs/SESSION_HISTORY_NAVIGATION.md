# Global timeline and bounded navigation

The history-query plugin also exposes two read-only operations through dedicated
CodeNomad routes: `session-history/outline` and `session-history/window`. They use
the same authenticated native RPC registration and daemon-storage identity
challenge as history queries. They do not expose generic RPC or SQL access.

## Read contract

- An outline page returns at most 256 lightweight message entries, with native
  sequence order, a short preview and technical-part counts. Its sequence horizon
  excludes new appended messages until the next refresh. The UI publishes a
  complete metadata snapshot; message payloads do not enter the transcript store.
  Page work is bounded by rows and 24 MiB of parsed source payloads, with a
  cooperative cancellation yield every 16 rows. Scheduler wait time must never
  truncate pages: it previously fragmented a busy Windows conversation into
  four-entry responses and multiplied authenticated RPC round trips.
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
  return a conflict; the broker rechecks location, project, revert and workspace
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

Hover and keyboard-focus previews use the same bounded plain-text excerpt for
resident and historical markers. They never mount a message card or load message
payloads. The opaque preview surface wraps text and stays inside the viewport;
Escape, rail scrolling, and viewport resizing dismiss it.

An absent/hidden native anchor returns `anchor_missing`, separately from ownership
or revert conflicts. Automatic restoration recovers once through the latest visible
page and replaces its saved anchor/cursor only on success. Explicit navigation still
reports the missing destination. Active-view initial reads cancel on hiding, and
outline work pauses while transcript hydration is loading. See
`SESSION_HISTORY_STRESS_REVIEW.md` for measured desktop switching costs and the
remaining streaming/memory work.

Outline scans retain accepted pages and their sequence-horizon cursor when a view
is hidden or unmounted. Four recent metadata snapshots are retained in the renderer,
keyed by instance/session, connection generation, content-mutation revision and undo
boundary. Returning reuses the completed rail immediately; message/status changes
refresh it while preserving its last completed snapshot. A status transition during
an incomplete scan cannot discard its progress. Initial loading exposes accepted and
total message counts rather than silently presenting the resident rail as complete.

## Validation

- Server SQL and route tests cover distant windows, sequence gaps, overlap,
  cancellation, payload limits, staged undo and ownership/mutation races.
- `history-navigation.test.ts` exercises the real SessionView, transcript store,
  native event dispatcher and SQL readers on a 1,500-message Chromium fixture.
- `test-session-navigation-native.mjs`, included in the isolated pruning fixture,
  checks a 1,501-message session against real OpenCode 2.0.5 on Windows.
- These fixtures do not validate an installed Electron/Tauri application, WSL,
  Linux or macOS.
