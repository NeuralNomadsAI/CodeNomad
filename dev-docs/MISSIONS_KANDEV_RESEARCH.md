# Missions / Kandev — working decision record

Status: exploration complete; see [the actionable roadmap](MISSIONS_KANDEV_ROADMAP.md).
This record distinguishes findings from implementation, which remains future work.
Mission: `msn_7ed15b53060e65b09cf5f3fd`.
Source checkouts: CodeNomad PR #673 (`feat/session-native-missions-v2`), `D:\kandev`.

## Destination and user decisions

- **Primary:** evaluate Kandev ideas for Missions, orchestration and dynamic workflows,
  principally in PR #673. A vague objective must be able to become a concrete,
  revisable plan as work reveals new information.
- **Secondary:** collect useful ideas anywhere in CodeNomad, including UI/UX,
  review, context and integrations. Docker, SSH and Sprite/cloud are examples,
  not the boundary of this investigation. Keep this backlog distinct from #673.
- **Invariants:** remain an OpenCode V2 client; no Go rewrite or copied execution
  runtime. Borrow useful behavior rather than Kandev's architecture wholesale.
- **Human decision, 2026-09-27:** broad autonomy by default. The coordinator may
  explore related avenues and adjust priorities while keeping the user informed.
  Ask for decisions explicitly reserved by the user. Do not add mandatory approval
  to every plan revision. This is the desired product policy; this research phase
  remains planning-only apart from the separately authorized dispatch repair.
- **Human decision, 2026-09-27:** accept a fourth focused `mission.revise` operation
  in the roadmap, evolving the initial three-tool contract. This approves the
  design direction, not an already implemented API.

## Established findings

### Multi-model execution: preserve the existing mechanism

PR #673 already validates native agent/model/variant selections, persists explicit
choices in task contracts and refuses mismatched actor reuse. Roles are independent
of execution profiles. No new model router is necessary for Astra coordination with
Muse, Space Bunny or Luna assistants.

Evidence:
- `packages/server/src/missions/execution.ts`
- `packages/server/src/missions/native-catalog.ts`
- `packages/server/src/missions/control.ts`, `delegateCurrent` / `finishDispatch`
- `dev-docs/MISSIONS.md`, native execution selection and queue limitations

Recommended UI work: distinguish requested explicit selections from native defaults,
and current actor selection from its assignment contract. Partial selections must
be represented per field: choosing only an agent does not pin a model. An unknown
runtime selection is not proof that the requested model is actually running.
External native selection changes remain possible after queue admission.

Kandev's per-step `AgentProfileID` and review override are useful presentation and
preference examples, not missing execution primitives. Source:
`apps/backend/internal/workflow/models/models.go`. Its tier-routing ADR is marked
superseded; do not use it alone as proof of current runtime behavior or model quality.

### Plan evolution: a concrete gap beyond presentation

Verified in `packages/server/src/missions/model.ts` and `control.ts`:
- Objective and notes are recorded at creation; no revision event exists.
- Reusing a task key with a changed contract is rejected.
- A recorded report is immutable; a later report retries notification.
- Green mission completion currently requires every task to be completed.
- There is no explicit replacement/abandonment or retry-attempt domain operation.

These properties protect retry idempotence, but adding tasks alone cannot fully
express a changing plan. An abandoned avenue or a failed/blocked reported task
needs an honest resolution path without rewriting evidence or falsely reporting
success. The decision task **Define minimal plan revision and task recovery**
confirms this gap. A map-state change must not pretend to stop an already admitted
native prompt.

#### Recommended direction and scope of the first slice

Keep historical contracts and outcomes immutable. Introduce a versioned current
plan and explicit retirement/replacement with a reason. Removing an obligation is
not evidence of success, and must not implicitly satisfy dependent work.

The scout proposes separate logical tasks, immutable execution attempts and a new
`mission.revise` tool. Coordinator assessment:
- **Retain:** append-only plan revisions, stale-revision rejection, explicit
  replacement links, late-report preservation and coordinator-only writes.
- **Simplify first:** a fresh task key/admission for a retried or reframed unit of
  work, linked to its predecessor. This uses existing task/report identity rather
  than immediately adding an independent attempt entity. A later UI may group
  the lineage; immutable history must remain accessible.
- **API direction approved by the user:** add a focused `mission.revise` operation
  instead of hiding unrelated mutations inside `inspect`, `delegate` or `report`
  merely to preserve the tool count. Its exact input schema and admission rules
  remain to be specified; the running API still exposes three tools.
- **Human policy already settled:** broad autonomy. Revision is not a mandatory
  approval gate; ask only for explicitly reserved decisions.

Acceptance scenarios for the roadmap:
1. A failed report remains visible after a successful replacement task.
2. Retrying an interrupted admission preserves its original ID; intentionally
   starting replacement work uses a new ID. These are different operations.
3. A retired task's late report cannot re-enter or complete the current plan.
4. Dependent work stays blocked until its requirement is explicitly redirected
   or removed; retirement never counts as completing required work.
5. A stale or repeated revision cannot overwrite state or duplicate work; all
   dependency changes are validated together, including unknown keys and cycles.
6. Retiring queued/running work does not stop its native session or switch its
   model. Outstanding execution remains visible even if the plan no longer needs it.
7. Completion distinguishes current obligations from retired history, preserves
   playbook evidence requirements, and does not claim outstanding native execution
   has stopped. Define the finish policy for outstanding work before shipping.

### Kandev inspiration: hypotheses to qualify

- Versioned plans and review history: promising for explaining what changed and why.
- Completion signals: compare with existing `mission.report` before adding anything.
- Child-task delegation: preserve the coordinator's topology authority; specialist
  follow-up proposals need not create another orchestrator.
- Human gates/quorum: optional patterns, not the default under broad autonomy.
- Workflow engine: configurable event/action state machine. Do not import it as a
  requirement for adaptive planning. See Kandev `internal/workflow/engine/` and
  `docs/decisions/0004-task-model-unification.md`.

## Coordinator verification of the UX report

- Confirmed: `MissionRoute` does not render `brief`; `MissionOverview` omits notes;
  dependencies use raw keys; the apparent route is creation order, not dependency order.
- Confirmed: native Forms already have a session-scoped queue (`stores/forms.ts`).
  Surface mission-related requests using existing Forms authority, not a new gate model.
  Reconciliation comes from native Form events and reconnect loading, not Missions RPC
  invalidation alone (`stores/instances.ts`). Do not infer a live Form from `needs-input`:
  that task status currently represents a blocked report.
- **Rejected finding:** `steer` is not a no-op. `missions/inputs.ts:11` preserves
  `task.delivery`; the prompt adapter accepts queue or steer. Only report synthetics
  always use queue (`inputs.ts:22`, `control-types.ts:38`).
- **Rejected assumption:** server runtime status is not already populated. Search of
  the server finds only its optional model declaration. Native session state remains
  the available source; distinguish unknown, idle, waiting and reported completion.
- The journal is retained, not discarded. The RPC exposes a materialized projection
  rather than the change history; add a bounded presentation projection if needed.
- Kandev `apps/web/components/task/simple/components/approval-action-bar.tsx:28-43`
  deliberately hides this particular human participant approval bar. This is not
  evidence that all human approvals or clarifications in Kandev are nonfunctional.
- Kandev inbox has actual snooze/dismiss API wiring in
  `apps/web/components/needs-you-inbox/needs-you-inbox-row.tsx`. Borrow the attention
  surface; do not require a fixed number of clarification questions for every mission.

## Remaining implementation investigations

- UX route is consolidated in the roadmap; visual design remains an implementation step.
- Recovery finding resolved at domain level; exact API and outstanding-execution
  finish policy must be specified before implementation.
- General-opportunity report includes infrastructure, review and utility ideas;
  several claims cite docs or interfaces rather than complete runtime traces.
  Validate priority candidates before promoting them into the roadmap.
- Docker/SSH/cloud can help isolation and remote compute. Assess a native-client
  integration path separately from remote access to CodeNomad's UI. No infrastructure
  deployment or provider-cost estimate has been validated by this research.

## Repair discovered while exercising the mission

- `258e20a2`: a verified owner no longer waits for unrelated workspace checks.
- `fa8925a6`: mission discovery allows 30 seconds for cold validated ownership,
  while browser probes keep their existing deadline and competing owners remain rejected.
- The original assignment and subsequent research were admitted using the same
  durable task identities. This does not establish a general performance benchmark.
