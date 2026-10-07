# Missions: product specification

## Product goal
Missions turns a complex objective into coordinated native OpenCode work while
keeping the human experience focused on five questions:
1. What was requested?
2. What is happening now?
3. What needs a human decision?
4. What was produced?
5. What comes next?
The product supports both one-time Missions and recurring Missions. OpenCode owns
the execution lifecycle; CodeNomad provides the planning, authority, control, and
reading experience.

## 1. Create a Mission
### Mission types
Users can start from:
- **Custom** for a free-form objective;
- **Pocock** for difficult bug fixing with diagnosis, implementation, independent
  review, and fresh validation;
- **Wayfinder** for exploration, bounded decisions, and parallel frontier work.
Each Mission records:
- an objective;
- optional working notes;
- a coordinator profile;
- role-specific task profiles;
- a task-session policy;
- project and Location identity;
- one-time or recurring execution mode.
Creation presents the effective choices before execution. **Play** is an explicit
human action and freezes the accepted creation inputs.
### Profiles
Profiles select the agent, model, and optional reasoning variant for each role.
Business roles remain independent from runtime agent identities.
The coordinator uses a primary profile. Task profiles follow the selected session
policy:
- native subagent sessions;
- independent primary sessions.
An actor keeps the profile accepted for its current work. New defaults apply to
new Missions and new actors.
### Reusable briefs
Users can save, load, and delete reusable briefs. Loading a brief copies its inputs
into a normal creation draft. Existing Missions retain their original configuration,
sessions, results, and history.

## 2. Delegate through OpenCode
The coordinator declares tasks, dependencies, roles, expected results, and execution
constraints. OpenCode creates and runs the native sessions and subagents.
### Native delegation
Native subagents are the default task mode. Results return through the native parent
relationship and are recorded against the declared Mission task.
Ready tasks can run in parallel. Agents can decompose work further according to
their native permissions and configured depth.
### Independent sessions
Independent sessions are available for work requiring a separate Location,
conversation lifecycle, existing session, or explicit root identity.
The choice is stored per Mission and remains stable for its task executions.
### Task and conversation identity
Tasks use stable keys and contract generations. Conversations use their exact native
session identities. Continuation and reuse preserve the accepted actor profile and
execution binding.
Task dependencies describe the business plan. Conversation ancestry describes the
native execution family. Both structures remain visible and distinct.
### Native depth
Subagent depth is a Location-scoped OpenCode setting. The editor shows:
- the owning configuration file;
- the effective value;
- the local override;
- explicit save and inherit actions.
Drafts retain their original file expectation for conditional writes.

## 3. Understand the Mission
### Information hierarchy
The Mission panel presents information in this order:
1. native Forms and permissions requiring a response;
2. the coordinator briefing;
3. current work and dependencies;
4. technical details and history;
5. preferences and cleanup receipts.
### Coordinator briefing
The coordinator produces a bounded, dated briefing containing:
- the current assessment;
- completed results;
- active obstacles;
- upcoming work;
- exact task sources.
The panel shows freshness and opens the full briefing in the central reader.
### Work
The Work section shows compact task rows and the declared dependency graph. Task
states include prepared, queued, active, blocked, awaiting input, completed,
replaced, withdrawn, and failed.
Each row exposes its status, actor, relevant actions, and exact reader target.
Completed and retired work remains visible when it explains the current plan.
### Results
Task readers place the current result first, followed by evidence, next actions,
the original brief, and technical details.
Reports support Markdown, code blocks, source references, and long bounded content.
Previous attempts and late reports remain available in one result history.
### Conversations
The Conversations section shows observed native ancestry:
- coordinator;
- task actors;
- ordinary descendants;
- independent roots;
- known activity state.
Navigation always targets the exact conversation identity.
### Plan history
Plan revisions record their reason and concrete changes: added tasks, retired tasks,
replacement relationships, and dependency updates.
The full revision opens in the central reader.
### Central reader
Long briefs, reports, evidence, and plan revisions open above the transcript. The
eye action remains pinned to its source item and highlights the exact active reader
target.
Reader, disclosure, and selection state are stored per native window and survive
data refreshes.

## 4. Human interaction
### Attention
Attention contains genuine native Forms and permission requests from the Mission's
observed conversations. Each request keeps its native provenance and opens in the
shared interruption surface.
Task obstacles remain task results, while explicit requests remain human attention.
### Lifecycle controls
One control strip provides:
- **Play** to start or resume;
- **Pause** to park dispatch and interrupt registered root actors;
- **Stop** to record terminal intent and retire authorized work.
Every native target has an explicit control receipt and retry surface.
### Guidance and questions
Users can give direction or ask the coordinator for an explanation. Each mode has
its own identity-scoped draft and uses ordinary native admission.
Direction can lead to a recorded plan revision. Questions preserve the current
plan while requesting clarification.
### Recovery
Targeted recovery observes the selected actor's Location, descendants, native
activity, Forms, permissions, and relevant Shell state. It reconciles Mission state
with authoritative native evidence.
Recovery actions and feedback remain attached to the selected Mission or task.
### Cleanup
Optional managed-session cleanup records immutable targets and per-session receipts.
It preserves coordinators, shared and reused sessions, moved sessions, and roots
that still own descendants.
Pending and completed cleanup receipts share one Mission disclosure.

## 5. Recurring Missions
### Setup
A recurring Mission adds:
- permanent instructions;
- a daily local time;
- a timezone;
- followed conversations or sources;
- passage-specific authority and effect budgets.
The Mission panel shows the next passage, latest result, pending decisions, and
current schedule state. Users can run a passage now, pause or resume the schedule,
and stop it permanently.
### Autonomous execution
The OpenCode service owns recurring execution while CodeNomad windows and the
intermediary CodeNomad backend are closed.
At each due time the service:
1. reads the durable schedule and authority;
2. reserves a stable passage and message identity;
3. resolves the current profile and execution environment;
4. admits exactly one finite Mission passage;
5. records native effects and receipts;
6. observes terminal settlement;
7. archives the result;
8. schedules the next passage.
Each passage completes independently. The permanent Mission remains available for
future passages and accumulated results.
### Catch-up and restart
The schedule uses civil time in its configured timezone. Daylight-saving gaps,
repeated times, and skipped civil days resolve deterministically.
After sleep, shutdown, or temporary unavailability, the service performs bounded
catch-up using stable due identities. Restart recovery continues the same pending
passage and preserves uncertain effects for reconciliation.
### Reference use case
A daily review Mission can:
- discover new or updated CodeNomad pull requests;
- review unprocessed commits;
- revisit explicitly followed conversations;
- collect new replies since the stored cursor;
- produce a result grouped as handled, needs decision, or no change.
Pull-request identity, commit identity, review publication, code modification, and
merge authority remain explicit inputs to the passage.

## 6. Authority and durability
### Standing authority
Recurring execution uses a signed human parent authority. Every passage receives a
finite child grant bound to:
- project and canonical root;
- schedule and passage;
- profile and execution host;
- message and conversation identities;
- effect budget;
- authority epoch.
### Effect lifecycle
Every external effect reserves a stable operation identity before execution. A
native receipt binds the actual invocation, target, payload, and observed outcome.
Unknown outcomes remain durable pending operations. Reconciliation uses the same
operation identity and authoritative native evidence.
### Passage settlement
Terminal settlement requires:
- the exact passage and conversation identity;
- terminal native execution evidence;
- settled Forms, permissions, controls, and child calls;
- acknowledged coordinator notification;
- a settled Mission journal.
Settlement archives the child grant, effects, receipts, result, and archive chain.
### Durable state
The Mission journal stores tasks, actors, reports, controls, notifications, cleanup
receipts, and plan history. Recurrence storage adds schedules, pending passages,
authority, result references, and followed-message cursors.
Stable identities are reserved before external effects. Conditional writes and
synchronous authority fences protect every mutation boundary.
### Fresh execution context
Each passage resolves its profile, environment, Location, ownership, connection,
permissions, and publication authority immediately before native admission.
Restarted actors and reused conversations retain their accepted execution identity.

## 7. UX requirements
- The Mission panel remains compact and square.
- Current work and human attention stay above technical history.
- Long content stays in the central reader.
- Desktop, touch, narrow, and RTL layouts expose the same actions.
- Keyboard focus survives refreshes and responsive action overflow.
- Controls use semantic labels, expanded state, and pressed state.
- All user-visible text uses the shared localization layer.
- Empty, loading, stale, uncertain, and error states preserve available data.
- Cache-first reads revalidate on visible demand and native invalidation.
- Late responses remain fenced to their original Mission, task, and Location.

## 8. Acceptance journeys
| Journey | Expected experience |
| --- | --- |
| Create | Review effective choices, save or load a brief, and start with explicit Play |
| Delegate | Use native subagents or independent sessions with stable profiles and identities |
| Follow | See the briefing, current tasks, dependencies, and observed activity |
| Respond | Open the exact native Form or permission request and preserve drafts |
| Read | Open complete results and evidence in the central reader |
| Guide | Send direction or a question to the exact coordinator |
| Control | Play, pause, resume, stop, recover, and inspect receipts |
| Schedule | Configure a daily recurring Mission and run a passage immediately |
| Continue | Resume the same passage and authority after service restart |
| Review | Inspect passage history, native effects, terminal results, and decisions |

## Reference documents
- [Mission contract](MISSIONS.md)
- [Native autonomy requirements](MISSIONS_AUTONOMOUS_PLUGIN_REQUIREMENTS.md)
- [Continuity and authority contract](MISSIONS_CONTINUITY_CONTRACT.md)
- [Native product acceptance](MISSIONS_NATIVE_PRODUCT_ACCEPTANCE.md)
- [Validation ledger](MISSIONS_REFACTOR_VALIDATION.md)
