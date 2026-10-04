# Native Windows HostLifetime primitives

Standalone Rust library and compiled Node-API binding; **not desktop/packaging enabled**.
Dependencies are pinned to cached `windows-sys = 0.59.0`, `serde = 1.0.228`,
`serde_json = 1.0.149`, `sha2 = 0.10.9` and their offline lockfile dependencies. The opt-in
`host-lifetime-fixture` executable is a test helper, not a product launch shim.
No installation, native service, daemon or Mission authority is implemented here.

## Alternative contained-manager runtime

`RuntimeSession::start(OwnerBootstrap, Command, timeout)` is a separately gated
alternative to the original ManagerSession below. An independently bootstrapped
outside supervisor creates Node M suspended, assigns it to its sole restrictive
runtime Job before resume, then verifies a fresh private-pipe challenge. Node M's
unchanged real backend spawn/IPC inherits this Job at creation. Exact-M native
watching closes the Job on manager death, including M/B descendants; query-only
`RuntimeMember` handles cannot keep the Job alive or terminate processes.

The opt-in `runtime-ipc` fixture proves this combined path inside an owned nested
Job, using unmodified server BackendProcess/AuthManager/NativeParent code. It does
not construct OwnerBootstrap or qualify supervisor independence. Original
ManagerSession/AuthenticatedManager outside-Job requirements are unchanged.
Service execution now MUST be brokered outside the runtime Job; the fixed external
Node sentinel proves placement only, not official service integration. See
`dev-docs/MISSIONS_NATIVE_NODE_IPC.md` for the implemented tradeoff, source fences,
combined proof command and remaining coordinator-owned production adapters.

### Delivered ABI and remaining conjunction

`SupervisedRuntime::start()` requires the same real `OwnerBootstrap` and
`RuntimeSession`. `launch_supervisor()` independently launches the no-argv
`codenomad-host-supervisor.exe` and sends bounded configuration privately; no
production nested/direct-spawn fallback is exposed.

The library also builds a real `cdylib` exporting `napi_register_module_v1`.
Trusted packaging names the DLL `.node` and supplies its digest to the delivered
server `NativeRuntimeBinding.load()`. ABI is exactly `codenomad.runtime.v1`; wire
is exactly the delivered `CNHRv001`. `openManager()` returns a wrapped native
session and real Node Duplex over owned overlapped pipe I/O, not Node IPC adoption.
`verifyMember()` uses signed native exact-Job observations and fresh retained
query/wait-only process handles. A separate private receipt key prevents the
JavaScript wire key from forging native evidence.

**Manager/service conjunction is not complete:** `verifyManager()` rejects the
missing independent/outside-service proof; `authorizeService()` / `verifyService()`
and S's service opcode refuse. The fixture-only outside Node broker runs the real
shared launcher against an owned mock CLI, but cannot qualify the official starter
outside all Jobs before resume. No qualifying service facts or permits are faked.

`node scripts/test-host-lifetime-node-ipc.mjs` loads the actual addon, exercises the
actual server transport and unchanged BackendProcess IPC, confirms sustained bytes
beyond bootstrap budgets, native receipt forgery rejection, exact M death cleanup,
Stop-ack consumption and actual product factory refusal. The runner's narrow proof
does not open private storage, independent launch or packaged parity gates.

## Concrete ownership interface

1. A trusted desktop/native broker calls `launch_independent(&Command)` to create
   the native owner/supervisor **suspended**. It reads its current native Job limits
   before choosing `CREATE_BREAKAWAY_FROM_JOB`; silent breakaway uses the native
   silent policy without inventing an explicit permission. A restrictive/unknown
   parent refuses. Before resumption, `IsProcessInJob(child, NULL)` must prove the
   child belongs to **no Job**, stricter than escaping one known UI Job. Nested
   restrictions never trigger a weakened retry. The UI Job is never modified.
2. `Child::authenticate()` sends a CNG-generated 32-byte challenge over the private
   inherited pipe, including PID and creation FILETIME from the actual retained
   `CreateProcessW` handle, plus the creator's PID/FILETIME. The manager echoes the
   fixed 64-byte frame. The creator
   then rechecks native identity, liveness and Job exclusion. Echoed bytes are not
   a claimed native Job fact: the creator's native handle checks are authoritative.
   Failure terminates only the exact just-created child handle. `AuthenticatedManager`
   has private fields and cannot be made from JSON, PID, environment or a token.
3. The independently running native owner first obtains `OwnerBootstrap` by
   consuming its own inherited stdio challenge. It checks its own native identity,
   no-Job membership, the pipe's native creator PID and a retained query-only parent
   handle's exact FILETIME before replying. Ordinary UI code cannot construct this
   proof from a report/flag. It launches/authenticates the Node lifetime manager
   the same way, then calls `ManagerSession::new(ownerBootstrap, manager)`.
   This again proves both owner and Node manager outside all Jobs. It creates an
   unnamed, non-inheritable backend Job with exactly `KILL_ON_JOB_CLOSE`, with no
   breakaway flags. A native watch retains the manager process handle, not a PID
   lookup, and closes the sole backend Job handle on manager death/unknown wait.
   Owner process death itself closes the Job through the kernel.
4. **Only after** the existing manager has claimed its private profile authority,
   it requests `ManagerSession::spawn_backend`. The backend is created suspended,
   assigned to the actual backend Job, membership is checked, and only then its
   initial thread is resumed. The manager is rechecked before resumption. Any
   launch/preflight failure cleans up the exact suspended native child. Descendants
   inherit containment, including Node `detached: true` descendants.
   Preparation, pipe setup, `CreateProcessW` and suspended-child cleanup run without
   the backend Job mutex. `AssignedBackend` loans that mutex and a **borrowed** child
   only for native assignment/membership/liveness facts and borrowed resumption.
   The loan is released before child extraction or any failure's Terminate/Wait,
   including an actual `ResumeThread` error. No Job handle is duplicated to keep
   a launch alive: manager death can close already-running containment immediately.
5. Authorized official service starters use `spawn_external`, never `spawn_backend`.
   The independently running owner and starter are outside all Jobs and the
   backend Job handle is not inherited. This primitive does not authorize requests
   or start OpenCode. Caller service capability/auth/environment fences still apply.

`Process` retains a handle minted by this library's `CreateProcessW`; its stop API
never accepts a PID. `observe_backend_member` opens query/wait-only handles and
checks actual membership of the private backend Job. Returned identities are
diagnostic, not process-control authority. Unknown native calls fail closed with
static error codes, never native error text, stdout, environment or paths.

## Pipes and process configuration

`STARTUPINFOEXW/PROC_THREAD_ATTRIBUTE_HANDLE_LIST` contains exactly the child's
stdin, stdout and stderr. Parent pipe ends are explicitly non-inheritable; Jobs,
process handles and watcher events never enter the child allowlist. Stderr goes
to `NUL`; stdout remains a private pipe and is never logged. New anonymous pipes
have an explicit protected owner/DACL allowing only the actual process-token user
and SYSTEM; no existing ACL is modified. The pipe creator is additionally checked
through native `GetNamedPipeServerProcessId` and a query-only creation-time handle.
Trusted executable/token provisioning remains a caller prerequisite; this is not
a substitute for private-storage ACL checks or application authentication.

CRT arguments are quoted without a shell; environment is an explicit bounded
snapshot with case-duplicate/NUL validation. Private profile/bootstrap configuration
must travel over the pipe, not argv or a persisted environment file. Initial
writes are capped at 4 KiB and a total of 8 KiB per child; native pipe capacity is
checked before creation returns. Reads poll private availability with size/deadline
bounds. This is a bounded bootstrap surface, **not** a streaming Node IPC shim.

The handshake frame is little-endian:

```text
"CNHLv001" (8) | random challenge (32) | child PID (u32) | child FILETIME (u64)
             | parent PID (u32) | parent FILETIME (u64)
```

FILETIME is the exact 100-ns native value, not a JavaScript number or `ps` timestamp.
The server's current `win32:<DateTime ticks>` identity uses a different epoch; a
future adapter must convert/check it exactly (FILETIME + 504911232000000000), using
BigInt/decimal strings or binary u64, and retain the process handle throughout.

## Explicit integration constraints / closed gates

- A native supervisor must remain alive **after UI pipe EOF/last-window close**.
  Its lifetime is the actual manager process handle, not a desktop connection.
  Manager loss closes containment; native owner loss also kills the backend Job.
  The manager must install its native-owner pipe-loss failsafe before initializing.
- Existing Node `BackendProcess` uses `spawn` and Node IPC. A mere successful
  `verifyOwnership(): void`, JSON report or shell probe cannot contain that spawn.
  The separately gated RuntimeSession now contains M before resume so its unchanged
  Node B creation inherits containment. The compiled channel/product executable
  exist, but their independent/service/packaging conjunction remains unqualified.
- BootstrapProofs/AuthManager, election/storage, per-request environment and
  authenticated bridge/ownership checks remain the existing authorities. A native
  launch/Job proof is not a permission to claim a profile or admit native requests.
- Job close is kernel containment, not proof of the backend's graceful cleanup
  handshake. Consumers must still confirm native child exit and existing graceful
  shutdown receipts; unknown/unconfirmed cleanup cannot be reported as success.
- Same-user/administrator handle duplication/replacement is outside the trusted
  executable/token assumption. Packaged Electron/Tauri lifecycle, logout/update,
  reconnect and daemon isolation qualification remain closed.

## Validation (offline, isolated own children)

```text
cargo test --locked --offline --features fixtures -- --test-threads=1
cargo check --locked --offline --lib
cargo build --locked --offline --lib --bin codenomad-host-supervisor
cargo clippy --locked --offline --all-targets --features fixtures -- -D warnings
cargo fmt --all -- --check
```

The fixture root is a newly created directory beneath the approved Windows temp
`C:/Users/Admin/AppData/Local/Temp/opencode`. Only fixture stop markers are written;
no existing directory ACL/config/profile is changed. All Node processes have an
intrinsic 60-second fixture failsafe. Optional `CODENOMAD_NATIVE_FIXTURE_NODE`
selects the Node executable only; it never changes native ownership policy.

Verified in this execution host: actual private pipe owner/DACL, CNG challenge
bound to native pipe-creator/child PID+FILETIME (including forged-field refusals),
native restrictive-parent refusal, actual native
Job-holder crash killing an assigned Node backend and detached descendant, and
actual Node manager crash triggering the retained-handle native watch to close
that Job. Both leave the separately spawned external sentinel alive. Containment
fixtures retain this host's restrictive outer Job and cannot qualify independence.

`launch_regression.rs` adds four native regressions through those same borrowed
containment/resume primitives. Thread/instance-local, test-only seams deliberately
pause preparation before native creation or cleanup before native Terminate/Wait.
While the pause remains unreleased, exact manager death must kill an already-running
backend and detached descendant within 500 ms, leaving an external sentinel alive.
Late children are never resumed and their retained native handles confirm cleanup.
Failure cases use an actual invalid-for-ResumeThread event handle, an actual exited
child, and a private poisoned/closed Job mutex—not forged ownership proof or policy
flags. These tests qualify lock/lifetime behavior only, not independent launch.

**Blocked qualification:** this execution host's Job forbids breakaway. The three
independent-launch/challenge/UI-surrogate qualification tests are explicitly
ignored by default and failed with `native-parent-job-forbids-breakaway` when
attempted here. Run them in an ordinary permitted Windows execution host:

```text
cargo test --locked --offline --features fixtures --test windows -- --ignored --test-threads=1
```

The positive fixture creates only its own UI surrogate Job with breakaway enabled,
proves owner/Node manager outside every Job through native handles and private
challenge, closes the surrogate's last Job handle, then crashes the Node manager
and waits for backend/descendant exit while the external sentinel survives.
Its pending status must never be represented as desktop parity or launch proof.
