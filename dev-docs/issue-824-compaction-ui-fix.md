# Issue #824: compaction delta reduction correction

## Outcome and scope

Native compaction fragments now aggregate **before** the OpenCode Solid reducer,
not merely before the visible transcript projection. No server, transport,
`task.tsx`, daemon, user profile or desktop deployment changes belong to this
correction. The preceding large synchronous backlog is diagnostic evidence,
not an acceptance gate or proof of real provider delivery frequency.

The implementation follows installed `@opencode/client@2.0.21` declarations and
its actual Solid reducer: `session.compaction.delta.data.text` appends to the
running row's `summary`; `ended.data.text` replaces it authoritatively; `failed`
replaces the running row with an error record. Durable start/end metadata is not
changed or synthesized.

## Product changes

- `stores/compaction-delta-buffer.ts`: one plain accumulator and one 250 ms timer
  per instance/session. It uses the exact native delta type and joins chunks in
  arrival order. The interval begins on the first chunk, so later chunks cannot
  postpone publication indefinitely.
- `stores/opencode-data.ts`: incoming fragments immediately advance CodeNomad
  message/full-data revisions and fence SDK reads, but emit one aggregate to
  the reducer per interval. Aggregate reentry does not advance admission twice.
  Same-session non-delta events flush preceding chunks to retain native order;
  unrelated sessions/instances cannot force a flush. End/failure, delete,
  committed revert, pruning invalidation, disposal and reconnect cancel pending
  content where its authority has ended. Idle flushes before reducer retirement.
- SDK history reads flush pending chunks before establishing read authority and
  before accepting responses. Otherwise a native page fetched after admission
  could already contain buffered text that would be appended a second time.
  A stale pre-delta page is rejected and receives the existing trailing read.
- Inactive sessions with neither a resident transcript nor a native observer
  do not materialize compaction payloads. Only their scalar admission fences and
  an unfinished-compaction marker remain. Final activation uses the native page.
  Activation during an unfinished skipped start recovers the running row via the
  existing authoritative resync path, rather than inventing a start/summary.
  The SDK's 20-row resync preserves the already hydrated native 200-row window.
  Subsequent streaming resumes interval reduction without duplication.
- `stores/instances.ts`: remove the old post-reducer timer. Deferred aggregate
  application projects once immediately; inactive loaded views remain invalidated
  but are not hydrated. Client replacement/removal destroys the owned native
  projection, including its pending buffer, rather than cancelling only the
  now-removed visible projection timer.

## Deterministic red/green evidence

The browser fixture instruments the real native emission and visible projection
boundaries through a test-only Vite transform. There is no product telemetry API,
mock reducer or render reimplementation. Both the full stylesheet and real
`SessionView` are mounted. HTTP/client responses are private fakes, and browser
requests outside loopback are blocked.

| Contract | Baseline `366830f6` | Corrected |
| --- | ---: | ---: |
| 128 tiny active chunks, immediate reducer emissions | 128 | 0 |
| Same burst, after first interval | 128 native emissions | 1 emission + 1 visible projection |
| 8 chunks spaced by 10 ms, first interval | 8 emissions | 1 emission + 1 projection |
| Second spaced interval | another 8 emissions | another 1 emission + 1 projection |
| 128 chunks for never-loaded inactive compaction | 128 emissions | 0 emissions, 0 projections, 0 message-list reads |
| Running compaction activated midway, subsequent 2 chunks | 2 emissions | 1 emission + 1 projection, exact cumulative text |
| Loaded but now inactive session, 4 chunks | 4 emissions | 1 emission, 0 hidden-view projections |

All five baseline browser assertions fail by exact counts, not timing or timeout.
All five corrected cases pass, including exact authoritative final text,
remount, immediate per-arrival revisions, no duplicate chunks, and active-session
isolation. Total active burst text is only 530 characters, not the preceding
32 MiB corpus. Spaced delivery uses genuine distinct task/timer intervals through
the native dispatcher, not one giant callback.

Descriptive ingress sample: baseline 128 chunks took **1.6 ms**, corrected
**0.4-0.5 ms** on the same host with other mission activity. These are sampled
development-build dispatcher durations, not controlled CPU benchmarks, frame
latency, or a claim of eliminating every freeze. No Long Task threshold remains.

## Executed gates

```powershell
# Current browser regression (5 pass)
node --import tsx --test --test-concurrency=1 packages/ui/tests/browser/compaction-responsiveness.test.ts

# Neighboring real-renderer/window/navigation regressions (67 pass)
node --import tsx --test --test-concurrency=1 packages/ui/tests/browser/history-navigation.test.ts packages/ui/tests/browser/session-rendering.test.ts

# Native reducer/admission/pruning gates (141 pass, including 11 new compaction cases)
node --conditions=browser --import tsx --test --test-force-exit packages/ui/src/stores/opencode-compaction.test.ts packages/ui/src/stores/opencode-data.test.ts packages/ui/src/stores/opencode-data-idle.test.ts packages/ui/src/stores/opencode-data-settlement.test.ts packages/ui/src/stores/session-native-events.test.ts packages/ui/src/stores/session-request-authority.test.ts packages/ui/src/stores/session-pruning-pagination.test.ts packages/ui/src/stores/session-pruning-projection.test.ts packages/ui/src/stores/session-pruning-events.test.ts

npm run typecheck --workspace @codenomad/ui
git diff --check
```

All commands above pass. The first combined browser invocation had a 120 s
harness timeout after 17 passing cases; it is not counted as complete. Re-running
the neighboring suites with a 360 s allowance completed all 67 cases naturally.
Unit gates use the repository's browser-condition/force-exit convention because
imported store timers persist. Diff check has only ordinary LF/CRLF warnings.

To reproduce baseline red without changing the checkout, extract the two
`366830f6` blobs `packages/ui/src/stores/instances.ts` and
`packages/ui/src/stores/opencode-data.ts` into a private temporary directory.
Set `CODENOMAD_COMPACTION_BASELINE` to it, then run the five browser cases. Vite
substitutes those blobs read-only and applies the same exact counters. Leave the
variable unset for ordinary corrected runs. Both old and corrected code use the
same dependencies, components and fixtures.

## Remaining limits / review targets

- This establishes avoided reactive work under modest separate event delivery;
  it does not qualify real EventSource wire traffic or Electron/Linux against a
  Windows backend. The companion transport/native diagnostics remain distinct.
- Same-session non-delta events and native reads intentionally force a flush.
  A workload continuously interleaving those boundaries can reduce the coalescing
  ratio; ordering and read authority win over a universal four-flushes/s promise.
- Mid-compaction activation uses the existing quiet/revision-stable native resync
  policy. Sustained arrivals can delay its authoritative catch-up; the already
  hydrated visible native page remains displayed. This patch does not replace
  that broader starvation policy or merge arbitrary in-flight history snapshots.
- No user database, daemon, provider calls, native-host timing, heap soak or
  deployment/restart was used. Source/token loss boundaries are covered by mocked
  deterministic native records, not an end-to-end real provider compaction run.
- File-size warning: touched `stores/opencode-data.ts` is approximately **828**
  lines and `stores/instances.ts` **2,093** lines. The new narrow buffer module is
  56 lines; no size-only refactor was attempted.
