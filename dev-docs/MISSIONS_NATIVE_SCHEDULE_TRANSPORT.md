# Native schedule transport

`native-mission-schedule-runtime.ts` registers the product carrier hooks, local
provider, receiving wake/status RPC, after-idle maintenance and fixed business
bridge. Its durable calendar owner and passage engine share the project document
exclusion. The daily document runtime keeps its own admission and control path.

`native-schedule-transport*` and `native-schedule-carrier*` supply the shared
transport/local-language primitives. `registerNativeScheduleCarrierFoundation`
provides a separate no-business-effect qualification composition.

The launch policy, document CAS and passage engine describe business scheduling
independently of native transport. Only the adapter owns the fixed carrier prompt,
private calendar facade and own-process HTTP hop. UI configuration projects the
Missions policy rather than native scripts. The observation port separately
requires original-input/terminal correlation and whole-family quiescence; a native
idle or inactive process-local session alone leaves that business proof incomplete.

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

The adapter calls only the internal `codenomad.missions.schedule.wake` mutation
and `status` read through the official client. Register these methods in the
current native RPC invocation graph, using the existing `nativeInvocation`
bridge where Promise business code needs scoped Core services. `status` reads the
exact saved outcome and can return `messagePresent` from a bounded point-read of
that deterministic native user message and its acknowledged schedule run. This
read hint preserves an `unknown` outcome and every prior dispatch hold. Returned
replies correlate the full wake key; business outcomes and archive/cursor updates
remain the receiver's CAS concern.

Every mutation requires a caller-owned durable `claim`: under the shared Mission
mutation exclusion, persist the exact dispatch intent/incarnation and return true
only for the first dispatch. Any unresolved dispatch in that Mission, and every
prior dispatch of the exact identity, returns false, including after a reload.
Release that exclusion before awaiting HTTP RPC. A claim
that outlives cancellation must retain its intent. Persisted intents are reconciled
through exact status reads; `unknown`, expiry or another occurrence must never
authorize a mutation resend. A pre-dispatch refusal describes only the current
attempt; preserve earlier uncertainty for that identity.

One process-wide lane per Mission spans bundle incarnations. The whole operation
has an eight-second deadline and an AbortSignal passed to RPC. Read-only discovery
has native probe timeouts and can finish after that deadline: its lane stays held
until it finishes, and its cancelled continuation refuses dispatch. RPC responses
are bounded to 1 MiB, both declared and streamed; redirects fail. Post-dispatch
failure remains uncertain. Error results contain fixed codes, keeping credentials,
native exception text and endpoint authentication out of logs and model messages.

Never add lifecycle calls, CLI children, default registration discovery, alternate
namespace lookup or standalone fallback to the wake transport. A running service
can be contacted independently of the supervision preference. Effective
`experimental.schedules`, service ownership and autonomous admission remain
distinct receiver guards.

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
result's two-space JSON holds at most 100,000 UTF-16 units, hence at most 300,000 UTF-8
bytes (three bytes per unit; escaped controls and lone surrogates are already counted
in the JSON text), plus fewer than 128 bytes of fixed RPC envelopes, below 1 MiB.
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

`nativeScheduleCarrierWakes` extracts correlation hints from at most 128 context
messages / 1 MiB, retaining at most 32 contiguous new runs after durable high-water.
Exact schedule IDs, deterministic message IDs, run, dueAt and late fields are
required. Gaps and incomplete metadata fail closed. RPC must point-read durable
messages and revalidate authority before reservation. Summaries remain prose;
same-carrier native compaction and exact reads own maintenance without changing
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
keep an unclosed claim held. Read-only status remains mutation-free.
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

Native compaction checkpoints and restart notices project as user-role model
messages. The invocation reader point-reads only referenced non-wake IDs from
the current model context to classify completed compactions and synthetics
carrying native `metadata.notice:"restart"`. Classification and deterministic
wake proofs share 128 reads and 1 MiB per invocation; SQL restricts each message
to 256 KiB and the remaining byte budget before transferring its body.
The model-context selector ignores their exact IDs only when schedule metadata is
absent and the ID is outside the current deterministic wake namespace. Prose and
description matching supply no classification. New scheduled users keep
their exact metadata and are point-read again by the RPC receiver. Automatic
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
