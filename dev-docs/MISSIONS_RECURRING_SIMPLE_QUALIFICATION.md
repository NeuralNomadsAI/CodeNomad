# Simple recurring Missions — real native qualification

## Rerun result (2026-10-09, after settlement fixes)

**Journeys A–D pass natively** against the same isolated OpenCode 2.0.26 copy,
after commits `bdbb35b3` (awaited settlement + revision CAS), `bdb6b80e` and
`59c7f05c` (event-driven settlement wake) and `702aa3b8` (restart-cut passages
settle as interrupted). Acceptance of the whole contract remains open for the
gaps listed below; this is not a claim of full acceptance.

```powershell
npm run build:missions --workspace packages/server
node scripts/test-recurring-simple-native.mjs <absolute-existing-cli> A
node scripts/test-recurring-simple-native.mjs <absolute-existing-cli> BCD
```

The `--bounded`/62-minute modes are gone: every archive must now appear within
150 s of quiescence (`client.session.wait`), far below the hourly ceiling.

| Journey | Evidence suffix | Result | Coordinator starts | Archive latency |
| --- | --- | --- | --- | --- |
| A daily work, backend closed | `z8NPBb` | completed archive, state running, nextDueAt = due + 24 h | **1** | **3.0 s** after quiescence |
| B restart pending → Resume | `fHv1dw` | `ended-without-report` / `interrupted`, same passage, no continuation | **1** (same message before/after) | settled before first post-Resume read (< 1 s) |
| C Run now ×2, same schedule | `fHv1dw` | two distinct passages, both completed; exact duplicate request returned the same passage | **1 each** | 2.0 s, 3.1 s |
| D Pause → Stop | `fHv1dw` | no admission through due + 30 s; Stop terminal, Resume → 503 | **0** | n/a |

Details (full prefix `C:/Users/Admin/AppData/Local/Temp/opencode/recurring-simple-native-`):

- **A** `rcs_7194341d…`: due `1791509340000`, backend/presence closed at
  `1791509265197`; passage `rcp_c32bcdc1…`, coordinator `ses_05cef120…`, only
  start `msg_02830109…`; real read → shell → mission_inspect → mission_report.
  Quiescent `1791509341007`, archive observed `1791509344043` (3 s debounce).
  `nextDueAt` `1791595740000` = due + 86 400 000. One native root session.
- **B** `rcs_d0c3f4a1…`: passage `rcp_90305809…`, coordinator `ses_99f9687c…`,
  start `msg_98704665…`; owned PID `65072` killed mid-turn, replacement `62536`.
  After restart: Interrupted/service-restart, same pending; 20 s later native
  active=false, no new provider call (1 total). The DB keeps the coordinator's
  `time_suspended` claim and no terminal event, as in `f60TKB`. Explicit Resume
  archived `ended-without-report` with `reason: interrupted`; still exactly one
  start and one provider call — no continuation was sent.
- **C** `rcs_a9385e56…` (Play'd, due 6 h away): passages `rcp_68da3978…`
  (`ses_5b5579c7…`) and `rcp_98a4b70c…` (`ses_1a938bd7…`), each one start and
  the full tool sequence; history 2, pending null. Replaying the first Run now
  payload (same requestID/expectedRevision) returned 200 `accepted` with the
  same passage/message — no second session.
- **D** `rcs_6f349424…`: as before; no root session after due `1791509520000`.

All recorded PIDs (`48864`, `65072`, `62536`) were absent afterwards and an
exact executable-path/command-line scan found zero fixture services or Node
fixture processes.

### Remaining gaps

- Tomorrow's real passage cannot be fast-forwarded natively; the offline day
  e2e covers the next civil day. Unattended hourly-wake behaviour is unchanged.
- Restart continuity was exercised only with an owned unmanaged `serve` and a
  hard kill. Upstream sources sweep orphaned claims only in the managed service
  at boot; that path (and a resumed claim after archive) is not qualified.
- Native does not persist event payloads here (the `event` table stays empty),
  so the observer's `session.execution.failed` lookup cannot see native failures:
  a failed passage would archive as `ended-without-report`. Not exercised.
- A Run now on a paused schedule has no Job to settle it until Play/Resume.
- Descendant/background-family settlement, watched cursors, human Forms and
  native CAS-conflict/lost-reply journeys remain offline-only.

### Validation

- `npm run typecheck` in packages/server and packages/ui: pass.
- `recurring-day.e2e.test.ts`: 9/9 (journey A now asserts the archive 5 s after
  the model finishes, not after the hourly wake).
- All `src/opencode/missions`, `src/missions/recurrence-*` and recurrence route
  tests: 320 pass, 1 skipped, 0 fail.

## Previous result (2026-10-09, first run)

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

**Blocker (fixed in `bdbb35b3`, see rerun above):** during actual settlement publication, the final synchronous
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
