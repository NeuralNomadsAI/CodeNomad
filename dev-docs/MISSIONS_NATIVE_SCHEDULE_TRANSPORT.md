# Native schedule transport

`native-mission-schedule-runtime.ts` registers the carrier hooks, receiving
wake/status/admit RPC, Code Mode wake tool, maintenance and fixed business bridge.
The durable calendar owner and passage engine share project document exclusion.

The adapter owns the Code Mode wake program, private calendar facade and own-process
HTTP hop; the launch policy, document CAS and passage engine own business scheduling.
UI configuration projects Missions policy. The observation port requires
original-input/terminal correlation and whole-family quiescence.

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
Native offers no joint snapshot of the Automation flags, a row and its carrier.
Calendar reads and mutations observe the flags, row and carrier together in the
final concurrent read, after all earlier awaits, and validate and act synchronously
on the result. Scheduled passage qualification uses the same read order.

The adapter calls only the internal `codenomad.missions.schedule.wake` mutation,
the `status` read and, for [code wakes](#code-wakes), the `admit` mutation through
the official client. Register these methods in the
current native RPC invocation graph, using the existing `nativeInvocation`
bridge where Promise business code needs scoped Core services. `status` reads the
exact run proof from the adopted Code Mode row and durable preparation or live
auxiliary run. `messagePresent` names that occurrence proof in the wire reply.
This read hint preserves an `unknown` outcome and prior dispatch holds. Returned
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
namespace lookup or standalone fallback to the wake transport. The effective
`automations` setting, service ownership and autonomous admission remain
distinct receiver guards.

## Code wakes

Mission calendars are Automation rows whose action is the fixed Code Mode program
`MISSION_WAKE_CODE` (`native-mission-automation.ts`). It calls the
`codenomad.mission_schedule_wake` tool (`native-mission-schedule-code-wake.ts`) without
a model turn. A new carrier has no model and carries `MISSION_WAKE_PERMISSIONS`;
carrier validation accepts an omitted model or the exact retained noop model identity.
Prompt rows are refused for arming, adoption, delivery and passage qualification.
Pause, Stop and Delete can clean up the owned row; recreate the schedule to run it.

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
  time, and the document control barriers, and writes the preparation. Wakes of
  one Mission share a transport lane; a call that finds it busy waits within its deadline. The
  program returns once admitted (`pending`) or consumed (`applied`); the dispatch
  that follows is retried by later wakes. A refused admission
  writes nothing, so the program fails and OpenCode retries the same run. A row
  resumed after failed runs reuses the count at its next slot: admission replaces the
  unreserved preparation of that count with the new due time.
- An auxiliary run dispatches itself through status, claim and wake, then the
  original next principal preparations, and returns only once applied.

`missionCodeWakeProof` qualifies the occurrence in receiver reads, passage coverage
and auxiliary preflight: a run at or below
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
A retained retiring auxiliary's run asks the maintenance RPC for that cleanup directly.
A reconciliation run that cannot recover a prior claim while an owner control is
pending asks it to settle that control, then recovers the same claim again.

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

## Carrier hooks and checks

`nativeScheduleCarrierHooks` supplies local title and compaction results for owned
carriers and refuses provider HTTP. The native `prompt` and `context` hooks throw
for every owned carrier. Ordinary product routes use
`assertOrdinaryMissionScheduleInput` to refuse authoritative carrier membership
or reserved metadata on prompt/command/shell/compact/fork/import/move/update/delete.

Run the transport, carrier binding, calendar service, wake and passage coverage
unit tests in `packages/server/src/opencode/missions/`. They cover official
loopback RPC, scope retirement, exact claims and replay, final concurrent reads,
cleanable non-code rows and local carrier hooks.

## Native document composition and packaging

The Code Mode caller first reads signed native readiness and freezes a fan-in cutoff; its outer eight-second
deadline spans both preflight and wake. Incomplete coverage and prior uncertain
dispatches retain their original durable preparations and stay read-only. The
receiver consumes and closes auxiliary technical claims before owner and pending
business reconciliation, then reapplies owner cleanup after settlement. Its
business bridge is registered once by `registerNativeScheduledBusinessRpc`.
A `MissionControlError` refusal crosses that bridge as a bounded `refusal` reply
(message and code) and is rethrown to the tool as on the direct path; every
other receiver or transport failure surfaces as "Scheduled Mission business unavailable".

The principal preparation is written by the `admit` RPC under document exclusion
while the Code Mode program runs. A separate fixed maintenance
RPC receives bounded public terminal hints from learned pure carrier/installation
data. It rechecks native quiescence in a new HTTP graph before cleaning a carrier
that was active during its own wake. On a live schedule it only settles a pending
owner control, with no quiescence check. It never uses status reads as mutations or
resends a prior dispatch claim. The subscription, its maximum 128 pending hints
and temporary debounce fibers belong to the plugin Scope.

The registered runtime resolves the exact session marker into its point-read
unified Mission document and current calendar, checks its project, Location and
allowed carrier model, and rejects stale generations. It keeps one native KV dispatch claim per
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
keep an unclosed claim held until its receiver is proven ended. Every Code Mode
wake first reconciles an unsettled claim on another occurrence through that exact
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

The receiver rereads exact native carrier and Automation rows around publication
in its current RPC graph. Its transaction guard checks incarnation and installed
artifact bytes alongside the document adapter's revision CAS. Cross-row native
mutation fencing for business admission belongs to CORE's admission boundary.
Never acquire another root SQL lease inside the document transaction's synchronous
guard. Keep required Core work in the current invocation and join it before graph
release.

## Product qualification

Product qualification uses `scripts/test-native-mission-schedule-product.mjs` with
an absolute isolated CLI and fresh approved scratch child. It drives the real
authenticated creation/settings/control routes and retained product bundle, then
closes the backend and restarts only its owned managed service. Native SQL reads
observe the cold no-client window. `--controlled-settlement` supplies an Effect
Clock only to the qualification tick; the natural wake/restart window uses wall
time. Additional fault-injection and platform gates belong in delivery evidence.
