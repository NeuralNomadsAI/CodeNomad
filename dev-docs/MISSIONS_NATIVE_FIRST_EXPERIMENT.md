# Native-first Mission experiment — lane 1

2026-10-03. Research only; no production activation or verdict on the other lanes.

**Final run PASS on the actual private OpenCode 2.0.22 process:** ordinary,
unmodified `subagent` performs real depth-three recursion, concurrent branches,
same-child continuation and parent result/error delivery. Explicit descendant
reports update the existing Mission journal/reducer and are consumed by the root
provider. The caller does not register subagent invocation IDs or use a wrapper.

## Runnable command and files

Run with the experiment worktree as the working directory:

```powershell
node scripts/native-subsession-spike/native-first/run.mjs
```

- `scripts/native-subsession-spike/native-first/mission.ts`: three-entrypoint module.
- `scripts/native-subsession-spike/native-first/index.ts`: native plugin adapter;
  context enrichment, event facts, two business tools and fixture-only inspection.
- `scripts/native-subsession-spike/native-first/run.mjs`: executable native fixture.

No other source files or old fixtures were edited. Dependencies are read-only
through the pre-existing junction. No installs, upgrades, shared optimizer,
desktop restart, shared-service discovery, root-actor dispatch, commits or staging.

## Small caller interface

```ts
start(ctx, rootSessionID, { objective, tasks: ["deep"] })
record(ctx, nativeSessionID) // inherited root contract + authoritative parent chain
report(ctx, nativeToolContext, { taskKey: "deep", outcome: "completed", summary })
```

The native plugin supplies `ctx`; the model supplies business evidence. Typical
model-facing use is deliberately ordinary:

```text
first_start({ objective: "Investigate", tasks: ["deep"] })
subagent({ agent: "recursive_all", description: "Investigate", prompt: "Investigate and report deep" })
// Inside the child or a recursive descendant:
first_report({ taskKey: "deep", outcome: "completed", summary: "Evidence collected" })
```

`subagent` retains its original executor, schema and permission options. The
plugin never calls `editor.update`, `editor.remove`, assigns a native executor,
or invokes a captured executor directly. A source guard checks this and hashes
the plugin; actual provider tool schemas are saved in `requests.json`.
Function-reference comparisons through plugin/client tool adapters were not a
valid identity test and are explicitly marked unknown in the artifact.

### Interface invariants and errors

- Start requires an owned root in this exact Location/project, unique bounded
  task keys and one root contract. Duplicate start fails rather than overwriting.
- Descendants inherit the root contract by actual `session.get().parentID`, with
  cycle/foreign-Location/depth checks. No title, description, prompt or result
  parsing binds a contract. Prompt markers route only the deterministic provider.
- Contract scope is **root-wide**, not a pre-bound single task per invocation.
  A descendant explicitly selects one authorized task in its report. This is a
  deliberate research ceiling, not per-task authorization for hostile siblings.
- Record reads bounded storage facts populated by native tool-progress events;
  continuation retains all observed native call IDs for that same child.
- Report refuses missing contract, unauthorized task, missing native call or
  admission correlation, another existing task actor, invalid outcome/summary,
  and coordinator completion. This experiment reports descendant tasks only.
- Native permission/depth errors remain native errors; no new child is created
  to work around a deny. Native session success/idle is never task completion.
- Maximum native depth is configured to three; ancestry checks allow at most
  eight reads and call correlation pages are capped at 100 entries.

### Implementation hidden behind the seam

The module accepts the native plugin context instead of constructing a runtime.
It reuses immutable product `MissionJournal`, `validateMissionReportArtifact`,
`stableToken`, `reportAdmissionID` and `reportNotificationID` helpers. Storage is
the private plugin namespace; no old Mission namespace is read or migrated.

The native event subscriber stores **facts**, not work: child/parent/call IDs,
native admission IDs and event IDs. It does not start, queue, retry or schedule
execution. Root-contract lookup does not depend on the event subscriber. Report
call correlation does. The journal's existing `task.dispatching` vocabulary
records an already observed native admission immediately before explicit report;
it is not a second dispatch operation. No forced root actor API is involved.

Reporting writes `task.reported`, admits one stable-ID native synthetic root
message, then writes the existing compatible `report.notified` receipt. Admission
and provider consumption are separate. The fixture proves consumption from the
actual HTTP body subsequently received by the provider, not from receipt/ACK.
Storage plus synthetic admission is not atomic; no crash/outbox guarantee claimed.

**Depth / Leverage:** caller learns three business operations while native
execution supplies recursive sessions, continuation, notifications and errors.
**Locality:** contract lookup/report policy lives in `mission.ts`; native glue
lives in `index.ts`. **Seam:** business contract/report handling, not the native
subagent executor. **Dependency strategy:** native OpenCode is an external
platform dependency, exercised for real; only the model provider is deterministic.

## Exact final evidence

Artifact root:
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-EDJTBC/`.

39 provider requests, all primary; 15 native sessions; 422 captured events.
The version was read by authenticated HTTP from the privately spawned PID, not
assumed from package metadata or old 2.0.21 assertions.

| Artifact | Evidence |
| --- | --- |
| `results.json` | Assertions, exact native IDs, request indices, snapshots, hashes |
| `requests.json` | Real provider bodies, complete tool schemas and consumed content |
| `events.json` | Native births, parent IDs, call/progress/admission IDs, ordering |
| `transcripts.json` | Native tool states/results/errors and synthetic notification metadata |
| `openapi.json` | Actual 2.0.22 runtime schema, including supported depth setting |
| `serve.log`, `fixture.db` | Owned private process logs and storage; no user data |

### Positive/negative/consumption matrix

Indices are zero-based `requests.json` positions, not assumed timing constants.

| Gate | Status | Native evidence / provider consumption |
| --- | --- | --- |
| Real root → child → grandchild → great-grandchild | Confirmed | `ses_efff2f50fffeHScbqYnrZqpW0T` → `ses_efff2f443ffe1gybucZJsoy4ZH` → `ses_efff2f32fffeFAMgJ6AU6CTq3u` → `ses_efff2f2b8ffeCBN8R5tAYQpkx0`; calls `depth_rc`, `depth_cg`, `depth_gg`; agents all/subagent/all |
| First child contexts inherit root contract and native call IDs | Confirmed in this run | First requests 2, 3, 4; each first context trace has nonempty call IDs throughout its real parent chain |
| Great-grandchild result consumed by actual grandchild | Confirmed | Request 6 contains `GREATGRANDCHILD_RESULT` |
| Grandchild result consumed by actual child | Confirmed | Request 7 contains `GRANDCHILD_CONSUMED_GREATGRANDCHILD` |
| Child result consumed by actual root | Confirmed | Request 8 contains `CHILD_CONSUMED_GRANDCHILD` |
| Explicit deep report visible as business completion and consumed by coordinator | Confirmed | Mission `msn_86700831fab888f9be76d0fc`, task `deep=completed`, report notification `admitted`; request 9 contains `GREATGRANDCHILD_BUSINESS_REPORT` |
| Same-child continuation | Confirmed | `continue_rc` returns exact child `ses_efff2f443ffe1gybucZJsoy4ZH`, one child birth under that root; child provider consumes `CONTINUE_DEPTH_CHILD` |
| Foreign-parent continuation | Negative confirmed | `ses_efff2f0a1ffemSuCWqCKxgEAWU` receives native error “not a child of the current session”; zero extra target-child requests |
| Built-in General recursion deny | Negative confirmed | General child `ses_efff2ee47ffeLB5STVBJUby16N` under `ses_efff2ef3dffeOMFBfTytxT9u6J`; no advertised subagent, forced call error, zero grandchildren |
| Explicit parent subagent deny | Negative confirmed | `ses_efff2ecc4ffeNSM12GPeNyDuJz`; forced tool error and zero child births |
| Concurrent background branches | Confirmed | Root `ses_efff2eaceffeT41Di5OVOgzrIh`; children `ses_efff2e8c6ffepEgp94Mgd2gosi`, `ses_efff2e8c5ffecRLFB0ozpR454f`; both active simultaneously while root idle; distinct call correlation present in first contexts |
| Native branch results and reports actually consumed | Confirmed | Parent requests 28–30 include both branch results and reports; native synthetic metadata `source=subagent`, exact `childID`, `state=completed`; business `branch-a` and `branch-b=completed` |
| Foreground provider failure returned to actual parent | Confirmed | Failed child `ses_efff2e5f2ffeXWXrxKB5ALcZ2Q`, parent `ses_efff2e68cffe40uOFIJ8M350iR`; tool `error_rc=error`; parent request 34 consumes `PRIVATE_CHILD_PROVIDER_FAILURE`; no business completion |
| Successful native result without explicit report | Negative confirmed | Root `ses_efff2e522ffeOceCVSb1h6fjAo` consumes `NATIVE_SUCCESS_NO_BUSINESS_REPORT`; task stays `ready`, not completed |
| Existing journal compatibility | Confirmed | Zero discarded events, notification authority available, compatible admitted report receipts |
| Atomic first-context call binding across arbitrary scheduling/restart | Unknown | Event subscriber preceded first contexts in measured runs; no native awaited pre-child hook or crash proof established |
| Pause/Stop, daemon crash, profile/security rollout | Unknown in lane 1 | Independently owned qualification lane; not grounds to reject ordinary native-child viability |

## Alternatives actually tested and failure retention

Default native depth-one policy rejected `depth_cg` with the precise message:
`Subagent depth limit reached (1). Increase "experimental.subagent_depth" to allow nested subagents.`
The actual served schema exposes integer `experimental.subagent_depth` (minimum
0). Setting it to 3, while using legal all/subagent agents with explicit allow,
enabled the real recursive chain. This is configuration, not an executor bypass.

`ctx.session.context` did not expose usable tool-progress metadata to this
implementation, though ancestry inheritance itself already reached the first
child provider request. The attempted raw `ctx.message.list` alternative failed
because **the actual plugin context has no `message` domain**, despite broad
documentation language comparing it to a client. The supported native event
stream supplied structured `session.tool.progress` data and worked without any
native tool edit. No parsing substitute or invented session-parent API was added.

A broad global `* allow` fixture rule also overrode the intended General negative
control. Removing that unnecessary rule preserved built-in General deny while
explicit custom agents remained recursive. Final native agent catalog records
General's deny and both custom modes/permissions. Do not mistake permissive
fixture configuration for a builtin/platform limitation.

Failed/intermediate private artifact directories are retained, never overwritten:

- `missions-child-environment-ygXvIE`, `-1kczHY`: pre-native catalog/RPC output bring-up.
- `-1EuKVO`, `-5YUrpy`: invalid function-reference identity checks through adapted tool definitions.
- `-nDq2PM`: actual default-depth denial and first inherited contract.
- `-4UdChJ`: unsupported plugin `ctx.message` attempt.
- `-qhqZFF`: native recursive/result proof; initial business reducer rejected an unbound task actor.
- `-iSDgJk`: recursive positive proof; excessively broad fixture permissions invalidated General negative control.
- `-JFHr5V`: initial full capability checks passed before stronger first-context/receipt assertions.
- `-kPAcMg`: first-context assertions passed; manually identified incompatible notification receipt IDs, then reused existing identity helpers.
- `-EDJTBC`: final complete PASS, including compatible receipts and zero discarded journal events.

Process deviation: fixture bring-up exceeded the requested three-correction
ceiling (11 private launches, plus an initial pre-launch hash-path error).
This is not hidden or reclassified as a platform blocker; all native failures
and the materially supported alternatives are preserved above.

## Isolation / integrity

Only the assigned absolute CLI is spawned with `serve --hostname 127.0.0.1
--port 0 --print-logs`. The reused immutable `privateRoot` helper provides private
HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG/config/DB/runtime paths and a synthetic
Git repository. Inherited OpenCode/CodeNomad/XDG and WSL/context/credential-like
keys are stripped; project configuration discovery, model fetch and updates are
disabled. Synthetic loopback provider only; no accounts or user projects.

One global 240-second deadline, native agents' 12-step ceilings, depth-three
configuration, provider budget 200, bounded waits and exact owned child cleanup.
No global process kill or shared daemon stop. `execute` is denied and never used.

Every final run reads all 2,225 frozen source files before/after and compares
them to the rollback manifest. The frozen index is independently hashed:

- Source digest before/after: `0b22cdd75f4f94658620472367cd0cfb9955eaa469b6f0d816b66506f91f1dfa`.
- Index before/after: `21a5beee4071a842ef888dfbbfecfcc95cc42b69b378dff0268031ffbac222db`.
- Final own module hashes are in `results.json`; no source/cache/index write
  command targeted the frozen worktree. This check is not a full node_modules
  cache-tree hash and does not claim to be one.

## Next integration needs, not a premature architecture verdict

1. Decide whether root-wide inherited contracts are the desired product policy,
   or whether individual task authorization must exist before the first child
   context. The latter is not established by this unwrapped experiment.
2. Qualify observer lag/reconnect/crash/replay and task-claim races. Event facts
   worked here but are not an awaited native contract-binding hook. Missing
   correlation fails report closed; first context can still inherit root policy.
3. Connect report binding to the intended display/activity projection before
   reports. The prototype only assigns a business actor at explicit report; a
   successful unreported task therefore remains ready, not “running/completed.”
4. Qualify durable authorization, environment ownership, root/child report scope,
   atomic start/report/outbox/retry identity, and Pause/Stop separately. No new
   execution queue is warranted by the capability tests.
5. Compare the other executable lanes only after their native evidence exists.
   This lane demonstrates native-first feasibility; it does not rank untested
   wrapper/observer alternatives or authorize production activation.

V2 sources consulted: `/v2/docs/config`, `/v2/docs/agents`, `/v2/docs/tools`,
`/v2/docs/build/plugins`; actual private `/openapi.json` is authoritative for
2.0.22. Read `AGENTS.md`, the `codebase-design` and `opencode` skills, and existing
`MISSIONS_CONTINUITY_SPIKE.md`; no V1 contract inferred or old fixture edited.
