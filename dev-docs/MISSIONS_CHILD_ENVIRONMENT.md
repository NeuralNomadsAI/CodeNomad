# Missions: native foreground child environment qualification

Measured on Windows, 2026-10-02, with the assigned **OpenCode 2.0.21** executable.
This is a private capability fixture, **not product foreground enablement** and
not independent approval of the durable Missions implementation.

## Outcome (baseline plus explicit admission seam)

**Blocked: foreground children do not inherit CodeNomad's cleaned, per-parent
profile environment in the measured runtime.** The owned backend route correctly
updates the roots, but native child shells use the private daemon's startup
snapshot. Continuing the same child after a complete profile replacement does
not repair this; creating a new child does not repair it either **without an
explicit child write**. This baseline remains `nativeInheritance: false`.

**Positive private seam proof:** awaiting the existing authorized backend's real
`session.environment` write from structured native progress, before forwarding
that progress, installs a fresh complete child profile. The first native child
model's selected shell uses it; a later real HTTP `session.shell` agrees. The
original foreground executor does not overwrite that explicit snapshot in the
tested new-child/continuation rounds. This is `explicitAdmission: true`, **not**
native inheritance being fixed and **not** product enablement.

Structured correlation, bounded foreground completion, inherited shell denial,
native agent/model selection and depth-one interruption are positive capabilities.
They do not compensate for the environment blocker or qualify durable Pause/Stop.
Independent root actors remain a separate product mode.

## Deliverables and command

- `scripts/test-missions-child-environment.mjs`: bounded native scenarios/artifacts.
- `scripts/missions-child-environment/runtime.mjs`: private directories and owned
  serve processes, with an independent private sentinel.
- `backend.mjs`: actual `WorkspaceManager`, owned instance proxy, private settings
  reader, real `AuthManager` and private bridge/presence lifecycle.
- `admission.mjs`: narrow authenticated identity-only child admission route,
  composing the existing backend primitives without changing product routes.
- `seam-scenarios.mjs`: explicit snapshot and negative admission measurements.
- `plugin.mjs` / `schema.mjs`: private transform and narrow contract/evidence RPC.
- `provider.mjs`: composition of the existing deterministic SSE provider.

```powershell
node scripts/test-missions-child-environment.mjs
```

Only this CLI is accepted, and only `serve` is launched:

```text
C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe
```

The final recorded run exited **0** with eleven capability checks and the baseline
environment blocker. Exit 0 means the measurements/assertions completed, not that
foreground Missions is qualified: `qualified` and
`environmentInheritanceQualified` are both **false** in `results.json`.
`explicitAdmission` is **true**; `signedLifecycleQualified` and
`productForegroundEnabled` remain **false**.

Artifact directory:

```text
C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-Bi0RHK
```

It contains `results.json`, `contracts.json`, `profiles.json`, `requests.json`,
`events.json`, `transcripts.json`, `openapi.json`, `serve.log`, and safe shell
probe JSON files under `project/`, plus `admission-trace.json` with sanitized
write/denial/observation receipts. Counts in `results.json` are observational,
not assertions: the recorded run has 23 roots, 89 provider requests, 1083 events,
30 registered invocation contracts and 44 fresh settings reads.
The private sentinel survived cleanup of the main fixture, then its own captured
process was stopped. Recorded read-only product/old-spike hashes were unchanged.
Both resource-cleanup receipts were fulfilled. `node --check` passed for the
six original modules and the two focused seam helpers. All owned files remain
below 500 lines.

Final capability flags:

```json
{
  "nativeInheritance": false,
  "explicitAdmission": true,
  "explicit.firstModelEnvironment": true,
  "explicit.failClosedBeforeModel": true,
  "signedLifecycleQualified": false,
  "productForegroundEnabled": false,
  "qualified": false
}
```

The two `explicit.*` labels above refer to fields inside `results.json`'s
`explicit` object. The denial flag concerns the denied invocation's model
request, not unrelated historical/move rounds or arbitrary native shell APIs.

## Environment experiment

The root sends go through the real canonical owned route:

```text
private settings file -> freshSettings.readEnvironmentForAdmission
  -> WorkspaceManager -> registerInstanceProxyRoutes
  -> native session.environment -> native session.prompt
```

There is no direct-prompt fallback if the route cannot admit a send. Each send
asserts a fresh private settings read. The lifecycle adapter returns only the
already-launched, authenticated private endpoint; it never discovers or starts
the user daemon. This is not qualification of the production service starter.

Parent A's first provider response is held after the A1 snapshot is admitted.
The complete profile changes to B1, and parent B is admitted and held separately.
Both responses are released; both native children reach a held first provider
request simultaneously. Editing settings to A2 does not itself write any session
environment. Each child model deliberately selects the native `shell` tool to
run a bounded Node probe. A subsequent real `session.shell` call on that child
must produce the same snapshot. Neither path prompts the child from the fixture.

Root diagnostic `session.shell` calls deliberately use the private native client,
**after** owned prompt admission: sending these diagnostics through the backend
proxy would install the now-current profile and obscure the original snapshot.
The **baseline phase** makes no child `session.environment` call. The subsequent
explicit phase intentionally makes one actual write per successfully admitted
native invocation (and reapplies on a new continuation call).

| Session / round | Marker | Retired key | Profile PATH entries | DB / state / server-password presence |
|---|---|---|---|---|
| Root A, first admission | `A1` | `only-A1` | A1 only | false / false / false |
| Root B, separate admission | `B1` | `only-B1` | B1 only | false / false / false |
| Concurrent child A | `base` | absent | none | true / true / true |
| Concurrent child B | `base` | absent | none | true / true / true |
| Root A after complete replacement | `A2` | absent | A2 only | false / false / false |
| Same child A, continuation | `base` | absent | none | true / true / true |
| New child A after replacement | `base` | absent | none | true / true / true |

`base` is the deliberate **private** daemon startup marker. Child DB/state/auth
presence refers to private fixture variables, never user database/credentials.
The probe writes booleans only for `OPENCODE_DB`, `XDG_STATE_HOME`,
`OPENCODE_SERVER_PASSWORD`, bridge-token and bootstrap-token presence. It never
reads or prints their values. Bridge/bootstrap presence was false throughout.
PowerShell prepends its own directory to PATH; the fixture therefore verifies
profile-bin membership, not first-position equality. PATH remains usable.

These results show neither new nor old **parent-profile** inheritance. They show
startup-snapshot behavior for the tested child creation/continuation paths.
They do not establish per-inbox environment isolation or behavior on other OSes.

## Explicit child admission: actual backend seam

The private plugin receives a construction-time seed file containing the private
route/cookie and the fixture's original absolute deadline, never profile values.
The route uses an enabled, real `AuthManager` session cookie and loopback check;
there is no auth-disabled mode or second product auth store. A missing cookie is
rejected with 403. All backend/auth files remain in this fixture's private root.

The plugin sends **only** these identities to `/observe` and `/admit`:

```text
parentID, callID, native childID, actual rootRequestID,
executionID, taskKey, contractRequestID
```

It sends no profile selector, variables, environment body, executable, blob or
grant flags. Extra fields and unregistered calls are denied; responses contain
only observation/admission acknowledgements or a generic error. SDK failure
bodies are neither logged nor returned to the plugin. The trace records field
names, identities and safe operation labels, not environment values.

The backend registry is seeded by the fixture controller, not the model. It pins
the parent, its native connection/project/exact location, immutable invocation
tuple and an approved server-side profile file. The same `freshSettings` reader
and `WorkspaceManager.getSessionEnvironment` build the complete execution-host
snapshot; `AsyncLocalStorage` selects the approved per-parent file server-side.
The native child IDs are not pre-created or invented by the backend.

At native progress, the plugin persists the immutable observed binding. The
backend reads that **private fixture binding**, the actual native parent and
child, the accepted root message, and the native assistant's running `subagent`
tool part with the matching CallID. It verifies direct parentage, same project,
exact owned locations, child execution selection and the pinned connection.
Bounded native message reads are limited to 100 messages; unknown observations
deny admission. In the measured progress window, the parent's HTTP tool metadata
does **not yet contain `sessionID`** (`metadataPublished: false`). The fallback is
therefore the immutable binding observed by the trusted, construction-seeded
plugin lifecycle, corroborated by the native running tool part. This is explicit
fixture trust, **not product signing or native attestation**.

The backend enters the **same actual deletion fence** used by the instance proxy,
reads fresh settings, rechecks identities/lifecycle/connection, and awaits:

```text
connection.client.session.environment({ sessionID: nativeChildID, variables })
```

There is no exported product `applySessionEnvironment` helper in this checkout;
the fixture composes the existing manager snapshot plus actual native API exactly
as the current session-send route does. It does not route a child through the
root-only mission admission validator or weaken that validator.
After the write, all identities and the fixture generation are rechecked. Only
then is the acknowledgement returned and original native progress forwarded.
The original native tool, prompt/default foreground behavior and permissions
remain in use. No extra child prompt is sent. The private child context guard
also requires a matching completed admission receipt before a model request.

One invocation is single-attempt, including failure: no automatic mutation replay.
A local in-flight child-writer exclusion protects this fixture's route only; it
is **not** native/public API writer ownership. Native policy/transport errors and
unknown state fail closed without another contract, setter or fallback.
The plugin carries the original tool signal into both HTTP calls and combines it
with the original absolute fixture deadline. The backend uses that same deadline,
request-disconnect cancellation and actual fixture-lifecycle abort signals for
settings/native calls. It neither restarts nor extends the daemon lifetime.

### Measured explicit snapshots

| Session / round | Marker | Retired key | Profile PATH | DB / state / password |
|---|---|---|---|---|
| Root A, already admitted before settings change | `A1` | `only-A1` | A1 | false / false / false |
| Child A, fresh child admission after change | `A2` | absent | A2 | false / false / false |
| Simultaneously active child B, separate approved profile | `B1` | `only-B1` | B1 | false / false / false |
| Same child A, explicit continuation with changed profile | `A1` | `next-round-only` | A1 | false / false / false |
| New child A, next complete replacement | `A2` | absent | A2 | false / false / false |

First-model native tool probes and HTTP child shell probes agree. Editing profile
A alone while the children are held in their first provider requests causes no
environment writes and does not change either existing child snapshot. No stale
root inheritance is expected: **child admission** is the fresh-read boundary.
Inherited shell denial still removes `shell` from the explicitly admitted child's
first model tool catalog. No permission is relaxed to obtain a probe.

### Negative admission results and precise limits

- **Actual environment API rejection:** delete one specifically bound, newly born
  private child at dispatch, then call the real native setter on that same ID.
  The native daemon logs `PUT .../environment` with HTTP **404**. The wrapper fails
  before any child provider request. This is not a stubbed SDK rejection; the
  removed child is marked explicitly in the transcript artifact.
- **Deletion fence:** hold a root provider response, block the real worktree
  mutation fence, then release the root. The born child receives no environment
  write/model request. After the block ends, only an explicitly requested **new
  native subagent call** creates/adopts a new admission; no automatic retry occurs.
- **Scope / identity / connection:** missing or changed approved profile scope,
  unknown root/call correlation, real private backend connection invalidation and
  an actually moved historical child deny admission without an environment write.
  The moved child's previous successful outcome is not mistaken for active state
  or root-only authority. Native move is asynchronous; the fixture waits for the
  actual location change before attempting continuation. Native move itself
  produced an additional old-call model round in the recorded run; the denied
  `moved_child` invocation produced **none**. No per-inbox/no-effect promise is
  inferred from this historical-child experiment. A move attempted while progress
  was held queued rather than settling: no post-write concurrent-move proof is
  claimed from that attempt.
- **Late connection / revoke / disposal:** hold the admission's awaited settlement after the
  **real native write has succeeded**, but before acknowledgement/progress return.
  Invalidating the actual private connection, changing the fixture generation,
  or disposing the actual private backend aborts
  the held admission. The cleaned child snapshot exists, yet no child provider
  request occurs for that denied call. These probes fence late acknowledgements;
  they do not demonstrate revocation inside the native write transaction itself.
  Diagnostic HTTP shells can still read those cleaned snapshots: denial does not
  revoke arbitrary public native APIs, guarantee no execution at all, or prove
  model consumption.
- **Detach:** removing the real private bridge/presence/backend before a child's
  gate denies its first model request. Removing them after completed admission
  leaves the already-running foreground child free to finish with its cleaned
  snapshot; it does not interrupt or stop the main/user service.

All these are fixture-specific environmental boundary measurements. The static
registry/lifecycle generations are not substitute signed durable grants.

## Structured binding and native policies

The private `authorize` RPC only records an immutable invocation tuple. Its name
does **not** signify a signed Missions grant, approval, task dispatcher or native
execution claim. `executionID`, `taskKey` and `contractRequestID` are private
contract identifiers; the fixture does not invent an upstream execution-ID field.
`rootRequestID` is the actual accepted native root message ID. The prompt hook
checks that identity; the wrapper checks the exact parent/CallID mapping and
request identity before calling the original foreground executor.

The transform changes only `subagent.execute`, preserving all other definition
fields by reference, including native options, schema and permission behavior.
Model-visible subagent schemas are also compared across rounds. `background` is
omitted for normal calls, exercising the native foreground default; true is
explicitly excluded. There is no invented `session.create({ parentID })` API.

The wrapper awaits **native `progress({ sessionID, ... })`**, fetches that native
session and checks its real `parentID`. It persists the immutable CallID binding
before forwarding progress back to the native executor. The child context hook
rejects missing/mismatched bindings. The first child provider request contains
the exact binding, corroborated by its structured request header and the parent's
native tool-result `metadata.sessionID`. Human-readable result text is never
parsed to discover an ID. No extra child prompt precedes binding.

The binding adds the actual native assistant message ID and selected agent/model.
Continuation records a new call/request binding for the **same** child ID while
preserving its parent, execution/task/contract owner. The measured tests reject:

- missing invocation records and mismatched root request IDs;
- immutable invocation substitution and a different task contract;
- continuation from another parent, without another child provider request;
- a primary-only agent and a natively denied subagent agent;
- a model variant absent from the native catalog.

The native catalog supplies the explicit model/variant selection. The default
child selects `fixture/child`; an explicit valid override selects
`fixture/fixture#low` on the same `fixture_child` agent in the recorded run.
This is native selection, not a fake approval or fabricated agent ID.
Shell denial inherited from the parent removes `shell` from that child's **first**
model tool catalog; the wrapper does not relax permissions to run a probe there.

Private storage is separate from Missions journals/authority. No legacy or fresh
Missions journal is imported, migrated, adopted or deleted by fixture code.
This result does not qualify the fresh-generation storage implementation.

## Foreground interrupt, detach and disposal

- A child is held in its actual first provider request. Calling native
  `session.interrupt({ sessionID: parent, resume: false })` settles the parent and
  the depth-one child with historical outcome `interrupted`; the child is also
  absent from `session.active`. A historical outcome alone is not an active-state
  check. No recursive descendant cancellation is claimed.
- While another bound foreground child is active, the actual private bridge
  manifest/server and Missions presence are removed. The child remains active,
  then completes its shell probe and settles successfully; the parent settles
  successfully too. There is no newly admitted mission task during detach.
- A separately captured wrapper call is held at the root provider. Actual
  transformation disposal sets its lifecycle fence and removes the transform.
  Releasing that previously captured call fails without a child binding.
  Before/after-await active/signal checks are fixture lifecycle proof only, not
  durable authority or a replacement for actual Pause/Stop generations.

Background mode is not adopted or tested here. The late native background
notification/wakeup behavior from `MISSIONS_CONTINUITY_SPIKE.md` remains a known
excluded concern; foreground measurements do not clear it.

## Unqualified gates and isolation limits

**Skipped as unqualified:** actual signed durable two-generation Pause/Stop
fencing before child environment admission. The installed plugin SessionDomain
has no environment setter, **but the authenticated HTTP backend seam is now
measured positive**. The earlier lack-of-setter observation is not an unsupported
capability conclusion. Structured progress plus explicit environment admission
still does not prove atomic signed native environment/control admission.
No fixture generation or boolean grant stands in for the durable gate.

No product hooks/control/journal/authority code, old spike or native-owner script
is edited. No UI, product flag, dispatch engine, recursive control, durable signed
authority, host-job/API ownership, family exclusion, old-writer quiescence,
reattachment, crash/restart race or platform parity is qualified. Source hashes,
the cleanup sentinel and namespace separation are not native ownership gates;
CNG/source-fence experiments from other fixtures are not relevant evidence here.

All HOME/config/DB/provider state and the Git-initialized unborn project are
private temporary directories. The current fixture makes no commits, installs,
updates, publications or pushes. The three-minute serve watchdogs and cleanup
target only captured fixture process handles, never a global process name/PID
search or user service. The independent sentinel has separate config/DB state.
No shared app/session/config/storage/service operations are performed.

**Product decision: keep native foreground Missions disabled.** The explicit
environmental seam is meaningful primitive-level progress, not signed lifecycle
or native-gate qualification. A genuine signed authority/lifecycle integration,
writer exclusion and independent qualification remain separate future work;
root-mode behavior is not changed by this measurement.
