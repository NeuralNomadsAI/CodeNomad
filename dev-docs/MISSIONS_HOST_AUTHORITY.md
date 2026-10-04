# Protected host Missions authority staging

## Implemented, not activated

`packages/server/src/missions/host-authority/` now implements protected local
Ed25519 provisioning, immutable public snapshots, exclusive file CAS, signed
typed intent staging, protected native-grant mirroring, durable local denial and
explicit qualified rotation. This is executable implementation, not a proposed
store or another blocked-only prototype.

No existing authority core, durable/legacy plugin, desktop entry, backend route,
package, runtime or #824 behavior is changed. No module registers HTTP auth,
plugins, agents, dispatchers or timers. Coordinator/native owners wire the real
private capability transport and existing admission routes separately.

The production entry point has **no permissive policy override**. A missing
native bridge allows only explicit local key staging; it cannot sign, publish a
qualified signer or authorize a grant. Persisted anchors do not qualify a new
process: its public read is staged and its signer map is empty until an explicit
authenticated human operation obtains a fresh, verified native handshake.

## Narrow construction/API

`createProtectedHostAuthority({ parent, auth, ownership, bridge?, nativeMirror? })`
is exported from `host-authority/index.ts`.

- `parent.readStagingScope()` is trusted private persistent-parent construction,
  not a serialized HTTP/bootstrap/config object. It supplies the preprovisioned
  private root and immutable profile scope, physical profile and execution host.
- `auth` is the **existing `AuthManager`**, not a second HTTP auth store. Disabled
  authentication and missing/changed cookie sessions are denied. Existing route
  origin/CSRF/admission checks still apply; this module does not replace them.
- `ownership.withOwned(binding, operation)` must hold the real profile,
  connection, session-send, physical-family and worktree-deletion gates and supply
  a fresh synchronous literal-`true` fence. Unknown ownership is denial, not a
  cached native project-ID/path-prefix inference.
- `bridge` is the private native attestation capability verifier described below;
  there is intentionally no default verifier or JS proof issuer.
- `nativeMirror.read(originalBody)` reads authenticated native-core evidence, not
  caller JSON. A missing original receipt/unknown observation cannot settle work.

The returned store exposes:

| Method | Meaning |
| --- | --- |
| `prepare(request, target, expectedRevision)` | Explicit local stage (`null` CAS means proven absence); generates authority/key IDs, key and provisioning generation internally. Existing keys are never silently replaced. |
| `read()` | Frozen public revision/state/generation/epoch/binding/signer/mirror/pending-digest projection. No private key, handshake capability or implicit mutation. |
| `sign(request, typedIntent, expectedRevision)` | Product schema allowlist only; verifies fresh human/owned/native admission and publishes protected reservation/denial **before** returning a domain-separated Ed25519 signature. No prompt/tool/RPC driver or caller key. |
| `accept(request, pendingDigest, expectedRevision)` | Protected mirror settlement from two identical fresh native observations and the original completed receipt. Never executes/retries native work. |
| `revoke(request, expectedRevision)` | Durable **local** denial independent of new execution qualification, pending effects or variable receipt capacity. Does not claim native grant revocation/interruption. |
| `readSigners()` | Qualified public signer map only; no stale fallback, automatic handshake or key creation. |
| `assertSignerCurrent(snapshot): true` | Fresh synchronous private-file and immutable scope/key/generation/qualification fence. Detached snapshot identity is compared by content, never object identity. |
| `assertManagedIncarnation(): true` | Fresh synchronous verified native host/writer capability fence, not an enabled flag. |
| `assertHostGrant(grant)` / `assertHostGrantCurrent(grant): true` | Async+final-sync protected mirror checks implementing `HostAuthorityRegistry`. |

A slot is deliberately bound to **one exact** namespace/project/coordinator/root
manifest. The trusted parent supplies stable private per-slot roots for multiple
scopes; do not reuse a slot as a global/profile fallback. Authority/key IDs are
host-generated. Full manifest matching includes profile, execution host, native
UUID, project/canonical identity, mission, coordinator and exact physical roots.

## Protected file implementation

`private-files.ts` reuses `HostStorage`, `privateStorage` and the Windows
owner/DACL/reparse evaluator from `host-lifetime/windows-storage.ts`.

- The root must already be privately provisioned. No DACL/mode repair, insecure
  fallback, user-profile discovery or permission-relaxing environment flag exists.
- Root/profile identities and non-reparse ancestors are checked again on reads
  and mutations. Synchronous final fences run the **same** bounded Windows
  evidence evaluator through a bounded native call, or the UID/mode checks on
  POSIX. This is not a cached asynchronous ACL approval.
- Files are bounded, non-reparse, singly linked and checked against opened-handle
  identity; synchronous reads use bounded bytes and fatal UTF-8 decoding.
- `missions-authority.identity` is a permanent installation/descriptor marker.
  Missing key state with a surviving marker is key loss, **not a new installation**.
  Corrupt/unknown key, marker, generation, profile or moved-root state is never
  repaired/overwritten. Private/public Ed25519 pairing and fingerprint are checked.
- A conservative `missions-authority-cas` mkdir claim serializes cooperating
  processes. Revision and complete original-document digest are checked, then
  privacy, human and native fences run before `HostStorage.atomic` publication.
  Validation failures release only the exact empty claim. Ambiguous publication
  parks it. No TTL, PID-only takeover, recursive cleanup or automatic repair.
- `HostStorage.atomic` uses a private `wx` temporary, fsync and rename. This is a
  logical cooperating-writer CAS, **not** proof of parent-directory fsync,
  power-loss durability or exclusion of administrators/nonparticipating writers.
- Ordinary host documents stay below 128 KiB minus a local denial reserve.
  Revocation is a bounded flag/disabled-mirror change and can use that reserve.
  Native receipt/terminal quotas remain in `NativeMissionAuthorityStore`; this
  module does not duplicate its journal or receipt engine.
- Private PKCS8 bytes live only in protected host files and short-lived host
  memory. Public projections, plugin maps, signatures, native bridge messages,
  errors and diagnostics never receive the private key. It is not supplied in
  browser data, arguments, environment, plugin options or RPC inputs.

## Real native qualification and explicit upgrade/quiescence

`PrivateManagedAuthorityBridge` must be implemented by the independently
qualified persistent native host's **private capability channel**, not HTTP JSON:

1. Read authenticated connected-daemon `config.get` discovery through
   `readNativeDiscoveryBoundary`. It reads twice and fences connection identity;
   global discovery is the first directory source, never backend environment,
   CLI `debug paths`, project root or an expired presence lease.
2. On an explicit authenticated human upgrade/quiescence decision, observe bounded
   native registrations **before** change: exact registration/incarnation IDs,
   artifact digests, writer kind and state. Unknown registration/state fails closed.
3. Existing live old writers must actually dispose/quiesce through the native
   owner's supported explicit control, with authenticated per-incarnation native
   disposal receipts. Absence/config edits/PID death/presence expiry are not receipts.
   If this capability is unavailable, activation remains unavailable. Do not
   implicitly call `location.reload` (which cancels Forms), restart the daemon,
   activate plugins or infer exclusion from a timeout.
4. Authenticate a fresh nonce-bound private handshake tying persistent-host
   generation and owner/backend start identities (backend PID must be this host),
   descriptor/profile/execution host, key fingerprint/provisioning generation,
   native daemon-storage identity, exact writer registration/artifact and full
   namespace/project/coordinator/physical roots. `verify` must authenticate native
   attestation bytes; parsing these fields is **not** a verifier.
5. `assertExplicitQuiescence` cross-checks complete before/after inventories,
   original-incarnation disposal receipts, inventory digest and excluded IDs.
   Only the declared managed writer may remain active in this conservative scope.
   The connected daemon's discovery/config digest is reread after preparation and
   must match the attestation.
6. The bridge's **mandatory synchronous** `assertCurrent(proof, digest): true`
   must freshly enforce current native ownership, host generation/start identities,
   private capability, writer registration/artifact/config inventory and physical
   roots. A Promise/thenable/undefined approval is rejected by the existing
   `authority-synchronous.ts` primitive. Host state additionally pins original
   provisioning generation, fingerprint, binding and anchor digest.

There is no production bridge implementation or synthetic qualifier in this
directory. These obligations are the exact handoff to the parallel native owner;
the default path cannot activate without them. Unit private-bridge stubs are
explicitly marked **not product proof** and test rejection of incomplete/stale
nonce, host PID, key/generation, scope, discovery and old-writer observations.

## Native/host grant semantics and wiring order

The native authority core remains authoritative for schema, project exclusion,
native CAS, revisions, epochs, immutable receipts and capacity. The host holds
only a protected mirror and one immutable current reservation; no journal,
assignment scheduler, outbox worker or effect runner is added.

- Sign and stage under the existing human/owned gates. Adoption uses the next
  **original signed epoch**, while controls/recovery use the existing epoch.
  Pause/Stop/revoke/delete disable the host mirror **before** any signature can
  authorize native effects. Stop/revoke/delete retain denial even when old native
  Play ambiguity remains. Never substitute a newer mirror's epoch into a signature.
- Send only through the existing authenticated bridge and authoritative native
  core/adapter. Preserve `expectedSigner`, native reservations, environment-fresh
  preparation, ownership/deletion/send gates and both host/native checks before
  preparation and immediately before effects. These modules provide no transport
  and no native prompt/synthetic fallback.
- Settle only the exact original receipt digest/request/generation/fingerprint,
  matching native grant/epoch, current native revision and terminal denial. Read
  twice; a changed snapshot, missing ACK or still-pending current request fails
  closed. Old pending receipts may survive terminal denial, never enable sends.
- Lost signature/ACK/publication remains pending; neither signing nor acceptance
  replays an intent. Reconciliation is an explicit owner operation, not a timer.
- Native metadata migration remains unchanged: legacy maps/evidence are readable
  and need authorization. No host read/startup automatically adopts them.
  Signed adoption disables sends; **separate explicit Play** and native completion
  are required before the host accepts an enabled mirror.
- Rotation requires completed native revocation, explicit local denial and fresh
  qualified old-writer quiescence. It creates new IDs/key/generation, preserves
  the epoch floor, clears qualification and needs separate signed re-adoption/Play.
  A local emergency revoke with unresolved native ambiguity stays denied; it does
  not magically make rotation/reconciliation safe.

## Validation and remaining gates

```powershell
node --import tsx --test packages/server/src/missions/host-authority/*.test.ts packages/server/src/missions/authority-core.test.ts
$files = (Get-ChildItem packages/server/src/missions/host-authority/*.ts).FullName
npx tsc --noEmit --strict --target ES2021 --module ESNext --moduleResolution Bundler --esModuleInterop --skipLibCheck --types node $files
node --import tsx --test packages/server/src/host-lifetime/windows-storage.test.ts packages/server/src/opencode/missions/durable-plugin.test.ts
```

Focused tests use real files in fresh isolated temporary roots, real Ed25519,
the unchanged native authority core and an actual isolated `AuthManager` cookie
session. Resource/CAS/corruption tests inject an explicitly **structural-only**
file policy; it is not exposed through the production factory. The genuine default
Windows policy refused the broad temporary ancestor on this machine. The test
records that refusal rather than weakening it. Existing native ACL tests validate
current-principal/SYSTEM leaf ACLs, unsafe parents, inherited files and junctions.

Validation passed: **25 new host-authority tests + 23 unchanged native-core tests**,
strict focused TypeScript, and **21 existing durable-adapter/Windows-storage tests**.
All new sources are below 500 lines. These are implementation/unit and bounded
private-ACL checks, not proof of production native managed-writer qualification.

Still open: native private attestation/host lifetime and old-writer control
qualification; real preprovisioned private storage/atomicity under competing
processes and crash/power loss; actual coordinator route/plugin wiring and full
native transport/environment/family admission; packaged Electron/Tauri and
cross-platform/WSL parity. Managed specialist creation/cleanup and background
recovery remain outside this implementation. **No rollout is enabled.**
