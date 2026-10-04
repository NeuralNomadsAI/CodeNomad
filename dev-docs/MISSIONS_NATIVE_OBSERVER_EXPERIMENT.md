# Attach-only native Mission observer — lane 3

2026-10-03. Research prototype only; no production activation or architecture verdict.

**PASS against an authenticated private OpenCode 2.0.22 process:** attach contracts
to existing roots, retain task context through unchanged depth-three native
delegation, observe simultaneous siblings/another root, accept coordinator-written
business evidence, and reconstruct the same graph and journal after disposal and
an actual Location reload. No root dispatch or native executor wrapper exists.

Final artifacts: `C:/Users/Admin/AppData/Local/Temp/opencode/missions-observer-2J4Gw5/`.
33 provider requests, 11 native sessions, 380 captured events; 11 confirmed checks
and two explicitly limited/unknown projections in `results.json`. Private PID 9276
served version 2.0.22; its exact owned ChildProcess was stopped (`cleanup.json`).

## Runnable surface

From `D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003`:

```powershell
node scripts/native-subsession-spike/observer/run.mjs
```

Owned files:

- `packages/server/src/missions/native-subsession-experiment/observer.ts`: business
  contract, ancestry, observation and explicit report policy.
- `scripts/native-subsession-spike/observer/plugin.ts`: native context/event hooks,
  one new business report tool, read-only native HTTP adapter, private fixture RPC.
- `scripts/native-subsession-spike/observer/run.mjs`: deterministic provider and
  real private runtime assertions; not a replacement subagent controller.

The caller-facing **Interface** is:

```ts
const observer = createNativeMissionObserver(storage, nativeReads, projectID, directory)
await observer.intent(coordinatorID, missionID, objective, tasks)
await observer.attach(coordinatorID, missionID, taskKey, existingRootID, expectedRevision)
const tree = await observer.watch(authoritativelyReadNativeFamilyIDs)
await observer.report(coordinatorID, {
  missionID, taskKey, rootID, sourceID, revision: expectedRevision,
  evidenceToolID, summary, reportID,
})
```

`context()` enriches an outgoing native context using real ancestry; `observe()`
accepts structured native progress facts. `snapshot()` uses the existing Mission
reducer. These do not admit prompts. Native model calls use ordinary `subagent`
and `observer_report`; the latter is a business tool, not a launch wrapper.

## Invariants, ordering and errors

1. Intent and attach require an existing owned local root, exact project and
   physical Location. All business writes belong to the one coordinator.
2. Attach never creates, prompts, switches or moves an actor. It binds one task
   per root; another overlapping root contract is `UNKNOWN`, not a guessed task.
   Reassignment to a different root fails. No automatic detach/rebinding exists.
3. Descendants inherit the one root/task contract through `session.get().parentID`.
   Foreign Location/project, cycles, excessive depth or changed source contract
   fail closed. This prototype is explicitly local-only: public 2.0.22 session
   Location declarations expose only `directory`, not a remote workspace identity.
4. Native child work is not automatically an individual Mission task. Only the
   coordinator's explicit, task-matched report may complete the attached task.
   An unassigned tree remains visible; no observer operation deletes it.
5. Source scope is a stored token of task key/title/brief/role/dependencies plus
   immutable root/coordinator/project/Location checks. Target revision is the
   current journal event revision, checked again after asynchronous preparation.
   Other-task reports can advance that revision without invalidating unchanged
   source context. An explicit source dependency edit invalidates the contract.
6. Report evidence must be a real terminal persisted parent assistant Tool part,
   with its stable `id`, native child `state.metadata.sessionID`, assistant message
   ID and matching `child.parentID`. Native child success and a bounded idle
   family observation are also required. No prompt/title/result regex binds work.
7. A completed background *launch* can have metadata `status=running`; this is
   neither child terminal success nor task completion. A native synthetic
   notification, provider consumption and a business report are separate facts.
8. A coordinator acting as its own task root cannot confirm that root's terminal
   execution from its still-running tool turn. The active-family check refuses it.
   Task A intentionally stays unreported; its dependent task stays blocked.
9. Missing/changed correlation or activity is `UNKNOWN`; wrong writer, task,
   source, revision or attachment is `DENY`. These affect business admission only.
   A changed observer contract must not veto ordinary native execution.

The module reuses `MissionJournal`, its reducer/storage generation, `stableToken`,
`validateMissionReportArtifact` and `readNativeMissionFamily`. No existing source
was changed. The experimental journal adapter uses existing `task.dispatching`
actor bookkeeping to record attachment. Its `observer_*` admission field is a
local bookkeeping identity, **not** a native inbox ID/ACK or dispatch operation;
that vocabulary mismatch must be resolved before product integration.

## Timing, native facts and persistence

Both `ctx.session.context()` and the real authenticated raw message-list endpoint
failed to expose foreground parent Tool parts while the parent assistant turn was
still in flight. Therefore ancestry can supply inherited root/task context before
per-invocation evidence is readable. It does not guess which concurrent sibling
call created the child. Missing correlation is a separate `pending` projection.

The supported `session.tool.progress` event supplies native parent/session,
assistant message, stable Tool ID and child metadata. The observer verifies the
native child's parent before storing that fact in private project-scoped plugin
storage. Read-only `execute.before/after` hooks capture native input/result IDs
without editing tools. Observer errors in the inspection hook do not block the
native executor.

In the final run, progress facts arrived before first child contexts, and first
contexts at depths 1/2/3 had real `a_child`/`a_grand`/`a_great` IDs. That ordering
is **observed, not an awaited pre-child guarantee**. Parent/task inheritance itself
does not depend on the event subscription. Terminal persisted Tool parts supersede
live facts and are required for completion evidence.

After all work settled, the fixture disposed its context hook/event subscriber,
created a new observer/journal over actual native plugin storage, and compared
the complete bounded native graph. It then called actual `location.reload`.
Plugin generation advanced 1 → 2; the same task actors, contracts, reports and
graph were reconstructed. Before reload, reads used the real authenticated raw
HTTP adapter; after reload, the same settled graph used in-process native context
reads. No saved transcripts or mocked signatures supplied the reconstruction.
No daemon restart/crash durability is claimed here; that belongs to lane 4.

## Exact evidence matrix

| Check | Result / final evidence |
| --- | --- |
| Unchanged native recursive chain | Root `ses_effe43212ffer7SIEeyOTSS2ht` → `ses_effe42f4cffeTxxelmtJsbwIRD` → `ses_effe42dcbffe0qUF44JOD6ob61` → `ses_effe42c94ffeOR8e76HdlEljWx`; native depth 3 |
| First-request inherited scope | `firstRequestContexts` has task A at depths 1/2/3 and task B at depth 1; no invocation ID pre-registration |
| Simultaneous native work | Two actual tool calls under root A, plus another existing root B's detached child; held provider requests prove overlap |
| Result consumption | Request 9 consumes `DEEP_LEAF_EVIDENCE`; root A consumes both child/sibling results; root B request 8 consumes native `BACKGROUND_EVIDENCE` notification |
| Background launch vs completion | Launch Tool `b_child` is completed while its child is active and task B has no report |
| Existing-child continuation | Native `a_continue` returns the original child; root A still has only its two original children |
| Foreign-parent continuation | Native `foreign_continue` errors; target child receives zero extra provider requests |
| Built-in General negative control | General advertises no subagent after removing broad global subagent allow; custom all-mode agent still recurses |
| Contract overlap/writer | Existing root A cannot accept another task; non-coordinator root B cannot attach another root |
| Report guards | Actual native `observer_report` Tool calls reject `wrong_task_report`, `wrong_revision_report`, `wrong_source_report` |
| Explicit business completion | `good_report_b` completes task B, actor remains original root B, with persisted child/Tool evidence; zero discarded events |
| Business consumption | Coordinator request 27 receives the actual accepted report Tool result containing `report_b` and `Explicit background evidence` |
| Self-root terminal guard | `self_root_report` errors; task A has no report; dependent remains blocked |
| Unassigned child | Its observed status is `unassigned`; no task report is inferred from native success |
| Persisted rebuild/reload | `afterRebuild` equals prior graph; generation 2 reload reconstructs identical Mission maps and graph from private native storage |
| Source changed | An explicit compatible `mission.revised` dependency edit invalidates source context; graph rows remain visible `UNKNOWN` |
| Native autonomy after unknown | Explicit `changed_source_continue` succeeds using the original child; no new child or task report is forged |

`results.json` contains code SHA256s, all transcripts, catalog inputs/options,
snapshots, exact native IDs and OpenAPI. `requests.json` and `events.json` retain
raw provider bodies/native events; `serve.log`, `private.db`, `sentinel.json` and
`cleanup.json` retain process/storage ownership and cleanup evidence. Catalog
schema/options match before and after reload; a source check prohibits native
`editor.update/remove` and direct captured tool execution. Executor identity is
not inferred from function-reference equality through client/plugin adapters.

## Isolation and retained failures

Only the assigned absolute CLI was launched, as private `serve 127.0.0.1 --port 0`.
Private HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG/config/DB/Git configuration and,
in final runs, TEMP/TMP were set before owned imports. Inherited OpenCode,
CodeNomad, XDG, WSL and credential-like environment keys were stripped. Project
config discovery, model fetch and updates were disabled. Only a loopback
deterministic provider with synthetic secrets was used. Dependencies stayed
read-only; bundles/caches/artifacts stayed outside the frozen source tree.

Each run has a 240-second budget, 200-provider-request ceiling, native 12-step
agent ceiling, depth-three setting, bounded reads and exact private-child cleanup.
No installation, shared service API, global kill, desktop restart, cache clear,
session move, staging, commit, Mission orchestration tool or real Mission data.

All 11 private CLI launch directories remain intact:

- `missions-observer-K49694`, `-xFtyuM`, `-z9aDAu`: no-provider bring-up failures
  (RPC JSON output normalization and reducer event-revision ordering).
- `-ENLmq8`: actual default-depth-one rejection; ancestry context timing observed.
- `-eriFB9`: depth-three, result consumption and continuation succeeded; broad
  global allow invalidated the intended General negative control.
- `-2dFMZQ`: event arrival order selected the sibling rather than the deep branch.
- `-h0vKNg`: supported raw native read confirmed missing in-flight foreground part.
- `-8wuII5`: native report succeeded, but a transcript-order assertion was wrong.
- `-k8nySu`: raw activity response needed its declared `{data: ...}` envelope;
  the overly optimistic self-root admission is preserved only in this private run.
- `-6jHndU`: complete PASS (30 requests, 349 events).
- `-2J4Gw5`: final PASS additionally proves native execution survives UNKNOWN
  observer contracts (33 requests, 380 events).

There was also an initial pre-launch Windows file-URL loader error. Initial
bring-up exceeded the original correction ceiling; subsequent supported attempts
were explicitly authorized by the user's evidence-only continuation steering.
No failure is concealed or converted into a platform-impossibility claim.

One initial scoped typecheck found the public Location/title declaration mismatch;
the corrected scoped check passed. No full server/browser/desktop build was run.
The frozen rollback was independently read-only verified: all 2,225 manifest
files match, digest `0b22cdd75f4f94658620472367cd0cfb9955eaa469b6f0d816b66506f91f1dfa`,
index SHA256 `21a5beee4071a842ef888dfbbfecfcc95cc42b69b378dff0268031ffbac222db`,
saved staged tree `0dd4b21892c6614c755c14b1fc8f0c30e776eeb9`. No `git write-tree`
was used against the frozen checkout.

## Seam comparison and remaining gates

**Depth / Leverage:** the caller owns bookkeeping, not native recursive execution.
**Locality:** root contract/source/report policy is confined to one small module;
native transport and instrumentation stay in its adapter. **Seam:** attaching and
observing an existing native tree, not replacing the native subagent executor.
**Dependency strategy:** native in-process reads/storage plus an authenticated
external native HTTP reader were actually exercised; only the provider is simulated.

Compared with lane 1, one attached task per existing root is narrower authority
than a root-wide list from which descendants choose reports. Neither proves
pre-child per-invocation authorization. Compared with a wrapper, this observer
cannot guarantee an awaited task-specific binding before native birth; it does
not need to own native launches, continuation, notifications or recursive agents.

No graph UI was added: `watch()` yields the bounded persisted native tree with
optional task scope for a future graph adapter. Unassigned/unknown rows are not
deleted and native hierarchy remains distinct from business dependencies.

Before integration: decide root/task scope and attachment vocabulary, connect
the authorized desktop bridge rather than exposing fixture RPC caller IDs, qualify
remote/environment/worktree/connection mutation fences and writer concurrency,
settle atomic report/outbox behavior and idle-family race handling, and consume
lane 4 crash/control findings. Report notification is deliberately still pending
in the existing reducer: coordinator Tool-result consumption is proved, not a
synthetic outbox ACK or automatic notification recovery. Recovery must stay an
explicit observation/reconciliation action, never a launch/prompt replay.

Consulted local AGENTS, `codebase-design`/`opencode` skills, V2 config/agents/plugin/
RPC docs, actual installed 2.0.22 declarations and authenticated served OpenAPI.
The existing 2.0.21 continuity script was read for private-provider protocol only,
not executed or modified. Lane 1's delivered evidence informed the supported
progress-event hook attempt; no other lane's files were changed.
