# Cooperative transcript replay

The native SDK transcript and the displayed message window are separate caches.
Rotating the SDK's bounded window can wait behind an already pending SDK sync.
Events arriving meanwhile retain their FIFO position in the transcript queue.

Previously, the continuation replayed the entire queue synchronously and projected
the complete resident page after each event. The dispatcher also projected the
unchanged page on each queued event's original arrival. A bounded event count did
not bound CPU time: 122 ordinary events containing only 120 new characters could
block the event loop for seconds. An isolated Tauri/WebView2 guest reproduced a
3.20-second synchronous drain with 200 SDK-resident messages and a retained 4 MiB
tool result. The sync delay and SDK history were fixture prerequisites, not an
observed causal trace of issue #851. Smaller Node controls reproduced the same
mechanism without a large tool payload.

## Replay contract

- Reduce events in FIFO order. Never combine or discard ordinary SDK events.
- Use an 8 ms replay budget and a secondary 64-event ceiling, followed by a real
  `setTimeout(0)` task boundary when more work remains. A microtask or animation
  frame is not a substitute; replay must progress in hidden windows too.
- The dispatcher opts into one stable, chunk-safe publication callback. Project
  once per reduced chunk instead of once per ordinary event. Queued ingress does
  not hydrate a page that has not changed.
- Other deferred callbacks retain their per-event contract. A callback or changed
  publication identity is an ordering barrier, not an opportunity to deduplicate
  arbitrary caller effects. Inbox cancellation and revert stay per-event barriers.
- Revalidate transcript, entry and generation after publication and after each
  task yield. Disposal, reset, queue overflow and authoritative resync fence old
  continuations before they can publish into a replacement transcript.
- Preserve the existing authoritative recovery, append reserve and FIFO queue
  semantics. Compaction still aggregates fragments before SDK reduction at its
  existing interval; non-delta ordering barriers remain intact.

Individual reductions, snapshot copies and publications are still synchronous.
The replay budget bounds accumulated work, not the duration of one indivisible
operation. This change removes a reproduced aggregate stall mechanism; it is not
proof that every reported freeze or delayed reply has the same cause.

## Regression coverage

`packages/ui/src/stores/opencode-transcript-replay.test.ts` exercises the real
SDK, dispatcher and stores with isolated clients. It covers unchanged queued
ingress, bounded publications, timers observing unfinished FIFO replay, arrivals
during yields, callback barriers, destructive events, disposal/reset, overflow
recovery and compaction. Timer assertions are scheduler tests, not claims about
physical keyboard events or a native daemon.

The shared UI implementation applies to both desktop hosts; native rendering
evidence collected for this change uses Windows Tauri/WebView2, not Electron or
the remote CachyOS topology from the original report.
