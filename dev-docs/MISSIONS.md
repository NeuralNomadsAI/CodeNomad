# CodeNomad Missions / Session Mesh

Missions are a thin coordination plane over native OpenCode V2 sessions. They intentionally do not provide a YAML workflow language, general interpreter, scheduler, or hidden worker runtime.

## Ownership

| Concern | Owner |
| --- | --- |
| Root sessions, prompts, durable inbox, execution, Forms, permissions | OpenCode V2 |
| Mission map and role context | Bundled `codenomad.missions` plugin; project-scoped native storage |
| Workspace/location authorization and browser access | CodeNomad |
| Checkout isolation and Git policy | Existing CodeNomad worktree/Git modules |
| Developer feedback | Separate `codenomad.automation` plugin and its visible-session fence |

The plugin exposes only `mission.inspect`, `mission.delegate`, and `mission.report`. The coordinator is the sole topology writer. Specialists receive one bounded assignment and report through a correlated synthetic inbox item. Delegation uses native `queue` delivery and `resume: true`, so a busy actor keeps the work in its durable inbox while an idle actor can begin immediately.

## Durability and recovery

The map is an append-only event journal in native plugin storage. Events have deterministic identities, and native prompt/synthetic admissions use deterministic message IDs. Retrying after a plugin or CodeNomad restart therefore resumes an incomplete dispatch without creating a second task, actor, or inbox item.

Snapshots are authoritative reconstructions of the journal. RPC events are only invalidations; the UI always reloads a snapshot after reconnect because native event subscriptions are live-only.

## Native execution selection (2.0.11)

`mission.inspect({ catalog: true })` reads the caller location's native agent/model catalog. `mission.delegate` accepts an optional `execution` selection, independent of its mission `role`:

```json
{
  "taskKey": "review-spec",
  "title": "Review acceptance criteria",
  "brief": "Compare the diff with the requirements and report evidence.",
  "role": "review-spec",
  "execution": {
    "agent": "reviewer",
    "model": { "providerID": "provider-from-catalog", "id": "model-from-catalog", "variant": "variant-from-catalog" }
  }
}
```

Use actual catalog IDs. New actors support visible `primary`/`all` agents and enabled tool-capable models. Explicit selections are persisted in the task contract and passed to native `session.create`; retries cannot replace them. Omitted fields retain native defaults, so specify both agent and model for a fully pinned assignment. The UI displays these native identifiers beside the role.

An existing actor must already match the requested selection. Missions never uses `switchAgent`/`switchModel` to repurpose a busy actor: those APIs alter subsequent turns, not a single queued assignment. Native queues do not freeze a per-assignment model; external client changes after admission remain possible.

Durable actors remain root sessions. `session.create` does not expose child creation, and subagent-only profiles belong to the native `subagent` tool. Use native subagents for bounded child work, not as durable mission-map actors. Root actors use native agent/project permission rules; they do not inherit a coordinator's child-session permission state.

## Distribution and environment

Desktop backends provision the content-addressed Missions bundle through `DesktopPluginLifecycle`, using the authenticated daemon's `config.get` discovery root. Backend leases live outside that watched root. Tools, context hooks and the sole typed snapshot RPC follow backend presence. No files are installed in the user's project. The old repository-local plugin entry is removed; `.opencode/checks/` still checks the published V2 plugin contract.

Assignment prompts and report synthetics use a narrow authenticated loopback bridge mode. The owning backend reconciles the persisted task/report via `codenomad.missions.snapshot`, validates complete native session ownership and selection, acquires the worktree mutation fence, and applies the current full profile environment before admission. Native environment errors are redacted and fail closed. No environment data travels through the UI or plugin. Multiple owning backends are rejected rather than choosing a profile arbitrarily.

This transport reuses desktop bridge discovery, not browser automation or its visible-window operations. Automation still has its independent execution-time session/window fences. Environment and model state are session-scoped, not atomic per-inbox-item snapshots; see [SESSION_ENVIRONMENT.md](SESSION_ENVIRONMENT.md).

## Safety limits

- One native project per mission.
- Root sessions only; child sessions and foreign projects are rejected.
- At most 8 actors, 96 tasks, 20 missions, and 2,000 stored events in one project view.
- Existing root actors may be reused, but an actor cannot join two active missions.
- Dependency tasks are mapped as blocked and are never auto-dispatched.
- Completing a mission green requires every task to have a completed report.

## Included playbooks

- **Pocock Bug Expedition** preserves evidence-first diagnosis, behavioral TDD, independent fresh Standards and Spec reviews, implementer-session resolution, and a fresh read-only green gate. Completed role reports carry validated structured artifacts, while the coordinator still chooses each transition; no fixed state machine was ported.
- **Wayfinder Map** adapts destination, map, frontier, claims, and fog-of-war planning to visible sessions. It remains planning-first and uses native Forms for human decisions.

## Validation

Build the shipped plugin with `npm run build:missions --workspace @neuralnomads/codenomad`, then run `node scripts/test-missions-native.mjs <absolute-opencode-executable>`. The fixture uses isolated configuration/storage, the real bundled plugin, typed RPC, WorkspaceManager and bridge, plus a local deterministic provider. It verifies catalog selection, variant persistence, a busy actor's durable queue, mismatched selection refusal, per-send actor/coordinator environment, presence removal/re-registration, and retry idempotence. No shared service or user provider is used. The fixture passed on Windows with CLI/client/plugin 2.0.11 on 2026-09-20.

The native runtime findings and recovery matrix are recorded in [`MISSIONS_RUNTIME_SPIKE.md`](MISSIONS_RUNTIME_SPIKE.md).
