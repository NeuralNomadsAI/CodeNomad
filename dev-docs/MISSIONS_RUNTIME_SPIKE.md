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

## Intentional boundary

Missions remain project-local. CodeNomad does not silently install executable code into arbitrary repositories or global OpenCode configuration. A project without the reviewed definition receives the explicit optional-capability response and otherwise continues normally.
