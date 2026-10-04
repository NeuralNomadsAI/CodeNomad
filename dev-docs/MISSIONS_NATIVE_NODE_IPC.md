# HostLifetime native runtime Job + real Node IPC

## Implemented decision, and qualification boundary

**The contained-manager topology is implemented and its combined private proof
passes.** The earlier BLOCKED conclusion applied to a different topology: manager
outside the backend Job, Rust-created backend, and unsupported external adoption
of Node's IPC channel. That topology remains available as `ManagerSession`; none
of its proof requirements or outside-Job checks have been weakened.

The new, separately named **`RuntimeSession`** uses this simpler topology:

```text
trusted native desktop broker
  -> independently launched native supervisor S  [outside ALL Jobs]
       -> Node HostLifetime manager M             [created SUSPENDED]
            assigned to S's sole restrictive runtime Job BEFORE resume
            -> unchanged Node.spawn backend B    [inherits runtime Job at creation]
                 -> descendants                  [inherit, including detached Node]

S watches the retained exact M process handle; M death closes the sole Job handle
M <-> B uses Node's real existing IPC and stdio channels, without adoption/shims
authorized official service execution belongs to S/outside broker, NEVER M.spawn
```

**Only the owned nested-Job proof is qualified here.** This execution host's
restrictive parent still prevents positive independent supervisor launch. Public
RuntimeSession construction requires a real `OwnerBootstrap`, revalidates S outside
all Jobs, and checks newly created M outside all Jobs while still suspended before
assignment. The lower-level fixture never constructs that proof or invokes the
public facade. No environment flag/no-op ownership hook substitutes for it.

The result does not enable desktop persistence, qualify private storage ancestors,
prove real official service execution or grant Electron/Tauri packaged parity.
This native owner has not edited existing Node/server/desktop sources. The separate
backend owner has delivered the product ABI/adapters described below. The native
crate and owned script helpers are the implementation frontier, not a second
backend/WorkspaceManager, authentication store or Mission workflow engine.

### Why change the topology?

| Property | Original ManagerSession | New RuntimeSession |
| --- | --- | --- |
| Manager location | Outside backend Job | Inside runtime Job, outside UI Job only through independent S |
| Backend creation | Rust creates/assigns/resumes B | Node M uses its unchanged real spawn/IPC; Job inheritance contains B before first instruction |
| Node IPC adoption | Needs additional native/Node internal seam | Not needed: Node creates both IPC endpoints normally |
| Native cleanup owner | S, watching exact M | Same sole native owner and exact M watch; cleanup includes M |
| Service execution | Outside manager can be a broker | Must move to S/outside broker; M direct spawn is categorically wrong |
| Shutdown tradeoff | Backend can be killed without killing M | Closing runtime Job kills M too; graceful Stop must drain its control acknowledgment before S closes Job |

No explicit or silent runtime-Job breakaway is permitted. A descendant may create
another nested Job but cannot escape the restrictive ancestor. Node `detached`
alone is neither independence proof nor an escape. Native tests check exact flags
and the Job handle's non-inheritable bit; query handles handed to observers cannot
keep the Job alive or terminate a process.

## Native implementation

- `packages/native-host-lifetime/src/runtime_session.rs`: public opaque facade.
  `start(OwnerBootstrap, Command, timeout)` rechecks native owner/bootstrap facts,
  creates M suspended, proves its initial outside-Job state, then invokes mandatory
  assignment/borrowed resumption and a fresh private inherited-pipe challenge.
  It exposes bounded initial setup/read, manager lifetime and query-only member
  observations, not a public arbitrary service-exec command.
- `runtime_core.rs`: reusable private `PendingRuntime`/`RuntimeCore` implementation.
  Uses the existing production `spawn_suspended`, `Containment`, `AssignedBackend`
  and CNG challenge primitives. The watcher is installed against the actual M
  creation handle before resume. Job assignment and membership are checked under
  the short borrowed loan; creation, IPC reads/writes and ALL error cleanup occur
  outside it. Pending drop order closes Job before blocking child cleanup.
- `RuntimeMember`: native PID + exact creation FILETIME + retained query/wait-only
  handle. PID input is merely a candidate locator; actual membership in this exact
  Job, liveness and limits are required. Neither serialized identities nor a
  caller-supplied Job handle construct it. It has no termination API.
- `runtime_fixture.rs`: opt-in fixture using the same lower-level primitives under
  the existing restrictive outer Job. No independent-owner proof is manufactured.
  S authenticates contained M over its natively protected stdio pipes. B and its
  detached descendant are **observed only**, never assigned after creation.
- `scripts/host-lifetime-node-ipc/runtime-manager.ts`: private M launches the
  unchanged BackendProcess, not an emulated ChildProcess. A bounded, correlated
  binary S/M control transport carries only candidate PIDs and fixed fixture
  operations. Auth proofs continue exclusively over Node's real M/B IPC.
- `protocol-suite.ts` / `backend-control.ts`: shared real AuthManager,
  BootstrapProofs, HostLifetime hook/guard, NativeParent and BackendProcess exercise.
  Runtime-mode B waits for S's native membership observation **before** constructing
  AuthManager or sending readiness. That fixture ordering does not manufacture
  native authority: containment already exists by OS inheritance at process creation.

`AuthenticatedManager` keeps its original outside-Job semantics and is deliberately
not reused for contained M. RuntimeSession becomes constructible only after its
separate native owner, assignment, challenge and membership gates. The CNG frame
remains `CNHLv001` + 32-byte nonce + child/parent PID and u64 creation FILETIME.
FILETIME remains binary u64 or decimal string, never a JavaScript number; conversion
to existing DateTime ticks is exact `+ 504911232000000000`.

## Reproduce (no product host or service)

```powershell
node scripts/test-host-lifetime-node-ipc.mjs
```

Exit **0** means `PASSED_NARROW_RUNTIME_PROOF`, not product qualification; exit 1
means a failed command/control/source fence/cleanup. Evidence always lists
independent launch and desktop parity as unqualified. Cargo commands use
`--locked --offline --features fixtures`; there are no downloads/installations,
ignored-test overrides, Job-policy changes or runtime restarts.

The installed runtime inspected here is **Node v25.2.1 / libuv 1.51.0**. The runner
hashes the executable's embedded child-process/bootstrap JavaScript and records
exact source anchors. It confirms Node constructs `Pipe(PipeConstants.IPC)`, uses
native `_handle.spawn`, supplies the channel fd/serialization bootstrap fields,
deletes them during child initialization and installs Node's own `setupChannel`.
The code neither calls those private functions nor guesses a Windows fd table.
Environment hints are not ownership proof; flags without actual IPC are rejected.

The private in-process TypeScript loader uses the installed compiler and Node's
`registerHooks`; it patches no IPC and spawns no compiler service. This fixture
runtime requirement does not revise the product's OpenCode/Node minimum versions.
Owned Node launches use absolute `process.execPath`; the only other launch is the
explicitly built native fixture executable. Existing readiness identity lookup
uses its bounded read-only PowerShell query. No full backend main, application,
provider action, OpenCode CLI, shared daemon or desktop host is run.

Auth initializes bootstrap-only against one new, empty
`%LOCALAPPDATA%/Temp/opencode/host-node-ipc-*` leaf. No auth/config/token file is
written. Cleanup requires that exact leaf to remain empty and removes it without
a recursive delete. Its ancestors remain unchanged and are not claimed private.
Command output is bounded to 128 KiB / 60 seconds; native/manager fixture messages
have smaller byte/count/deadline limits. Secrets never enter argv, environment,
logs or result evidence. Raw stdout/stderr, assertion values and stacks are not
published; native failures have static codes. Native watcher cleanup and external
sentinel cleanup use exact owned/retained handles, never PID-tree kills.

The runner hashes server/native/desktop source and relevant manifests before and
after execution (including untracked native files). Changed digests fail closed;
it never restores concurrent user work. Generated native artifacts remain ignored.

## Combined proof and negative coverage

Successful combined native fixture checks:

1. M is created suspended, assigned/member-checked through the real native loan,
   then resumed. Job ownership never leaves S and the exact M watch is active.
2. Four real BackendProcess children inherit the same restrictive Job. S performs
   native exact-Job/liveness/FILETIME checks before each B's auth/readiness. M also
   compares that binary-u64 birth receipt exactly with BackendProcess's unchanged
   native DateTime-tick readiness lookup using BigInt. There
   is **no** backend/descendant `AssignProcessToJobObject` path in this fixture.
3. Inside the Job: actual send/connected/disconnect, a 32-byte correlated nonce,
   two concurrent independent AuthManager proofs, one-shot consumption/replay
   rejection, revoke, NativeParent stdio round trip and graceful stdin shutdown /
   stdout complete-status / actual successful child close all pass.
4. Explicit IPC disconnect and unexpected stdin EOF produce fatal guarded exits.
   Aggregate Node close is recorded separately: baseline observations on this Node
   are `[true, false, true]`. An exit/disconnect is never synthetic graceful Stop.
5. A fourth B and real detached Node child remain alive in the runtime Job when M
   deliberately exits. S remains alive and retains RuntimeCore; **only the native
   exact-M watcher** closes Job. Retained B/descendant handles confirm their death.
6. S's fixed external Node sentinel is natively rejected as a runtime member,
   survives M/runtime death, then is stopped by its exact owned handle. The fixture
   operation accepts no executable/args/environment payload from M.
7. Late admission after M death fails. Separate native tests reject poisoned/closed
   runtime ownership, an exited suspended M, forged challenge, zero PID, and a
   process belonging to another actual runtime Job. Non-inherited handle and
   exact no-breakaway limits are inspected natively.

Native library suite: **26 passed, 3 original positive qualifications ignored**;
the combined Node/native fixture is an additional proof run by the script. Existing
slow launch/cleanup and native owner/Node-manager crash tests remain unchanged.

Limits: this is not an adversarial DACL/peer audit of Node/libuv's internally
created M/B IPC pipe, nor proof of packaged versions, independent UI-Job survival,
private storage chain or actual
official service launch. Rust S/M pipes retain their existing native protected
DACL/challenge tests. The old three independent-launch qualifications stay pending
on a permitted host, including the earlier `native-parent-job-forbids-breakaway`
refusal. The successful nested proof does not waive them.

## Coordinator-owned product adapters (not edited in this phase)

There is no longer a need to adopt an externally created backend into Node IPC.
Minimal integration is to launch the existing M through RuntimeSession and keep
BackendProcess's real spawn/stdio/IPC, adding authoritative supervisor membership
validation before accepting readiness. M's launch configuration and private native
owner capability must arrive through S's authenticated channel, not flags or a
serialized assertion. The current `manager-entry.ts` reads configuration until
stdin EOF and has no Windows ownership/service adapter; it cannot simply be reused
with the live supervisor control channel.

The delivered backend ABI is `codenomad.runtime.v1` in
`packages/server/src/host-lifetime/native-runtime-binding.ts`; its actual sustained
wire is `CNHRv001` in `native-runtime-transport.ts`. The implementation below uses
those exact names/bytes, not a competing manager protocol. `native-manager-entry.ts`
is the new product entry; the older EOF-based entry remains unsuitable here.

Required S/M adapter: typed, bounded, per-generation private transport for
membership/owner facts, shutdown/lifetime and **official service start only**.
Existing native bootstrap writes remain bounded setup (4 KiB/write, 8 KiB total),
not an indefinite streaming protocol. Production sustained control needs explicit
backpressure, cancellation and manager-death fencing outside Job locks. No generic
HTTP/RPC exec, public caller Job/PID authority or automatic task/mission action.

For service execution, preserve the shared `createNativeServiceLauncher` /
`NativeServiceStartRequest` signature: selected executable, original args, complete
execution-host environment, cwd, verbatim options, bounded deadline and redacted
output. M must forward the existing private backend-pipe `opencode.service.start`
capability to S or an authenticated outside Node broker. S resolves the approved
profile/runtime policy; renderer/control callers cannot request arbitrary exec.
An outside Node broker can use the shared launcher and normal Node child stdio
unchanged: S independently creates/authenticates that broker with the existing
outside-Job primitives, rather than moving a service child out of M after spawn.
Native starter membership validation and the authenticated restricted request
contract still require production implementation/qualification; a broker flag is
not that proof.
The external sentinel proves the placement/cleanup separation primitive **only**;
it does not call the real launcher or qualify an official starter. Actual Windows
starter/daemon outside-Job facts must still be verified natively before product
enablement. Never retain/adopt the shared daemon in runtime cleanup or retry a
failed native start through direct M spawn.

### Continuity, election and shutdown invariants checked against existing code

`MISSIONS_CONTINUITY_CONTRACT.md`, HostLifetime manager/client/storage and manager
entry were read together. The new Job placement changes native cleanup, not these
authority semantics:

| Event | Required product behavior |
| --- | --- |
| UI detach / last window | No RuntimeSession drop, M stop, Pause, service stop or workflow action. Qualified S must survive its original UI parent; retained parent bootstrap handle is not lifetime authority. |
| Election lost | M can briefly run contained, but no second B before the existing exclusive claim. M exits; S closes only that losing runtime Job. |
| Registration | Keep owner identity **M**, not S. Existing profile/generation/secret publication waits for B auth/readiness and native identity. A live S after dead M is not a live WorkspaceManager authority. |
| M crash / S loss | Runtime descendants die; keep stale owner/registration for existing authoritative recovery. Do not delete storage or launch a replacement from a watcher. |
| Dead-owner election | Existing storage claim still requires both previous M and registered B provably dead. Native Job closure is asynchronous; do not infer B death merely from M exit. Live/unknown/unreachable owner still blocks replacement. |
| Unexpected B failure | Existing M fences/revokes and closes control, preserving registration. A live S/M pipe can now keep M's loop alive: integration needs an explicit fatal-runtime notification/exit path after fencing, not a silence watchdog or restart. Do not leave remaining descendants running indefinitely. |
| Graceful backend Stop | Existing one-command completion, complete stdout status, zero B exit and drained close remain mandatory. M must release its matching generation and drain authenticated Stop replies before S's Job cleanup kills M. B exit alone must not close the runtime Job early. |
| Stop timeout/incomplete cleanup | Preserve stopping fences and registration; explicit retries observe the same operation. Forced runtime Job closure is NOT successful graceful release/HTTP acknowledgment. |
| Service starter / shared daemon | Separate authorized outside path; never native-Job or PID-tree cleanup targets. Profile stop and daemon stop remain different actions. |

Storage/private auth, single WorkspaceManager, ownership/worktree deletion fences,
native connection fences and fresh per-admission profile environment remain with
the same shared backend. The supervisor is not a settings/environment cache,
second auth manager or hidden mission dispatcher. Packaged Electron/Tauri,
native-independent launch, private-storage and official-service parity remain
explicit qualification gates before desktop integration is enabled.

## Compiled SDK / supervised channel implementation (current handoff)

The native crate now builds two **non-fixture** artifacts offline:

```powershell
# Working directory: packages/native-host-lifetime
cargo build --locked --offline --lib --bin codenomad-host-supervisor
```

- `target/debug/codenomad-host-supervisor.exe`: production S entry. No command-line
  options or environment approval callback. It consumes a real `OwnerBootstrap`
  and a bounded private configuration packet; `SupervisedRuntime::start()` calls
  the original fail-closed `RuntimeSession::start()`. `launch_supervisor()` is the
  trusted native parent's factory, using `launch_independent()`; it does not offer
  a nested/direct-spawn fallback. The restrictive execution host cannot qualify it.
- `target/debug/codenomad_native_host_lifetime.dll`: real Rust `cdylib`, exporting
  `napi_register_module_v1`. Trusted packaging copies it as a `.node` artifact and
  supplies its SHA-256 to the backend owner's existing `NativeRuntimeBinding.load()`.
  The private runner uses `target/debug/codenomad_native_host_lifetime.node`.
  Node-API symbols resolve from the running Node executable; no N-API crate, SDK
  download, install, FFI shim or JavaScript SDK approval object is used.

`addon_api.rs`, `addon.rs` and `native_client.rs` implement the six exact ABI
methods. `openManager(challenge32)` consumes stdin **once**, verifies native private
pipe owner/DACL, challenge PID/FILETIME, retained S/M process handles and the named
pipe's actual native server PID, then completes a CNG-keyed current-generation
handshake. It returns an actual native-wrapped opaque session, bounded launch bytes,
initial raw receipt, wire key and a real Node `Duplex`. That Duplex uses asynchronous
Node-API work over owned Win32 overlapped reads/writes. It is not adoption of
`NODE_CHANNEL_FD`, a guessed libuv handle or a monkeypatched M/B IPC channel.

`named_channel.rs` creates the sole first-instance local pipe with a protected
current-user/SYSTEM DACL, remote-client rejection and a non-inherited handle.
Native peer checks reject another process before reading its proof. S retains its
exact M creation handle; the SDK retains query/wait-only S/M handles. Neither a
JavaScript PID nor a Job handle is accepted as ownership. No Job handle crosses
the bootstrap or Node-API boundary. Path is a random public locator; seeds travel
only through the native approved inherited bootstrap pipes, never args/env/logs.

`runtime_wire.rs` matches the delivered 62-byte header and HMAC-framed wire exactly.
S checks scope, generation, direction, strictly increasing sequence, fixed opcode,
frame/receive limits and partial-frame/write deadlines. No blocking channel work
holds the Job loan. Manager timeouts close the supplied Duplex, fencing S rather
than replaying an operation. The actual `RuntimeTransport` provides the existing
  16-pending/write cap. Native addon work has a separate bounded 32-work ceiling.

Native receipts use a **different CNG key that is never returned to JavaScript**.
The returned wire key cannot forge manager/member receipts. S signs only after
fresh `RuntimeCore` exact-Job/liveness/limits/FILETIME observation; the SDK verifies
the private native receipt, source/challenge/runtime/launch digest and freshly
queries retained source and candidate process handles. It does not approve parsed
JSON booleans. `verifyMember()` now has positive real compiled/native coverage.

**The production service path is implemented; native product qualification remains
closed.** The six-method `codenomad.runtime.v1` ABI and `CNHRv001` M/S frames are
unchanged. `verifyManager()` now verifies a concrete authenticated outside peer,
`authorizeService()` mints native single-use permits, `verifyService()` checks
historical exact-starter receipts, and S opcode 4 consumes a permit before work.
They still reject nested fixture facts. The actual `NativeRuntimeCapability.open()`
therefore continues to refuse this host's compiled fixture session; loading a
digest-verified addon alone cannot qualify it.

`service_channel.rs` independently launches the production peer using the original
fail-closed `launch_independent()` gate, authenticates native PID/FILETIME/private
pipes, and publishes manager facts only after peer authentication. Its nested
placement exists only under the `fixtures` feature and proves outside-runtime-Job
placement, never outside-all-Jobs independence. No contained-M service spawn or
ordinary Node/direct-spawn fallback exists in the product path.

`service_permit.rs` owns S's 16-entry irreversible ledger. CNG receipt keys are
separate from the exposed wire key. Permits bind SHA-256 of the exact UTF-8 request
envelope, profile, generation, runtime, retained M/S/peer identities and an absolute
millisecond deadline. Wall-clock and monotonic limits can only narrow. Admission
uses the selected executable, cwd, verbatim option and exact trusted argument list
(`argsPrefix` is retained as the configuration field name, but is not a permissive
prefix match). Non-fixture configuration requires canonical `service start` at the
front; remaining original arguments must already be in that private approved list.
The complete per-admission environment travels only over private channels; permit
and completion receipts contain its request digest, not its values. No environment
cache, renderer execution route or arbitrary native launch method is introduced.

`service_starter.rs` creates the real starter **suspended**, with Win32-owned stdin
NUL/stdout/stderr and a non-inherited handle allowlist. The compiled peer checks
outside-all-Jobs before requesting S's resume permission and checks it again before
`ResumeThread`. S independently queries the suspended child's native identity/Job
placement, duplicates only its exact native-signed creation handle from the retained
peer, and retains query/termination evidence through normal exit. S never assigns
the starter or daemon descendants to its runtime Job. M death, fatal/loss,
cancellation and expiry kill only retained starter handles; no daemon lookup, tree
kill, shared-service wait or retry is performed. Successful completion requires
native zero exit and drained owned streams. SDK receipt consumption is one-shot
and rechecks current M/S/peer plus both deadline limits even after asynchronous RPC.

The private auxiliary control channels expose only permit, prepare/resumed,
completion and verification operations, with native peers, bounded frames,
strict sequences, partial-frame/write deadlines and fixed work ceilings. The
internal peer JSON remains private infrastructure, not another M/S ABI or an
HTTP/RPC tool. Private role-gated addon exports cannot execute without a native
broker session and S-signed exact-request grant. Keys/bootstrap proofs never pass
through argv, environment or logs.

`node/owned-starter.mjs` exposes actual native pipe `Readable`s, observed close and
exact-handle kill; it fabricates neither a `ChildProcess` nor a Node/private IPC
handle. `node/service-broker.mjs` uses the one shared `createNativeServiceLauncher`,
preserving executable/args/environment/cwd/verbatim/deadline and independent 64 KiB
stdout/stderr bounds. Synchronous `OwnedServiceStarter` returns accept existing
real Node children, so Electron retains its original spawn path and receives
listeners before any Promise handoff. Async producers return only
`Promise<PreparedServiceStarter>`: they must call the shared `prepareServiceStarter`
constructor synchronously when the actual starter is created, before any await or
Promise return. An arbitrary `async () => spawn(...)` does not type-check.
The constructor captures starter/stream errors without their private details and
retains close; Readables retain buffered output under their own backpressure.
The launcher consumes the registered token once, propagates pre-handoff failure
as the redacted rejection, and drains retained output before replaying success.
A copied/unregistered token is rejected. This is an observation/lifetime contract,
**not native ownership or Job attestation**. The producer owns cleanup if it abandons
preparation instead of handing back the token. Late async handoff is bounded and
kills only the returned exact starter. The native helper now prepares this token
before its first poll/Promise return; it does not replace failure capture with
no-op error listeners or pretend to be a Node `ChildProcess`.

The trusted native `BrokerConfig` includes `bindingFile`/`bindingSha256`,
`entrySha256` and `launcherSha256`, verified before launch. A packaged entry calls
`runNativeServiceBroker(bindingFile, bindingSha256)` with trusted manifest constants;
the loader validates a real absolute `.node` file/digest. The fixture generates
only an owned private entry for its compiled artifact. Trusted production manager,
transitive package integrity and Electron/Tauri packaging remain coordinator gates.
The original manager registration/election/AuthManager and per-send environment
modules were not edited. `mock-service-cli.mjs` writes no files, starts no daemon
and spawns no descendants. On this host the peer/starter still inherit the outer
Job: narrow native component evidence is not a positive independence qualification.

The runner now additionally loads the actual compiled addon through the real
digest loader and exercises:

- unchanged `BackendProcess`, concurrent AuthManager proofs/consumption/revoke and
  native parent IPC round trips with native compiled member verification before B
  readiness;
- wrong challenge/PID, launch digest, altered receipt, foreign session and a receipt
  forged using the exposed wire key; all reject;
- 16 concurrent actual binary member calls, a rejected seventeenth call and real
  matching S responses; unit regressions cover fragmentation, coalesced calls,
  wrong scope/generation/MAC/direction, replay and frame/queue overflow;
- live B/detached descendant death following exact M death, retaining query handles
  until native cleanup is observed; original outside sentinel proof remains intact;
- real empty `stopDrained` acknowledgement consumption followed by SDK release and
  M zero exit. This narrow ack test is **not** a complete product HTTP/profile Stop;
- a valid canonical launch passed to the actual product factory, which refuses
  unqualified native manager/service facts. No fixture factory or stub SDK is used.
- real suspended starter/owned streams through the shared launcher; native permits
  reject replay, altered exact request bytes, expired deadlines, wrong profile or
  generation, and signatures forged with the exposed wire key;
- native exact-starter cancellation, real deadline expiry and M death cleanup;
  successful historical receipts explicitly retain `outsideAllJobsBeforeResume:false`
  in this nested counterproof rather than approving product facts.
- the native permit ledger's 16-entry backpressure ceiling, with no implicit
  dispatch or fallback when admission is exhausted.

The runner still reports `PASSED_NARROW_RUNTIME_PROOF`, preserves the three ignored
positive qualifications, hashes all source before/after and removes only its empty
owned temp leaf. Product activation still requires a permitted Windows independent
launch host, full private storage/Node IPC audits, independent service conjunction
qualification and
trusted packaged Electron/Tauri addon/manager parity. None is replaced by a flag.

Validation commands (no downloads, application launches or user daemon operations):

```powershell
node scripts/test-host-lifetime-node-ipc.mjs
node --import tsx --test packages/server/src/workspaces/native-service-launcher.test.ts packages/electron-app/electron/main/native-service-start.test.ts
# In packages/native-host-lifetime:
cargo fmt --all -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo clippy --locked --offline --all-targets --features fixtures -- -D warnings
cargo build --locked --offline --lib --bin codenomad-host-supervisor
```

The latest focused shared launcher/Electron suite has **24 passed, 1 POSIX-only skip**,
including isolated synchronous and prepared-async ENOENT failures from both
`setImmediate` and stream callbacks. Async probes deliberately yield before
handoff: each exits zero, writes only the redacted rejection and has empty stderr.
Tests also cover retained starter/stdout/stderr errors, buffered output/close,
single-use and copied-token rejection, async success and late-owned-handle cleanup.
Focused strict TypeScript checks include the unsafe async-ChildProcess type rejection
and `--allowJs --checkJs` checking of the actual native owned-starter helper, alongside
the launcher/Electron sources/tests. Actual independent S/peer/starter success cannot be
qualified on the present `native-parent-job-forbids-breakaway` execution host; no
ownership restriction was relaxed and no product activation was enabled.

Last combined runner **before launcher-review corrections**: **8,751 files**, identical before/after SHA-256
`bea8cf84f8507128a6674f51e22d32550eca9ce3bcd78b0f883e022808cb79a4`;
the private owned temporary leaf was empty and removed. The final production DLL
is rebuilt without fixture features; the runner's `.node` copy is still explicitly
a fixture artifact, not a trusted packaged product binding. The combined runner has
not been rerun during these corrections; this historical hash does not describe
the revised launcher/helper sources. No native ABI/qualification change or new
product acceptance is claimed by the focused handoff tests.
