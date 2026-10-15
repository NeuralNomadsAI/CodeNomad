# Global timeline and bounded navigation

The history-query plugin exposes three read-only navigation operations through dedicated
CodeNomad routes: `session-history/outline`, `session-history/outlinePreview` and `session-history/window`. They use
the same authenticated native RPC registration and daemon-storage identity
challenge as history queries. They do not expose generic RPC or SQL access.

## Read contract

- An outline page returns at most 16,384 structural entries: native ID, sequence,
  type, technical-part counts and the first tool name used by the aggregate marker,
  with no excerpt or body. SQL projects this metadata
  directly; large content never enters JS/RPC/renderer just to draw the rail.
  Its sequence horizon excludes newly appended messages until the next refresh;
   `known` supplies up to 512 contiguous checkpoint digests. Each covers up to 512
   native row headers (ID, type, sequence, update stamp and stored byte length).
   Only changed ranges require technical-count projection and return entries;
   the live tail is conservatively refreshed and grows before adding a new range.
   Deletions retain earlier checkpoint boundaries instead of shifting every range.
   Each page uses its own read transaction. Cancellation
   yields every 128 projected entries and between checkpoints. Cold assistant/tool indexes still inspect native JSON
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

### Restoration of structural indexes

Completed indexes join the existing restoration graph, with separate 512-entry
content-addressed leaves and no excerpts or message bodies. Limits are 16 indexes,
200,000 entries and 16 MiB across the snapshot, prioritizing selected sessions.
The optional data uses a separate budget from drafts, attachments and selections.
Missing/corrupt index chunks discard only that index. Frozen normalized indexes
and encoded leaves are memoized so draft/scroll captures do not rehash each entry.
Indexes saved before representative tool names were added display immediately, then
perform one complete checkpoint revalidation before being persisted again.
The `outline-index-v1` root extension fences older renderers rather than letting
them discard session documents they cannot interpret. Hosts without partition
support keep their existing monolithic snapshot without the optional indexes.

Hydration seeds indexes before mounting the session. Durable session identity,
directory, project and undo boundary must match; ephemeral runtime generations
are not written to disk. Restored geometry is provisional and all checkpoints are
revalidated, including old ranges that may have been edited or deleted offline.
The cache never supplies native mutation authority. Clearing/disabling restoration
uses the existing native transaction and recapture suppression. Unsupported,
over-budget or unavailable indexes fall back to a cold structural read.

Revalidation still scans bounded row headers in SQLite; it avoids replaying
unchanged structure and parsing unchanged technical content, not all database
work. The stamps follow native message updates; pruning also changes stored byte
length. Out-of-band writes that deliberately preserve both stamp and length are
outside this cache invalidation contract.

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

### Transcript scroll ownership and trace

`VirtualFollowList.writeScroll(reason, op)` is the only list-owned transcript position write.
Reasons come from the closed `SCROLL_REASONS` list in `virtual-scroll-trace.ts`; the
same call opens the programmatic window, records synchronous targets and keeps
imperative Virtua operations cancellable by the next gesture. Follow-mode changes go
through `syncControllerResult` with a reason as well. Outside it remain user gestures
(including wheel re-emission and middle-button autoscroll), Virtua's own size
compensation, browser clamping and search-result reveals.

Search reveals keep their one-shot occurrence centering through nested scrollers
(not an element-alignment hold). They emit `writer: "external"` with reason
`search-reveal` and do not change the list's programmatic marking. SessionView's
activation/submission handles and MessageSection's paging, restoration and message
navigation (timeline and search alike, through `navigateToMessage`) use the list API
and therefore reach `writeScroll`.

Enable the trace with `codenomadLogger.enableLogger("scroll")` (persisted until
disabled), then read DevTools or the `codenomad.inspect` console diagnostics. Each line
is `write`, `mode` or `observe` JSON with session, offsets, scroll height and mode. An
`observe` move that no write claimed is `unowned`; `intent` distinguishes a user
gesture from Virtua/browser movement. A recent synchronous write claims only its
actual landing offset, not unrelated moves during its 120ms programmatic window
(`during` retains that recent reason); asynchronous Virtua/smooth operations are
attributed by that window and must be correlated with their preceding `write`.
Virtua releases are logged without taking over attribution. Synchronous no-op writes
are omitted; asynchronous requests report `now` and `target`, never a pre-landing `to`.
The trace is observational, not a proof of native/virtualizer ownership. While enabled,
`.message-stream` also carries `data-scroll-write` (last position-write reason), cleared
with its attribution state on the next list action/observation after disabling.
`data-follow-mode` is always present. Disabled, the trace adds no layout reads or
diagnostic-entry allocations; the scroll operation literals and follow-mode binding
still exist.

Each measurement reset remounts Virtua with the key-remapped size cache. The remount
keeps the carried default row size as `itemSize`: Virtua's one-time median
re-estimate would otherwise fire later (once a streaming reply outgrows the viewport,
or after the long-reply hold escapes) and resize every never-measured history row at
once; near the bottom the browser clamps before Virtua compensates, an `unowned`
backward jump of many rows. When every retained row is measured, the remap refreshes
that default to their median, so a 40px fallback carried by an instance that remounted
before estimating lasts only until the first remount whose retained rows are all
measured. A new instance reads offset 0 until the next scroll event, so a non-zero
offset is seeded by one scroll event (the
remount has already recreated every row). The long-reply hold publishes its escaped
position itself, since it scrolls nothing. Gestures and explicit navigation supersede
restoration, alignment and bottom pins through one function; deactivation, session
reset and unmount stop every list-owned positioning operation (including a
restoration in flight) through another, and deactivation also releases Virtua's
queued imperative scroll.

One bottom loop (`bottomPin`) keeps the bottom, and only while following: leaving
follow ends it. Ordinary following re-pins for two frames after each bottom write;
an explicit pin (send intent, latest paging, restoration at the bottom) lasts until
enough rows exist and the bottom stays put, within a frame deadline, then hands the
bottom back to ordinary following. Layout changes apply restoration, then an explicit
pin, then the long-reply hold, then follow. A restoration requested during a pin
supersedes it (the pin settles `interrupted`), except that a restoration to the
bottom joins an active explicit pin and keeps its row count; it reports `onApplied`
only after its own landing, and `onCancelled` when superseded or when its pin loses
follow without a gesture. A new send intent also cancels MessageSection's pending
window paging, which would otherwise leave follow after the send.

In-place reveals (`alignElement`) are reader-settlement holds on the revealed
element, with the former element alignment's lifetime: the element is measured and
re-aligned on every frame of a fixed 30-frame window counted from the request, which
layout never extends. Within it, viewport and `beforeItems` resizes re-align the
element instead of dropping it, and its requested offset is kept and clamped into
the current viewport only when applied. Gestures, navigation and focus moving to
another element inside the transcript scroller (Tab, assistive technology) end it at
once, and so does losing the element (an unmounted row); focus leaving the
transcript (e.g. to the composer) does not. Any other scroll during the window is
corrected like layout, as before. While a hold is active, a window shift retains the
hold rather than the visible top anchor, so no reader stays retained after it
expires. Settlement, alignment and anchor restoration share one anchor measurement.
Pre-existing: a Virtua index request still pending from an earlier key navigation
re-runs on every measurement while they keep coming (for instance during streaming)
and can re-place its row; a gesture, another index navigation, a restoration or
deactivation replaces it.

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
the lightweight structural index loads independently of transcript hydration.

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
