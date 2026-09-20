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

## Post-deployment check — incomplete

The `0636301f` UI/server resources were deployed with the existing `5cb6f0eb`
native executable after the packaged-resource smoke check passed. A second desktop
capture observed message-list requests being cancelled when their session was left
(roughly five seconds for the slower switches and 400 ms for the rapid switches).
The two comparison sessions still had zero rendered rows/markers at the five-second
samples; the streaming conversation showed only its small live resident tail.
No completed response in this capture established successful historical restoration.

The active instance changed before the settling sample, and the script's instance
fence stopped the run. Its local diagnostics are
`pr723-switch-profile-postfix.json` and `pr723-switch-postfix.log`. This is an
incomplete qualification run, not a comparable performance improvement: lower
memory or traffic while content has not loaded is not success. It confirms observed
cancellation on navigation but leaves cold-load latency and real missing-anchor
recovery to be verified in an uninterrupted desktop run. A subsequent read-only DOM
inspection found the review conversation rendered in the newly active instance;
that does not establish restoration in the originally measured instance.

## Structural index / demand previews follow-up

The next iteration separates rail geometry from content. `outline` now returns
only IDs, sequence, native type and tool/reasoning counts, up to 16,384 entries per
bounded response. `outlinePreview` returns bounded Markdown for requested IDs in
batches of 12, prioritizing hover and the visible area. The rail no longer waits for
transcript hydration or excerpt scans, and the loading countdown is removed.
Renderer index retention is now up to 16 sessions / 200k entries (one larger active
index is allowed); changed sessions refresh the last 32 entries plus new arrivals.
Ownership, destructive mutation, revert and connection-generation fences remain.

Validation of this iteration:

- All 19 Chromium navigation cases pass in one run. The cold-load case deliberately
  blocks both transcript and excerpt replies: complete index geometry is available,
  hovering shows no empty popup, and the eventual excerpt cannot resize the rail.
- Six other session-index visits do not evict the original; an unchanged return
  makes no structural request. A live update refreshes the tail rather than the prefix.
- Historical and resident hover/focus use bounded Markdown with real bold/link
  rendering, while native windows/lists stay untouched. The strengthened demand-area
  assertions also pass in a targeted rerun.
- Six SQL tests, three route-admission/race tests, both package typechecks, packaged
  resource smoke and the full isolated native OpenCode 2.0.5 UI fixture pass.

The resources were deployed on the existing native executable. A short real-desktop
capture (`pr723-switch-profile-index.json`) measured a complete 11,210-message index
in **one 2,050.9 ms response / 1,066,823 response bytes**, and the 4,857-message review
index in **one 581.7 ms response / 454,561 bytes**. The former displayed 14,265 markers
at the five-second sample, without a reload control. Excerpts arrived independently
in batches of at most 12. A later index request started from sequence 138527 rather
than the beginning, and was cancelled on leaving the session.

The user changed selection during the review-session visit, so the script stopped
instead of completing the warm/rapid-switch rounds. These timings are network
request durations, not precise first-paint measurements. They establish completed
structural reads in the installed app; they do not establish a desktop warm-return
latency or a completed restoration soak. A two-second cold read on the largest
conversation is still not instantaneous. SQLite must inspect nested assistant JSON
for tool grouping, although bodies are no longer copied into JS or transported for
index construction. The earlier whole-transcript allocation/streaming findings
remain relevant; lower excerpt traffic alone does not resolve them.

## Persisted index / checkpoint revalidation follow-up

The optional structural index now joins the native restoration partition graph.
On reload it seeds geometry before verification, then reconciles the complete
sequence range using checkpoints. Only changed blocks return structure. The last
block grows to 512 entries, preventing one-checkpoint-per-append accumulation.
Draft/scroll saves reuse immutable normalized indexes and encoded chunk hashes.

Validation so far:

- 21 Chromium navigation cases passed together, including a real renderer reload
  through the partition codec with the verification response held. The saved
  1,500-row geometry appeared before release, then reflected an offline deletion,
  an old technical-count edit and an appended message. A foreign-project index
  was not displayed. The final growing-tail adjustment passed both targeted cases.
- 75 restoration/codec/merge tests passed; two additional clear/disable cases and
  the persistence cases then passed with all 33 client-state/persistence tests.
  The 20,000-entry round-trip exceeds 1 MiB and keeps every native leaf below 1 MiB.
  Missing/corrupt index chunks preserve draft, selection and scroll state.
- Eight SQL/navigation cases and three ownership/race route cases pass, including
  offline pruning and repeated appends without manifest growth per message.
- All six Electron/Tauri project-tab restore browser cases pass. The selected-draft
  hydration test passes with `--conditions=browser --test-force-exit`; an initial
  plain Node invocation used Solid's server build and failed during module import.
- Both package typechecks pass. The isolated OpenCode 2.0.5 native/UI fixture also
  passes after the final tail-growth adjustment, including 1,501-message navigation
  and checkpoint reuse. Packaged Tauri resources pass the build and smoke checks;
  all 34 Electron native client-state storage tests pass.

These are fixture results. At this stage native automation reported no visible
session for this conversation, so installed-app restart restoration has not yet
been measured. No fresh desktop latency claim follows from these test results.

### Gatekeeper correction loop

The first independent whole-PR review reproduced three P2 defects. All three have
targeted fixes and passing regressions before the second review:

1. Delta pages could exceed 16,384 entries when deletions left partially filled
   checkpoint ranges. The reader now reserves one whole block before continuing;
   an 18,000-message regression validates every delta page against the RPC schema
   and recovers all 17,999 surviving entries.
2. The final bulk-cleanup invalidation could cancel a pruning-event reload without
   scheduling its replacement. Final success and ambiguous failure now use the
   same coalesced content-refresh path as native events. Six native-page/SDK-order
   cases cover success, timeout and event-only repair of the 200-message window.
3. A terminal status during an unfinished fixed-horizon outline scan could leave
   later arrivals unseen. Completion now compares the nonreactive message revision
   and requests one trailing scan. The Solid regression holds the last page,
   delivers a native message event and idle transition, and verifies the catch-up.

Both package typechecks pass after these corrections. The first outline test run
also exposed an incorrect expected request count: status cancellation retries the
last page before the single trailing scan, for four reads rather than three. The
corrected assertion passes and still requires exactly one catch-up.

The second independent gatekeeper pass reports **zero actionable findings** and
confirms all three fixes. Its separate SQL/persistence run passed 12 tests; its
Solid/pruning assertions also passed, although those reviewer processes retained
handles and hit the harness timeout. The primary validation used the documented
`--conditions=browser --test-force-exit` invocation and exited successfully.
The rebuilt packaged resources pass the smoke test after the fixes.
All 21 Chromium navigation cases pass together again after the gatekeeper fixes.
