# Native schedule transport

`native-mission-schedule-runtime.ts` registers the product carrier hooks, local
provider, receiving wake/status/admit RPC, the code wake tool, after-idle
maintenance and fixed business bridge. Its durable calendar owner and passage engine share the project document
exclusion. The daily document runtime keeps its own admission and control path.

`native-schedule-transport*` and `native-schedule-carrier*` supply the shared
transport/local-language primitives. `registerNativeScheduleCarrierFoundation`
provides a separate no-business-effect qualification composition.

The adapter owns the fixed carrier prompt, calendar facade and own-process
HTTP hop; the launch policy, document CAS and passage engine own business scheduling.
UI configuration projects Missions policy. The observation port requires
original-input/terminal correlation and whole-family quiescence.

The calendar facade uses `ctx.experimental.automation` for create, carrier-scoped
list and delete when advertised. The private Automation service supplies point
reads, Pause/Resume and the enabled check, plus create/list/remove when the plugin
API is absent. Both creation paths run under the persisted slot anchor's Effect
Clock. A failed API call never switches transports; recovery reads the exact
carrier and checks the row against the saved intent before adoption or cleanup.

## Transport contract

The caller supplies the owned absolute registration path resolved at arming in
the service's host namespace, the exact Location directory and wake identity.
Discovery uses only `Service.discover({ file })`; authentication is constructed
in memory with `Service.headers`. The public `Info` projection keeps
`id/pid/url/version`, requires a nonempty incarnation and the current process PID,
and reads at most 32 KiB. Versions participate in equality checks; availability
follows the consumed contracts. Discovery and the registration projection run
again before dispatch. The RPC handler uses `nativeScheduleIncarnationGuard`
after I/O and synchronously before every CAS/native effect, alongside its fresh
mapping/Location/generation/state guards. The receiver resolves its registration
path from its owned durable mapping and requires the supplied path to match it.

The adapter calls only the internal `codenomad.missions.schedule.wake` mutation,
the `status` read and, for [code wakes](#code-wakes), the `admit` mutation through
the official client. Register these methods in the
current native RPC invocation graph, using the existing `nativeInvocation`
bridge where Promise business code needs scoped Core services. `status` reads the
exact saved outcome and can return `messagePresent` from a bounded point-read of
that deterministic native user message and its acknowledged schedule run. This
read hint preserves an `unknown` outcome and every prior dispatch hold. Returned
replies correlate the full wake key; business outcomes and archive/cursor updates
remain the receiver's CAS concern.

`admit` takes no claim: it only writes a preparation, under the document exclusion,
for a code run whose own program is live in this process (see [code wakes](#code-wakes)).
Every `wake` requires a caller-owned durable `claim`: under the shared Mission
mutation exclusion, persist the exact dispatch intent/incarnation and return true
only for the first dispatch. Any unresolved dispatch in that Mission, and every
prior dispatch of the exact identity, returns false, including after a reload.
Release that exclusion before awaiting HTTP RPC. A claim
that outlives cancellation must retain its intent. Persisted intents are reconciled
through exact status reads; `unknown`, expiry or another occurrence must never
authorize a mutation resend. The one replay is an abandoned claim: status reports
`abandoned` when the exact claim is unsettled, its run is still above the calendar
high-water, and its receiver has ended. A receiver of another incarnation fails its
incarnation guard before every CAS; one of this process registers its own Promise
for its whole lifetime (`native-mission-schedule-wake-flight.ts`, shared across bundle
reloads) and also fails once its signed preflight expires before it consumes the run.
Such a dispatch consumed nothing, so the caller re-claims that same identity (`retry`), rechecking abandonment
under the Mission exclusion, and dispatches it with a fresh preflight. The run counts as
consumed once its high-water commits: claim closure and reconciliation no longer need the
preflight. The caller's eight-second deadline can still cancel that request; the next
wake then reconciles. A pre-dispatch
refusal describes only the current attempt; preserve earlier uncertainty for that identity.

One process-wide lane per Mission spans bundle incarnations. The whole operation
has an eight-second deadline and an AbortSignal passed to RPC. Read-only discovery
has native probe timeouts and can finish after that deadline: its lane stays held
until it finishes, and its cancelled continuation refuses dispatch. RPC responses
are bounded to 1 MiB, both declared and streamed; redirects fail. Post-dispatch
failure remains uncertain. Error results contain fixed codes, keeping credentials,
native exception text and endpoint authentication out of logs and model messages.

Never add lifecycle calls, CLI children, default registration discovery, alternate
namespace lookup or standalone fallback to the wake transport. Effective
`experimental.automations`, service ownership and autonomous admission remain
distinct receiver guards.

## Code wakes

New calendars are Automation rows whose action is the fixed Code Mode program
`MISSION_WAKE_CODE` (`native-mission-automation.ts`). It calls the
`codenomad.mission_schedule_wake` tool (`native-mission-schedule-code-wake.ts`), so
a due run needs no model, provider or carrier message. Rows created with the
carrier prompt keep it, and the carrier hooks and local provider serve them, until
they retire. The kind of a calendar is the action of its row; documents record none.

OpenCode authorizes the program once at creation from the carrier session, which
carries exactly `MISSION_WAKE_PERMISSIONS` (Code Mode and the tool's own permission);
a carrier created without rules receives them before its code row, and a carrier
with other rules is refused. OpenCode counts a run only after its program returns,
fails a program that throws and retries the same run after a minute, and pauses the
row after three failures; the owner resumes a principal or auxiliary row it finds
paused while the Mission runs, at the row's next slot.

The tool accepts only an unattended run (`Permission/Unattended` is set) whose
context session is a verified current carrier and whose context message is
`msg_<aut>_<run>` for that carrier's calendar. A retiring carrier returns without
effect. Its deadline is twenty seconds, below the program's thirty.

- Each tool call registers its wake process-wide (`runningMissionCodeWake`) before any
  effect. Row state alone also fits a future occurrence, so first admission and an
  auxiliary's uncounted-run proof require that live registration.
- A principal run first reconciles an unsettled claim on another occurrence and a
  counted preparation of an earlier run. `admit` then checks, under the document
  exclusion, the exact code row, its unchanged count (`run - 1`) and its next due
  time, and the prompt-entry control barriers, and writes the preparation. Wakes of
  one Mission share a transport lane; a call that finds it busy waits within its deadline. The
  program returns once admitted (`pending`) or consumed (`applied`); the dispatch
  that follows is retried by later wakes like a carrier turn's. A refused admission
  writes nothing, so the program fails and OpenCode retries the same run. A row
  resumed after failed runs reuses the count at its next slot: admission replaces the
  unreserved preparation of that count with the new due time.
- An auxiliary run dispatches itself through status, claim and wake, then the
  original next principal preparations, and returns only once applied.

`missionCodeWakeProof` replaces the native message wherever a code row's wake needs
proof (receiver reads, passage coverage, auxiliary preflight): a run at or below
high-water, a principal's preparation, or an auxiliary run still in flight. A code
row's count may trail high-water by one while its program returns; any count above
the calendar's high-water and preparation fails closed. A prepared code run is the
fan-in barrier from admission. OpenCode counts a returned program even after its
row was paused, so each tool call registers its wake process-wide for its whole run
(`runningMissionCodeWake`). `wakeAcknowledged` accepts a counted run, or a prepared
run of a paused or done row whose program is no longer running in this process.

A code auxiliary that settles the last passage reconciles cleanup within its own run:
with no carrier turn its carrier is quiet, so its row, carrier and index are removed
before its program returns, and OpenCode's count of the removed row writes nothing.
A retained retiring auxiliary's code run asks the same cleanup-only maintenance RPC
that prompt-row carrier turns reach through their after-idle hints.

A run Missions consumed but OpenCode had not yet counted when the service stopped is
retried by OpenCode once its row is due again while active, and then counted. If the
row is paused before OpenCode retries it, including after the restart, after Resume
the row reuses that run number for its next slot, which the receiver reports as
consumed, so that slot launches nothing.

## Business result bounds

The business receiver fits mutations with the ordinary tools' shared
`missionMutationToolResult` before serializing its reply. Only its `toolResult`
crosses the wire: revision/frontier, compact affected tasks and a native declaration's
canonical assignment, with the same omission reads and revision task pages. Reports
and briefings keep their compact revision result. Exact original request IDs retain
the journal's committed replay semantics after a lost reply.

All map, task, list and content inspection uses `inspectTool` in the owning invocation.
Its observed conversations and decision candidates are fitted with the rest of the
task view. Direct `inspect`, `listMissions`, `observeTask` and `decisionCandidates`
bridge calls are refused; internal observation stays inside the receiver. Each fitted
result's two-space JSON holds at most 100,000 UTF-16 units / 300,000 UTF-8 bytes,
plus fewer than 128 bytes of fixed RPC envelopes, below 1 MiB.
Catalog ownership checks carry a null acknowledgement after validation. Replies use
the byte-checked JSON codec so journal-valid artifact nesting fits inside its display
and RPC envelopes; requests retain the authority codec's structural checks.

`native-scheduled-business-results.test.ts` compares scheduled and ordinary registered
tools with 60 large tasks, three-byte BMP text, prompt/content reads and paging.
`native-scheduled-business-rpc.test.ts` also drives the authenticated bridge with real
MissionControl writes and a lost committed reply, verifying an exact replay leaves
the journal revision and write count unchanged.

## Local carrier primitives

`nativeScheduleCarrierHooks` supplies public language/context/title/compaction and
provider-HTTP hooks. Register them with the native plugin and an exact owned
carrier lookup. Bundle `createNativeScheduleCarrierProvider` at the acquired
`aisdk:file` path, create the carrier with its explicit technical title and the
fixed local model, and reject missing provider/bundle/selection at admission.
The language object is shared and stateless; title and compaction return local
results even when auxiliary agent defaults point to remote models. Context
validation clears technical tools; provider HTTP for an owned carrier throws.

`nativeScheduleCarrierWakes` follows the [context read contract](#context-read-authority-and-bounds).
Same-carrier native compaction and exact reads own maintenance without changing
the schedule identity or phase.

## Checks and integration gates

Run:

```sh
node --import tsx --test packages/server/src/opencode/missions/native-schedule-transport.test.ts packages/server/src/opencode/missions/native-schedule-carrier.test.ts packages/server/src/opencode/missions/native-schedule-carrier-binding.test.ts
```

The transport tests exercise official discovery/auth/RPC against a local HTTP
fixture, same-URL incarnation replacement, an eight-second discovery overrun,
response bounds, cancellation, shared lanes and durable-claim replay refusal.
Carrier tests exercise cached local language, local auxiliary hooks, exact wake
keys, replay high-water and incomplete-context refusal.

`node scripts/test-native-mission-calendar-api.mjs <absolute-isolated-cli> plugin`
qualifies the three plugin calls, including an intentionally lost creation reply
after insertion and delayed creation of recurring and relative slots. Use `core`
instead on a runtime without the plugin API to qualify the compatibility path.

Native shipment qualification requires registered handlers with actual durable
CAS, cold restart/backend absence, private Core graph/shape/lifetime checks,
auxiliary reconciliation schedules, provider/network spies with forced native
compaction, ordinary-entry carrier protection and installed bundle retention.
The no-provider-HTTP guarantee belongs to that installed native composition;
transport discovery and internal RPC themselves use loopback HTTP.

## Native document composition and packaging

The production `native-mission-schedule-runtime.ts` composes the provider and exact
local hooks with its fresh wake/status receivers. Context-side dispatch first
reads signed native readiness and freezes a fan-in cutoff; its outer eight-second
deadline spans both preflight and wake. Incomplete coverage and prior uncertain
dispatches retain their original durable preparations and stay read-only. The
receiver consumes and closes auxiliary technical claims before owner and pending
business reconciliation, then reapplies owner cleanup after settlement. Its
business bridge is registered once by `registerNativeScheduledBusinessRpc`.
A `MissionControlError` refusal crosses that bridge as a bounded `refusal` reply
(message and code) and is rethrown to the tool as on the direct path; every
other receiver or transport failure surfaces as "Scheduled Mission business unavailable".

The principal preparation is written by the prompt hook before native inbox
admission, serialized with Pause and temporal replacement. Context reads the
persisted original and native ACK before transport. A separate fixed maintenance
RPC receives bounded public terminal hints from learned pure carrier/installation
data. It rechecks native quiescence in a new HTTP graph before cleaning a carrier
that was active during its own wake. It never uses status reads as mutations or
resends a prior dispatch claim. The subscription, its maximum 128 pending hints
and temporary debounce fibers belong to the plugin Scope.

The registered runtime resolves the exact session marker into its point-read
unified Mission document and current calendar, checks its project/Location/local
model, and rejects stale generations. It keeps one native KV dispatch claim per
Mission (32 KiB), serialized with document mutations across bundle incarnations.
An unresolved claim holds newer wakes; a current high-water proof permits replacing
the single slot. `closeNativeScheduleCarrierClaim` persists a monotone
`settled: { revision, highWater }` receipt on the exact claim under the same
project document-mutation exclusion. Its proof is the matching session/schedule/
time-generation mapping in the current or retiring calendars, with high-water
covering that run. Principal reservation consumes its technical occurrence in the
same CAS: high-water advances to its run while `pendingWake` retains the exact
business reference. This permits closing the principal claim while business stays
pending and admits the auxiliary claim. Later ignored contiguous occurrences keep
that pending reference and may advance high-water; settlement preserves its maximum.
The runtime closes after the committed technical CAS; a calendar replacement owner
closes before discarding retiring mappings. A closure receipt survives temporal
replacement and lets the next generation use the single slot. Missing/pruned proof,
an unreserved uncertain run, a lost dispatch acknowledgement or an elapsed deadline
keep an unclosed claim held until its receiver is proven ended. Every carrier context
turn first reconciles an unsettled claim on another occurrence through that exact
original (a status read, then the abandoned replay), so a slow source read that
outlives the eight-second deadline delays the schedule by one wake instead of holding
every later principal and auxiliary wake. Read-only status remains mutation-free.
During incomplete arm/replacement, the current auxiliary has its own durable
partial mapping. A lost auxiliary-create ACK uses read-only exact native-row
preflight against its verified current intent; the optional trusted claim
resolver carries that binding across the own-process RPC boundary. The claimed
receiver adopts the existing auxiliary, consumes its technical occurrence and
closes its claim before owner reconciliation. Complete synchronization preserves
the partial mapping's progress. Principal admission keeps its control barriers.
Native document publication uses
`acquireNativeMissionDocumentStore` and its real SQL revision CAS.

`nativeScheduleCarrierLookupKey` point-reads the reverse ownership record under
`documents-v1/carriers/<projectToken>/<sessionID>`, including current, retiring and
pending-cleanup descriptors. The owner writes it before session creation and
removes it after confirmed native session removal. Ordinary-route protection uses
ownership even when marker/model verification fails; technical execution requires
verified current ownership. New technical roots use
`ses_cn_schedule_<40 lowercase hex>` and keep their indices during uncertain cleanup.

The receiver rereads exact native session/message/schedule rows around publication
in its current RPC graph. Its transaction guard checks incarnation and installed
artifact bytes alongside the document adapter's revision CAS. Cross-row native
mutation fencing for business admission belongs to CORE's admission boundary.
Never acquire another root SQL lease inside the document transaction's synchronous
guard. Keep required Core work in the current invocation and join it before graph
release.

## Context read authority and bounds

Native compaction checkpoints and restart notices project as user-role model
messages. The invocation reader point-reads every referenced user-role ID from
the current model context in the exact carrier session to classify native scheduled
users, completed compactions and synthetics carrying native `metadata.notice:"restart"`.
Projected metadata and prose supply no authority. Context input is bounded to 128
messages / 1 MiB; classification has 128 exact reads / 1 MiB per invocation.
Candidate proofs reuse those resolved native rows. A separate recovery budget of
nine exact reads / 1 MiB covers a compacted candidate and up to eight principal
recoveries, so full context cannot consume recovery capacity. SQL restricts each
body to 256 KiB and its remaining lane budget before transfer; an existing row
outside either bound raises the coverage error, including during recovery.
Read-count exhaustion also raises coverage, preserving durable uncertainty visibly.
The native-record selector ignores notice/checkpoint IDs only when schedule metadata is
absent and the ID is outside the current deterministic wake namespace. Prose and
description matching supply no classification. Wake records require native user type,
the fixed signal, exact schedule ID, deterministic message ID, run, dueAt and late
fields. At most 32 contiguous new runs follow durable high-water; gaps and partial
metadata fail closed. Stored scheduled users carry their exact metadata and are
point-read again by the RPC receiver, which rechecks placement, mapping, native
schedule correlation and source bytes before CAS/high-water publication. Automatic
compaction can also serialize the current wake into the checkpoint: when context
has no candidate, the hook first asks read-only `status` for the next deterministic
native message, including when the checkpoint has no model-facing ID. Only a positive exact-message hint permits attempting its original
claim; an existing hold still refuses dispatch. The mutation rereads the message.

`buildNativeScheduleFoundation` in
`packages/server/scripts/build-native-schedule-foundation.mjs` writes a standalone
local provider and reusable runtime bundle into a caller-owned absolute directory.
It returns SHA-256 manifests and enforces external native Effect/plugin modules.
Every owned hook checks provider/runtime existence and exact bytes, including when
the language is cached. Qualification and a hook-free observer/controlled-clock
package are explicit opt-in artifacts.

The owned provider's `languageModel` throws when the language hook is absent.
Create carriers with the fixed local model and an explicit technical title so
native initial-title generation stays out of the wake path. Primary model
resolution constructs that provider before automatic compaction selection; a
missing runtime therefore fails at local language construction, and a missing
provider fails at package loading. Qualify this consumed native ordering with
remote auxiliary defaults and an over-ceiling history when updating integration
contracts. Never replace it with a globally rewritten auxiliary agent selection.

`assertOrdinaryMissionScheduleInput` is the ordinary-input boundary primitive. Its
caller supplies authoritative carrier mapping membership and the resolved session
metadata; reserved schedule/carrier metadata are also refused on ordinary sends.
The native prompt hook separately rejects malformed carrier inputs. Apply the
ordinary guard to prompt/command/shell/compact/fork/import/move/update/delete at
the authorized product routes before exposing programmed Missions.

Run the isolated composition with an absolute qualified CLI and fresh scratch
directory:

```sh
node scripts/test-native-schedule-foundation.mjs <absolute-cli> <fresh-scratch>
```

`--cold-missing=runtime` and `--cold-missing=provider` retain an over-ceiling
history and the original session/schedule, remove the artifact while stopped,
and observe the natural native wake after cold startup with no project client.
`--controlled-maintenance` uses a real every:90-minutes row and automatic
compaction, holds the local compaction hook to compare row snapshots, then
restarts and processes the next original slot. Only the tick's native Effect
Clock is controlled; OS time is unchanged. That mode measures maintenance and
phase/end preservation, while ordinary cold autonomy uses the natural-wake mode.

It installs the reusable registration/provider against the native unified document
adapter in a private service. The fixture owns its paths, credentials, network spy,
calendar and daemon processes.

Product qualification uses `scripts/test-native-mission-schedule-product.mjs` with
an absolute isolated CLI and fresh approved scratch child. It drives the real
authenticated creation/settings/control routes and retained product bundle, then
closes the backend and restarts only its owned managed service. Native SQL reads
observe the cold no-client window. `--controlled-settlement` supplies an Effect
Clock only to the qualification tick; the natural wake/restart window uses wall
time. Additional fault-injection and platform gates belong in delivery evidence.
