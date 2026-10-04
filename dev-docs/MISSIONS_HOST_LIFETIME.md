# Shared HostLifetime foundation

This is executable production protocol/process/storage code under
`packages/server/src/host-lifetime/`, with the **full backend entry/auth/readiness
hook wired, but not enabled in either desktop**. It has no Mission, scheduler,
prompt, grant or workspace authority behavior. Protocol tests use a private mock;
full-backend tests run the real CLI/server/AuthManager against an empty private
profile with a throwing service adapter, never a user's daemon.

## Integration surface

- `canonicalScope(channel, config, cwd, home)` matches desktop lexical config
  identity: JSON maps to sibling `config.yaml`, directories append `config.yaml`,
  Windows paths fold case. Pass the desktop's resolved normalized channel. The
  registry uses the full SHA-256 key of channel + NUL + config identity and checks
  both original fields, not merely the key.
- `HostLifetimeClient.attach({ storage, launch })` validates process start
  identity before attach/election. Its `attachment` supplies a fresh bootstrap
  proof, stable loopback origin and an ephemeral window capability. Desktop
  consumes proof through the existing loopback bootstrap auth route and keeps
  the resulting cookie in its webview store. No cookie enters registry/control.
- `HostLifetimeManager.start()` owns **one full backend child**, its stdin/native
  pipe and authenticated loopback control server. Its owner is published before
  spawn; readiness registration is published only after backend auth/readiness,
  backend start identity, server binding and secret publication. Competing
  managers may start briefly but cannot start a second backend.
- `launchNodeManager()` / `manager-entry.ts` provide the independent Linux Node
  launch path. Configuration travels over one bounded pipe, not argv, registry
  or a persisted environment file. Packaging must resolve compiled entrypoints.
- Windows uses `loadAndRunNativeRuntimeManager(trustedAddonPath, trustedSha256)`
  from `native-manager-entry.ts`. The path/digest are trusted packaged-host inputs,
  never profile/renderer/environment/argv authority. The loader accepts only a
  digest-verified `.node` binding with the `codenomad.runtime.v1` ABI.
  It captures `process.dlopen` at module initialization and loads a fresh `Module`
  directly through that native loader, independent of `require.cache` and
  `require.extensions`. Hash-checked text with cached/hooked SDK exports cannot
  acquire production binding authority. The loader neither deletes cache entries
  nor rewrites hooks. This boundary excludes arbitrary mutation of trusted Node
  builtins before initialization and retains the trusted immutable/private
  packaged-artifact assumption; native session/peer proofs remain mandatory.
  `runNativeRuntimeManager(binding)` obtains both launch configuration and opaque
  `NativeRuntimeCapability` from that binding's authenticated live S/M channel.
  The old EOF configuration entry explicitly rejects Windows. There is no
  exported ownership-approval callback, direct Windows spawn fallback or
  environment flag which qualifies a runtime.
- The Windows owner is still M. Profile election happens before fresh native
  manager-Job verification and B creation. The native receipt must prove exact
  manager/supervisor birth, assigned-suspended history, sole S Job ownership,
  non-inherited Job handle and **exactly** `KILL_ON_JOB_CLOSE` (`0x2000`), with
  neither breakaway flag. The same receipt must bind an authenticated,
  profile-approved outside service peer; absence refuses before B creation.
  Node.spawn/stdio/real IPC are unchanged. The wrapper waits on correlated Node
  IPC admission **before importing index/AuthManager**. M authorizes that reply
  only after S's native member receipt and exact B PID/FILETIME/start-identity
  comparison; readiness also waits for admission. No retroactive Job assignment
  exists in this adapter.
  One absolute five-second child admission deadline is captured before spawn and
  inherited through first process lookup, member request, native verification,
  correlated admission reply and readiness identity lookup. The wrapper checks
  that same expiry before importing/starting the backend. A delayed stage never
  starts a new allowance. Non-runtime standalone readiness retains its separate
  15-second budget.
- Run the full backend through `backend-entry.ts`, with
  `CODENOMAD_HOST_BACKEND_ENTRY` pointing to its absolute `index.js` (or source
  `index.ts` in private fixtures), not the spawning `bin.js`. The wrapper verifies
  `HOST_BACKEND_ENTRY_VERSION === 1` and explicitly invokes the exported,
  process-singleton `runBackendMain(process.argv.slice(2))`; import alone does not
  run the CLI. Original arguments are neither replaced nor reparsed in a second
  startup. Unsupported older entries and direct persistent-child CLI launch fail
  closed. Normal direct standalone CLI startup/version behavior is unchanged.
  The wrapper installs the shared IPC disconnect/stdin EOF failsafe **before**
  importing backend initialization. The real `index.ts` installs
  `installBackendHostLifetime(new BootstrapProofs(authManager), origin)` after
  HTTP/auth readiness and after native stdin/signal shutdown handling is ready.
  Readiness uses the actual IPv4 loopback HTTP port, not the displayed remote URL.
  Persistent attach forbids skipped auth, absent token bootstrap and CLI upgrade;
  those fail before profile/auth mutation. Graceful shutdown fences new proofs,
  revokes outstanding proofs and closes IPC only after existing cleanup finishes.
- `BootstrapProofs` delegates issuing/consuming to the existing AuthManager and
  adds per-window revocation bookkeeping. Keep the existing loopback bootstrap
  route, session creation and cookie exchange unchanged. The bounded multi-token
  `TokenManager` implementation is a dependency; a
  single-slot token implementation is not suitable for parallel reattachment.
  The native-bootstrap line protocol remains for legacy managed parents only,
  not persistent attach. Persistent bootstrap uses child IPC exclusively and
  suppresses the unused startup stdout proof; there is no second HTTP auth store.
- Desktop calls `serveNative(handler, abortSignal)` and `detach()` when window
  ownership ends. Explicit detach revokes immediately, including pending native
  calls and unconsumed proofs. Process crash/no heartbeat revokes after a bounded
  10-second lease (1-second sweep). Already headless calls fail immediately with
  `no-attached-native-window`; there is no background UI executor.
- Window native calls require the explicit window ID (`call.windowId` or
  `params.windowId`), never "current"/first window inference. Desktop handler must
  retain existing inspected-target/session/run authority fences. Only
  `browser.*`/`developer.*` route to windows. `opencode.service.start` is available
   **only** from the backend pipe, not a renderer/control API. Windows routes it
   through the opaque runtime capability to the verified outside peer; an injected
   `startService` override is forbidden for this path. POSIX retains its explicit
   host-owned service capability. No other method is implicitly allowed.
  Queued calls carry their effective deadline (at most 30 seconds), not the
  backend's longer original deadline. Cancellation removes queued work; polling
  independently rechecks the exact pending call, window capability and deadline.
  A per-call `requestToken` accompanies native poll/results so a late reply cannot
  settle a reused ID. Old timers are also fenced by pending-object identity. The
  native client skips expired calls without discarding later live calls, while
  abort/detach still stops execution and late-result submission.
- `stopAuthority()` requires authenticated explicit `stop-profile-backend` intent.
  It sends the existing stdin shutdown command, confirms child exit, then removes
  registration/secret/owner. It cannot stop OpenCode, traverse process trees or
  kill arbitrary PIDs. Failed/unconfirmed stop retains owner and registration.
  The backend sends that command once and keeps one drained-close/complete
  promise across all observers. Each manager Stop observation is bounded to four
  seconds, inside the five-second local-client deadline; only Stop receives the
  longer six-second server inactivity allowance. Concurrent Stop HTTP requests
  share observation and storage release. An observer timeout never cancels cleanup
  or authorizes another command: authenticated explicit Stop can retry observing
  the same completion, while attach/native/status/detach remain fenced. Failure
   never resets the stopping fence or claims success without complete + zero exit.
   Successful Stop immediately closes new control admission, then drains existing
   observers (including authenticated peers still completing a request body).
   They receive the same cached acknowledgement without another shutdown/release.
   An absolute five-second drain deadline closes peers that never finish, even if
   they keep their sockets active; server close clears the timer when drainage ends.
   Independent bounded re-review confirms both peer cases and closed new/keep-alive
   admission, one command/release, zero backend exit, and 13 passing regressions.
   This is protocol qualification only, not a native launch/containment gate.

## Safety and deliberately closed gates

1. **Windows product admission is implemented; native channel qualification is
   still closed.** It consumes the separately implemented `RuntimeSession`
   topology: S outside all Jobs, M assigned suspended to S's sole restrictive Job,
   B/descendants inheriting at creation, exact M death watch. It does not consume
   the older outside-M topology or treat detached Node as evidence. The compiled
   native ABI/channel/service implementation described below is not supplied by
   these server files. Missing/unverified binding or outside-service authority
   refuses; SDK-stub receipts never qualify production. Independent UI survival,
   real official starter/daemon placement and packaged hosts remain native gates.
   See `MISSIONS_NATIVE_NODE_IPC.md` for the separate containment proof and limits.
2. **Windows ACL verification remains a native qualification gate.** The separate
   Windows storage adapter must check owner/private DACL and reparse behavior for
   provisioned root, registry directory and every file. These full-backend fixtures
   deliberately use their explicit private test policy and do NOT qualify product
   DACL behavior. Do not use that test policy in a product launcher.
3. Linux default identity uses boot UUID + `/proc` start ticks. Windows lookup uses
   native `Get-Process.StartTime` UTC ticks and distinguishes absent from lookup
   failure. No `kill(pid, 0)` trust. macOS `ps lstart` second resolution is rejected;
   supply an exact native start-identity adapter before enabling production launch.
4. Registration with live or unknown owner, including unreachable authenticated
   control, fails closed. Proven-dead recovery holds a short exclusive election
   gate, rechecks owner/backend identity, quarantines registration, rotates secret
   and publishes the new generation. A previous backend whose exit cannot be
   proven blocks replacement. No PID reuse can authorize a broad kill.
   Only ENOENT/`undefined` represents an absent registration or owner. Present
   `null`, `false`, `0`, empty strings and malformed typed owner fields are invalid,
   never election permission. Owner reads share PID/start-identity and canonical
   generation validation before client launch, claim, quarantine or release.
5. A crash **inside the short filesystem election gate** leaves a gate requiring
   explicit operator recovery. It is never stolen by elapsed time or guessed PID.
   This conservative availability gap needs a native OS lock adapter for automatic
   gate-crash recovery; ordinary manager crashes after publication recover safely.
6. Atomic files are exclusive temporary files + fsync + rename, private permissions
   and bounded read/type/inode checks; symlink ancestors are rejected. Directory
   fsync/power-loss durability and Windows reparse/ACL TOCTOU qualification remain
   native filesystem gates. Assume a privately provisioned root and no hostile
   same-user/administrator capable of replacing its ancestors.
7. POSIX channel-loss child exit is cooperative failsafe. The Windows adapter
    relies on qualified S-owned RuntimeSession containment for descendants.
   Graceful stop now requires the real backend's complete shutdown handshake,
   drained child streams and a zero exit code; otherwise it explicitly reports
   `backend-stop-unconfirmed` rather than claiming tree cleanup. Its bare Node
    Linux entry intentionally has no persistent service-start adapter; host
    integration must inject that explicit capability. Windows requires the
    authenticated outside-native service path, never a direct M fallback.
8. Packaged Electron **and** Tauri lifecycle tests (last-window detach, relaunch,
   logout/session-end, updater and real full-backend auth rebootstrap) remain gates.
   This change enables none of them automatically.

All local control messages and responses are capped at 256 KiB, request deadlines
are bounded, concurrency is capped and scope/generation/control secret are checked
on every request. Raw child stdout/stderr and native error bodies are never logged.
Secrets live only in private generation files; registration contains no cookies,
bootstrap proofs, window capabilities, profile environment or mission credentials.

## Native S/channel handoff (not desktop enablement)

`native-runtime-binding.ts` defines the native ABI; `native-runtime.ts` implements
the product capability factory/admission/service/lifetime adapter;
`native-runtime-transport.ts` implements sustained private framing. The separate
native owner must implement this ABI in a trusted compiled binding and S's live
channel. A JS object implementing this shape is **not** production authority.
`forPrivateFixture()`/`createHostLifetimeManagerForPrivateFixture()` deliberately
mint only unqualified test instances; the production manager rejects them.

### Required native binding contract

- `openManager(challenge32)` authenticates S's exact retained endpoint/process
  against the native bootstrap, private DACL and cryptographic current-host proof.
  It returns `{ channel: Duplex, nativeSession, key32, launch, attestation }`.
  `launch` is bounded UTF-8 JSON `{ root, scope, generation, backend }`, with the
  existing `BackendLaunch` and actual backend wrapper. Secrets/config/env are
  transported privately, never logged. The native session, key and raw attestation
  originate from verified native binding operations, never renderer/HTTP/JSON
  assertions. The authenticated endpoint binds launch SHA-256, scope/channel/
  config identity, generation, runtime ID and exact manager/supervisor births.
- `verifyManager(session, challenge32, launchSha256, rawAttestation)` verifies
  cryptographic challenge/source/launch/generation/route claims and queries fresh
  retained native process/Job state. Return `NativeManagerFacts` only after those
  checks, including `ownerBootstrapVerified`, suspended precontainment history,
  exact limits/sole owner and concrete profile-approved outside service peer.
  Initial attestation comes from `openManager`; later attestation comes from the
  fixed member query for M. Do not parse remote JSON booleans as verified facts.
- `verifyMember(session, candidatePid, challenge32, rawAttestation)` must use
  RuntimeSession's exact-Job/member/liveness/native FILETIME verification. Candidate
  PID is a locator only, never public Job/kill/ownership authority. Return exact
  birth plus runtime ID, nonce and **inherited** membership; no assign-after-spawn.
  Windows FILETIME (1601 epoch) converts exactly via BigInt to the existing owner
  identity: `win32:${FILETIME + 504911232000000000}`.
- `authorizeService(session, exactRequestBytes, deadline)` returns a bounded
  cryptographic profile-policy permit for those bytes, generation, runtime and
  outside peer. S independently authenticates/verifies it and the current profile
  policy, rejecting stale/expired/canceled requests. It is not a settings cache.
  The permit never grants generic execution or renderer access.
- `verifyService(session, requestSha256, rawAttestation)` verifies the bound peer,
  retained exact starter PID/FILETIME, native outside-all-Jobs placement **before
  resume**, profile policy, original execution preservation and runtime/request
  digest. The outside peer implements `createNativeServiceLauncher` semantics:
  selected file/args, complete environment, cwd and verbatim option unchanged;
  timeout from the original absolute deadline, bounded stdout/stderr and redacted
  errors. No retry through M, fabricated CLI response, shared-daemon adoption or
  cleanup. Official starter/daemon native qualification remains pending.
- `release(session)` releases channel/session resources idempotently. It must not
  treat a mere attachment/channel release as successful profile Stop or delete
  registry/daemon state. Native calls must be bounded and cancel pending service
  admission on channel/M death; verification cannot block indefinitely. Native
  ownership and exact M watch remain authoritative for runtime cleanup.

### Sustained channel wire

After native authenticated setup (not the existing 8 KiB bootstrap writer), each
frame is `u32LE(length) + content + HMAC-SHA256(content, key32)`. Content header:
`"CNHRv001"[8] + scope SHA256[32] + generation UUID bytes[16] + sequence u32LE +
opcode u8 + direction u8`, then payload. Direction 0 is M request, 1 is S reply;
sequences are nonzero and never reused. Replies must match generation, scope,
sequence and opcode. Unknown/replayed/malformed/MAC-invalid replies, timeout,
EOF/error or queue overflow fail closed. At most 16 outstanding calls/writes;
payloads are at most 256 KiB, with callback-tracked writes and bounded receive
buffers. Per-call deadlines are capped at 30 seconds. Native S must independently
bound buffers, cancellation and backpressure outside Job locks; the existing
bootstrap write budget is not reusable as this sustained protocol.

Each pending transport call stores its **effective absolute expiry** (including
the 30-second cap). After MAC/scope/generation/sequence/opcode validation, receive
checks that expiry before settling: even a valid reply at/after expiry rejects
with `native-runtime-timeout`, revokes the channel and rejects other pending work.
This clock check is independent of scheduled timer callbacks; delayed timers do
not permit result publication. Unknown/replayed replies retain fail-closed channel
revocation. All terminal paths clear their owned timers.

`NativeDeadline` shares one expiry across each operation's asynchronous stages and
checks it before starting work and after every awaited result. Initial native open
and manager verification share one five-second qualification budget; late open
resources are disposed without minting a capability. Fresh manager/member queries
and their native verification share a budget, rather than stacking fresh waits.
The optional inherited expiry in `admitBackend(child, startIdentity, deadline?)`
is backward-compatible local API only; the compiled `NativeRuntimeSDK` ABI is
unchanged. The existing service deadline is forwarded unchanged and preserved
through profile permit, outside-peer exchange and native service verification.

Only these fixed operations exist (none exposed through local HTTP):

| Opcode | Request payload | Response payload |
| --- | --- | --- |
| 1 `runtime member` | nonce32 + candidate PID u32LE (M or its owned B) | Native raw challenge-bound manager/member attestation |
| 2 `fatal` | One of `backend-exit`, `startup-failed`, `owner-lost`, `election-lost` | Empty acknowledgement |
| 3 `stop-drained` | Empty | Empty acknowledgement |
| 4 `opencode.service.start` | permit length u32LE + permit (32..4096 bytes) + exact UTF-8 JSON `{ request: NativeServiceStartRequest, deadline }` | attestation length u32LE + native attestation (at most 4096 bytes) + bounded UTF-8 JSON `{ stdout, stderr }` |

S must verify current generation/source and fixed route claims for every operation.
Member attestation is verified by the compiled binding; HMAC alone is not native
Job proof. Service fields are forwarded unchanged, output is independently bounded
to 64 KiB per stream, and errors contain no native details/config/env/arguments.

Unexpected B exit fences/revokes M, closes control and sends explicit fatal/exit;
there is no silence watchdog, replacement launcher or storage release. Losing
election similarly terminates only that runtime with **no B**. S loss fences M;
native exact M death cleanup retains stale registry for existing dead-owner checks.
Normal B exit during explicit Stop does **not** send fatal or close S's Job. Only
complete status + drained B close + zero exit, matching generation release and
actual control HTTP close permit `stop-drained`. This preserves authenticated Stop
observers and avoids native cleanup preempting their replies. Stop timeout/incomplete
cleanup remains fenced with registry intact and explicit observation retries.

## Windows storage privacy

`windows-storage.ts` is the default Windows storage policy's read-only native
adapter. It runs execution-host Windows PowerShell/.NET `Get-Acl` and `Get-Item`
with exact quoted `LiteralPath`, no profile, system module discovery, an encoded
command, a five-second deadline and a 64 KiB output bound. It obtains the current
principal from native `WindowsIdentity`, not a claimed SID/token or environment
flag. The pure validator checks native owner, raw DACL ACEs, canonical/present
ACL, file size/type and all lexical ancestors' native reparse attributes. Only
the current local/domain account and SYSTEM may own private storage or receive
effective Allow rights there. Inherited ACEs are not implicitly trusted. A foreign
InheritOnly grant on a directory also refuses, because it could expose a newly
created child before verification. Unsupported ACEs, unknown SIDs, unreadable ACLs,
remote/device/alternate-stream paths and bounded-probe failures all fail closed
without returning native error text or paths. Verification never repairs ACLs.

Ancestors must be ordinary directories owned by the current principal, SYSTEM,
Administrators or TrustedInstaller. Foreign effective DELETE, DELETE_CHILD,
WRITE_DAC, WRITE_OWNER or generic equivalent grants refuse; read/create-sibling
rights and ancestor-only InheritOnly grants can remain. Same-user, administrator
and SYSTEM replacement attacks remain outside this privately provisioned-chain
assumption. These read-only path probes are not handle-bound ACL transactions:
ACL/reparse TOCTOU and power-loss durability still need native filesystem
qualification. No launch, containment or desktop-enablement gate is opened.

The Windows test creates and changes ACLs **only on its newly created temp
directory and files**, then checks actual native current-account/SYSTEM grants,
inherited file ACLs, foreign grants, junctions and sanitized unknown failures.
Broadly writable CI/agent temp ancestors are intentionally refused; checking a
private native leaf is not represented as qualification of that entire chain.

## Validation

```text
node --import tsx --test packages/server/src/host-lifetime/windows-storage.test.ts
node --import tsx --test packages/server/src/host-lifetime/host-lifetime.test.ts
node --import tsx --test packages/server/src/host-lifetime/full-backend.test.ts
node --import tsx --test packages/server/src/host-lifetime/lifetime-corrections.test.ts
node --import tsx --test packages/server/src/host-lifetime/native-runtime.test.ts
node --import tsx --test packages/server/src/host-lifetime/native-boundary-corrections.test.ts
# Explicit compiled-artifact prerequisite; does not build it or skip if absent:
node --import tsx --test packages/server/src/host-lifetime/native-binding-positive.test.ts
npm run typecheck --workspace @neuralnomads/codenomad
```

Fixtures use only private temp files/child handles: eight parallel attaches,
independent bootstrap consumption, authentication/scope refusal, explicit window
routing/revocation, retained backend/generation after detach, immediate headless
failure, manager-crash IPC failsafe and new generation recovery, unknown/live owner
refusal, atomic dead-owner reclaim, malformed/symlink/permission gates and explicit
stop with an unchanged external daemon sentinel. No product launch, shared daemon,
user auth/config/profile, install, restart or profile mutation is performed.

The full-backend regression additionally exchanges two concurrent proofs through
the real `/api/auth/token` route for separate AuthManager cookies, checks existing
cookie auth/status, unused-proof revocation after detach, the same origin/backend
at zero windows, exact root/cookie CLI flags, one startup despite duplicate main
calls, graceful client-only shutdown, and no service discovery/start/connection
attempt. Private HOME/USERPROFILE, XDG roots, app-data, config/auth, UI, workspace,
provider config and logs are all beneath the test's temporary directory. A narrow
`BackendMainDependencies.sharedService` seam prevents native discovery even if
an empty-workspace readiness path regresses. Rejection tests cover skipped auth,
missing bootstrap, old managed modules, spawning bin imports and direct persistent
entries; standalone `--version` retains its existing direct-entry behavior.
Separate private protocol-failure children verify that absent/incomplete cleanup
handshakes or nonzero exit never confirm profile stop.

`lifetime-corrections.test.ts` verifies real private Node/HTTP shutdown with two
concurrent timed-out Stop observers and explicit retries: one command, one release,
complete cleanup and zero exit, unchanged external sentinel and persistent
attach/native fences. A direct backend test separately exercises concurrent
observers of the same completion. Native-wire tests check canceled queues,
poll-time deadline rejection before a real timer runs, the 30-second effective
deadline, duplicate/reused IDs and stale result tokens. A client wire fixture
checks live work behind an expired first call. Each falsy registration/owner and
malformed owner field must reject attach/claim with zero launches and unchanged
original bytes. Trusted test injections remain private fixture allowances, not
Windows containment, ACL privacy or packaged-desktop qualification.

`native-runtime.test.ts` uses the actual HostLifetimeManager, private real Node
wrapper/IPC/AuthManager/NativeParent and an owned outside-service child, with
explicit native SDK stubs. It tests callback/JSON/fixture rejection at production
admission, absent peer/no-breakaway refusal before B/auth, fresh pre-spawn queries,
native member/MAC denial before AuthManager import, original service execution,
graceful generation release before S drain signal, unexpected B fatal notification,
losing election without B or changed owner, and owner-channel loss without daemon
or replacement actions. These prove product adapter ordering/protocol only: no SDK
stub or ordinary fixture spawn qualifies Windows Job/outside-peer/native privacy.

`native-boundary-corrections.test.ts` runs cache/hook attacks in separate private
Node children against a hash-checked text `.node`, with complete SDK-shaped cached
exports. Both refuse without SDK execution, native authority or cache/hook changes.
Another isolated child holds every timer callback while delivering a correctly
MACed correlated reply exactly at expiry, including the effective 30-second cap:
no result publishes, concurrent/subsequent calls refuse, timers clear and the key
is revoked. Native-runtime integration tests additionally advance the clock during
initial child lookup and hold native member verification after an earlier lookup
and member query. No late AuthManager import or readiness registration is granted.
Initial manager open/held verification and late readiness identity lookups receive
the same independent clock checks. These are regression probes, not acceptance or
native compiled-addon/ownership qualification.

`native-binding-positive.test.ts` additionally copies the native owner's existing
compiled debug N-API addon into newly owned temp storage and loads it in an
isolated Node child with both cache and extension-hook SDK bait. Actual native
exports load, the bait is never called or mutated, and the compiled native method
rejects a fabricated native session. This explicit fixture requires that built
artifact and fails if absent/invalid; it never builds, installs, skips or substitutes
JS. It proves loader behavior only, not fresh supervisor/session/service authority.

Latest scoped combined validation: **28 passed, 0 failed, 0 skipped**, with the nine
additional loader/boundary/deadline regressions plus existing native-adapter,
full-backend/process/lifetime corrections. Full server
`npm run typecheck --workspace @neuralnomads/codenomad` passes. The scoped
`git diff --check` passes. No desktop enablement, native qualification claim,
shared-daemon access, install, restart, commit or publication is part of this work.
Independent Gatekeeper re-review remains required. The positive compiled N-API
loader probe passes with the native owner's actual artifact. Native private-channel,
independent launch, complete service starter/daemon placement and packaged parity
qualification remain with their owners; loader success does not open those gates.
