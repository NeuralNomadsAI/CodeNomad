# Missions native V2 runtime spike

Validated on Windows with the OpenCode client, plugin package, and private runtime all at `0.0.0-beta-18999`. The spike used an isolated temporary Git project and a private `opencode2 serve` process; it did not restart or mutate the shared daemon used by active CodeNomad sessions.

## Proven contracts

- A fresh location activated the project-local `codenomad.missions` definition and served its typed `snapshot` RPC. The runtime entrypoint itself required no `.opencode/node_modules`; the pinned plugin package is compile-time-only.
- A root coordinator started a mission through `mission.inspect`. After the private server was stopped and started again, the same journal reconstructed the mission at the same ID and revision.
- A second root session was deliberately kept in `running` state. `mission.delegate` admitted its assignment with native `delivery: "queue"` and `resume: true`; the assignment remained in the native inbox while that actor was busy.
- The actor consumed exactly one correlated assignment, called `mission.report`, and returned exactly one correlated synthetic report to the coordinator. Both sessions had no `parentID`.
- Repeating the exact delegation after completion left the mission revision, task count, report count, and correlated assignment count unchanged.
- Both the raw V2 event stream and `client.rpc(CODENOMAD_MISSIONS_RPC).events.subscribe("changed")` delivered `rpc.codenomad.missions.changed`. The event revision matched the authoritative snapshot loaded afterward.
- A Git worktree resolved to the same native project ID and canonical root as its main checkout. Plugin storage exposed the same ordered mission IDs from both locations.
- The CodeNomad broker returned the live snapshot for an owned workspace location and ignored a request-controlled `directory` query. No generic RPC endpoint was registered.

## Runtime corrections found by the spike

1. Optional snapshot properties must be omitted rather than returned as JavaScript `undefined`, because V2 validates registered RPC output against the portable schema. The handler now JSON-normalizes the snapshot before returning it.
2. Native context hooks accept system parts shaped as `{ type: "text", text }`. The role hook now uses that exact contract, and the project-local contract check compiles the setup function against the installed plugin context.
3. Local plugins that register an RPC advertise `features.server` but do not currently add `features.rpc`. The broker therefore checks the reviewed plugin ID and active state, then treats the typed RPC call and output validation as the capability test.
4. Adding a new plugin file after a Windows location is already activated can leave that one runtime instance with a failed mtime-qualified dynamic import. Fresh location activation and normal process restart both load the file. Released checkouts contain the entry before activation; development validation should use a private server or restart only the explicitly owned host.
5. Optional location fields must also be omitted, not materialized as `workspaceID: undefined`. A live managed-root dispatch exposed this at native session creation; the journal parser now preserves omission, and the same durable `dispatching` intent resumed successfully after the private server restarted.

## Live playbook demonstrations

The same private `beta-18999` runtime executed both playbooks with real model turns and project-local tools on 2026-09-04.

### Pocock bug expedition

- Mission `msn_f33707edc1860e538dc62ba4` started from a committed two-test Node fixture whose cross-workspace cache-key check was red.
- The diagnostician proved that `workspaceID` was ignored and returned a structured `diagnosis` artifact without edits.
- A fresh implementer changed only the key composition, recorded the focused regression red then green, and returned a structured `fix` artifact.
- Fresh standards and specification reviewers ran independently over the same unstaged diff; both returned their own axis-specific `review` artifact and no findings.
- The `resolver` assignment reused the implementer root exactly, preserved the reviewed diff, and returned a `resolution` artifact.
- A fresh validator ran the configured typecheck, lint, test, build, and focused regression commands. Its source-file hash was unchanged before and after the read-only assignment, and its `validation` artifact was green.
- The completed map reached revision 32 with all six tasks completed, six visible root actors, no child sessions, and no commit or publication.

### Wayfinder map

- Mission `msn_776b9bc7662fc5ff1d7ffc27` named a planning-only destination and retained unresolved reconnect/ownership questions as fog in mission notes.
- Two independent research roots claimed `event-semantics` and `ownership-boundary`. At revision 8, both were queued, `choose-route` was blocked, the two research keys were claims, and the frontier was empty.
- After both reports, revision 12 had no claims and derived `choose-route` as the sole frontier task.
- A fresh decision root selected one allowlisted typed snapshot broker with typed events as invalidation-only hints, server-owned location binding, reconnect reload, generation fencing, and stale-last-good error behavior. Polling and a generic RPC proxy were explicitly rejected.
- The completed map reached revision 17 with all three tasks completed, four visible root actors, empty claims/frontier, and a clean Git fixture. No implementation was performed.

## Intentional boundary

Missions remain project-local. CodeNomad does not silently install executable code into arbitrary repositories or global OpenCode configuration. A project without the reviewed definition receives the explicit optional-capability response and otherwise continues normally.
