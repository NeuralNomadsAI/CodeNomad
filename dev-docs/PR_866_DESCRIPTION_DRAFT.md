# PR #866 description — draft (not published)

> Draft for `feat(missions): native project coordination, briefings and tracking`.
> Replace the current PR body only after review. Branch:
> `experiment/missions-simple-integration-20261009`.

## Summary

Missions turns a complex objective into coordinated native OpenCode work and keeps
the human view focused on five questions: what was requested, what is happening,
what needs a decision, what was produced and what comes next. OpenCode owns
execution; CodeNomad provides planning, explicit controls and reading.

Two execution modes share one panel, templates (Custom, Pocock, Wayfinder),
profiles and reader:

- **One-time Missions**: a coordinator declares tasks, dependencies and roles;
  OpenCode runs them as native subagents (default) or independent root sessions.
- **Recurring Missions**: permanent instructions run as finite daily passages
  inside the OpenCode service/plugin, with the CodeNomad UI and backend closed.

No OpenCode modification is required or included.

## What ships

- **Create**: template, objective, notes, coordinator/role profiles
  (agent/model/variant), task-session policy (`taskMode`), reusable brief-only
  library. Creation never starts work; Play is an explicit action.
- **Follow**: dated coordinator briefing, compact Work graph of declared
  dependencies, observed native conversation ancestry, plan history, and a
  central reader for long briefs/reports/evidence above the transcript.
- **Respond**: only genuine native Forms/permissions appear as attention; they
  open in the shared InterruptionDock.
- **Control (one-time)**: Play/Pause/Stop strip with per-target receipts,
  guidance and questions through ordinary admission, targeted recovery and
  optional specialist cleanup. Lost replies are reread, never replayed.
- **Recurring (simple contract, `dev-docs/MISSIONS_RECURRING_SIMPLE.md`)**:
  - One schedule document in project-scoped plugin kv with a custom revision CAS
    (native kv has none); create stores it **paused**.
  - Play/Pause/Stop/Resume/Run now/Check passage only through the authenticated
    UI/backend route → HMAC bridge → plugin RPC; never model tools. Each control
    has `requestID` idempotency and `expectedRevision` CAS.
  - One process-local native Job per running schedule sleeps until
    `min(nextDueAt, now + 1h)`; a native execution event wakes it after 3 s so
    archives follow quiescence. Latest missed civil day only; DST-safe.
  - Write-ahead pending passage (deterministic passage/session/message IDs)
    before any native effect; first-admission-wins message IDs.
  - Settlement only when coordinator and all descendants are inactive, inboxes
    empty, no pending Form/permission, no running Shell/background subagent.
    Outcomes: `completed` (final report), `failed` (business or native failure),
    `ended-without-report` (reason `interrupted` when a restart cut the turn).
    Watched cursors advance only on `completed`; history bounded to 30.
  - Service restart ⇒ schedule shows **Interrupted**; only explicit Resume
    re-arms it, and Resume is reconcile-only for a pending passage.
- **Wayfinder human gate (both modes)**: answering a Mission-family Form in the
  InterruptionDock records a two-phase UI mark (`pending` → `confirmed`). The gate
  accepts only a native Form with a confirmed UI mark; other answers reach the
  model as "Human decision required: answer from the CodeNomad interface".
  Non-Mission Forms keep the ordinary native reply and get no mark.
- **Desktop profile propagation**: Electron and Tauri pass the exact desktop
  profile (`CODENOMAD_UPDATE_CHANNEL`, `CODENOMAD_PROFILE_CONFIG_IDENTITY`, original
  `CLI_CONFIG`) to every backend spawn so recurring metadata and UI marks bind to
  the right profile.

## Security boundary (honest statement)

HMAC authenticates the ordinary desktop bridge; it is not an OS sandbox. An agent
with unrestricted shell under the same user can read the service password and kv
database and act with the service's privileges. Native shell permissions and OS
isolation are the real boundary. UI marks are provenance under that boundary, not
tamper-proof proof. Signed grants, epochs, effect budgets and per-effect receipts
were removed from recurring passages because they did not provide that boundary
and complicated restart reconciliation. Unknown external effects stay unknown;
nothing is exactly-once for arbitrary shell/tool side effects.

## Qualification

Native journeys run against an isolated read-copy of OpenCode **2.0.26**
(`scripts/test-recurring-simple-native.mjs`): private HOME/XDG/config/database,
owned `serve` process, loopback deterministic provider, production HTTP handlers,
WorkspaceManager fences and the shipped bundle via `DesktopPluginLifecycle`.

| Journey | Native | Result on this branch |
| --- | --- | --- |
| A daily work, backend closed | yes | completed, archive 3.05 s after quiescence, 1 start, nextDueAt = due + 24 h |
| B restart with pending → Resume | yes | `ended-without-report`/`interrupted`, 16 ms after Resume, same single start |
| C Run now ×2 + exact duplicate | yes | two completed passages; duplicate returns the same passage |
| D Pause → Stop | yes | no root session after due; Resume after Stop → 503 |
| Q Wayfinder UI vs ordinary answer | yes | UI: mark confirmed/ui, completed; ordinary: no mark, gate refusal, ended-without-report |
| N ordinary (non-Mission) dock Form | yes | ordinary native reply 204, model received the answer, no mark |
| E background child + shell, F provider failure, W watched cursors, G paused Run now | yes (previous run, same code paths) | see `MISSIONS_RECURRING_SIMPLE_QUALIFICATION.md` |
| Tomorrow's real passage | **offline only** | `recurring-day.e2e.test.ts` drives the real plugin/scheduler to the next civil day |
| Post-restart Check passage, CAS conflict, lost reply | **offline only** | covered by route/plugin tests |
| Pruned start message after recorded admission | **offline only** | settles by quiescence, never re-sent |
| One-time Wayfinder gate | **offline only** | Q covers recurring Wayfinder natively |

## Known limits

- **Managed-service restart is unqualified.** Restart was exercised only with an
  owned unmanaged `serve` and a hard kill; upstream sweeps orphaned execution
  claims only in the managed service at boot.
- **Narrow double-send window:** if native accepts the start message but the
  `recordAdmission` write is lost, and the message is later pruned before the
  next wake, the passage is indistinguishable from never admitted and the same
  IDs could be admitted again.
- Pause/Stop interrupt the registered root coordinator; they do not prove
  descendants stopped. Admission is not proof of model consumption.
- Unattended cold wake, missed-day backlog replay and automatic scheduler
  restoration are out of scope by design.

## Split out of this PR (local branches, not pushed)

- `experiment/host-lifetime-foundation-20261009` — persistent-backend
  foundation: `packages/native-host-lifetime`, server host-lifetime
  manager/backend/native runtime/Missions channel, durable host/plugin,
  host-authority store/registry, derived-call publication, native product
  admissions, startup/node-IPC probes and their docs. Never activated; parking
  commit, does not build on its own.
- `experiment/desktop-backend-bootstrap-20261009` — Electron/Tauri bootstrap
  cookie fencing across backend generations (independent desktop fix).
- `preserve/missions-full-20261009` — the full pre-cleanup branch, including
  native-subsession spikes, experiments and research readouts.

## Validation (merge with upstream `dev` 43165435)

- Typecheck: server, UI, Electron pass. `npm run build:missions` passes (bundle
  inputs unchanged by the scope cleanup).
- Server: `src/missions/**` 669/669; `src/opencode/missions/*.test.ts` incl.
  recurring-day e2e 102 pass, 1 skipped; `src/server/routes/*.test.ts` 313/313;
  host-lifetime/settings/auth/family-authority/opencode 302 pass, 6 skipped.
- UI browser (`--test-concurrency=1`): `mission-*`, `interruption-dock`,
  `permission-fallback-diff`, `provider-usage`, `git-history` all pass; tests
  that launch Electron could not run locally (no Electron binary installed).
- Electron `test:native`: 210 pass, 4 platform skips; Tauri
  `cargo check --offline --tests` passes, profile-propagation tests 4/4.
- Native smoke above; all owned fixture processes stopped, zero leftovers.

## Reference documents

- `dev-docs/MISSIONS.md` — product contract and one-time Missions.
- `dev-docs/MISSIONS_RECURRING_SIMPLE.md` — recurring contract.
- `dev-docs/MISSIONS_RECURRING_SIMPLE_QUALIFICATION.md` — native evidence.
- `dev-docs/MISSIONS_REFACTOR_VALIDATION.md` — validation ledger (historical).
