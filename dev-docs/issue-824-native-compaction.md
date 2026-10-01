# Issue #824 — private native compaction isolation

## Result

**No cross-session service freeze reproduced in this bounded scenario on
OpenCode 2.0.21 / Windows.** A genuine OpenCode session compaction waited on a
deliberately held loopback summary response. While it was still waiting,
session B accepted a prompt, executed its model request and completed
successfully. Native session reads, activity and server info remained available.

The subsequent large-context qualification below sends verified 2/8/32 MiB
tool payloads from **A itself** to its compaction provider. It observes transient
pre-provider latency (up to ~85 ms in the outline-disabled matrix), but no
persistent cross-session freeze. This supersedes only the original size limit,
not its separate outline measurements.

This result separates provider waiting from service starvation; it does not
identify or disprove the reporter's root cause. It does not qualify OpenCode
2.0.19, Electron Linux, a remote Windows HTTP backend, or compaction work beyond
the bounded synthetic sizes below. Only the explicitly supplied 2.0.21 executable was tested; no other
runtime was installed or discovered.

## Fixture and isolation

Added `scripts/test-compaction-isolation-native.mjs` (383 lines). It follows the
existing isolated native-pruning fixture architecture:

- Requires an absolute CLI path. Runs `--version` and a child
  `serve --hostname 127.0.0.1 --port 0`, never `service start/restart` or service
  discovery. Authenticated server metadata must match the created child's PID
  and executable version.
- Gives that child fresh HOME, USERPROFILE, XDG roots, config directory and
  explicit database, all beneath the approved temporary directory. Project
  config discovery and model-catalog fetching are disabled.
- Uses only synthetic prompts/data and an HTTP loopback provider. Fixture hooks
  add request-kind/session headers and one inert tool; they do not override
  compaction results. A real provider request with kind `compaction` is held and
  then streams the summary through OpenCode's normal completion path.
- Builds the current session-pruning source into a temporary plugin bundle,
  explicitly configured against the private database. This tests outline work
  in the real native plugin host, not just an in-memory standalone reader.
- Retains private `result.json` and `server.log` evidence. Finally aborts its
  event subscriber, releases fixture gates, stops only its child, awaits its
  exit and closes the provider connections/server. The script exits naturally.
- No product edits, shared daemon/base access, user-profile mutation, commit,
  deployment or restart occurred.

Contract sources consulted before fixture adaptation: V2 client/API/plugin
guides and the installed `@opencode/client@2.0.21` generated declarations
(`session.compact/wait/get/active`, import/export and event timestamps), plus
`@opencode/plugin` session HTTP hook declarations. Configuration was checked
against the V2 config guide, not the legacy JSON schema.

## Procedure and causal assertions

1. Create and warm A/B with real native assistant/tool messages.
2. Outside the measured intervals, import a separate outline corpus of
   128 assistant tool messages × 256 KiB textual output (~32 MiB).
3. Submit A's compaction and observe its real provider request and
   `session.compaction.started`. Keep the response gated.
4. Sample native info, A/B get and activity concurrently four times.
5. Submit B's prompt and separately gate its primary provider request. Assert
   native activity reports **both sessions running**. Release B only; await its
   successful outcome and assistant conclusion while A's wait remains pending
   and no A compaction-ended event exists.
6. Run the real outline RPC against the separate corpus during A's provider
   wait; concurrently sample native `/api/info` as an external heartbeat.
7. Keep A held for another second, verify B get/info again, then release A.
   Require a completed compaction message in native context and an ended event,
   with no compaction-failed event.

The test has request/condition deadlines, but does not assert a fragile
millisecond performance threshold. Its main assertion is causal: B completes
**before the only mechanism that releases A is invoked**.

## Original small-context measurements

Two complete measured runs with the one-second extended hold:

| Measurement | Run `qAF00E` | Final run `cb4Y79` |
| --- | ---: | ---: |
| A compaction inbox admission | 17.1 ms | 8.1 ms |
| Total interval A held, from compact submission | 1485.7 ms | 1473.4 ms |
| Four info reads during hold | 3.0–7.0 ms | 2.0–4.5 ms |
| Four A get reads during hold | 3.3–5.4 ms | 3.2–5.7 ms |
| Four B get reads during hold | 2.6–4.6 ms | 3.3–5.7 ms |
| Four native activity reads during hold | 2.0–4.3 ms | 1.8–5.6 ms |
| B prompt admission while A held | 6.3 ms | 6.7 ms |
| B completion wait after releasing B, A still held | 21.0 ms | 9.9 ms |
| A completion after releasing A | 11.9 ms | 12.7 ms |
| Outline RPC, 128 × 256 KiB | 132.0 ms | 96.6 ms |
| Concurrent outline native-info requests | 7 | 7 |
| Maximum outline info-request latency | 12.4 ms | 10.5 ms |

In the final run, six info requests completed before the outline finished; a
seventh began near its end and completed afterward. These are native HTTP round
trips, not a main-thread deadline or renderer frame-rate measurement. The
working-source pruning bundle SHA-256 was
`3222a741d8707ac672c4b6e0c199993437372fbccabac769c7bbf3821e1a510a`.

Both runs observed one compaction started, 29 real compaction deltas, and one
compaction ended. A fast observer records `received - event.created` using
same-host wall clocks: held-compaction/both-held session-event maximums were
23 ms; summary-release maximum was 10 ms. No growing delivery backlog was
observed in those phases. This is **delivery-lag evidence**, not an inspection
of an internal queue, a losslessness guarantee, or absence of all backlog.

The seed/import phase had maximum event-delivery lag of 264/193 ms respectively.
It is kept separate: bulk import, local JSON encoding/GC and native work can
contribute, and this fixture does not attribute that delay to compaction.

## Commands and retained evidence

```powershell
$env:TEMP='C:\Users\Admin\AppData\Local\Temp\opencode'
$env:TMP=$env:TEMP
node scripts/test-compaction-isolation-native.mjs `
  'C:\Users\Admin\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe'
node --check scripts/test-compaction-isolation-native.mjs
```

Final run: PASS, OpenCode 2.0.21, child PID 19312, private endpoint
`http://127.0.0.1:63236` (stopped afterward).

Evidence directories beneath
`C:\Users\Admin\AppData\Local\Temp\opencode\opencode\`:

- `compaction-isolation-qAF00E/result.json` and `server.log`
- `compaction-isolation-cb4Y79/result.json` and `server.log`

An earlier successful development run used a shorter hold. The first setup
attempt failed before creating a server because `--version` had already made
the private config directory; directory creation is now idempotent. Neither is
included in the measured table above.

## Original investigation limits

- A's outgoing summary request was only 24,557 bytes. The separate 32 MiB tool
  corpus stresses outline reads, **not** summary-context assembly. This result
  excludes neither large-context serialization/parsing nor tool/provider-specific
  synchronous work during actual compaction.
- Manual summary compaction under a synthetic compatible provider was exercised,
  not provider-native checkpoint APIs or automatic context-overflow recovery.
- No CodeNomad HTTP proxy, renderer, reconnection or remote TCP path is present.
  Their independently reproduced defects must not be dismissed by this result.
- The current cooperating outline source was tested; this is not a native
  baseline/patch A/B or a general CPU-throughput comparison.

No product correction followed from that small-context non-reproduction. The
requested bounded large-A qualification is recorded next; runtime/platform
qualification and exact CPU attribution remain separate.

## Follow-up: real 2/8/32 MiB A context

### Fixture changes and size validation

`--context-mib 2|8|32` imports native user/assistant-tool pairs into A, using
templates generated by real native tool execution. Each tool has a distinct
canary and 256 KiB of ASCII text; one small trailing turn is retained separately.
The fixture rereads native context and asserts the exact message/tool counts
and total stored output bytes before measuring anything.

In this stress mode only, automatic compaction is disabled, `keep.tokens=0` and
the synthetic model advertises a 16,777,216-token context limit. This avoids
testing a silently shortened request instead of the requested byte budget. It
is deliberately not a typical production model policy. The V2 compaction guide
documents the retained tail and model-budget shortening behavior.

An initial development check exposed exactly that distinction: without a small
trailing turn, the first 2 MiB request contained only 7 of 8 payload markers.
The fixture failed rather than reporting the stored size as the compacted size.
Putting the current turn after the large summarized prefix corrected the corpus;
all subsequent runs assert all markers **and every payload-fill byte** at the
actual provider boundary. There is no direct SQLite seeding or mutation.

| A tool payload | Native messages (pairs + tail) | Payload markers received | Provider JSON bytes | Provider messages |
| --- | ---: | ---: | ---: | ---: |
| 2 MiB (2,097,152 bytes) | 18 | 8/8 | 2,123,428 | 26 |
| 8 MiB (8,388,608 bytes) | 66 | 32/32 | 8,421,286 | 98 |
| 32 MiB (33,554,432 bytes) | 258 | 128/128 | 33,612,826 | 386 |

Provider message counts differ from stored native counts because lowering adds
separate assistant tool-call/tool-result messages and the summary instructions.
These are compaction request sizes, not the earlier separate outline corpus.
`--skip-outline` omits that separate 32 MiB import/RPC so the assembly matrix is
not confused with outline load. Allowed A sizes are capped at 32 MiB, sequential
runs create only one private native child/provider each, and no size escalation
or runtime installation was performed.

### Phase measurements and causal checks

Immediately upon compact submission, info and B-get probes start, together with
a B prompt/wait. Their start/finish times are retained, with explicit booleans
for completion before provider headers/body. The provider records its handler
start (headers observable), complete body receipt and JSON parse separately.
The output distinguishes submission-to-arrival from **admission response** to
arrival; neither is mislabeled completed compaction duration.

All three witness calls must be issued before A's provider handler begins.
Their issuance is a client-call timestamp, not an upstream route-entry trace.
B succeeds before releasing A in every run. An additional B prompt is then
tested during the provider hold, both sessions must be running simultaneously,
and A's completed context/ended event is required after release. No timing
threshold was introduced in product or fixture assertions.

Two sequential runs at each size (no simultaneous fixture launch):

| Size / run | Compact admission | Submission → headers / full body | Max info / B-get wholly before headers | Early B prompt admission | Early B wait | B done before headers? |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 2 / `IO0hKV` | 6.4 ms | 31.2 / 33.9 ms | 2.5 / 24.6 ms | 26.4 ms | 27.2 ms | no |
| 8 / `mrXUsj` | 8.7 ms | 119.7 / 130.4 ms | 10.2 / 55.9 ms | 59.0 ms | 38.7 ms | yes |
| 32 / `I1Py1V` | 31.8 ms | 224.8 / 309.5 ms | 47.4 / 57.3 ms | 9.4 ms | 32.1 ms | yes |
| 2 / `gomUTk` | 8.5 ms | 56.2 / 66.1 ms | 3.5 / 36.9 ms | 48.7 ms | 57.1 ms | no |
| 8 / `ShUeBE` | 24.3 ms | 163.5 / 173.4 ms | 83.7 / 83.2 ms | 28.5 ms | 100.5 ms | yes |
| 32 / `jKWuew` | 45.8 ms | 290.9 / 332.7 ms | 83.2 / 82.3 ms | 11.3 ms | 52.7 ms | yes |

Requests *started* before headers can straddle arrival; their maxima were
84.7/84.3 ms for info/B-get in the final 32 MiB run. The table's wholly-before
filter excludes that fixture's provider body parsing from those latency values.
For the final 2/8/32 runs, admission-response → provider headers was
47.6 / 139.0 / 244.9 ms. Local provider JSON parsing was separately
2.7 / 7.3 / 29.9 ms; it is not native assembly CPU.

During the held-response phase of the matrix, native reads were generally a few
milliseconds (maximum 18.1 ms); B prompt admission was 6.1–10.0 ms. B completed
without releasing A at every size, then A completed 12.4–19.4 ms after release.
All runs observed started, 29 compaction deltas and ended, with no failed event.
Observed session-event lag in the assembly sampling phase reached 128 ms, versus
28 ms maximum during the B/provider-held phase. These are delivery observations,
not internal queue-depth or losslessness measurements.

### Attribution and limits

Confirmed: the pre-provider preparation/dispatch window grows with this stress
corpus, and unrelated native operations sometimes experience transient latency
inside that window. It cannot be attributed to the deliberately held summary
response: the provider hold has not begun for the wholly-before samples. B also
completes before A reaches the provider in the 8/32 MiB runs, ruling out a
continuous global stall throughout that preparation window in these executions.

Not confirmed: one particular synchronous SQLite step, tokenizer, JSON encoder,
lock or upstream function as the cause. The distribution differs by operation
and run, with fast info responses alongside slower B-get/admission in some
samples. Host scheduling, native GC/storage work and fixture scheduling remain
possible contributors. There is no native CPU profile or route-entry trace;
HTTP latency alone does not prove uninterrupted event-loop blocking. No upstream
or CodeNomad production patch is justified by this bounded evidence alone.

A compatibility smoke run with **2 MiB A plus the separate outline enabled**
also passed (`6OnLuq`). It verified all A bytes plus 13 completed native
heartbeats during a 218.2 ms outline RPC. That extra run is outside the matrix:
its pre-header B-get/prompt were 89.1/93.5 ms and seed-phase event lag reached
2.56 s. This additional variability reinforces the host/seed/GC qualification
limits; it must not be hidden or mislabeled a persistent compaction freeze.

The corpus is synthetic repeated ASCII, with imported historical templates,
fixture token usage and an artificially permissive model budget. It tests real
assembly of bounded bytes, not the reporter's exact token/JSON/provider workload,
automatic recovery, provider-native checkpoints or remote Linux/Windows HTTP.

### Reproduction / next step

```powershell
node scripts/test-compaction-isolation-native.mjs `
  'C:\Users\Admin\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe' `
  --context-mib 32 --skip-outline
```

Use `2` and `8` for the other bounded sizes; retain the TEMP/TMP setup above.
All seven successful runs retain `result.json` and `server.log` under the same
private `compaction-isolation-<run>` namespace. Every child was stopped and its
exit awaited; the script naturally exited. `node --check` passes. Only this
script and this report were edited for the follow-up.

Smallest useful next step: profile the **native pre-provider preparation window**
and correlate native route-entry/exit and event-loop work under a controlled
host, at the same fixed byte budgets. Preserve the verified transmitted bytes
and the wholly-before-header filter. Do not patch an unproven upstream hotspot
or reinterpret provider waiting as freeze; runtime 2.0.19 and the real remote
platform remain separate, untested qualifications.
