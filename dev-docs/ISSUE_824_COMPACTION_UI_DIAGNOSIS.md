# Issue #824: native compaction renderer diagnosis

## Scope

This investigation covers the UI event path only. It does not exercise session
pruning, the shared daemon, provider traffic, Electron/Linux, or the remote
Windows backend. The fixture uses the real `SessionView`, native event
dispatcher, OpenCode Solid reducer, CodeNomad message store, and virtualized
transcript. Native client calls and `/api` traffic are isolated fakes.

The red reproduction is:

```powershell
$env:TEMP = 'C:\Users\Admin\AppData\Local\Temp\opencode'
$env:TMP = $env:TEMP
node --import tsx --test --test-concurrency=1 packages/ui/tests/browser/compaction-responsiveness.test.ts
```

## Confirmed behavior

A compaction for an inactive session still performs synchronous work in the
single renderer that owns the active session:

1. `SSEManager.handleEvent()` calls `handleInstanceInvalidation()` for every
   native event.
2. `handleInstanceInvalidation()` calls `applyOpenCodeDataEvent()` before it
   checks whether the session is active for visible projection.
3. `applyOpenCodeDataEvent()` creates/retains a per-session OpenCode Solid data
   reducer and emits every `session.compaction.delta` into it.
4. The bundled `@opencode/client` reducer finds the running compaction and
   appends every fragment to its `summary` in a Solid `produce()` update.
5. CodeNomad delays only `projectOpenCodeMessages()` to 250 ms. That avoids
   repeatedly normalizing/hydrating the visible transcript, but it does not
   coalesce the upstream reducer work or callback scheduling.

The active transcript stayed byte-for-byte unchanged in the fixture. The
timeline and virtualizer were therefore not the cause of the measured stall.
No `message.list` request occurred during any burst. The one `session.active`
call per sample comes from the synthetic terminal `compaction.failed` cleanup,
not from delta delivery.

### October 1 isolated Chromium sample

Each fragment was 1 KiB. The fixture schedules a zero-delay active-session
timer before dispatch and records browser Long Tasks. The final run reported:

| Delta events | Dispatch | Active timer delay | Long tasks |
| ---: | ---: | ---: | ---: |
| 4,096 | 14.1 ms | 14.2 ms | 0 |
| 8,192 | 21.9 ms | 22.0 ms | 0 |
| 16,384 | 42.6 ms | 42.8 ms | 0 |
| 32,768 | 82.5 ms | 82.6 ms | 83 ms |

CDP sampling attributed named self time primarily to
`applyOpenCodeDataEvent` (36.3 ms), OpenCode/Solid store access/update paths,
and `projectMessages` (11.8 ms). A large `(program)` bucket remained
unattributed by the sampling profiler. The near-linear count scaling points to
per-event reducer/callback overhead rather than a whole-transcript DOM redraw
or a superlinear summary concatenation in this corpus.

Two preceding runs also failed red at 32,768 fragments, with 80-85 ms timer
delay and one 82-85 ms Long Task. A 16,384-fragment run varied around the Long
Task boundary (approximately 42-70 ms), so the regression deliberately uses
the larger corpus and asserts behavior, not a comparative performance gain.

## Interpretation and limits

This is a confirmed renderer scalability defect: inactive compaction content
is reduced synchronously even though it cannot be displayed. It provides a
mechanism for cross-session UI interference and demonstrates delayed active
input/timers in the real UI stack.

It is not yet proof that normal EventSource delivery produces one callback
containing 32,768 events. The current browser transport invokes `onBatch` with
one event, while the reproduction deliberately presents a backlog directly to
the dispatcher to make callback work deterministic. Real network task
scheduling may interleave user input. The corpus is also 32 MiB of aggregate
summary fragments, larger than many compactions. Therefore this result must
not be presented as the sole cause of the reported multi-second freeze.

The test does not reproduce the daemon-side symptom where other native
sessions stop progressing, nor the Linux Electron to Windows HTTP persistence
after restart. Those require separate service/transport evidence. Native
compaction and CodeNomad's pruning RPC are unrelated paths here.

Current V2 UI events are `session.compaction.started/delta/ended/failed` plus
other granular `session.*` events. No current renderer handler for legacy
`session.updated`, `message.updated`, or `message.part.updated` was found.

## Smallest recommended product patch

Coalesce `session.compaction.delta` **before** the OpenCode Solid reducer, keyed
by instance and session, instead of only coalescing the later CodeNomad message
projection:

- append fragments to a plain pending accumulator;
- preserve an immediate revision fence on the first arrival so in-flight
  native message reads cannot publish stale content;
- flush at most once per 250 ms to the reducer and visible projection;
- cancel the pending aggregate on `ended` because that event carries the
  authoritative final text, and discard it on `failed`;
- clear pending aggregates on instance disposal/reconnect;
- do not materialize an inactive, unloaded transcript reducer solely for
  compaction deltas. A later activation should hydrate authoritatively.

The regression should retain this two-session browser fixture and add exact
event-count instrumentation: thousands of inactive deltas must produce a
bounded number of reducer emissions/projections, zero message-list reads, no
active-transcript mutation, and no Long Task. Existing request-generation,
revert, pruning, rotation, and terminal-authority tests must remain green.

## Files added for reproduction

- `packages/ui/tests/browser/compaction-responsiveness.test.ts`
- `packages/ui/tests/browser/fixtures/compaction-responsiveness.tsx`

The initial timing-only test has since been replaced by deterministic reducer
and projection counters in `compaction-responsiveness.test.ts`. It is red on
the diagnosed implementation and green with the buffering correction. See
`issue-824-compaction-ui-fix.md` for the current gates and their limits. No shared
daemon, user profile, external network, or desktop restart is used.
