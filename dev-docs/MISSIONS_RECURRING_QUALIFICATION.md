# Recurring Missions — native qualification fixture

`scripts/test-recurring-simple-native.mjs` qualifies the acceptance journeys of
[`MISSIONS_RECURRING.md`](MISSIONS_RECURRING.md) against a real
isolated OpenCode service and the shipped Missions bundle. That document defines
the journeys; this one maps them to fixture letters and describes the fixture.

## Run

```powershell
npm run build:missions --workspace packages/server
node scripts/test-recurring-simple-native.mjs <absolute-existing-cli> [journeys]
```

`journeys` is an ordered subset of `ABCDGELFWQN` (default `ABCD`). A–D and G live
in the script, the others in `scripts/recurring-simple-native/journeys.mjs`. The
fixture runs on Windows: it copies the CLI as `opencode.exe` under
`%LOCALAPPDATA%\Temp`. It writes `qualification.json` to its private root, prints
a JSON summary (root, CLI version, outcome, failed stage, error) and exits with
code 1 on any failure.

## Journeys

| Letter | Acceptance journey | Asserts |
| --- | --- | --- |
| A | 1, daily useful work | With backend, bridge and presence closed, the due passage runs read → shell → `mission_inspect` → final `mission_report`; completed archive, one start, schedule still running with nextDueAt = due + 24 h |
| B | 2, restart with pending | The owned service is killed mid-turn and relaunched: Interrupted (`service-restart`) with the same pending passage; Resume archives `ended-without-report`/`interrupted` with the original single start and no further provider turn |
| C | 3, Run now | Two Run now passages on one schedule, each completed with one start and its own session; the evidence records the response to an exact duplicate of the first request |
| G | 3, Run now | Run now on a paused schedule completes through the settlement-only observer; the schedule stays paused with nextDueAt null |
| D | 4, Pause/Stop | Pause before due leaves no root session through due + 30 s; Stop is terminal and a later Resume is refused |
| Q | 5, human gate | A Wayfinder decision child asks a native Form, which keeps the passage pending. The dock answer with `x-codenomad-human-answer` writes a confirmed `ui` mark and the passage completes; the same answer without the header leaves no mark, the gate returns "Human decision required…" and the passage ends without report |
| E | 1, family settlement | A background `subagent` and a background `shell` keep the passage pending; child end → shell end → final report → archive, with one Mission start beside the native completion notices |
| L | 1, family settlement | 34 background subagents launched six per turn form a 35-session family; one held child keeps it pending until it ends |
| F | 1, provider failure | Provider HTTP 400 archives `failed` from the native idle outcome, with one start and no further provider call |
| W | 1, watched conversation | Four passages over one watched conversation: each start carries the messages after the cursor; a failed passage keeps the cursor, so the next one receives those messages again |
| N | dock route | A question Form from an ordinary, non-Mission session, answered through the dock route, reaches the model and leaves no mark |

## Isolation

Everything the fixture touches lives under one private root
(`%LOCALAPPDATA%\Temp\opencode\recurring-simple-native-*`): the CLI copy,
HOME/XDG/config/database/bridge roots and a loopback deterministic provider. Every
`debug paths` location must resolve inside that root. The service runs as an owned
`serve` process; its authenticated API PID must equal the spawned PID before the
fixture stops it. Never point the fixture at the shared daemon, its registration,
configuration or database, or at a user's Missions, and never add installers,
pattern kills or pushes.

The fixture drives the production recurrence create, control and Run now routes,
WorkspaceManager ownership and deletion fences, the automation bridge with HMAC
verification and the InterruptionDock human-answer proxy route.
`DesktopPluginLifecycle("missions")` provisions the shipped bundle through native
discovery in the isolated config, and a fixture-only cookie session supplies the
authenticated human. A hook-only fixture plugin tags provider requests; the
deterministic provider plays the model through ordinary native tools only
(`read`, `subagent`, background `shell`, `question`, `mission_*`).

## Timing

Due times are real UTC minute boundaries 1–2 minutes ahead. Settlement is
event-driven: each archive must appear within 150 s of family quiescence
(`SETTLE = 150_000`), and a passage with remaining work must stay pending through
a 10 s observation window (E, L, Q).

## Output

`qualification.json` holds the CLI version, isolation paths, per-journey
snapshots, timestamps and archive latencies, provider call names with the tools
offered, owned service PIDs and a read-only listing of the fixture database's
sessions and start messages. Native log lines are kept only as a bounded error
excerpt with the service password redacted.

## Coverage elsewhere and open gaps

Paths below are under `packages/server/src/` unless stated.

- Next civil day's passage: `opencode/missions/recurring-day.e2e.test.ts`
  journey A, because the native service clock runs in real time.
- Check passage after a restart, crash boundaries around the write-ahead CAS and
  a start message pruned after admission: the same e2e (H, L2, C, C4).
- Lost control replies and stale-revision conflicts:
  `server/routes/mission-recurrence-control.test.ts` and
  `server/routes/mission-recurrence-stale-revision.test.ts`.
- The 4,096-session family ceiling and above-ceiling coverage:
  `opencode/missions/native-recurrence-family-bound.test.ts`; L covers a
  35-session family natively.
- One-time Wayfinder decisions: `scripts/test-missions-native-trajectory.mjs`
  (`MISSIONS.md` §Validation).
- Open: the managed service's restart, including its boot-time sweep of orphaned
  claims (B restarts an owned `serve` process with a hard kill).
- Open: a native admission whose `recordAdmission` write is lost reads as never
  admitted once its start message is pruned.
