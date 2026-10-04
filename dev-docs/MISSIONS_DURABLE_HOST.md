# Canonical durable Missions host

## Delivered frontier

`packages/server/src/missions/durable-host/` now composes the protected host
authority/file store, native authority RPC, real durable plugin host interface and
the existing backend admission routes. `server/routes/mission-authority-actions.ts`
provides normalized authenticated-human action helpers for the existing router.
This is executable composition, not a duplicate authority engine or a callback-only
transport proposal. It is deliberately **not imported by startup/packaging and
registers no HTTP routes**. The real private native RuntimeSession/backend proof
channel is independently owned and unavailable here; rollout remains closed.

Only the new journal `codenomad-missions/v2` and authority
`codenomad-missions/authority-v2` are used. No old bytes are read/imported/deleted,
no `migrateLegacy` is restored, and no migration/administration UI is added.
Core signature/grant/denial-capacity semantics remain unchanged; its read-only
receipt method is described below. The corrective frontier below adds restrictive
human-request checkpoints to core/plugin publication, without editing the journal,
host-lifetime, native runtime, family-claim implementation, UI or #824.

## Factory and private native handoff

The public entry is:

```ts
createCanonicalDurableMissionsHost({
  nativeHost, auth, manager, workspaceID, fence, familyClaims,
}) // -> { host, authority, actions }
```

- `nativeHost.open()` must return the **genuine authenticated sustained private
  native channel** from the independently qualified persistent parent/backend.
  `QualifiedNativeMissionChannel` is the precise handoff contract, not a JSON proof,
  feature flag, HTTP credential store or attestation issuer. There is no default,
  environment gate, permissive bool, no-op qualifier or production mock.
- Construction checks the channel's mandatory **synchronous literal-true** fence
  before reading its staging scope and again after composition. The channel
  provides the protected parent scope, fresh managed-writer bridge, exact native
  namespace/project/canonical identity and fresh
  family-claim verifier. These values must come from private native verification,
  never browser/root options or daemon bootstrap environment.
- The production factory constructs `ProtectedAuthorityFiles` with its real
  `HostStorage`/`privateStorage`/Windows DACL policy. It exposes no file-policy,
  signer, key or qualification override. Its internal `assemble…` function exists
  only to exercise identical composition with isolated file-policy fixtures;
  it is not exported by `durable-host/index.ts` or wired to HTTP.
- `AuthManager` remains the sole human-auth/session authority. The helper uses
  existing cookies and carries that exact session fence through in-flight human
  native effects and publication, not only before/after the RPC. Existing
  router auth, origin and request protections must remain in place. No second
  HTTP auth store, password handoff or generic RPC proxy is added.
- `familyClaims` are explicit **held object capabilities from the shared physical
  FamilyAuthorityStore**, not profile-specific new stores or caller root strings.
  The native channel must verify their current protected owner/receipt identity
  synchronously. A callback returning true without this native/private check is
  not qualification. Missing/unproven claims deny every root/admission.

The native owner still needs to connect `ProtectedNativeMissionHostFactory.open`
to the real private RuntimeSession channel. This implementation does not guess or
patch that owner's APIs. Returning an injected fixture channel is **not proof**
that production attestation, old-writer exclusion or persistent lifetime works.

## Canonical root and mutation ownership

`CanonicalMissionRoots` first asks WorkspaceManager to authorize the location on
the authenticated connection. Only then does it map the service path, read the
physical checkout and `readFamilyAuthorityIdentity` (Git common-directory), match
the explicit held claim, await its current protected marker, and run the native
synchronous claim fence. Full directory/family/checkout identities are compared,
not path prefixes or native project IDs. Read paths never acquire/adopt claims.

Local Git roots are implemented. WSL/remote mapping is deliberately denied when
the mapped path is not the same local physical execution-host path; a Windows
path translation cannot establish Linux Git-family ownership. A qualified native
cross-host root resolver is a future seam, not a guessed identity. Directory-only
durable continuity is likewise denied without a trustworthy physical claim model.

`canonicalAuthorityOwnership` uses the real WorkspaceManager connection,
coordinator root/session ownership, root resolver and WorktreeDeletionFence. It
requires an existing selected root coordinator; it does not create managed actors,
infer moved roots or adopt on startup. The factory's transport serializes native
target admissions across all mission slots sharing that manager, with settled
tails removed. This is bounded owned-backend serialization, not exclusion of
arbitrary external native clients or a background dispatcher.

## Human methods and native authority/mirror coupling

`actions.create(request, { requestID, coordinatorSessionId, payload }, signal)`:

1. Checks the existing human cookie and private native channel.
2. Reads and authorizes the selected native root coordinator and physical claim.
3. Derives the deterministic mission ID from project/request identity, prepares
   the protected local key slot explicitly, then signs a typed **prepared** create.
4. Dispatches only the native authority RPC with final host signer/reservation,
   human, native and root fences. It does not call SDK session creation directly.
5. Accepts only a fresh original completed native receipt. The selected session's
   agent/model/location stay unchanged; new managed specialists remain excluded.

`actions.execute(request, { method, requestID, expectedRevision,
expectedHostRevision, payload }, signal)` supports only normalized
`update/lifecycle/recover/delete/adopt/revoke` payloads. Unknown fields, caller
grant/epoch/key/namespace/roots/driver input and managed-session deletion are
rejected. Full bindings and original epochs are reconstructed from the protected
host state. Adoption and Play are **separate explicit human actions**; neither
create/read/startup/adoption starts work automatically.

The native core still owns epochs, native storage CAS, quota/denial reservation,
immutable receipts and business effects. Protected signing stages its exact
original reservation first. Pause/Stop/revoke/delete disable the host mirror
before the signature can reach effects. Failed native Stop retains both native
and host denial with an honest pending receipt; no retry, ACK fabrication,
replay, legacy fallback or synthetic transport escape is attempted.

`CanonicalNativeAuthority` uses the authenticated connection's challenge/state/
receipt/intent and native Mission snapshot RPCs. Settlement:

- challenges exact namespace/project identity before **and after** waiting;
- reads the native state, exact original receipt, authoritative journal snapshot,
  receipt again and state again, rejecting any change;
- preserves the signed request ID/digest/provisioning generation/epoch and current
  native revision; the protected registry then performs its own mandatory two reads;
- uses the exact completed terminal receipt for deletion whose live map is gone;
- never clears a reservation from a cached intent response or resends an intent
  to pretend that a mutation endpoint is a read-only receipt query.

**Receipt producer gap closed:** `codenomad.missions.authority.receipt` is now a
strict typed read-only native method registered by the actual durable plugin.
`NativeMissionAuthority.readReceipt({ intent, digest })` validates the full original
typed intent and digest, namespace/project/canonical identity, mission/request,
profile/key/host/coordinator/physical roots, method and epoch against the recorded
receipt. It returns `{ namespace, projectID, projectCanonical, receipt }`, with
one immutable detached receipt or `null` for an unknown exact request. Pending
receipts retain absent completion; historical completed evidence remains readable
after revocation/deletion without a current signer or live mission map.

The producer calls only `store.read`; it never initializes, transacts, repairs,
executes/retries effects, acquires a signer, reserves capacity or sends a native
message. Existing store read validation/bounds still apply. It checks plugin
activity before and after the storage await, bounds the cloned native response,
and uses a static redacted declared RPC error. `authority.state` stays unchanged.
`authority-receipt.ts` contains only the narrow query/response wire schemas.
The unsigned journal namespace still rejects a `receipt`-named method; only the
declared authority namespace allows it. No generic RPC proxy or unsigned human
writer is exposed.

The canonical reader now performs both exact receipt RPC reads on the **same
authenticated, ownership/family/connection-fenced client and location** as its
state/snapshot reads, bracketed by namespace challenges. The external
`PrivateAuthorityReceiptReader` and channel callback have been removed. Fixtures
use the real product RPC registration; their fault hook can only perturb a decoded
wire response, never supply a host-side raw-storage producer or cached ACK.
Managed-writer/native RuntimeSession qualification remains necessary for trusted
host signing/admission, **not for this project-readable evidence producer**.

Only completed, freshly accepted native Stop/delete terminal receipts trigger
release of the exact held family claim. Failure leaves the claim held. Another
profile cannot acquire the same physical-family store while it is held; release
permits a later **explicit** acquisition, never an automatic takeover.

## Final admission path

`createCanonicalMissionTransport` never calls SDK prompt/synthetic/interrupt
itself. It captures an immutable plugin request and calls the **same**
`admitMissionInput` / `applyMissionLifecycle` functions used by the canonical bridge.
Those routes reconstruct assignment/report/recovery/control inputs from the
authoritative native map, reject forged contracts, verify actor membership,
location, execution selection and ownership, and retain the deletion fence and
per-send complete profile environment snapshot.

The only route extension is a private, optional `MissionAuthorityCheckpoint`
construction dependency (never parsed from HTTP). Durable transport always
provides it; existing non-durable callers are unchanged. It adds:

- asynchronous plugin reservation/grant revalidation and fresh physical-root/
  family-claim checks after environment/readiness preparation;
- fresh synchronous managed-channel, immutable signer, protected original
  reservation or full enabled host grant checks immediately before actual native
  environment, prompt, synthetic, interruption and inbox-cancel effects;
- session/location ownership rereads after checkpoint awaits, including coordinator
  rechecks in lifecycle admission, so awaited preparation cannot authorize a move;
- protected denial, original native epoch and profile/key/root matching, not trust
  in a browser or transport command;
- explicit cleanup denial: unqualified managed-session deletion is not routed.

The host store gains only `assertReservationCurrent(originalIntent): true`, a
fresh synchronous protected-file pending-digest/full-binding fence. It allows
already signed terminal effects with a disabled grant; it is not free send
authorization. The existing shared literal-true guard and immutable signer hooks
are reused rather than copied. Git-context synchronization remains the existing
advisory route behavior; a tiny instruction-client adapter adds the same synchronous
fence at its actual put/remove after the Git probe await. This change does not
introduce another environment path or edit the shared Git-context helper.

## Validation and boundaries

```powershell
node --import tsx --test packages/server/src/missions/durable-host/*.test.ts packages/server/src/server/routes/mission-authority-checkpoint.test.ts packages/server/src/server/routes/mission-input.test.ts packages/server/src/server/routes/mission-lifecycle.test.ts
```

Tests exercise real temporary files, Git physical identity, the shared
FamilyAuthorityStore, real AuthManager cookie sessions, product durable-plugin
setup/tools/control/journal/native authority and the real canonical routes. They
cover separate create/adopt/Play, assignments/reports, key/grant changes during
environment preparation and recovery readiness, loss after the environment ACK,
tampered live dispatch, missing native proof/family/WSL mapping, cookie loss,
readonly receipt substitution, failed Stop, final native terminal release and
cross-profile family exclusion. Source files remain below 500 lines.

The file policy and sustained native proof in those isolated tests are explicitly
**injected/unqualified**, not production DACL/RuntimeSession proof. No shared
daemon/database/provider/user-profile storage is touched. Native/host-lifetime
gates, packaged Electron/Tauri/WSL/cross-platform
qualification, full shared-family/native-root enforcement and new managed-actor
creation/cleanup remain with their respective owners. No startup/packaging, UI,
installation, service restart, agents, commit/push or rollout is performed here.

The prior frontier passed **95 tests**, including 17 composition/admission/
checkpoint tests. The receipt implementation adds focused producer and actual
product-RPC regressions for full-scope mismatches, cloning, pending evidence,
disposal across storage awaits, namespace isolation, changed native epoch between
reads, moved coordinator ownership and deletion without recreation. Run the full
combined regression set, including `missions/authority-receipt.test.ts` and
`durable-host/receipt.test.ts`, plus focused and complete server TypeScript:

```powershell
$files = @((Get-ChildItem packages/server/src/missions/durable-host/*.ts).FullName, (Get-ChildItem packages/server/src/server/routes/mission-authority*.ts).FullName, 'packages/server/src/server/routes/mission-input.ts', 'packages/server/src/server/routes/mission-lifecycle.ts') | ForEach-Object { $_ }
npx tsc --noEmit --strict --target ES2021 --module ESNext --moduleResolution Bundler --esModuleInterop --skipLibCheck --types node $files
npm run typecheck --workspace @neuralnomads/codenomad
```

`git diff --check` passed for touched existing route/store files (only native line
ending advisories). Every new source is below 500 lines. These results qualify the
delivered isolated composition, **not production native continuity or rollout**.

Native OpenCode 2.0.21 fixture qualification is the coordinator/next owner's
handoff. The coordinator-owned native runner was not edited or run in this change.
Remaining gates are the real native compiler/private-channel binding and sustained
managed-writer proof, global physical-family claim distribution/native-root
enforcement, and packaged host/platform qualification—not a missing receipt API.

Receipt handoff validation: **110 tests passed** (the previous 95 plus **7 new
read-only core/RPC tests and 8 new actual product-RPC/canonical-reader tests**).
All **23 existing authority-core regressions** still pass, including original
generation guards and denial-capacity reservations. Focused strict TypeScript and
the **complete server TypeScript check** both passed. These are isolated product
domain/RPC-registration tests, not an actual OpenCode service or managed-writer
qualification claim. All touched sources remain below 500 lines.

## Human in-flight fence and cancellation corrections

`human-intents.ts` owns a per-composition, bounded (128 outstanding entries),
ephemeral map keyed by the exact immutable **signed intent digest**, including its
signature. `CanonicalNativeAuthority.execute` registers the original human cookie
and cancellation fence before RPC preparation and removes/settles the lease in
`finally`. No AsyncLocalStorage, global current-human callback, second auth store,
dispatcher, retry, timer or watchdog is involved.

The native plugin captures that stable lease synchronously at RPC entry, before
its first await. Missing/settled scopes deny; a captured old or missing scope cannot
join a newer retry even for identical signed bytes. The guard is restrictive only:
all signature, immutable signer, host reservation/grant, native reservation, epoch,
ownership and native capability checks still apply. Standalone qualified test-host
adapters may omit the optional restrictive capture seam; the canonical factory
always supplies it, and canonical HUMAN transport always requires the captured
guard. Every approval must be synchronous literal `true`; promises/thenables and
missing/malformed results fail closed without awaiting attacker thenables.

The captured guard follows human native reservation, journal reservation/ACK,
per-target queue waits, environment preparation and ACK, actual synthetic/prompt/
interrupt effects, and final native completion publication. In particular, a late
Play completion cannot reenable native sends after the original human session
expires. Already-granted **autonomous** assignments/reports retain their native and
protected grant fences but do not acquire an unrelated browser cookie dependency.

The original signal also reaches protected `prepare`, `sign` and `accept` admission
and existing CAS pre-publication fences. Pre-aborted create and Pause are exact
no-ops for protected bytes/revision/pending/native state/write/provider counts.
Abortion during ownership, private qualification or protected preparation prevents
publication. Errors/cancellation after legitimate native writes leave honest
reservations and ACK evidence; there is no inferred rollback, replay or completion.
Cancellation is checked at checkpoints, not a promise that an already-issued native
write can be undone, nor interruption of autonomous already-granted work.

Dedicated real canonical-fixture regressions live in `cancellation.test.ts` and
`human-fences.test.ts`; `human-intents.test.ts` additionally covers exact-signature
correlation, bounds, concurrent isolation, stale/missing leases and malformed
guards. Cookie-expiry tests remove the actual isolated AuthManager SessionManager
entry while preserving its original request cookie. Native invocation cancellation
is deliberately independent in this fixture, demonstrating that no remote RPC
signal propagation or ambient request context is assumed.

The sustained private native channel and fixture file policy remain injected and
**unqualified**. This correction qualifies isolated request-fence behavior only,
not whole-refactor acceptance, production continuity, native compiler/transport
binding or packaged desktop rollout. No startup/packaging, manager/family, HTTP
server wiring or native-service-launcher scope is changed.

Final corrective validation passed: **142 expanded tests** (including **25 new
regressions** across the three dedicated files), **41 additional existing control/
lifecycle/readiness/storage-isolation regressions**, focused strict TypeScript,
and the **complete server TypeScript check**. A scoped whitespace/line-count check
passed; every touched source is below 500 lines (largest: `authority-core.ts`,
381 lines). The final expanded run used `node --import tsx --test
--test-concurrency=1` with the full file list above plus `host-authority/*.test.ts`,
`authority-core.test.ts`, `authority-receipt.test.ts` and
`opencode/missions/durable-plugin.test.ts`; it finished in **277.7 s**, with no
failures, cancellations or skips.

Earlier parallel aggregate runs exceeded 180/360 s and are not pass evidence.
An initial report-based queue fixture also exceeded its serial fixture deadline;
it was replaced with deterministic queuing of the same real signed Play admission
before either attempt writes natively. The final serial command above passed that
regression and the entire expanded set. File-level serial execution does not
remove the explicit concurrent-intent lease isolation regressions.
