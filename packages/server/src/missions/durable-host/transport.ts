import { admitMissionInput } from "../../server/routes/mission-input"
import type { MissionAuthorityCheckpoint } from "../../server/routes/mission-authority-checkpoint"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { DurableMissionAdmission, DurableMissionsHost, DurableMissionTransportReceipt } from "../../opencode/missions/durable-plugin"
import type { ProtectedHostAuthority } from "../host-authority/store"
import { authorityDigest, canonicalAuthority, rejectAuthority, type AuthoritySignerSnapshot } from "../authority-protocol"
import { matchBinding } from "../host-authority/model"
import { assertSynchronousAuthorityGuard } from "../authority-synchronous"
import type { CanonicalMissionRoots } from "./roots"

export type AdmissionManager = Parameters<typeof admitMissionInput>[0]
type ConnectionManager = Pick<WorkspaceManager, "getSharedServiceConnection">
// Multiple mission slots in the same owned backend share native-target admission.
// The manager identity owns this cache; settled tails are removed, no scheduler.
const managerTails = new WeakMap<object, Map<string, Promise<unknown>>>()

/** The ONLY native write implementation is the existing backend admission route.
 * No SDK prompt/synthetic/interrupt shortcut, browser grant, generic proxy or
 * replay exists here. Serialization is per native target within this host slot. */
export function createCanonicalMissionTransport(input: {
  manager: AdmissionManager & ConnectionManager; fence: WorktreeDeletionFence; workspaceID: string
  authority: ProtectedHostAuthority; roots: CanonicalMissionRoots; assertNativeCurrent(): true
}): DurableMissionsHost["transport"] {
  let tails = managerTails.get(input.manager)
  if (!tails) { tails = new Map(); managerTails.set(input.manager, tails) }
  const ownedTails = tails
  return { async execute(request, options) {
    // Capture a detached immutable contract. Plugin checkpoint is deliberately
    // invoked again after every route preparation await, not admission evidence.
    canonicalAuthority(request, 512 * 1024)
    const captured = structuredClone(request) as DurableMissionAdmission
    // Pin the plugin's ORIGINAL lease before queue waits. Never look it up again
    // by digest after an old RPC has settled or a new retry has begun.
    const humanCurrent = options.assertHumanCurrent
    const assertHuman = () => {
      if (!captured.intent) return // already-granted autonomous delivery
      if (!humanCurrent) rejectAuthority("authorization-blocked")
      assertSynchronousAuthorityGuard(humanCurrent, "policy-unqualified")
    }
    assertHuman()
    if (captured.kind === "cleanup") rejectAuthority("authorization-blocked")
    const key = captured.input.sessionID
    const previous = ownedTails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(async () => {
      assertHuman()
      options.signal.throwIfAborted()
      const state = await input.authority.read()
      if (!state?.signer || state.state !== "qualified" || state.binding.coordinatorSessionID !== captured.coordinatorID) rejectAuthority("authorization-blocked")
      const signer: AuthoritySignerSnapshot = state.signer
      const binding = state.binding
      const connection = await input.manager.getSharedServiceConnection(input.workspaceID)
      if (!connection) rejectAuthority("observation-unavailable")
      const current = (): true => {
        assertHuman()
        options.signal.throwIfAborted(); connection.assertCurrent()
        assertSynchronousAuthorityGuard(input.assertNativeCurrent, "policy-unqualified")
        input.authority.assertSignerCurrent(signer)
        input.roots.current(binding.roots)
        if (captured.intent) input.authority.assertReservationCurrent(captured.intent)
        if (!captured.intent) {
          if (!captured.grant) rejectAuthority("authorization-blocked")
          input.authority.assertHostGrantCurrent(captured.grant)
        }
        return true
      }
      const checkpoint: MissionAuthorityCheckpoint = {
        async prepare() {
          assertHuman()
          await options.assertCurrent()
          await input.roots.assertRoots(binding.roots)
          const fresh = await input.authority.read()
          if (!fresh || canonicalAuthority(fresh.binding) !== canonicalAuthority(binding)) rejectAuthority("binding-mismatch")
          if (captured.grant) matchBinding(captured.grant, binding)
          if (captured.intent) {
            matchBinding(captured.intent, binding)
            if (fresh.pendingDigest !== authorityDigest(captured.intent)
              || captured.grant && captured.grant.epoch !== captured.intent.epoch) rejectAuthority("epoch-conflict")
            // Exact signed reservation permits terminal controls, not free sends.
            if (captured.kind === "lifecycle" ? captured.intent.method !== "lifecycle"
              : captured.kind !== "synthetic" || captured.intent.method !== "recover") rejectAuthority("binding-mismatch")
          } else {
            if (!captured.grant) rejectAuthority("authorization-blocked")
            await input.authority.assertHostGrant(captured.grant)
          }
          current()
        }, current,
      }
      await checkpoint.prepare()
      // admitMissionInput/applyMissionLifecycle reconstruct from the authoritative
      // native map and compare input/location/execution; this request is not trust.
      return admitMissionInput(input.manager, input.fence, captured.coordinatorID,
        { kind: captured.kind, input: captured.input }, options.signal, checkpoint)
    })
    ownedTails.set(key, result)
    try { return await result as DurableMissionTransportReceipt }
    finally { if (ownedTails.get(key) === result) ownedTails.delete(key) }
  } }
}
