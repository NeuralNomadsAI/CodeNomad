# Event relay ownership and discovery isolation

## Failure and scope

PR #835 fixed duplicate connection notifications clearing Usage snapshots. It
did not fix real `Instance event relay routing timed out` disconnects.

Existing passive diagnostics captured ownership waiting on
`WorkspaceManager.getWorktrees -> WorktreeInventory.read/load -> native POST
/api/worktree/refresh`. One captured refresh was still pending after 150,964 ms;
another completed in approximately 220 seconds. These waits exceed the relay's
unchanged 60-second retained-job budget. A recipient timeout fails the shared
subscription, reconnects and correctly invalidates Usage for all projects.

The native refresh's internal delay is not identified by these observations.
This fix removes that unnecessary discovery dependency from CodeNomad routing;
it does not claim to repair native strategy execution or every possible network
stall. Compaction and the separate window-resizing report are not reproduction
requirements or established causes of this failure.

## Boundary

- Display reads, request authorization and explicit worktree operations retain
  native strategy refresh, discovery of agent-created Git worktrees, fresh family
  validation and their existing read-your-writes behavior.
- Event authorization reads **native registered worktrees without refresh** in
  its own `WorktreeInventory`. An unresolved discovery scan cannot block it or
  supply stale ownership. Native event locations are registered by OpenCode;
  isolated real-runtime coverage checks this without an initial refresh.
- The catalogue implementation remains shared: authenticated native project and
  checkout checks, physical Git common-directory identity, Git registration,
  effective configured checkout roots, nested folder projection and WSL host
  translation are unchanged. A shared project ID never grants clone membership.
- Directory caches are separated by the event namespace. Both inventories and
  both directory-cache namespaces are invalidated by native worktree changes and
  local mutation fences, and forgotten at workspace disposal. A changed ordinary
  discovery snapshot also invalidates the event snapshot.
- FIFO lanes, ownership-revision retries, workspace epochs, connection fences,
  retained-byte/job budgets and the 60-second watchdog remain intact. Unknown
  or revoked registrations fail closed; routing never starts strategy discovery
  as a fallback. Legacy full-location validation retains its native identity
  check and now receives the current attempt's abort signal.

## Reproduction and validation

`instance-event-ownership.test.ts` uses the production manager and bridge with
real temporary Git checkouts. It holds a native discovery refresh unresolved and
requires a linked-worktree delta to publish before that refresh is released.
The test failed on the baseline and passes with registered-only event ownership.
Its harness deadline is not a changed product timeout.

Additional assertions cover independent clones sharing a native project ID,
nested openings, junction/symlink aliases, registration removal/re-addition,
blocking invalidation, ordinary discovery and stopped-workspace authorization.
Existing relay tests cover FIFO, full legacy locations, session moves/deletions,
native/local invalidation, reconnect/shutdown, backlog failure and recovery.

`scripts/test-opencode-location-native.mjs <absolute CLI executable>` starts its
own authenticated daemon and isolated config/database. Its worktree fixture
checks real pre-refresh native registration, then holds only the fixture
manager's discovery call while real native session rename events must route in
order. The user's daemon, application and settings are never changed.
