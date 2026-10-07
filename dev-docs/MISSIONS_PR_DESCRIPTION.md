# Missions

## Overview

This PR adds a native-first Missions workspace for coordinating multi-agent work
through OpenCode. It combines mission creation, delegation, progress tracking,
human controls, durable results, and recurring-work foundations in one compact UI.

## What is included

### Mission workflow

- Custom, Pocock, and Wayfinder mission templates.
- Explicit coordinator and per-role agent, model, and variant selection.
- Native OpenCode subagents by default, with independent task sessions available
  per Mission.
- Prepared creation followed by explicit **Play**.
- Stable task generations, conversation identities, and reusable briefs.

### Tracking and controls

- Real Forms and permissions surfaced as actionable attention items.
- Coordinator briefings, compact task rows, and dependency graphs.
- Full reports, evidence, briefs, and history in the central reader.
- Exact observed conversation ancestry, separate from task dependencies.
- **Play / Pause / Stop**, guidance, questions, targeted recovery, and optional
  managed-session cleanup.

### Preferences and UX

- Mission preferences live inside the Missions panel.
- Unsaved drafts retain their original compare-and-swap expectation.
- Global defaults, task-session policy, and Location-scoped OpenCode depth remain
  independent settings.
- Responsive layouts support narrow panels, touch, RTL, empty states, and long
  results without duplicating technical content in the panel.

### Durable and recurring work

- Timezone-aware schedules, manual runs, stable passage identities, bounded
  catch-up, and single-passage admission.
- Signed standing authority with finite child grants and effect receipts.
- Durable passage journals, terminal settlement, and immutable archives.
- Native creation preparation using the existing ownership, profile, environment,
  and admission policies.
- Protected writer, family, checkpoint, and managed-incarnation guards.
- Native Job admission and process-bound lifetime through OpenCode.

## Current validation

| Scope | Result |
| --- | --- |
| Server | **2,370 passed / 0 failed / 8 skipped** |
| Browser | **761 passed / 1 failed / 2 skipped** |
| Browser inputs | **2,162 unchanged** |
| Native Job | Start, running acknowledgement, interruption, inactive execution, and retained root claim observed |

The remaining browser failure is an InterruptionDock fixture startup timeout before
the test assertions.

## Main areas

- `packages/server/src/missions/`
- `packages/server/src/opencode/missions/`
- `packages/server/src/server/routes/mission-*`
- `packages/ui/src/components/mission-*`
- `packages/ui/src/styles/panels/mission-*.css`

Detailed validation evidence is kept in
[`MISSIONS_REFACTOR_VALIDATION.md`](MISSIONS_REFACTOR_VALIDATION.md).

PR #866 remains open and unmerged.
