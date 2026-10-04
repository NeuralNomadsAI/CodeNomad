# Native Missions continuity authority core

2026-10-02. **Core implementation only, not enabled or release-qualified.**
The completed private prototype is documented in `MISSIONS_AUTHORITY_SPIKE.md`;
it was not rerun. These modules neither provision a signer nor register a plugin,
route, desktop lifecycle, transport or presence lease.

## Owned modules

- `packages/server/src/missions/authority-protocol.ts`: domain-separated Ed25519,
  strict typed human intent allowlist, bounded canonical JSON and full bindings.
- `authority-store.ts`: native `get/set` adapter, durable UUID, atomic project
  document, reserved quota, immutable intent digests/completion receipts.
- `authority-core.ts`: project-excluded grant CAS, adoption/revocation,
  prepared creation reservations, terminal fences, current-state retry results,
   fresh-generation metadata and fresh native admission checks.
- `authority-admission.ts`: mandatory host-grant/gate adapters and native checks
  before preparation and again before sending.
- `authority-rpc.ts`: typed read/challenge/signed-intent handlers and fail-closed
  legacy human RPC wrapper. No test-driver `invoke`, `capture`, caller session or
  generic prompt/HTTP/environment input exists.
- `authority-synchronous.ts`: shared literal-true host/core guard; rejects invalid
  asynchronous approvals while observing genuine Promise rejection without
  awaiting approval or assimilating arbitrary thenables.
- `authority-core.test.ts`: native-storage-style async JSON-copy adapter and real
  Ed25519 tests. This is unit qualification, not another native-daemon prototype.

## Plugin integration contract

1. Construct `NativeMissionAuthorityStore(ctx.storage, project.id,
   project.canonical)` in explicit plugin setup; `initialize()` creates a UUID
   only on first installation. No admission/read creates missing storage, and
   an existing document with a lost/mismatched UUID fails closed. No direct DB I/O.
2. Construct `NativeMissionAuthority` with a `NativeAuthorityAdapter`:
   - `assertActive`: native incarnation/disposal fence, independent of desktop.
   - `readSigners`: host-provisioned map (empty means no execution authority),
     **not RPC/project/native-storage input**. Each public Ed25519 signer has
     exact authority/key/profile/execution-host/UUID/project/canonical/root scope.
     More than one matching scope fails closed. Disjoint profiles/projects may
     coexist in the supplied map; there is no global-profile or last-owner fallback.
   - `assertSignerCurrent`: synchronous trusted provisioning generation/key/scope/
     qualification fence at publication and final admission. It must check the
     current host map, not reuse the preceding asynchronous signer snapshot.
     Its interface is now `AuthoritySignerSnapshot => true`, enforced at runtime:
     promises, thenables and undefined are rejected, never silently ignored.
     Signature verification supplies a detached/frozen key/scope/generation
     snapshot; a later trust read cannot substitute a new signer. Immutable
     receipts retain the original signer digest and provisioning generation, so
     pending effect reconciliation cannot settle under a replacement key.
   - `observeMission`: read the current native journal and validate every saved
     actor against its current native session, parent/project/location and the
     owned physical roots. Return a deterministic exact-root list. Do not recreate
     missing actors, accept prefixes, or infer sibling roots when Git is absent.
   - `assertJournalCapacity`: bounded read under native project exclusion,
     including native per-target control/cleanup receipt costs. Existing journal
     publication **must still reserve those slots before effects**.
3. Register `missionAuthorityHandlers` with
   `CODENOMAD_MISSIONS_AUTHORITY_RPC`; convert `MissionAuthorityError.code` into
   the declared `mission.authority-rejected` error without native detail. Native
   RPC has no caller identity. Apply `rejectUnsignedMissionMutators` to the old
   human RPC handlers: only `snapshot` and `cleanupTarget` survive. Unknown new
   methods are denied by default. Do **not** apply this wrapper to native agent
   tools or report evidence writes; those retain their native actor/task checks.
4. The `AuthorityEffectAdapter.apply` receives only a verified, reserved typed
   create/update/delete/lifecycle/recover intent. Reconstruct business input using
   the top-level mission/coordinator/requestID/revision. Creation must use the
   signed deterministic IDs and `prepared:true`, never implicit prompting.
   Run existing native business CAS and ownership checks. Return only the narrow
   `AuthorityEffectResult` references/ACKs; no journal copy, arbitrary result,
   environment, secret or private key is accepted into the completion receipt.
   A wrapper that has already authenticated a signer supplies `expectedSigner`;
   the core still verifies the signed input independently and rejects a changed
   key/scope/generation before entering reservation. The typed RPC adapter retains
   this restrictive pin; it is never an alternate source of signing authority.
5. `assertMissionControlReservation` must run before async preparation and again
   immediately before each signed native control/start/recover effect, in addition
   to the host-registry/connection/ownership checks. Regular assignments and report
   notifications use `admitWithMissionAuthority`; neither guard supplies transport.

`challenge` echoes a bounded nonce, UUID, policy and native project identity.
Authenticate its transport and compare the protected host registry before use:
this response alone is **not** adoption, human approval or managed-writer proof.
`state` exposes only a current grant/terminal/pending-ID projection, never stored
intent payloads or keys. An active grant may still have `sendsEnabled:false` or
pending effects and therefore does not itself mean admissions are available.

## Host admission contract

The backend remains the protected authority; the native grant is its mirror.
The backend must authenticate the human action before signing, pin its actual
profile/execution-host/physical family roots and native UUID, and keep private
keys outside plugin storage, shell environment, models, UI and project files.
There is intentionally no signing-key generator, provisioning file writer,
environment flag, lifecycle runner or direct-send fallback in this core.

`admitWithMissionAuthority` requires both `assertHostGrant` and `withHostGate`.
The latter must hold the **same** singleton/profile/family ownership,
connection/session-send and worktree-deletion fences used by the actual backend.
`prepare` may apply a fresh host environment but cannot send a prompt/synthetic.
After preparation, both native and host grants are reread before `send`.
Continue existing native actor/selection/location checks after awaits. Do not
claim atomic environment+HTTP admission or protection from external Git/clients.

Lock order: native `mutation:<journal.projectToken>` protects metadata reservation
and settlement; release it before calling business methods which take that same
lock. Backend send/ownership/worktree gates follow the established admission
order. Never call a native mutator from a backend callback holding a gate which
the plugin's current mutation transport is waiting on.

## Durable semantics and crash behavior

- One project document publishes grants, terminal denial and request reservations
  together with one `storage.set`. Native storage declares no CAS/transaction:
  CAS uses the existing global-symbol project exclusion inside one native JS host.
  Cross-process physical-family exclusion remains mandatory, not simulated here.
- Adoption requires revision CAS, the next epoch, active nonterminal native state
  and resolved controls. It is metadata-only and disables sends until **separate
  explicit successful Play**. Replacing another active scope is denied; revoke
  and explicit qualified re-adoption are required for handover.
- Revoke/Pause disable sends at reservation; Stop/delete also publish permanent
  terminal denial and revoke the grant **before** native effects. Settlement of
  an older Play cannot reactivate a revoked epoch or terminal mission.
- Exact request retries compare immutable canonical-body digests and return the
  current grant, not historical active state. Conflicting bodies fail. Pending
  effects are returned as pending and are **never automatically rerun**. A trusted
  integration reconciler may call `complete` with proven original-intent native
  receipts. Partial native controls still require explicit human retry of only
  current pending targets through their existing lifecycle implementation; do
  not treat a generic pending authority receipt as permission to replay work.
- Errors/lost ACK after reservation retain pending ambiguity and quota. A failed
  write before reservation produces no business effect; a write which commits
  then reports failure may leave a pending reservation but also produces no effect
  on this attempt. Native reads are fresh and fail closed, never cached fallback.
- Capacity is bounded by grants, receipts, terminal IDs and bytes;
  pending completion space is reserved before side effects. There is no pruning
  of revocation/tombstone/request identity. Exhaustion needs explicit reviewed
  archival policy, not eviction of old security evidence.
  Every active grant additionally reserves one denial receipt, terminal slot and
  enough binding/header/completion bytes. Ordinary traffic cannot consume this
  reserve. Revoke is metadata-only and does not need business-journal capacity.
  Stop/delete publish denial before their business effects; a full business journal
  may leave native interruption/cleanup pending, never an enabled grant or false
  acknowledgement of interruption. Re-adoption must reserve denial capacity anew.
  Byte reservation serializes the complete largest schema-valid denial receipt
  (including escaped request/generation metadata), the exact terminal, separators
  and grant-state growth; it does not estimate a fixed header allowance.

## Storage generation: no legacy migration

The durable journal uses `codenomad-missions/v2`, and authority documents and their
namespace UUID use `codenomad-missions/authority-v2`. These are storage generations,
not wire-format versions: event/document schema version remains `1`.

Only fresh-generation maps are read. Previous `v1` journal and `authority-v1`
bytes are left untouched and ignored: no import, migration, deletion, legacy read
fallback or legacy adoption UI. `migrateLegacy`, migration metadata/schema and
its capacity allowance have been removed. Old writers appending their explicit
old-generation keys cannot change fresh maps, grants or receipts. This boundary
does not protect against arbitrary code choosing the new keys.

A freshly created prepared mission still requires signed adoption to bind its
grant, then a separate explicit successful Play. Namespace UUID, exact physical
roots, signer generation, qualification and every existing admission fence remain
mandatory. Reports admitted in the fresh generation remain preservable after
Pause/revoke/Stop; notification sends still require current authority.

Storage separation does **not** prove exclusive native global tool/writer
registration, host-job/API ownership, environment/family exclusion or isolation of
shared native actors. Existing actor metadata is not a generation-specific proof;
this change does not independently prohibit reuse of a legacy actor. Native
old-writer qualification and protected actor ownership remain separate release
gates. No control, execution or hook policy has been weakened to claim otherwise.

One native storage write avoids a two-key torn grant/receipt, but does not prove
power-loss durability or protect against a local administrator/arbitrary daemon
plugin which already has code execution. Public-key fingerprints fence silent
key replacement under an active keyID; real key rotation requires a new reviewed
provisioning/handover protocol, not editing stored fingerprints.

## Explicit release gates still open

- Authenticated human signer provisioning and protected host grant store, real
  multi-profile/disjoint-family map distribution in one daemon, cross-host/WSL
  identity and physical family exclusion.
- Current key rotation, revocation, downgrade policy and managed old-writer
  exclusion challenge. `qualification` is a **trusted host adapter result**, not
  an approval field from a native read or user/model input. The core rejects
  `rotation-pending`, `old-writer-unexcluded`, `downgrade-unqualified`; this task
  has not qualified any real installation as `qualified`.
- Managed upgrade/disposal without implicit location reload, host lifetime,
  native independent launch and packaged Electron/Tauri parity.
- Native storage power-loss guarantees, grant publication/host-register recovery,
  audited explicit reconciliation of pending authority/native control receipts,
  bounded archival/revocation capacity policy.
- Actual route/plugin integration with fresh settings/environment, the singleton
  manager/fences, native selection/location checks and preserved late evidence.

## Focused validation

```powershell
node --import tsx --test packages/server/src/missions/authority-core.test.ts
$files = (Get-ChildItem packages/server/src/missions/authority-*.ts).FullName
npx tsc --noEmit --strict --target ES2021 --module ESNext --moduleResolution Bundler --esModuleInterop --skipLibCheck --types node $files
```

Initial focused validation passed: **18 tests**, and the TypeScript command above.
Independent bounded review found quota-blocked revocation and stale qualification
at adoption/Play publication. The denial reserve was confirmed resolved. Re-review
then exposed signer substitution between signature/trust reads and ignored async
assertions. Corrections retain the immutable verified signer and enforce a literal
  synchronous success contract; the expanded focused suite passes **23 tests**, including
enabled-grant receipt/byte exhaustion, full business journal, downgrade/key change
during observation, third-read and in-place key/generation replacement, rejecting
async/thenable assertions and rotation during Play settlement. Scoped strict
TypeScript checking verifies the async callback is rejected statically. Third
independent review closed the signer findings and found an escaped-metadata
denial-byte under-reservation. The complete receipt/terminal serialization fixes
that finding, with saturated-byte regressions for revoke/Stop/delete. Independent
re-review resolved the reserve finding and flagged a literal-policy type widening;
the `as const` correction passes scoped strict TypeScript validation. Final
independent bounded re-review reports **zero residual actionable findings** in
core/protocol/store/admission/rpc, independently repeating the 23 tests and strict
TypeScript check. No whole-refactor acceptance is claimed.
The suite also checks storage-seam monotonicity and read-only projections.
No user's daemon, application, profile,
plugin discovery/presence, filesystem settings or runtime database was mutated.
