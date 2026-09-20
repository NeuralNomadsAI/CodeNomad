# Large-session switching: measured baseline and follow-up

## Scope and method — 2026-09-20

This is a desktop baseline for PR #723, not a claim that session streaming or
memory use is fully qualified. Windows Tauri `0.20.0-dev-20260920-5cb6f0eb` was
running the installed UI with the timeline-divider CSS update only. The behavior
fixes described below were not present during this capture.

Three real sessions were selected using native renderer input: the active long
integration conversation (approximately 11,000 stored messages / 13,983 timeline
markers initially), an already-warm issues conversation (11,714 markers), and a
review conversation (4,836 stored messages). Marker counts include content groups
and are not message counts. The integration conversation continued streaming.

Sequence: two rounds through all three sessions (sample at 300 ms and 5 s), then
six switches at roughly 400 ms intervals, 10 s settling, and one explicit renderer
garbage collection. The capture lasted approximately 45 s. It observed application
requests, DOM counts, JS heap usage and browser long tasks; it did not modify
messages or query the shared database externally. No credentials or message bodies
are included here. Native fixture tests use separate synthetic storage/daemons.

## Observations

| Area | Measured result | Interpretation / limit |
| --- | --- | --- |
| Saved passage | Three completed window requests for the same old anchor returned HTTP 200 with `blocked/conflict`; a fourth was cancelled. Reload controls reappeared on successive returns. | A saved anchor can outlive its message. Treating that as a generic conflict makes retry repeat the same impossible destination. |
| Warm return | The issues session had 32 rendered rows and 11,714 markers at the first 300 ms sample on each return. The integration rail also retained its complete outline. | Outline retention works for a completed snapshot; it does not fix transcript restoration. This is sampled availability, not a measured first-paint latency. |
| Cold outline | The review session had no rows/markers at 300 ms, then 16 rows, 338 resident markers and `2048 / 4836` outline progress at 5 s. A later visit resumed at 2048 and reached 2816. | Resume preserves accepted pages, but a short visit still presents only the resident rail until the entire outline is ready. |
| Outline traffic | 105 requests, 4.22 MiB completed response bytes. 90 requests belonged to the integration session, including two first pages. Six outline requests were cancelled. Slowest completed outline request: 4.53 s. | Full-history refreshes remain expensive even though individual pages are bounded. Retention and virtualization do not make refresh incremental. |
| Transcript traffic | 14 native message-list requests, 62.62 MiB completed response bytes. The integration session accounted for 42.17 MiB; the others for 7.85 and 12.60 MiB. None was cancelled in this trace. | Inspect load provenance, SDK reconciliation and view lifecycle together. The trace does not prove every list request was redundant or originated in the active-view hook. |
| JS memory | Initial sample 228.1 MiB; sampled peak 513.9 MiB; after explicit GC 216.3 MiB. | Significant transient allocation. The initial sample was not GC-normalized, so this neither proves nor disproves a retained-memory leak. These are renderer JS heap figures, not total desktop RSS. |
| Main-thread stalls | 39 tasks over 50 ms, 3,659 ms cumulative duration; p95 129 ms, maximum 514 ms. | Noticeable jank is measurable. A CPU allocation profile is still needed to attribute it among normalization, projection, layout and rendering. |
| DOM | Samples ranged from 3,076 to 5,585 elements across the window; active transcript samples had 0–32 mounted rows. | Rendering remains bounded in this short run. Bounded DOM does not bound parsed payloads, SDK stores or cached metadata. |

The capture file and profiling helpers are local diagnostics in the approved
temporary directory (`pr723-switch-profile.json`); they contain local session
identities and are not repository fixtures. Another run will differ with machine
load, message sizes, cached views, expanded tools and ongoing generation.

## Narrow corrections in this follow-up

1. **Distinguish absent anchors from authority conflicts.** The bounded native
   window operation reports `anchor_missing` only after session ownership/visibility
   has been checked and the anchor is absent from that session's visible rows.
   Route-level location/project/revert revalidation still wins over this result.
2. **Recover a stale saved position once.** Automatic session/window restoration
   loads a fresh visible latest page after `anchor_missing`. Its successful commit
   retires the dead anchor and cursor, so subsequent visits do not repeat it.
   Explicit timeline/search jumps still report missing destinations. Transport and
   ownership conflicts keep their retry semantics and never authorize this fallback.
3. **Cancel the initial view-owned read on hiding/disposal.** Its load authority is
   released synchronously so an immediate return can issue a replacement before the
   old promise settles. Successful loads retain their loaded flag. An away-and-back
   cycle during hydration cannot revive an obsolete callback for the same session.
4. **Prioritize transcript hydration over outline scanning.** A loading active
   transcript pauses its outline scan; accepted metadata/cursor and the previous
   completed rail remain retained. This is local priority, not a global scheduler.
5. **Timeline scrollbar rule.** A light, non-interactive 1 px separator uses the
   Status card contour color and appears only when the measured rail overflows.
   It follows the content edge without assuming a platform scrollbar width.

## Remaining work, ordered by user impact

| Priority | Work | Evidence / risk | Acceptance check |
| --- | --- | --- | --- |
| P1 | Merge live events with latest-window reads instead of requiring a quiet interval | `loadMessages` rejects a latest snapshot whenever message revisions changed during the read, with three bounded retries. Sustained generation can exhaust that policy. This starvation risk is from code inspection, not a separately isolated failure in the desktop trace. | Delay a large latest page while emitting real native deltas; publish current content without lost/duplicated text, unbounded retries or false empty state. |
| P1 | Incremental/coalesced outline refresh | Two first pages and 90 outline requests for the streaming session in one short run. Current status/message-driven refresh still scans the prefix. | Track append horizon and dirty existing entries; fetch changes without rescanning all history. Destructive mutation/revert/location fences must remain authoritative. |
| P1 | Attribute repeated native lists | 62.62 MiB in 14 list responses, including warm sessions. Several consumers exist: view opening, native SDK reconciliation, rotation and restoration. | Tag request initiators and repeat cold/warm/rapid switches; coalesce only equivalent reads and prioritize foreground destinations. |
| P2 | Reduce outline parsing and per-page overhead | The wire outline is small, but `navigation-store.ts` reads/parses message JSON, yields, and each page repeats the authenticated storage binding and ownership checks. | CPU/I/O profile of large tool-heavy history; bounded metadata projection with measured cancellation latency and no weakened ownership checks. |
| P2 | Byte budgets across caches and stores | UI view cache is five sessions; outline snapshot cache is four keys. Limits are counts, not a total byte budget. Cache eviction does not necessarily release objects still held by mounted owners. | GC-normalized runs beyond both cache limits, multiple instances, eviction and session deletion; document retained bytes and ownership before choosing budgets. |
| P2 | Reduce projection allocation during streaming | `session-outline-projection.ts`, timeline layout/maps and reactive segment state traverse metadata collections. A 514 ms long task was observed, but not attributed. | Profile allocations and CPU stacks with 10k/50k markers and sustained deltas; stable marker identities and scrollbar geometry must survive optimization. |
| P2 | Improve cold-loading presentation | A 4,836-message session still had only 338 resident markers after 5 s. | Show clear progress while preserving a usable rail. Do not publish growing partial extents that move a manually held scrollbar thumb. |
| P2 | Error provenance and recovery | Earlier desktop refresh HTTP 500 was not reproduced in this trace. Some route admission awaits occur outside the navigation handler's catch; errors may lose their cause. | Capture stage/timing/retryability without payloads, distinguish cancellation from failure, and make each retry repeat a recoverable operation. |
| Qualification | Soak, constrained links, other hosts | This is one Windows desktop run, not Electron/macOS/Linux/WSL coverage or a leak study. | Slow network, reconnect during initial/anchor reads, cleanup/revert during switching, more than five large sessions, repeat equal-workload GC baselines and process-private bytes over a longer run. |

## Regression coverage

- The real SessionView/SQLite-backed browser fixture covers missing saved anchors
  with a resident window and after eviction, a second return without retrying the
  dead anchor, and no automatic fallback on an ownership/revert conflict.
- The active-load hook tests cover immediate cancellation/authority release,
  reactivation before promise settlement, successful cache retention and an
  away-and-back hydration race.
- Existing mixed-history navigation cases retain exact extent, native thumb
  ownership, window overlap, distant jumps and streaming reading-position checks.
- The isolated native navigation fixture checks the new absent-anchor result over
  the real plugin RPC as well as its existing export/window/outline parity checks.

Test outcomes and installed artifact status are reported separately in the PR;
baseline measurements above must not be relabeled as post-fix measurements.
