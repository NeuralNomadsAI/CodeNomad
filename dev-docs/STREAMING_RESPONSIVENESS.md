# Streaming responsiveness: bounded redundant-work fixes

## Scope — 2026-10-05

This investigates #851; it does **not** reproduce or establish a fix for the
reporter's Linux Electron freeze against a remote Windows server. The Tauri and
OpenCode-version comparisons requested from the reporter remain useful.

Two unnecessary client-side operations can be demonstrated independently:

- Each streaming session revision republishes the resident marker array, even
  when its individual structural markers retain identity. Outline projection
  then reconstructs the entire history and republishes an equivalent array.
- Multiple Markdown invocations awaiting the module loader all enter the
  synchronous parser. The former request-key check prevented some stale output
  publication, but not wasted parsing; same-key language retries could also
  publish obsolete results.

## Changes and invariants

Outline projection reuses its output when the immutable outline snapshot,
resident marker identities and translated labels are unchanged. Translation
reads remain reactive, including when the translator function retains identity.
Replacement snapshots, resident removal/reordering, tool metadata changes and
structural text-bucket changes still project. Unchanged projected output retains
array identity, preventing downstream rail geometry work. This deliberately does
not alter the existing 128-character signature granularity.

Markdown assigns each invocation a distinct request number, including cache hits
and language retries. It checks current invocation/disposal authority after
module loading, before parsing, and after asynchronous rendering before highlight
inspection/cache publication. Disposal also fences queued render notifications.
Fallback display, full-source copy, theme/highlight retries and render bounds are
retained. Parsing remains synchronous; this is not worker rendering or an
input-yielding scheduler.

Neither change delays/reorders native events or modifies transcript authority,
session admission, HTTP hydration, stored history or the OpenCode service.
Both desktop hosts consume the same host-independent UI implementation.

## Deterministic evidence

- Real SessionView/native-dispatcher fixture with a 10,000-entry outline: 64 paced
  one-character deltas within a structural bucket invoke full-history projection
  **64 times before / zero after**. The unchanged-input assertion fails against
  the baseline module. Crossing the bucket and switching locale still project;
  terminal text remains exact.
- Real Markdown/component/parser instrumentation: cold queued burst **33 parses
  before / one after**, warm same-task burst **32 before / one after**. Versioned
  and same-key bursts, disposal, cache-hit supersession, language/theme retries,
  code wrap/copy and bounded-display/full-source behavior are covered.
- Standalone actual outline implementation, Windows Node 24, 64 unchanged-input
  calls at 50,000 entries: baseline median **47.81 ms**, total **3,673.62 ms**;
  cached median **below 0.001 ms**, total **below 0.1 ms**. These measurements exclude
  Solid/DOM and apply only to unchanged structural inputs, not changed markers.

## Limits of the broad synthetic profile

`scripts/profile-streaming-responsiveness.mjs` profiles real SessionView with 620
seeded messages, bounded resident rows and approximately 100k streamed characters.
HTTP is fake and no full-history outline is supplied. Code bursts still produce
long tasks: the initial run's maximum heartbeat gap was about **369 ms**, and a
later run with these changes measured **515 ms**. Paced code measured roughly
74 ms and 83 ms respectively. Runs were not controlled for other concurrent
tests/builds; these are observations, **not evidence of an overall latency win**.
Fallback DOM replacement, layout, native-page reprojection and other costs remain.

Reproduce targeted work counts with the new `streaming-outline.test.ts` and
`markdown-latest-request.test.ts` browser tests. For outline CPU measurements use
`node --import tsx scripts/profile-outline-projection.mjs`, optionally with
`--baseline=/absolute/path/to/historical-session-outline-projection.ts`.
For saved CPU profiles/captures use
`node scripts/profile-streaming-responsiveness.mjs --kind=burst`; optional
`--chunk=8192 --deliveries=64` changes the workload. Timings are observational;
the regression gates assert work counts and behavior, not machine-specific speed.
