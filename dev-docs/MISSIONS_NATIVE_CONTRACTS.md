# Missions native contract boundaries

Public plugin/client contracts and private Core services have separate authority
and lifetime. Acquire private services inside the current RPC/Location Effect
graph; `native-invocation.ts` joins child reads and finalizers before releasing
that graph. A local `ctx.rpc` call keeps its originating graph. Every consumed
private shape and result requires a bounded check in the installed bundle.
Missing required coverage keeps the operation blocked with its original identity.

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
| `@opencode/Global`, `@opencode/server/ServerInfo` | state/config roots; urls() → string array | `native-managed-owner.ts`: bounded ownership reads, exact executable/database/process namespace, ambiguous identity refusal. Discovery transport uses the public service facade. |

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

The calendar owner must call this preparation before arming and supply scheduled
creation/controls, immutable carrier mappings, the auxiliary barrier and the
transactional business admission/settlement guard. The technical foundation's
registration stays separate until that owner and the ordinary-entry guards are
installed together. Native regression of the product preparation route:
`scripts/test-mission-schedule-activation-native.mjs`.
