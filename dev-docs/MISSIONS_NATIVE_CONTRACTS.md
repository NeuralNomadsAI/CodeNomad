# Missions native contract boundaries

## Scheduled HTTP request retention

`server/routes/mission-scheduled.ts` transfers its original physical permit through
`prepareMissionMapMutation.retain` to the fence-scoped scheduled-request hold.
The registry retains at most 128 Missions, with the original action/request/revision,
payload digest, workspace object, native project/canonical path, physical checkout,
profile, directory and connection. Unknown and partial outcomes keep that permit.
Only a positive exact original receipt with both result and control pending false
releases it. Missing/error/expired-proof reads retain uncertainty.

GET and repeated original requests read the original request ID. A new human
Check first requires its positive exact partial receipt, uses the retained
permit's busy guard and original connection, signs the human Check's fresh request
and revision, then rereads the original receipt before releasing that permit.
The held action, request, revision and payload digest stay fixed. Explicit partial
retry also requires a positive exact partial receipt and the original connection.
A retired connection's permit can settle through a fresh connection after the
same workspace, native project and physical-root proof. Reads can use that retained
permit while deletion waits, and remain observation-only. Revalidate live human
auth, request cancellation and ownership after asynchronous reads and responses.
Never infer an exact DELETE acknowledgement from an unqualified tombstone.

New scheduled CREATE rejects a pure immediate policy before physical admission;
standard one-time creation owns that policy. Configure retains same-object
conversion to immediate with its native armless-owner contract.

Public plugin/client contracts and private Core services have separate authority
and lifetime. Acquire private services inside the current RPC/Location Effect
graph; `native-invocation.ts` joins child reads and finalizers before releasing
that graph. A local `ctx.rpc` call keeps its originating graph. Every consumed
private shape and result requires a bounded check in the installed bundle.
Missing required coverage keeps the operation blocked with its original identity.

### Invocation graph availability

| Entry | Session | Database | Location | Schedule |
| --- | --- | --- | --- | --- |
| Plugin setup | absent | absent | absent | absent |
| Prompt hook | present | present | present | present |
| Context hook | absent | present | present | absent |
| Tool execution | absent | present | present | absent |
| Fresh receiving HTTP RPC | present | present | present | present |

`nativeInvocation.capture` preserves and joins the originating graph. Acquire the
scheduled passage runtime in a fresh receiving HTTP RPC when called from context
or tool execution. The public Session/KV prefilter selects the exact pending
family; the internal bridge accepts only fixed business-control methods and ENV
preparation, with each mutation entering `executeBusiness` under document exclusion.
Human lifecycle controls use their separate authenticated control path.

Internal RPC authentication carries the service's full privileges. Its trusted
adapter owns the exact service registration, endpoint, incarnation and native
pending-family checks. Never accept endpoint/path selectors from model input,
expose lifecycle through the business bridge, fabricate Core tags, or acquire an
unrelated root graph to complete a partial invocation.

One-time first Play persists its original validated native acknowledgement in the
same document CAS as admission time and launch count. The proof is internal;
public document summaries expose only its IDs/timestamps. A missing journal
receipt is reconstructed from that exact saved acknowledgement without invoking
transport, including when native history has been pruned. Shared running guards
combine the journal state and document desired state, so a paused/stopped
document blocks new work while a journal control publication catches up.
Journal-only maps retain their existing immediate controls and business execution
path. Their reads and mutations preserve the journal representation. New scheduling
uses explicitly configured unified documents; native conversation controls remain
available independently.

Paths below are relative to `packages/server/src/opencode/missions/`.

## Public surfaces

| Surface | Consumed shape | Boundary |
| --- | --- | --- |
| `@opencode/client/service` | `discover({file})` returns Endpoint/undefined; `headers(endpoint)` builds authentication; public `Info` describes registration fields | Exact absolute registration, bounded non-secret id/pid/url/version projection, current PID/incarnation before dispatch and inside receiving RPC. Keep credentials in operation memory. For wake transport, forbid ensure/start/stop/terminate, CLI children, standalone and alternate namespaces. |
| Client HTTP/RPC | `OpenCode.make(...).rpc(definition).method(input,{location,signal})` | Acquired authenticated connection, exact native directory and cancellation; preserve uncertainty after dispatch. |
| Schedule HTTP contract | `experimental.schedule.create/list/get/pause/resume/delete`, `{data:Info}`, session-filtered list, delete 204 | `opencode/native-schedule-capability.ts` recognizes the consumed request/response shapes read-only. Read `experimental.schedules` independently from the highest-priority whole native block. Never create probe schedules. |
| Plugin Session facade | get/create/prompt/synthetic/interrupt/context | Prefer facade methods when they expose the required operation. Preserve exact session/message IDs and fixed profiles at admission. Use bounded point/page reads for source coverage. |
| Session/AISDK hooks | prompt/context/title/compaction/language | Context admission requires the exact durable user message and schedule correlation. Title/compaction/language carry only local technical work. Treat metadata as correlation within service privileges. |
| Native context messages | `session.context` → native `SessionMessage.Info[]`; synthetic `metadata.notice:"restart"` | Bounded native IDs classify restart notices before model-facing wake extraction. Schedule-bearing or deterministic wake IDs retain strict validation; notice prose supplies no authority. |

## Private service inventory

| Context key / state | Consumed contract | Callers and required checks |
| --- | --- | --- |
| `@opencode/Session` | get/create → Session.Info; prompt/synthetic → SessionInbox.Info; environment → exact string map; inbox → array; cancelInbox → void | `native-service-adapter.ts`: method/Effect checks, public result codecs, pinned placement/parent/profiles/metadata, synchronous fence adjacent to dispatch, ≤1024 inbox entries. Environment is process-local and reapplied before admission. |
| Session message readers | messages({sessionID,limit,order,cursor:{id,direction}}) → array; message({sessionID,messageID}) → Info/undefined | Same adapter: ≤32 messages/source, ≤256 KiB native message, 16,384-character launch envelope; point-read anchor and each message, stable complete prefix, source placement/bytes rechecked after I/O. Deleted/moved/changed anchors block. |
| Session active | `active` is an Effect returning a ReadonlySet | `native-passage-observation.ts`: actual Set, ≤4096 sessions. Treat activity as a process-local observation. Require correlated durable terminal evidence and complete family quiescence for restart settlement. Keep an old execution claim uncertain during asynchronous native recovery. |
| `@opencode/Location` | directory/workspaceID/project{id,directory,canonical} | `native-service-adapter.ts`, `native-service-clock.ts`, recurrence readers: structural Location.Info fields, exact native/physical placement and current graph checks after I/O and before effects. |
| `@opencode/storage/Database` | db.$client.unsafe(sql,params).withoutTransform → Effect rows; db.transaction(callback,{behavior:"immediate"}) | `native-recurrence-storage.ts`, `native-passage-observation.ts`: current graph, actual SQL client/transaction, safe row types and synchronous query guard. Preserve the driver's transaction Context when composing effects. Asynchronous-only reads cannot implement the synchronous admission fence. |
| KV/CAS SQL | kv(key,value,time_created,time_updated); plugin namespace is plugin ID encoded as padded UTF-16 hex | `native-recurrence-storage.ts`: exact project key/bytes/revision, immediate transaction, conditional update and readback. Publish invalidation after commit; an invalidation failure preserves the committed result. |
| Family SQL | session_v2 placement/parent/time_suspended, session_inbox, session_message id/type/seq/content/idle | `native-passage-observation.ts`: family ≤4096, exact message/inbox presence and nonnegative counts. Anchor the original input in durable seq order and require a later terminal idle as the latest projection. Count failures only between that input and terminal, then recheck family, claims and requests. Missing anchor/terminal or any remaining claim keeps uncertainty. |
| Durable background delivery | kv keys in `job.background/`; JSON recovery kind and session/parent/child IDs | Same reader: ≤1024 records, IDs/kind only. A completed child with an undelivered native result still blocks its family. Unknown shape, table/column or coverage refuses settlement. |
| `@opencode/Form` | list/get/state/reply Effects; public Form.Info/State result codecs | `native-passage-observation.ts`, `native-human-answer.ts`: ≤1024 requests, exact native IDs, confirmed durable UI-answer mark and invocation lifetime. Sessionless requests conservatively prevent quiescence. |
| `@opencode/Permission`, `@opencode/Shell` | list Effects returning public Request/Info arrays | `native-passage-observation.ts`: ≤1024 each; unknown request ownership or running uncorrelated Shell blocks settlement. |
| `@opencode/Job` | get/start/cancel; running/completed/error/cancelled | `native-service-clock.ts`: exact Job identity/metadata, process-local lifetime, current Location leases and cancellation. Qualify any use as an acceleration separately from durable schedule authority. |
| `@opencode/example/LocationServiceMap` and Effect RcMap | contextEffect/contextEffectOption, rcMap state tag/map | Same clock: scoped leases, current loaded entry/placement checks. Required cross-Location family coverage stays blocking when an entry or contract is unavailable. |
| `@opencode/Bus` | listen → unsubscribe Effect; publish(definition,data,{location}) | `native-service-clock.ts`, `native-recurrence-events.ts`: acquire/release listener lifetime, event as wake hint, post-commit invalidation. |
| `@opencode/Global`, `@opencode/server/ServerInfo` | state/config roots; urls() → string array | `native-managed-owner.ts`: bounded ownership reads, exact executable/database/process namespace, ambiguous identity refusal. `native-schedule-installation.ts` acquires the own-process registration during arming: ≤256 state entries, ≤64 service records of ≤32 KiB, ≤16 advertised URLs, exact public discovery with a four-second deadline. Its guard rechecks native graph values, own PID/incarnation and immutable artifact bytes within the current scoped RPC. Discovery transport uses the public service facade. |

## Schedule integration qualification

Before consuming private `@opencode/Schedule`, qualify each actual method in its
current RPC graph: create/list({sessionID})/get/pause/resume/remove/enabled. Core
create takes tagged `when` and `action:{type:"prompt",prompt}`; HTTP create takes
the public `when` input and `prompt`. Core list/get/pause/remove require explicit
flag/session/mapping checks at the caller. Bound adoption to the exact carrier.

Semantic qualification covers deterministic `msg_<scheduleID>_<run>` and metadata
propagation, native missed-slot/phase rules, durable turn ordering, local cached
language/title/compaction, and continuation concurrent with schedule recovery.
Keep a pending passage uncertain while its terminal correlation or family
coverage is incomplete. Tests of method presence and typechecks accompany these
native checks; qualification results belong in the delivery evidence.

### Durable calendar owner

`native-schedule-owner.ts` composes `NativeScheduleCalendarOwner` with the current
invocation's `native-schedule-calendar-service.ts` facade and
`nativeScheduleOwnerBindings`. The parent supplies authenticated human controls,
ready schedule activation, immutable installation artifacts and the configured
profile/YAML source. Each control holds `NativeMissionDocumentStore.withExclusion`
across native I/O and uses its borrowed store for short individual CASes. The
borrowed view and private facade expire with their exclusion and RPC Scope;
`LocationLifecycle.isClosed()` also fences each operation.

Creation persists the exact slot intent, reverse ownership index and attempted
barrier before its native effects. Adoption lists at most 16 rows for that carrier
and requires one exact candidate; duplicate candidates are paused. The auxiliary
is positively active before principals can arm. Pause retains native identities;
temporal replacement retires exact old mappings before completing new coverage.
A current auxiliary mapping is published immediately after its adoption, before
principal effects. Complete synchronization preserves that mapping's exact
high-water and pending/preparing references; newly added slots start at zero and
retired IDs stay fenced.
A paused temporal edit creates/adopts and pauses its replacement rows, completes
its synchronization, and retains those identities for explicit Resume.

`readNativeScheduleAuxiliaryWakeBinding` performs read-only current-intent
preflight inside a fresh receiving RPC: verified reverse ownership, current
auxiliary descriptor, one exact native candidate and native run acknowledgement.
The parent also verifies the exact durable user message. When an auxiliary create
ACK was lost, the context-side claim helper may use its optional trusted
`readAuxiliaryIntent` resolver to obtain that preflight binding from the read-only
own-process RPC. Claim admission rereads the same complete document and current
intent under exclusion. Ordinary principal guards remain applied. Only the exact
current auxiliary can cross desired-state, synchronization and blocked/deletion
barriers for technical reconciliation.

In the claimed wake RPC, `owner.adoptAuxiliary(wake)` records the existing
auxiliary descriptor and mapping without creation, principal effects or business
reservation. The parent then consumes its technical wake and closes its claim
under document exclusion **before** calling `owner.reconcile`. Read-only preflight
acquires no document exclusion and mutates no saved state; private services stay
inside each receiving RPC Scope.

### Production technical runtime

`registerNativeMissionScheduleRuntime(ctx, artifacts?, invocation?)` in
`native-mission-schedule-runtime.ts` contributes the local provider, broad exact
technical ownership hooks, the wake/status and maintenance RPCs, native terminal
hints and the scheduled business bridge.
It returns `NativeDocumentBusiness`; the bridge registration is shared once with
the persistent plugin's routing. `native-mission-schedule-owner.ts` supplies the
shared scoped owner/native/store factory for controls and autonomous receivers.

`native-mission-schedule-wake-prepare.ts` persists the exact principal
`wakePreparing` in the native prompt hook, under document exclusion and before
returning to Session prompt admission. Prompt entry supplies the pre-inbox proof;
Pause, temporal edits, wrong/currently unadopted mappings and unresolved control
barriers refuse that admission. An exact preparation survives a pre-inbox crash
and fences structural editing without consuming high-water or launch count.
`native-mission-schedule-wake-context.ts` reads bounded durable user messages in
the hook's Database/Location graph and retains recovery preparation for delivered
originals. It sends read-only native HTTP
preflight before claiming. `ready` includes complete fan-in coverage; a signed
eight-second receipt freezes its cutoff. One outer deadline covers status and
wake. An already dispatched exact identity or an unconsumed uncertain claim stays
status-only. Native compaction hints are classified by exact public context IDs.

Each wake/status receiver has its own `nativeInvocation` and full HTTP graph.
It verifies saved registration/own process/incarnation, physical placement,
current ownership, native schedule ACK and the exact durable original user. A
missing auxiliary mapping is adopted from its qualified existing row. Auxiliary
CAS and claim closure precede owner reconciliation and pending-business
observation; another owner reconciliation applies quota/end cleanup immediately
after that observation, including when the last pending settles. Principal
reservation closes its technical claim with its durable high-water while business
remains pending. Fresh auxiliary turns recover only original next principal wake
identities, respecting every prior dispatch hold.

Title/compaction remain local through paused, retiring and attempted ownership;
owned corrupt sessions and reserved unknown technical IDs fail closed. Every owned
provider HTTP request is refused. Public terminal-event subscription learns only
pure installation/carrier data from live ownership hooks (128 records maximum).
One bounded hint per Mission, after the native inactive-transition debounce,
contacts the fixed `codenomad.missions.schedule-maintenance/reconcile` method.
The fresh receiver rechecks exact current/retiring ownership and positive native
active/claim/inbox/child quiescence before owner reconciliation. Setup event/KV
failures preserve ordinary Missions; unavailable setup KV delegates the exact
learned hint's lookup to the receiver. Scope disposal stops the subscription.
Missed hints retain cleanup for explicit Check. Native auxiliary wakes provide
restart reconciliation of saved work; installed native event/facade qualification
accompanies shipment.

Each new descriptor carries `anchorAt`. The facade supplies an Effect Clock only
to native `Schedule.create`; wall-clock milliseconds/nanoseconds use that logical
anchor, while monotonic time and sleep delegate to the real Clock. Native
`Info.time.created`, `nextDueAt` and absolute ends provide the readback. First Play
anchors relative timings and the common end. An unchanged `in` keeps its original
duration and absolute `oneShotAt` through bounds-only edits. An unchanged Every
bounds edit reads native phase before retirement, chooses its next strictly future
slot, and derives the replacement anchor as that slot minus the interval. A timing
change may anchor Every at the validated edit. Native recorded due times remain
authoritative for future slots and late-wake eligibility.

`nativeScheduleOwnerControlReceipt` reads the exact retained human operation,
including Check aliases, across automatic reconciliation. Receipts retain the
latest 16 completed controls. The internal `resumePending(locked, document)` port
qualifies the exact already-admitted pending passage and its fresh guard before
Resume, including its last-budget continuation. Original passage identities and
admitted counts remain intact. Unknown admission retains the pending barrier.

Terminal cleanup keeps the auxiliary and mapping proofs while pending business,
technical claims or incomplete fan-in remain. Session removal requires positive
claim/inbox/child quiescence. A self-active auxiliary retains its native wake and
reverse index; the parent schedules a fresh invocation after idle or an explicit
Check to finish that same cleanup intent.

## Event source readers

`native-mission-condition-reader.ts`, `native-scheduled-passage-sources.ts` and
`missions/mission-local-sources.ts` read one explicit condition in the service
namespace. First Play prepares a fresh baseline under document exclusion; Resume
retains it. Editing adds baselines only for new source keys. Retained keys win
over newly observed proofs during configuration, preserving remove/re-add cursors.
The pending stores the complete bounded checkpoint. Successful archive consumes
that checkpoint, while failures preserve the prior one and retain the admission
barrier. A conversation condition also contributes its frozen prefix to launch input.

Schedule success uses durable `successfulCount` and `lastSuccessfulPassageID`,
independent of the 30 retained results. Every unseen success needs its retained
receipt, exact completed journal and correlated whole-family terminal proof.
Exceeding that receipt window blocks. One-time completion uses the exact original
admission, completed journal and the same family proof. A positively active family
waits with its prior checkpoint; unavailable original/terminal correlation blocks
explicitly as unknown coverage. Journal-only sources derive placement from their
coordinator's journal identity and exact native session, validate the configured
authorized root and pin that placement across checks. Dependency chains are
point-read with a 64-object ceiling and reject cycles, deletion and unknown edges.

Conversation reads use a latest stable baseline page of at most 32 messages,
then the shared bounded stable-prefix reader. Exact native message digests and
placement remain pinned. Technical wakes/restart notices contribute no event;
technical carriers and the schedule's own coordinator families are excluded.
The bounded, cycle-checked parent walk pins each ancestor's placement and metadata
before awaiting its native read, then rechecks that same projection at publication;
carrier recognition uses `codenomad.schedule-carrier` and the reserved ID prefix.
Streaming, compaction, changed/deleted anchors and input capacity preserve unknown
coverage. A full prefix containing only technical records requires a decision.
`native-source-observation.ts` borrows only an explicitly selected authorized
source Location for family requests, retaining its graph through the receiving RPC.

Local Git reads use a full local branch, physical worktree/common-directory identity,
commit OIDs and ancestry. Asynchronous child commands have a shared ten-second deadline and
1 MiB output ceiling, with lazy fetch, optional locks and prompts disabled. Files
use explicit relative paths, absence or SHA-256 bytes, at most 128 paths,
1 MiB/file and 16 MiB/check. Parent links, devices, directories, root escapes,
unreadable files and changed reads fail closed. Promise-based filesystem calls run
off the service event loop. One ten-second deadline covers initial reads and final
revalidation; cancellation or expiry promptly rejects the caller, including while
metadata, open, read or close is pending. Late kernel completions are observed and
acquired handles close in `finally`; a blocked kernel operation releases its handle
when it returns. Git cancellation kills its child. Byte and physical-placement
rereads run under document exclusion after the target read and immediately before
publication. A failed revalidation invalidates the proof. External filesystem
writers can race the final reread and SQLite commit.

`native-source-fence.ts` pins bounded exact document/journal/message/family SQL
projections before observation, then checks them synchronously at target CAS.
Family proofs include the existence and full native bytes of each correlation
input and latest terminal, with exact assignment IDs for managed actor roots.
The document adapter supplies its current transaction Context to those reads;
the guard borrows that transaction's SQL service. Local publication preparation
awaits the byte/branch/placement reread outside SQL; its synchronous guard checks
the proof's lifetime, cancellation, deadline and completed revalidation state.
The source guard expires with its RPC.

Qualification: `node --import tsx scripts/test-mission-event-readers-native.mjs
<absolute-isolated-cli> <fresh-approved-reader-scratch>` exercises all five actual
readers, private SQL/CAS, service restart without a CodeNomad backend, frozen
consumption, remove/re-add and a changed-file reservation race. Its explicit test
controls seed/archive passage journals; product wake and actor-settlement journeys
remain covered by the separate scheduled-product qualification.

## Experimental document authors

`native-experimental-settings.ts` shares the depth/schedules JSONC reader and
editor. Preserve explicit false/zero and local companions; materialize inherited
true schedules when writing a depth, and preserve depth from the target's own
lower-priority block only when creating an experimental block for schedules.
An existing block keeps its depth key or native default unchanged. Copy only
those two known keys.
`PluginControls` owns connection/Location/deletion fences, byte expectations and
the physical file lock. Duplicate keys, invalid parents and simultaneous JSON/
JSONC in one layer refuse settings edits.

Native regression: `node --import tsx
scripts/test-mission-experimental-settings-native.mjs <absolute-isolated-cli>`.
It exercises real discovery/whole-block precedence/watcher acknowledgement and
both edit orders, using private roots and a provider request counter.

The product preparation endpoint is
`/api/workspaces/:id/missions/:missionID/schedule-settings`: GET reads its document;
POST accepts only `requestID` and `expectedDocumentRevision`. It holds the owned
worktree admission, refreshes authority before every typed `documentActivation`
phase and composes the two-file executor with native document CAS. Readiness keeps
the Mission paused. Immediate objects refuse this path. A failed intent with no
attempted write can be replaced only by a new explicit request at the fresh
document revision; an attempted effect retains its original request fence.

## Integration conventions

`scheduleControl` accepts fixed human actions with an exact signed action/revision/
payload tuple. Creation records its immutable request/digest; `scheduleRead` can
select a retained original request receipt. Run now stores `manualExpectedRevision`
with its pending and archive, and a changed revision cannot reuse that request.
The response combines calendar and actor receipts. Document deletion remains
pending through compaction; the tombstone exposes a bounded `deletionReceipt`
containing only ID, original request/revision and the cleanup option.

The scheduled HTTP route retains its physical deletion permit after dispatch until
a positive exact complete receipt. Holds are fence-scoped, bounded to 128 Missions
and persist until that receipt. GET/reconnect stay read-only. An explicit Check of a positively
recorded partial request runs under the original permit, then rereads that original
receipt. A replaced connection can settle a positive receipt only after the same
workspace, project, profile and physical placement are re-proven.

The authenticated parent completes this preparation before the calendar owner's
Play/Resume and composes scheduled controls, immutable carrier mappings, the
auxiliary barrier and transactional business admission/settlement. Product
registration composes the owner with the ordinary-entry guards. Native regression
of the product preparation route:
`scripts/test-mission-schedule-activation-native.mjs`.

### Scheduled passage invocation

`native-scheduled-passage-runtime.ts` acquires the document store, native service,
whole-family observation and calendar coverage inside each receiving invocation.
The business port first reads public ancestry, then reacquires for each `execute`
and `prepare`. Hold document exclusion before MissionControl's writer; SQL CAS
guards check only synchronous invocation/incarnation/exclusion identity. Native
effect-entry authority reads the exact unified document outside SQL publication.

Before creating a technical claim, require the read-only runtime `preflight`:
exact native message and run acknowledgement first, then full principal coverage
at the frozen cutoff for a running principal without pending work. It preserves
an unfinished window's cutoff and publishes no document state. Positive contiguous
auxiliary/overlap/paused wake proof stays on the non-reserving path. Exact prepared
wakes participate only when covered by their contiguous native messages. The
transport owns prior-claim admission and the short-lived process-local receipt;
pass its validated cutoff unchanged to `wake`, under the shared request deadline.

Fan-in keeps its cutoff and overlap suppression in the document. Every principal
needs an exact mapping, enabled flag, contiguous messages and a native firing
barrier qualified for admission or suppressed observation below; coverage is
bounded to 256 occurrences and rechecks the complete group. Source
conditions require a qualified reader; watched inputs retain complete frozen
prefixes and native anchor digests. Original admission increments the global count
only after exact native ACK/message/inbox proof. Recorded admission stays
observe-only through pruning, with whole-family H11 checks before settlement.
The original's `pending.admissionAttempted` barrier is published under document
CAS immediately before the first native admission call; a missing field reads
false. A saved attempt with absent/pruned original proof keeps the same pending
unknown. Positive exact message/inbox evidence reconstructs its admission count.
A root created before the attempt barrier can still receive its first original
input after positive absence. A lost attempt-write acknowledgement preserves
uncertainty, and the bit stays monotone for the pending's complete lifetime.
Paused manual dispatch requires the exact manual pending's `manualAllowed` bit;
the authenticated reservation sets it and a subsequent Pause/Stop clears it.
Run now reservation also stores optional `manualExpectedRevision` in its CAS and
retains it in the passage receipt. It is counter-validated, exclusive to manual
origins and immutable throughout that pending identity. Pending/archive replay
requires the original request ID and exact saved revision; a missing saved
revision preserves unknown identity. The 30-result retention bound applies to
these receipts.

### Scheduled actor lifecycle

`native-mission-schedule-actors.ts` acquires its lifecycle port inside the current
RPC scope. `owner.prepareControl` publishes the exact guarded request before
execution-side mutations; `prepareInterruption` restricts this stage to Pause/Stop/Delete.
The authenticated proof's 30-second freshness window guards admission through
that CAS. `admitControl` validates the committed request/action/revision/payload
receipt, then its execution retains Location, physical-root and ownership checks
under the RPC's shared 95-second deadline. The passage's MissionControl attempts interruption
from that exact current intent, then calendar reconciliation proceeds independently.
Start/Resume require completed calendar controls. MissionControl supplies its
existing request/operation, frozen targets and receipts under document exclusion
followed by the project writer. Actor callbacks
point-read that document and passage journal without reacquiring document exclusion.
They preserve the human calendar request ID and frozen root profiles/metadata.
The interruption barrier accepts the exact current explicit pending operation;
completed receipts remain eligible while the desired state and latest intent agree.
The captured explicit control identity is rechecked before effects alongside
the desired-state and pending-passage guards.

The public Session facade owns root reads, interrupts and lifecycle synthetic
admission. Family listing, activity, inbox cancellation and environment use an
authenticated own-process client discovered from the saved absolute registration,
with invocation/incarnation, placement and operation fences. Secrets stay in that
invocation's memory. `missions/native-actor-lifecycle.ts` shares the bounded
deepest-first interruption, post-root checks, Stop drain and Pause parking with
the desktop backend. Resume uses its deterministic lifecycle message identity and
actual queued acknowledgement; the original passage input and launch count stay
unchanged. Partial family observations remain explicit in the existing receipt.
Each Session call combines its caller's cancellation signal with the scoped
lifecycle signal. The shared 50-second family walk and 10-second post-root recheck
cancel and join a blocked descendant's Effect/finalizers within their own budgets;
the root attempt continues under the lifecycle budget and its receipt uses the
admitted execution guard.
Dedicated `controlPassage` calls hold the same exclusion and supply the current
invocation's actor lifecycle transport. They select the isolated journal's Mission
identity and forward only the explicit request ID, action and journal revision.
The runtime entry's document identity and execution callbacks stay at that boundary.
Journal control retries recover the
original journal revision and exact receipts through MissionControl. Observation
authority permits control publication after the desired Pause/Stop is durable;
initial dispatch and business effects retain their separate admission predicates.

Suppressed fan-in observation accepts positively paused principals as a frozen
future-firing barrier. Their exact mappings, native flag, acknowledged contiguous
messages, preparing references and stable whole-group reread remain required.
Admission windows retain their active/future-or-done barrier. Terminal deletion
consumes positively acknowledged current preparations and closes the corresponding
technical claim before native removal; missing or changing proof retains the intent.

An armless first Play publishes its desired state and original reservation together.
Public control completion follows that original's persisted admission or proved
not-started archive. Origin/request identity distinguishes first admission from an
actor Resume, including equal timestamps. The bounded control history pins this
first receipt while the original remains unconfirmed.

`native-scheduled-passage-capability.ts` qualifies each new native mutation after
lazy effect construction and pinned-root reads. Calendar-backed policies require the exact current
provider/model contribution, immutable artifact bytes, the ready auxiliary's
adopted mapping and active native row, its technical carrier identity, and a
positive native schedule flag. The synchronous initial/business fence rechecks
the fresh document's installation and artifact bytes. Observation authority uses
the original passage identity and whole-family terminal proof, allowing controls
and settlement while technical provider artifacts are unavailable. Human Check
keeps an unadmitted original pending when mutation qualification fails.

A pure immediate policy uses its frozen `requiresMissionCalendar` result and an
armless owner: empty current/owned/retired calendar slots and auxiliary readiness
false. Its Session/Database/Location, profile, root, original admission and H11
fences remain active; technical provider artifacts and Schedule services belong
to calendar-backed policies. An unplayed scheduled object can keep its identity
and explicit profiles when configured immediate, then first Play atomically
records the armless owner and reserves origin `immediate`. The existing runtime
`reconcile` admits that exact original pending once, under the one-launch limit.

The immediate configuration path performs only its guarded document CAS and
physical-placement capture. `acquireNativeMissionServiceRegistration` supplies the
own-process RPC registration proof independently of technical artifacts; calendar
arming composes that proof with exact provider/runtime byte validation. The business
bridge derives the calendar requirement from the pending's frozen launch policy
and includes it in the captured source identity. Pure immediate selection and ENV
use their native session/profile guards even when the technical provider file is
unavailable.
