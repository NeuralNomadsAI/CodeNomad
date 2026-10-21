# Global timeline and bounded navigation

The history-query plugin exposes three read-only navigation operations through dedicated
CodeNomad routes: `session-history/outline`, `session-history/outlinePreview` and `session-history/window`. They use
the same authenticated native RPC registration and daemon-storage identity
challenge as history queries. Never expose generic RPC or SQL access through them.

## Read contract

- An outline page returns at most 16,384 structural entries: native ID, sequence,
  type, technical-part counts, an assistant step's `layout` (its visible parts in
  order: `R` and `T` for each run of non-blank thinking or visible text, `X` per
  tool, first 64 kinds) and the first tool name used for indexed tool icons,
  with no excerpt or body. SQL projects this metadata
  directly; large content never enters JS/RPC/renderer just to draw the rail.
  Its sequence horizon excludes newly appended messages until the next refresh;
   `known` supplies up to 512 contiguous checkpoint digests. Each covers up to 512
   native row headers (ID, type, sequence, update stamp and stored byte length).
   Only changed ranges require technical-count projection and return entries;
   the live tail is conservatively refreshed and grows before adding a new range.
   Deletions retain earlier checkpoint boundaries instead of shifting every range.
   Each page uses its own read transaction. Cancellation
   yields every 128 projected entries and between checkpoints. Cold assistant/tool indexes inspect native JSON
  in SQLite, so first-load cost grows with history. Larger histories use
  bounded pagination; the exact structural snapshot publishes once it is complete.
- `outlinePreview` reads at most 12 requested IDs, in priority order. Each reply
  contains up to 4,096 characters of Markdown and 4,096 of tool excerpt per message;
  source bodies over 16 MiB return empty excerpts. Preview data never enters the
  transcript store or affects rail geometry. Cancellation yields between messages.
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
  return `anchor_missing` (distinct from ownership/revert conflicts); the broker rechecks location, project, revert and workspace
  ownership before publishing either result.

## UI navigation

`history-window.ts` translates this contract into explicitly namespaced CodeNomad
window cursors. These are never forwarded to native `message.list`. Native page
cursors are also supported. A truncated newer-page path switches to a
direct resident-message anchor rather than replaying the path from the latest page.

Timeline clicks, current-session search hits and missing restoration anchors share
`loadMessageAnchor`. Window publication checks the request epoch, connection
generation, mutation revision and cancellation. Latest-window reads also apply
the stronger live-message revision check. Reading an old window never overwrites
the composer's model/agent from historical messages.

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

Completed indexes join the restoration graph, with separate 512-entry
content-addressed leaves and no excerpts or message bodies. Limits are 16 indexes,
200,000 entries and 16 MiB across the snapshot, prioritizing selected sessions.
The optional data uses a separate budget from drafts, attachments and selections.
Missing/corrupt index chunks discard only that index. Frozen normalized indexes
and encoded leaves are memoized so draft/scroll captures do not rehash each entry.
Indexes lacking representative tool names, text counts or step layouts display
immediately, then revalidate every checkpoint once before being persisted again.
The text count covers non-blank text parts that are neither synthetic nor ignored.
An index from an older plugin copy has no layout: its steps are drawn from the
counts as thinking, then text (kept when its count is unknown), then tools. The
`outline-index-v1` root extension fences older renderers rather than letting them
discard session documents they cannot interpret. Hosts without partition support
use a monolithic snapshot without the optional indexes.

Hydration seeds indexes before mounting the session. Durable session identity,
directory, project and undo boundary must match; ephemeral runtime generations
are never written to disk. Restored geometry is provisional and all checkpoints are
revalidated, including old ranges that may have been edited or deleted offline.
The cache never supplies native mutation authority. Clearing/disabling restoration
uses the native transaction and recapture suppression. Unsupported,
over-budget or unavailable indexes fall back to a cold structural read.

Revalidation scans bounded row headers in SQLite and skips replaying unchanged
structure and parsing unchanged technical content. The stamps follow native
message updates; pruning also changes stored byte length. The cache misses
out-of-band writes that preserve both stamp and length.

The timeline uses the same standard native scrollbar as the transcript, with one
ordinary gutter. Marker rectangles give up width to it; fixed-size icons and
vertical geometry never scale with available width. `timeline-virtual-list.tsx`
measures the marker height and gap primitives, computes exact offsets (including
the uniform gaps between markers), and mounts only the visible range. Hidden markers are excluded from
the layout. Browsing offscreen rows cannot change the scrollbar extent.

### Markers and the active marker

The rail has one marker per transcript block that a reader can land on, in the
transcript's order: each text run (a content row), each thinking run (a reasoning
card or group), each tool, compaction and system context. Omitted parts split
the runs around their placeholder and have no marker. Markers follow Message
content visibility: thinking, system and hidden tool types leave the rail with
their blocks. Resident messages use their exact part-level markers; indexed
messages outside the window take their native sequence position around them and
derive their markers from the outline's `layout`. Markers are keyed
`messageId:type:ordinal`, so an indexed marker keeps its identity when its window
loads. A tool inside a collapsed technical group stands for that group's header.

A click (or a user-message jump) makes its marker active until the reader
scrolls: the key jump holds that marker's own block at the top, through row
remounts and window loads, rather than the message row. Otherwise the active
marker is the first marked block reaching more than 4 px below the transcript top,
re-read once per frame on scroll and content rendering from the mounted rows only.
`tests/browser/timeline-sync.test.ts` covers ordering, identity, click placement
and the reading line on a synthetic 320-record session. The opt-in
`tests/browser/timeline-sync.qualification.ts` replays native session stores
(`{ sessionID, path, count }` entries in the shape of `createSessionStore`) and
reports per-preset marker agreement, active-marker and placement accuracy for
random rail clicks and wheel scrolls.

Manual rail browsing suppresses active-marker reveals until an explicit transcript
gesture. Reveals wait one layout frame and are cancelled by a newer selection or
manual rail interaction. Intermediate transcript positions during window loading
cannot move the rail. Native transcript scrollbar drags escape following at press,
retain ownership beyond the ordinary wheel/key deadline, and postpone boundary
paging until release. A wheel gesture at an already-clamped boundary can request
the adjacent window even when no DOM scroll event is emitted. First/latest controls
account for off-window messages as well as the local scroll offset.

### Transcript scroll ownership and trace

`VirtualFollowList.writeScroll(reason, op)` opens the programmatic window and records synchronous targets. Every write
is a DOM write: the list never issues Virtua's imperative operations
(`scrollTo`/`scrollBy`/`scrollToIndex`). In Virtua 0.53 such an operation reapplies
its fixed target on every item or viewport measurement until 150 ms after the last
one; the rows a gesture mounts, or a streaming tail, keep re-arming it, and nothing
public cancels it, so it would undo any gesture or later write made meanwhile. Key
jumps (always to the row's top) and anchor restoration therefore write the offset
Virtua would target for the row (`writeIndex`, from its own item offsets) and let a
list stabilizer settle the row once measured, both cancelled by every gesture: a
jump's row is held like an in-place reveal (below), for the same bounded window, and
then released, so a later focus, Tab or `scrollIntoView` is never pulled back to it;
the restoration keeps its own loop. A restored anchor that has shrunk since its capture is
kept partly visible: Virtua mounts no overscan above the viewport after a downward
scroll, so a row held entirely above it would be unmounted and re-placed in a loop.
A rolling window (the store keeps the latest 200 messages, so each agent step in a
long session drops the oldest) never enters Virtua's shift mode, which compensates
every later measurement until scrolling idles and can only be left through an
imperative operation. Rows leaving the head are instead retired in place: they stay
in Virtua's data as an empty prefix (a key and a size, no content), so Virtua only
sees the data grow, measures them at zero, and its ordinary resize anchoring keeps
the reader in place. Callers never see them: `renderItem` receives live indexes, and
key lookups, the active row and anchors skip them; a remap never carries a retired
row's zero to the same message brought back by a page (live rows are remapped by
key, a retained retired prefix by position), and a retired key coming back without
a page resets the list. When idle or scrolling up, Virtua compensates only a
shrinking row entirely above the viewport (a retiring row across the top stays
uncompensated), so a roll records an escaped reader's place, its first visible
surviving row and offset. Layout notifications come from the list's row
ResizeObserver. ResizeObserver delivers a pass in observer creation order, so that
observer is recreated after each Virtua instance (every measurement reset remounts
one) and reports after Virtua's measurement, before paint; each roll re-observes a
rendered row, so the pass in which Virtua measures the retiring rows at zero reaches
it, with or without a net append. It puts the reader's row back and drops the record
once every retired row is measured at zero: no painted frame shows the retiring
row's height, and nothing outlives the measurement to pull back a later programmatic
scroll, a viewport resize (which stays bottom-anchored, clamping included) or a
middle-button autoscroll. A held native scrollbar thumb is corrected the same way:
Chromium continues a thumb drag from the current offset. Until that measurement
Virtua keeps every row where it was, so a write or reveal in the roll's own task,
whose scroll event arrives before the measurement, moves the recorded place with
it. A write from an animation-frame callback of the roll's frame is undone:
its scroll event arrives only after the measurement, when the correction has
already run (list-owned reveals supersede the correction instead).

The content above the rows (`renderBeforeItems`: permission receipts, the older
history controls, the empty, loading and load-error states) is Virtua's row 0,
ahead of the retired prefix (Virtua's sizes are positional, so a header after the
prefix would change index, and size, with every roll), and always mounted. Row
`index` of the list's data is Virtua's row `index + 1`; the translation stays inside
the list (`writeIndex`, `findLiveItemIndex`, the retired watermark, the remapped size
cache, which keeps the header's size by position, and `keepMounted`). The header
carries no `data-virtual-follow-key`: it is never
an anchor, the active row, a reveal or restoration target, a message or a
`renderItem` call. Like every row it is absolutely positioned, so its resizes move
nothing until Virtua measures them and compensates them in the same pass, by the
same rule as any row: a header wholly above the viewport keeps the reader's rows in
place; one cut by the viewport top is compensated only while scrolling down, and
otherwise the rows below it move with its resize (the reader inside it stays put).
Near the bottom the browser clamps the
offset as Virtua shrinks its content; Virtua then compensates
from its recorded offset, so the rows stay in place there too. A held native
scrollbar thumb is compensated like a roll: the content stays in place and the
offset moves. The row observer also watches the header, so its growth re-pins a
following bottom. Its element is created once: a remount moves it into the new
row 0 rather than recreating it. The move drops focus inside it; the row observer
restores it after Virtua's measurement, before paint, since a remount without a
carried size cache (a disjoint window: older page, first/latest, jumps) hides the
header until measured.

The place is kept from roll to roll while nothing else moves the reader by more
than 2 px, so Virtua's rounded compensations (a fraction of a pixel per roll, more
at fractional zoom) never accumulate; returning to follow forgets it.
Growth above an escaped reader is Virtua's own compensation and can drift it by a few pixels over many updates. The row observer never watches
Virtua's container, which Virtua resizes during its own measurement: a shallower
observation changing mid-pass would be deferred to the next frame (a
`ResizeObserver loop completed with undelivered notifications` window error). Only
rows that Virtua itself mounts during that pass, after an uncompensated shrink such
as a retiring row across the viewport top, raise that error; they lie in the
overscan and are measured on the next frame. Retired rows stay mounted only until
Virtua has measured them at zero (a watermark advanced on every items change and row
resize), so the DOM stays bounded; their keys and sizes accumulate until the next
reset (page navigation, a disjoint window, an emptied list or a session change), a
few bytes per step. In a hidden (`display:none`) list the retired rows are measured,
and compensated, when it is shown again. Follow-mode changes go through
`syncControllerResult` with a reason as well. Outside it remain user gestures
(including wheel re-emission and middle-button autoscroll), Virtua's own size
compensation, browser clamping and search-result reveals inside nested scrollers.
List positions are read from the DOM, never from Virtua's `scrollOffset`, which lags a write
until its scroll event; a following list is captured at the bottom (without an
anchor) wherever its pin's latest write stands.

A search navigation reveals its occurrence once, after placing its message. Inside
nested code/tool scrollers the reveal writes them directly and emits
`writer: "external"` with reason `search-reveal`, without changing the list's
programmatic marking. The transcript step goes through the list's `alignElement`
(reason `align-element`), which holds the occurrence's element at its centred offset
for the alignment window against the list's placement corrections; only a transcript
outside a list (no alignment) is written directly as `search-reveal`. SessionView's
activation/submission handles and MessageSection's paging, restoration and message
navigation (timeline and search alike, through `navigateToMessage`) use the list API
and therefore reach `writeScroll`.

Enable the trace with `codenomadLogger.enableLogger("scroll")` (persisted until
disabled), then read DevTools or the `codenomad.inspect` console diagnostics. Each line
is `write`, `mode` or `observe` JSON with session, offsets, scroll height and mode. An
`observe` move that no write claimed is `unowned`; `intent` distinguishes a user
gesture from Virtua/browser movement. A recent synchronous write claims only its
actual landing offset, not unrelated moves during its 120ms programmatic window
(`during` retains that recent reason); smooth scrolls are attributed by that window
and must be correlated with their preceding `write`. Synchronous no-op writes are
omitted; smooth requests report `now` and `target`, never a pre-landing `to`.
Never treat the trace as proof of native/virtualizer ownership. While enabled,
`.message-stream` also carries `data-scroll-write` (last position-write reason), cleared
with its attribution state on the next list action/observation after disabling.
`data-follow-mode` is always present. Disabled, the trace costs only its scroll
operation literals and follow-mode binding, with no layout reads or
diagnostic-entry allocations.

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
remount has already recreated every row). The long-reply hold scrolls nothing; the
section persists its escaped position as a follow-mode change and leaves it unsettled,
so a state capture's flush records it again after growth below it. An escaped reader
keeps its anchor even when captured at the bottom (a hold triggered there), and
returns to that anchor rather than to a bottom that has grown while it was away; the
restore loads that anchor's window like any other anchor. Gestures and explicit
navigation supersede restoration, alignment and bottom pins through one function;
deactivation, session reset and unmount stop every list-owned positioning operation
(including a restoration in flight) through another. Middle-button autoscroll over a
nested output deliberately releases the transcript's follow as well: a transcript
still re-pinning its bottom would move that output under the held pointer.

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
window paging, which would otherwise leave follow after the send, and its pending
activation restore: a send before hydration keeps the bottom over a saved passage,
and does so even if the prompt is then rejected (the saved passage is not restored).

In-place reveals (`alignElement`) are reader-settlement holds on the revealed
element; key jumps hold their row the same way at offset 0, or the block their
optional selector finds in it on that frame (a timeline marker's own block). While
a jump's row is not rendered, the hold rewrites Virtua's current estimate of its
offset instead, since measuring the rows around a distant estimate can carry the
row out of the rendered range; once rendered it is aligned. Both last a fixed
30-frame window counted from the request, which layout never extends, re-measuring
and re-aligning the element on every frame, and are released afterwards. Within it,
viewport and header resizes re-align the
element instead of dropping it, and its requested offset is kept and clamped into
the current viewport only when applied. Gestures, navigation and focus moving to
another element inside the transcript scroller (Tab, assistive technology) end it at
once, and so does losing the element (an unmounted row); focus leaving the
transcript (e.g. to the composer) keeps it. Any other scroll during the window is
corrected like layout. A hold whose row rolls out of the window ends;
nothing retains a reader after a hold expires. Settlement, alignment and anchor
restoration share one anchor measurement. The long-reply hold is decided before
each bottom write, against the offset that write would reach, so it engages with the
reply top still below its line: once that top is above the viewport, Virtua (still
scrolling down) would compensate the reply's next growth and push it further up.
Known limitations: a search reveal is aligned one frame after its row's highlights
are painted, so that frame can show the message top; and Virtua renders the rows of
a jump's new offset only at its next scroll event, so a session switch within that
frame finds no anchor to capture and keeps the position from before the jump.
A hold whose reply grows while its pane is hidden lands at the top only
in the switch fixture: native events for an inactive session invalidate its message
load, and that fixture's `message.list` omits the in-flight reply, so the reload drops
the hold's anchor and restoration waits `ANCHOR_RESTORE_MAX_FRAMES` before its pixel
fallback. With the reply listed, the hold returns exactly; but the latest button's
reload then re-engages the long-reply hold at once, a product decision left open.
A following list shown again after `display:none` is pinned before its first painted
frame: a gap read in the animation frame that shows it predates layout and the
ResizeObserver-driven pin, and a browser check measures 0 px once painted.

Browser checks load the complete stylesheet and cover overflow, hover, keyboard
focus, RTL and 125% zoom, mixed text/tool/idle records, actual native thumb dragging,
and viewport anchor stability during streaming and distant jumps.

Hover/focus previews escape raw HTML and do no syntax highlighting; moving
elsewhere cancels obsolete excerpt work. An unloaded/empty excerpt shows no popup; resident
selected content can supply it directly. A separate 512-excerpt cache survives
view switches; entries older than 30 seconds revalidate on demand, without
timers/polling. The opaque surface wraps text and stays inside the viewport;
Escape, rail scrolling and viewport resizing dismiss it.

Automatic restoration of a missing anchor recovers once through the latest
visible page and replaces its saved anchor/cursor only on success; explicit
navigation reports the missing destination. Active-view initial reads
cancel on hiding.

Outline scans retain accepted pages and their sequence-horizon cursor when a view
is hidden or unmounted. Up to 16 structural snapshots (200,000 entries across the
retained LRU, except a single larger active index) are retained in the renderer,
keyed by instance/session, connection generation, content-mutation revision and undo
boundary. Returning reuses the completed rail immediately. An unchanged return
performs no index read. Message changes observed on activation/status transitions
refresh the last 32 indexed rows and new arrivals, preserving the prefix and last
completed display. Destructive edits/reconnect/undo invalidate the full index.
A status transition during an incomplete scan cannot discard its progress.

## Validation

- Server SQL and route tests cover distant windows, sequence gaps, overlap,
  cancellation, payload limits, staged undo and ownership/mutation races.
- `history-navigation.test.ts` exercises the real SessionView, transcript store,
  native event dispatcher and SQL readers on a 1,500-message Chromium fixture;
  `timeline-sync.test.ts` checks marker order, identity, placement and the reading
  line with the same readers on mixed native step shapes.
- `timeline-sync.qualification.ts` (opt-in, `npm run qualify:browser:timeline-sync`)
  measures marker agreement and click accuracy on replayed native session stores.
- `test-session-navigation-native.mjs`, run by the isolated pruning fixture, checks
  a 1,501-message session against a real Windows daemon. These fixtures cover
  Chromium and Windows daemons only, never an installed Electron/Tauri app, WSL,
  Linux or macOS.

## Agent conventions

- Timeline markers mirror the transcript: one marker per marked block, in transcript order (each text run, thinking run, tool or collapsed tool group, compaction and system context). They follow Message content: a tool marker is hidden when the tool type it shows (its icon, the outline's representative tool for indexed history) is hidden there, thinking markers when thinking is hidden and system markers when system messages are; markers with an active permission stay visible. A hidden active marker hands its highlight and reveal to its message's first visible marker (`activeVisibleId`) and never reappears just because it is active. Message content is the only control: never add a timeline-tools preference, View menu item, palette command or shortcut. The Nothing preset hides every tool marker. Covered by `tests/browser/timeline-tool-filters.test.ts` and `tests/browser/timeline-sync.test.ts`.
- Session timeline placement spans the transcript and composer via the session-owned mount; keep its rail layout in `styles/messaging/session-timeline-rail.css`. Hide the rail and force conversation-header actions into their overflow menu below 420 CSS px of the `session-center` container on all platforms. Keep that width-only force separate from measured header density so trial layouts can expand again above the breakpoint; filters anchor and return focus to the visible menu. Docked drawers reserve a minimum conversation width of 390 CSS px before overlaying. The composer worktree selector becomes a compact arrow-only cell below 460 CSS px of that conversation container (never the remaining composer width); keep its accessible label and styles in `styles/components/prompt-context-controls.css`. Timeline visibility must not depend on measured header density, changing status controls or viewport height; preserve the saved visibility preference.
- Timeline geometry uses the cached structural index independently of transcript/excerpt loading. Resident messages keep their exact markers (`buildTimelineSegments`); indexed messages outside the window take their native sequence position around them, with markers from the outline's `layout` (the step's visible part order) or, from older plugin copies, its counts ordered as thinking, text (kept when unknown), tools. Markers are keyed `messageId:type:ordinal`, so an indexed marker keeps its identity once its window loads; resident messages the transcript hides have no markers. Indexed tool markers retain the outline's representative tool name so their icon does not fall back to `other`; preserve that metadata through projection and persisted-index revalidation. A clicked marker or user-message jump stays active until the reader scrolls, and its own block is held at the top by the list's key jump (`scrollToKey` with a block selector, which survives row remounts and follows Virtua's estimate until the row renders); otherwise the active marker is the first marked block reaching below the transcript's reading line, refreshed once per frame on scroll and content rendering. Marker-to-block lookup and the reading line live in `components/timeline-transcript-blocks.ts`. Hover/focus previews render bounded Markdown, prefetch visible-nearby excerpts and prioritize the hovered marker through `stores/timeline-previews.ts`; never mount whole message/tool cards or fetch transcript windows for hover. Keep the viewport-bounded surface in `styles/messaging/timeline-preview.css`.
- Transcript rows and the header row (`.virtual-follow-list-before`) retain pointer hit testing during virtualizer scrolling (`styles/messaging/virtual-follow-list.css`), so nested code/tool scrollers, message and history controls receive gestures at their visible target.
- The transcript header (`renderBeforeItems`) is Virtua's row 0, ahead of the retired prefix: Virtua compensates its resizes like any row's, so never add list-side header corrections. Keep its index translation inside `virtual-follow-list.tsx`; it is never an anchor, a message or a `renderItem` call.
- Every list-owned transcript position write goes through `VirtualFollowList.writeScroll` with a reason from the closed `SCROLL_REASONS` list (`components/virtual-scroll-trace.ts`); never add a direct `scrollTop`/Virtua write beside it. User-gesture routing (wheel re-emission and middle-button autoscroll) also writes the transcript outside it; search reveals inside nested scrollers are the explicitly traced external exception (`search-reveal`); their transcript step goes through the list's `alignElement`. Diagnose jumps with the `scroll` logger namespace.
