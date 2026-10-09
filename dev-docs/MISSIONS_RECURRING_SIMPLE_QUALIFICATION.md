# Simple recurring Missions — real native qualification

## Result (2026-10-09)

**NOT ACCEPTED.** The real OpenCode service performs scheduled useful work with
the CodeNomad backend and its presence lease closed. Pause/Stop cancellation passes.
Settlement and interrupted native-session continuation remain blockers; offline
e2e success is not native acceptance.

CLI: **OpenCode 2.0.26**, read-copied from the existing
`C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe`.
Historical startup receipts used 2.0.24, but this existing artifact now reports
2.0.26. No installation or upstream modification was performed.

## Reproduction and isolation

```powershell
npm run build:missions --workspace packages/server
node scripts/test-recurring-simple-native.mjs <absolute-existing-cli> A --bounded
node scripts/test-recurring-simple-native.mjs <absolute-existing-cli> BCD --bounded
node scripts/test-recurring-simple-native.mjs <absolute-existing-cli> CD --bounded
```

The fixture uses production recurrence CREATE/control/manual HTTP handlers,
WorkspaceManager ownership/deletion fences, the production automation bridge and
HMAC verification. A fixture-only authenticated cookie supplies the human identity;
this does not test browser login. `DesktopPluginLifecycle("missions")` provisions
the shipped bundle through native discovery in the isolated config. A hook-only
fixture plugin identifies deterministic provider turns; it does not execute tools,
write Mission reports or mutate schedules. The provider emits actual read, shell,
mission_inspect and final mission_report calls.

Each invocation copies the CLI to an independently created directory beneath
`C:/Users/Admin/AppData/Local/Temp/opencode/recurring-simple-native-*`, uses private
HOME/XDG/config/database/bridge roots and a loopback deterministic provider. Actual
`debug paths` outputs must remain inside that root. The native service is launched
as an owned `serve` process, authenticated, and its API PID must equal the spawned
PID before cleanup. No shared daemon discovery, registration, config, database,
installer, pattern kill or push occurs. Restart in B kills/relaunches only that
owned process; managed-service graceful restart is not qualified by this fixture.

No native clock fast-forward capability was found or used. Daily due clocks use
real UTC minute boundaries roughly 1–2 minutes ahead. The current Job observes
pending settlement on an hourly wake, so a full default run can exceed the
requested 20-minute budget. The original B run waited **62 minutes** after Resume
and still failed. Foreground bounded reruns finish in minutes and explicitly do
**not** certify unattended hourly settlement or tomorrow's passage.

## Evidence

Every root below contains `qualification.json` with snapshots, runtime PIDs,
provider call names and tool availability, exact schedule/passage identities and
read-only native database start-message counts. Databases contain only fixture data.

| Journey | Foreground evidence root suffix | Result | Coordinator starts |
| --- | --- | --- | --- |
| A daily work | `jaj1XS` | Work/admission passes; archive/next-day projection unqualified | **1** |
| B restart pending | `f60TKB` | Interrupted + reconcile-only Resume/no duplicate passes; continuation/archive fails | **1 before, 1 after** |
| C Run now | `TGDl8f` | Two distinct manual admissions/work pass on separate schedules; settlement fails | **1 per passage** |
| D Pause → Stop | `TGDl8f` | Pass in observed due window; Stop terminal | **0** |

Full prefix: `C:/Users/Admin/AppData/Local/Temp/opencode/recurring-simple-native-`.
Earlier background results are preserved at `3Lgel8/qualification.json` (A) and
`OlRBhS/qualification.json` (B). Both completed with failure, not success. A's
earlier timeout additionally exposed a fixture race: it captured conversationID
from write-ahead pending before admission supplied it. The foreground rerun waits
for the admitted conversationID. B remained pending for its entire hourly window.

### A — exact daily passage

- Schedule `rcs_db0f0236b4b3a2b55525a01768930317819df2e0` created paused with title.
- Play acknowledged; backend/bridge/presence closed at `1791507425849`.
- Due `1791507540000`; admitted passage
  `rcp_aebb110464141067e83857eed7c7cc8e426ba433` observed at `1791507540834`.
- Coordinator `ses_76b8fc4ce0b2269b85426ea81f`; only start
  `msg_b9632b023ec7ae81ea4d82f9d11f` (synthetic).
- Real read → shell → mission_inspect → final mission_report → Done completed
  at `1791507541349`, with no backend. No additional coordinator session/message.
- Last snapshot remains pending, history empty; nextDueAt is still today's due.
  Completed archive and next-day projection therefore **not proven**.

### B — exact pending identity after restart

- Schedule `rcs_bcdb9c8c8df807a7d7f61485c242b5079d4c0019`.
- Passage `rcp_bb8de5181933a8f6a87fa82bc78f6246fb46ddda`;
  coordinator `ses_bc51e74f0e7fa0ebb274162350`;
  start `msg_05bfe8f275fd18182b6292a1098c`.
- Owned service PID `51376` stopped; replacement PID `30180`.
- Snapshot after restart: Interrupted / service-restart, same pending identity.
- After 20 seconds native active=false and no resumed provider turn. Explicit
  Resume acknowledged, but no second start/session and no settled history.
- Restart continuation remains a separate native contract gap; Resume correctly
  did not invent a replacement prompt. Earlier `OlRBhS` also remained pending
  after 62 minutes, excluding a merely short observation window there.

### C — independent distinct manual passages (partial)

1. `rcp_5f7b34bb9c9f435a8d40d1902de1407bfa80c73e`, coordinator
   `ses_be88a5812af53084285bd07113`, start `msg_5b63112f4e1519770ac21d06254e`.
2. `rcp_5f208039655cef089dad7da466019bf39514df6c`, coordinator
   `ses_361b5acbd2634885cbdcd80ab5`, start `msg_b8b02470d148f8ecd1e63ef7a9b5`.

Both used real read/shell/Mission tools and final reports. Each has exactly one
native start. They use **two schedules**, because unresolved pending blocks reuse
of the first schedule. Explicit reconciliation did not archive either. This is
not certification of same-schedule repeat Run now, duplicate-request replay or
complete manual settlement.

### D — cancellation and terminality

Schedule `rcs_318b7092fa3d05f5f9ba8495bdbb1fcdf9841ccc`: Play → Pause acknowledged
scheduler cancellation; waited through due `1791507360000` plus 30 seconds.
No pending, history or new root session appeared. Stop acknowledged cancellation,
state=stopped, actions empty. Attempted Resume returned 503 (not successful).
This proves no admission in that observed window, not recursive interruption or
future multi-day behavior. Standalone earlier D also passed (`HSx5rJ`).

## Production fixes and remaining blockers

Committed fix `f06122db`:

1. esbuild rewrote free require inside the stringified Git worker to an undefined
   __require. Bound loader parameter makes bundled native Git work. Regression
   bundles the module and runs Git; baseline failed, fixed code passes.
2. Bundled MutableHashMap hashing missed native Location keys. Native iterator
   field matching preserves exact entry identity and replacement fences.
3. Strict Location.Info decoding rejected the foreign native class with explicit
   workspaceID undefined. Validate typed fields and rewrap, as other paths do.
4. Borrowed Location graphs omit global Database/Session/Job/Bus. Retain those
   process-global services and combine with freshly borrowed Location services.
   SessionExecution is not plugin-visible; observe native Session.active Set.
   Tests and the offline fixture now mirror the observed native shapes.

Additional focused fix: normalize native SQL directory separators at the Windows
observation boundary. Native DB stores `/`, Location stores `\`; previously a
settled family falsely appeared moved. The SQL observation regression now stores
slash-separated paths while the schedule keeps native host paths.

**Unfixed blocker:** during actual settlement publication, the final synchronous
quiescence guard executes SQL with Effect.runSync against the captured observation
graph. Under the real native transaction this requires asynchronous execution:
`AsyncFiberError: An asynchronous Effect was executed with Effect.runSync`, then
`Mission authority rejected: policy-unqualified`. Temporary built-bundle-only
diagnosis at `oulQfr/qualification.json` records this cause. Diagnostic edits were
removed by rebuilding the clean bundle. Do not bypass the guard or equate a final
report with quiescence. The atomic transaction/read-context contract needs a
focused production fix and real native rerun.

Other gaps: crash-versus-managed native resumption, actual next-day passage,
descendant/background-family settlement, watched cursors, human Forms and native
duplicate/lost-reply/CAS-conflict journeys are not accepted by these results.

## Validation and cleanup

- `npm run typecheck` in packages/server: passed after the additional fix.
- `node --import tsx --test src/opencode/missions/recurring-day.e2e.test.ts`: all
  six top-level journeys pass (including three crash-boundary subtests).
- Combined observation/clock/Git-worker/offline e2e command: **13/13 tests pass**.
- Earlier full opencode/missions suite plus Git regression passed after f06122db.
- All foreground runs finished. Before returning, exact executable-path/process
  inspection found **zero** `recurring-simple-native-*` services and zero fixture
  Node processes. All recorded native PIDs were absent. Provider listeners are
  closed by fixture finally blocks. No shared daemon was stopped or modified.

Acceptance remains closed despite passing offline checks.
