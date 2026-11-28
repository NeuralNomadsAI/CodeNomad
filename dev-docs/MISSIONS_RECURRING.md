# Mission launch criteria and documents

Programmed Missions (the native Automations that launch a Mission again) are described in
[Missions](MISSIONS.md), §Mission calendar tool. The Wayfinder UI-answer mark below applies to every Mission.

## Launch criteria

A launch policy (`missions/launch-policy.ts`) is one ordered list `{ when }` of criteria, each a
schedule (`{ kind: "now" }` once at Play, or one cron with its IANA zone) or an event. A sole
`now` criterion and an empty list make a one-time Mission.

`missionCriteriaStructure` (`missions/mission-launch-kind.ts`) is the one parser the codec, the
calendars, the editor and the list summary share. It reads the list as groups of consecutive
schedules or events. Between two adjacent cards the connector depends only on their kinds: same
kind **or**, schedule → event **if**.

- Events alone launch on each new occurrence (OR), checked every 15 minutes.
- Events after a schedule group are the conditions (OR) of every schedule of that group: at each
  of its slots the Mission launches only if one of them changed since the last successful launch.

The editor keeps schedules above events. `missionCalendarAutomations`
(`missions/calendar-automation.ts`) refuses what a calendar cannot carry: a schedule group after
events, an end date or count, followed conversations, and the events of other Missions or of
conversations. A stored policy naming one of those events stays under "Stored scheduling policy" in the form until it is replaced.

## Wayfinder human decision mark — both execution modes

When the user answers a native Form through CodeNomad's InterruptionDock, the
backend records `{ formID, sessionID, answeredAt, via: "ui" }` in two phases:
a `pending` mark with a fresh `attemptID` before forwarding, promoted to
`confirmed` only after the native reply returns positively for that attempt.
A definitely failed forward (Form still observed pending) removes the mark; a
lost/uncertain reply leaves it pending forever. Pending never qualifies, so a
later non-UI answer cannot borrow an earlier failed UI attempt; the coordinator may ask again.
A Wayfinder decision readout that claims the human's answer passes only with a native
Form carrying the matching confirmed UI mark; the coordinator's own decision
(`decidedBy: "coordinator"`) needs no mark and is never shown or counted as the
human's (`MISSIONS.md`, §Human questions and decisions). A refusal reaches the model
as "Human decision required: the user must answer this question from the CodeNomad
interface", with the gate's cause as a detail.
The gate also proves the asking conversation natively. The coordinator asks from its
own root conversation (`coordinator-form-answer`): the Form's session must be that
mission's coordinator and a root, the cited field's own question must end with the
cited decision task's `questionTag` with no other tag in its question or header, the
answer must postdate the task's declaration, and one Form field settles at most one
live decision task. A decision conversation's own question (`native-form-answer`, missions whose
decision workers asked themselves) needs a fresh child of the expected parent's exact
`subagent` call whose prompt carries the declared assignment. Answers
and execution failures are read from durable message projections (completed question
part, `idle` outcome). Native question and delegation evidence counts only from
local tool parts and events: `isLocalNativeTool` (`missions/native-call-observation.ts`)
accepts `executed === false`; `true` (provider-hosted) or a missing flag never qualifies.
Do not infer identity from answer text, tool completion or the agent's assertion.

Only Forms whose session belongs to a Mission family take the mark path: a root
with `codenomad.mission` metadata, or a metadata-less root (an attached
existing coordinator) that the plugin finds as the coordinator actor of a
Mission in the project's durable one-time journal, after walking the bounded
native parent chain to exactly that root. Every other Form uses the ordinary
native reply unchanged and gets no mark. Marks live under
`codenomad-missions/human-marks-v1`.

The UI principal is explicit in the private bridge proof: a local login cookie
session (auth enabled), or a paired Remote Control device chosen by ingress
socket membership. A device qualifies only while Remote Control is connected
and the device is still paired, unrevoked and unexpired; the route and the
bridge callback revalidate that principal across native I/O. A device ID never
poses as a cookie session. When the mark cannot be prepared before forwarding
(no authenticated principal, plugin/binding unavailable, revocation or a
session move), the answer falls back to the ordinary reply without a mark; the
user is never blocked from answering. The human-answer header alone (automation,
SDK) never mints a mark. The dock sends `x-codenomad-human-answer` only for a
real pointer click or submit keydown on that exact question, never for
`element.click()`, `requestSubmit()`, synthetic events, developer automation,
automatic or SDK calls (`tests/browser/interruption-dock.test.ts`,
`automation-input.test.ts`). The input captures a one-use token bound to the exact
request, schema and answer (`lib/form-answer-interaction.ts`); it expires with that
input task and is consumed at the SDK send in `stores/instances.ts`. Only a dispatched mark reply with a lost outcome is
reported as uncertain.

Missing evidence leaves the gate unmet and never replays an answer; the ordinary
answer path keeps its ownership and uncertainty checks.

## Agent conventions

### Unified document foundation

`missions/launch-policy.ts` and `mission-document{,-state,-store}.ts` provide a
strict internal configuration codec and conditional document store. Their
`codenomad-missions/documents-v1` namespace owns paused creation, launch criteria
(triggers and conditions), the stored legacy policies read
through `missionLaunchModel`, the single deferred launch and an admitted-passage
count. Relative legacy origins are frozen at first Play; the slot end applies to
recorded due times, including late arrivals. Engine code reads launch policies only
through `missionLaunchModel` and its helpers, never their stored fields.
Each passage references its execution journal by immutable mission ID. The existing
journal ranges, deletion reserve and activation index own execution history.


The store requires transactional revision compare-and-set and a synchronous fresh
ownership guard. `opencode/missions/native-mission-document-storage.ts` acquires
the private Database in the current RPC graph and performs revision/byte-checked
publication inside an immediate transaction. One-time product creation and first
Play use this adapter through `mission-document-one-time.ts`; their immutable
creation receipt reserves the coordinator identity before native creation, and the
first Play retains its original lifecycle request/message and admission count.
Panel reads project bounded document metadata through the existing map RPCs.

`documentCapabilities` qualifies new unified document creation. Journal-only
one-time maps keep their existing execution controls, declarations, continuations
and final reports through the journal path, with their stored representation
preserved.

`documentCapabilities` qualifies new unified document creation. Journal-only
one-time maps keep their existing execution controls, declarations, continuations
and final reports through the journal path, with their stored representation
preserved.
