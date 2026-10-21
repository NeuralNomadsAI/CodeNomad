# Simple recurring Missions — real native qualification

Isolated native runs of the acceptance journeys in
[`MISSIONS_RECURRING_SIMPLE.md`](MISSIONS_RECURRING_SIMPLE.md).

## Latest results

All runs used one isolated read-copy of OpenCode 2.0.26 (below the current 2.1.2
minimum, so these are dated results) with a rebuilt `build:missions`. Evidence
roots are `<TEMP>/opencode/recurring-simple-native-<suffix>/qualification.json`,
local to the machine that ran them. Every owned PID was absent afterwards and an
executable-path/command-line scan found no fixture processes.

| Journey | Scenario | Result (detailed run) | Latest pass |
| --- | --- | --- | --- |
| A | daily work, backend closed | completed; 1 start; archive 3.05 s after quiescence; nextDueAt = due + 24 h (`GI9sD9`) | 2026-10-11 `gZDNBT` |
| B | restart pending → Resume | `ended-without-report`/`interrupted` 16 ms after Resume; same passage, 1 start, no continuation (`37sirt`) | 2026-10-11 `gZDNBT` |
| C | Run now ×2 + duplicate | two completed passages; the exact duplicate returns the same passage (`37sirt`) | 2026-10-11 `gZDNBT` |
| D | Pause → Stop | no root session after due + 30 s; Resume after Stop → 503 (`37sirt`) | 2026-10-11 `gZDNBT` |
| G | paused Run now | completed by the settlement-only observer Job with the schedule still paused; 1 start (`RT5Z4f`) | 2026-10-11 `gZDNBT` |
| E | background child + background shell | pending while child/shell run, then completed; 1 start (+2 native notices) | 2026-10-09 `mNFSMz` |
| F | provider HTTP 400 | `failed` from the idle outcome; no retry (1/1 provider calls) | 2026-10-09 `mNFSMz` |
| W | watched conversation ×4 | completed, completed, failed, completed; cursor moves only on completed | 2026-10-09 `mNFSMz` |
| Q | Wayfinder Form, UI vs ordinary answer | UI: confirmed/ui mark, completed; ordinary: no mark, gate refusal, `ended-without-report` | 2026-10-09 `q6sq7G` |
| N | ordinary (non-Mission) dock Form | dock reply 204, model saw the answer, no mark | 2026-10-09 `q6sq7G` |
| L | 34 background subagents in batches of six | 35-session family pending while one held child was active; completed 3.06 s after quiescence | 2026-10-11 `a39Z1n` |

L is not 4096-session stress qualification; the ceiling and above-ceiling
unknown coverage are unit-tested against the real SQL observation adapter.

## Remaining gaps

Tomorrow's real passage (offline e2e only), managed-service
restart, post-restart Check passage natively, native CAS-conflict/lost-reply
journeys, one-time (non-recurring) Wayfinder natively. The pruned-start case is
covered offline only (no native pruning trigger was used). An admission accepted
natively whose `recordAdmission` write is lost before a later prune remains
indistinguishable from never admitted.

## Reproduction and isolation

```powershell
npm run build:missions --workspace packages/server
node scripts/test-recurring-simple-native.mjs <absolute-existing-cli> [ordered subset of ABCDGELFWQN; default ABCD]
```

Journeys E/L/F/W/Q/N live in `scripts/recurring-simple-native/journeys.mjs`.
The fixture uses production recurrence CREATE/control/manual HTTP handlers,
WorkspaceManager ownership/deletion fences, the production automation bridge and
HMAC verification. A fixture-only authenticated cookie supplies the human identity;
this does not test browser login. `DesktopPluginLifecycle("missions")` provisions
the shipped bundle through native discovery in the isolated config. A hook-only
fixture plugin identifies deterministic provider turns; it does not execute tools,
write Mission reports or mutate schedules. The provider plays the model through
ordinary native tools only (read, `subagent`, background `shell`, `question`,
`mission_*`).

Each invocation copies the CLI to an independently created directory beneath
`<TEMP>/opencode/recurring-simple-native-*`, uses private
HOME/XDG/config/database/bridge roots and a loopback deterministic provider. Actual
`debug paths` outputs must remain inside that root. The native service is launched
as an owned `serve` process, authenticated, and its API PID must equal the spawned
PID before cleanup. No shared daemon discovery, registration, config, database,
installer, pattern kill or push occurs. Restart in B kills/relaunches only that
owned process; managed-service graceful restart is not qualified by this fixture.

No native clock fast-forward capability was found or used. Daily due clocks use
real UTC minute boundaries roughly 1–2 minutes ahead; every archive must appear
within 150 s of quiescence (`SETTLE = 150_000`). Each `qualification.json` holds
snapshots, runtime PIDs, provider call names, tool availability, exact
schedule/passage identities and read-only native start-message counts; its
database contains only fixture data.
