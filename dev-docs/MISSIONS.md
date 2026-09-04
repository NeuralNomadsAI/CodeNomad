# CodeNomad Missions / Session Mesh

Missions are a thin coordination plane over native OpenCode V2 sessions. They intentionally do not provide a YAML workflow language, general interpreter, scheduler, or hidden worker runtime.

## Ownership

| Concern | Owner |
| --- | --- |
| Root sessions, prompts, durable inbox, execution, Forms, permissions | OpenCode V2 |
| Mission map and role context | Project-local `codenomad.missions` plugin |
| Workspace/location authorization and browser access | CodeNomad |
| Checkout isolation and Git policy | Existing CodeNomad worktree/Git modules |
| Developer feedback | Separate `codenomad.automation` plugin and its visible-session fence |

The plugin exposes only `mission.inspect`, `mission.delegate`, and `mission.report`. The coordinator is the sole topology writer. Specialists receive one bounded assignment and report through a correlated synthetic inbox item. Delegation uses native `queue` delivery and `resume: true`, so a busy actor keeps the work in its durable inbox while an idle actor can begin immediately.

## Durability and recovery

The map is an append-only event journal in native plugin storage. Events have deterministic identities, and native prompt/synthetic admissions use deterministic message IDs. Retrying after a plugin or CodeNomad restart therefore resumes an incomplete dispatch without creating a second task, actor, or inbox item.

Snapshots are authoritative reconstructions of the journal. RPC events are only invalidations; the UI always reloads a snapshot after reconnect because native event subscriptions are live-only.

## Safety limits

- One native project per mission.
- Root sessions only; child sessions and foreign projects are rejected.
- At most 8 actors, 96 tasks, and 2,000 stored events in one project view.
- Existing root actors may be reused, but an actor cannot join two active missions.
- Dependency tasks are mapped as blocked and are never auto-dispatched.
- Completing a mission green requires every task to have a completed report.

## Included playbooks

- **Pocock Bug Expedition** preserves evidence-first diagnosis, behavioral TDD, independent Standards and Spec reviews, resolution, and a read-only green gate. The coordinator chooses each transition from reports; no fixed state machine was ported.
- **Wayfinder Map** adapts destination, map, frontier, claims, and fog-of-war planning to visible sessions. It remains planning-first and uses native Forms for human decisions.

The project-local entrypoint is `.opencode/plugins/codenomad-missions.ts`. `.opencode/package.json` pins the V2 plugin contract to the same `beta-18999` snapshot used by the CodeNomad client. Projects without that reviewed plugin remain fully functional; Mission Control reports the capability as unavailable.
