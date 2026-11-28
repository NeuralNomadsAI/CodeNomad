# Missions native contract boundaries

## Invocation graph availability

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

Native test drivers register Effect RPC handlers and yield registered tool
executors inside the receiving invocation. Promise setup adapters retain their
activation context, so tools requiring native services need the receiving Effect
graph. Execution scenarios first assert prepared state and absence of provider
turns, then Play through the authenticated lifecycle route and verify the saved
native admission and exact replay before declaring work. Storage-damage probes
remain isolated from lifecycle admission.

Plugin project Locations pass through `readLocationRef` before document creation;
optional selectors enter durable JSON only when present. The native RPC creation
contract supports an omitted `expectedCoordinatorLocation` by using that normalized
project Location.

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

## Private service inventory

| Context key / state | Consumed contract | Callers and required checks |
| --- | --- | --- |
| `@opencode/Session` | get/create → Session.Info; prompt/synthetic → SessionInbox.Info; environment → exact string map; inbox → array; cancelInbox → void | `native-service-adapter.ts`: method/Effect checks, public result codecs, pinned placement/parent/profiles/metadata, synchronous fence adjacent to dispatch, ≤1024 inbox entries. Environment is process-local and reapplied before admission. |
| Session message readers | messages({sessionID,limit,order,cursor:{id,direction}}) → array; message({sessionID,messageID}) → Info/undefined | Same adapter: ≤32 messages/source, ≤256 KiB native message, 16,384-character launch envelope; point-read anchor and each message, stable complete prefix, source placement/bytes rechecked after I/O. Deleted/moved/changed anchors block. |
| Session active | `active` is an Effect returning a ReadonlySet | `native-passage-observation.ts`: actual Set, ≤4096 sessions. Treat activity as a process-local observation. Require correlated durable terminal evidence and complete family quiescence for restart settlement. Keep an old execution claim uncertain during asynchronous native recovery. |
| `@opencode/Location` | directory/workspaceID/project{id,directory,canonical} | `native-service-adapter.ts`, `native-service-clock.ts`, recurrence readers: structural Location.Info fields, exact native/physical placement and current graph checks after I/O and before effects. |
| `@opencode/storage/Database` | db.$client.unsafe(sql,params).withoutTransform → Effect rows; db.transaction(callback,{behavior:"immediate"}) | `native-mission-document-storage.ts`, `native-passage-observation.ts`: current graph, actual SQL client/transaction, safe row types and synchronous query guard. Preserve the driver's transaction Context when composing effects. Asynchronous-only reads cannot implement the synchronous admission fence. |
| KV/CAS SQL | kv(key,value,time_created,time_updated); plugin namespace is plugin ID encoded as padded UTF-16 hex | `native-mission-document-storage.ts`: exact project key/bytes/revision, immediate transaction, conditional update and readback. |
| Family SQL | session_v2 placement/parent/time_suspended, session_inbox, session_message id/type/seq/content/idle | `native-passage-observation.ts`: family ≤4096, exact message/inbox presence and nonnegative counts. Anchor the original input in durable seq order and require a later terminal idle as the latest projection. Count failures only between that input and terminal, then recheck family, claims and requests. Missing anchor/terminal or any remaining claim keeps uncertainty. |
| Adopted-family sequence | event_sequence(aggregate_id,seq), keyed by native session ID | `native-source-fence.ts` and `native-passage-observation.ts`: bounded baseline rows and safe integer sequences. The aggregate watermark survives retained-message removal; a changed/regressed/missing watermark prevents an unchanged-history conclusion. Qualification uses isolated native input, continuation and retention operations. |
| Durable background delivery | kv keys in `job.background/`; JSON recovery kind and session/parent/child IDs | Same reader: ≤1024 records, IDs/kind only. A completed child with an undelivered native result still blocks its family. Unknown shape, table/column or coverage refuses settlement. |
| `@opencode/Form` | list/get/state/reply Effects; public Form.Info/State result codecs | `native-passage-observation.ts`, `native-human-answer.ts`: ≤1024 requests, exact native IDs, confirmed durable UI-answer mark and invocation lifetime. Sessionless requests conservatively prevent quiescence. |
| `@opencode/Permission`, `@opencode/Shell` | list Effects returning public Request/Info arrays | `native-passage-observation.ts`: ≤1024 each; unknown request ownership or running uncorrelated Shell blocks settlement. |
| `@opencode/Job` | get/start/cancel; running/completed/error/cancelled | `native-service-clock.ts`: exact Job identity/metadata, process-local lifetime, current Location leases and cancellation. Qualify any use as an acceleration separately from durable schedule authority. |
| `@opencode/example/LocationServiceMap` and Effect RcMap | contextEffect/contextEffectOption, rcMap state tag/map | Same clock: scoped leases, current loaded entry/placement checks. Required cross-Location family coverage stays blocking when an entry or contract is unavailable. |
| `@opencode/Bus` | listen → unsubscribe Effect; publish(definition,data,{location}) | `native-service-clock.ts`, `native-recurrence-events.ts`: acquire/release listener lifetime, event as wake hint, post-commit invalidation. |

Assistant content follows the native storage projection: ordinal `session_part`
rows take precedence when present, otherwise the message's inline content applies.
`native-message-data.ts` supplies that SQL projection to tool quiescence, human
answer verification/discovery and source digest fencing. Source proofs reread the
rehydrated bytes inside their existing transaction graph. Storage qualification
checks the consumed part columns before passage admission.

## Event source readers

`native-mission-condition-reader.ts`, `native-scheduled-passage-sources.ts` and
`missions/mission-local-sources.ts` read each explicit event of the launch criteria,
one reader call per event key, in the service namespace; any change is enough. First Play prepares a fresh baseline under document exclusion; Resume
retains it. Editing adds baselines only for new source keys. Retained keys win
over newly observed proofs during configuration, preserving remove/re-add cursors.
The pending stores the complete bounded checkpoint. Successful archive consumes
that checkpoint, while failures preserve the prior one and retain the admission
barrier. A conversation event also contributes its frozen prefix to launch input.

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

GitHub reads share the included `gh api` transport: fixed `github.com`, credential-free
checkpoint data, 4 MiB child-output bound, cancellation and hidden console windows.
`mission-github-source.ts` narrows each collection to four 50-item pages and one ten-second
budget. It validates repository URLs, descending timestamps, unique IDs, account binding
and exact source keys. Dependabot continuation accepts only a bounded opaque `after`
token; the next request reconstructs the fixed endpoint and filters. Notifications are
read with `all=true`; their read status is preserved. First Play freezes a server-date
baseline with timestamp-tie IDs. Historical events stay frozen across later collection
changes; revalidation reads account identity under the same deadline. Frozen input
validates the selected repository and optional author before serializing event summaries
within the existing launch envelope.

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
