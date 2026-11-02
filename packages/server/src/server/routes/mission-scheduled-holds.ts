import type { ServiceConnection } from "../../workspaces/opencode-service"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { MissionScheduleAction } from "../../missions/mission-schedule-contract"
import { sameLocation } from "../../opencode/compatibility/location"
import type { RecurrenceHoldOwner } from "./mission-recurrence-holds"
import { missionScheduleRefusalSchema } from "../../missions/mission-schedule-contract"
import { missionCreationDigest } from "./mission-creation-holds"

export type ScheduledHoldBinding = {
  missionID: string; workspaceID: string; requestID: string; action: MissionScheduleAction; expectedRevision: number; digest: string
  owner: RecurrenceHoldOwner; connection: ServiceConnection; location: { directory: string }; base: { directory: string }
  profile: string; configYamlPath: string; executionHost: string
  deleteManagedSessions?: boolean
}
type Receipt = { pending?: unknown; document?: { id?: unknown; control?: {
  requestID?: unknown; action?: unknown; expectedRevision?: unknown; pending?: unknown
} | null } | null; deletionReceipt?: { id?: unknown; requestID?: unknown; expectedRevision?: unknown; deleteManagedSessions?: unknown } }
const held = new WeakMap<WorktreeDeletionFence, Map<string, ReturnType<typeof record>>>()
export class ScheduledHoldError extends Error {
  constructor(readonly status: 409 | 503, message: string) { super(message) }
}
const current = (connection: ServiceConnection) => { try { connection.assertCurrent(); return true } catch { return false } }
export function exactScheduledRefusal(binding: ScheduledHoldBinding, raw: unknown) {
  const result = raw as { pending?: unknown; refusal?: unknown } | null, parsed = missionScheduleRefusalSchema.safeParse(result?.refusal)
  if (result?.pending !== false || !parsed.success) return false
  const refusal = parsed.data
  return refusal.missionID === binding.missionID && refusal.requestID === binding.requestID && refusal.action === binding.action
    && refusal.expectedRevision === binding.expectedRevision
    && missionCreationDigest([refusal.requestID, refusal.expectedRevision, refusal.action, refusal.payloadDigest]) === binding.digest
}
function record(binding: ScheduledHoldBinding, release: () => void, drop: () => void) {
  const original = Object.freeze({ ...binding, owner: Object.freeze({ ...binding.owner }),
    location: Object.freeze({ ...binding.location }), base: Object.freeze({ ...binding.base }) })
  let active = true, busy = false, dispatched = false, retried = false
  let connection = original.connection, releasePermit = release
  const bound = (fresh: ScheduledHoldBinding) => {
    fresh.connection.assertCurrent()
    if (!active || fresh.missionID !== original.missionID || fresh.workspaceID !== original.workspaceID
      || fresh.owner.workspace !== original.owner.workspace || fresh.owner.projectID !== original.owner.projectID
      || fresh.owner.projectCanonical !== original.owner.projectCanonical || fresh.owner.checkout !== original.owner.checkout
      || fresh.profile !== original.profile || fresh.configYamlPath !== original.configYamlPath || fresh.executionHost !== original.executionHost
      || !sameLocation(fresh.location, original.location) || !sameLocation(fresh.base, original.base)
      || fresh.requestID !== original.requestID || fresh.action !== original.action || fresh.expectedRevision !== original.expectedRevision
      || fresh.digest !== original.digest || fresh.connection !== connection && current(connection))
      throw new ScheduledHoldError(409, "Held Mission schedule scope differs")
  }
  const exact = (raw: unknown) => {
    const result = raw as Receipt | null, control = result?.document?.control
    const deleted = result?.deletionReceipt
    if (original.action === "delete" && result?.document === null && deleted)
      return deleted.id === original.missionID && deleted.requestID === original.requestID
        && deleted.expectedRevision === original.expectedRevision && deleted.deleteManagedSessions === (original.deleteManagedSessions ?? false)
    return result?.document?.id === original.missionID && control?.requestID === original.requestID
      && control.action === original.action && control.expectedRevision === original.expectedRevision && typeof control.pending === "boolean"
  }
  return {
    binding: original,
    get connection() { return connection },
    get busy() { return busy || !dispatched },
    get preparing() { return !dispatched },
    assertBound: bound,
    dispatch() {
      if (!active || busy) throw new ScheduledHoldError(503, "Mission schedule request is in flight")
      connection.assertCurrent(); busy = true; dispatched = true
    },
    retry(fresh: ScheduledHoldBinding, raw: unknown, freshRelease?: () => void) {
      bound(fresh)
      if (busy || !exact(raw) || (raw as Receipt).pending !== true || fresh.connection !== connection && !freshRelease)
        throw new ScheduledHoldError(503, "Exact partial Mission schedule receipt unavailable")
      if (fresh.connection !== connection) {
        const previous = releasePermit
        releasePermit = freshRelease!; connection = fresh.connection
        previous()
      }
      busy = true; retried = true
    },
    refuse(fresh: ScheduledHoldBinding, raw: unknown) {
      bound(fresh)
      if (!dispatched || !busy || retried || !exactScheduledRefusal(original, raw)) return false
      active = false; busy = false; drop(); releasePermit(); return true
    },
    settle(fresh: ScheduledHoldBinding, raw: unknown) {
      bound(fresh)
      if (!dispatched || !exact(raw) || (raw as Receipt).pending !== false
        || !(original.action === "delete" && (raw as Receipt).document === null && (raw as Receipt).deletionReceipt)
          && (raw as Receipt).document?.control?.pending !== false) return false
      active = false; busy = false; drop(); releasePermit(); return true
    },
    dispose() {
      busy = false
      if (active && !dispatched) { active = false; drop(); releasePermit() }
    },
  }
}

/** Fence-scoped retention only: no timers, negative-read release or dispatcher. */
export function holdScheduledMission(fence: WorktreeDeletionFence, binding: ScheduledHoldBinding, release: () => void) {
  let registry = held.get(fence)
  if (!registry) { registry = new Map(); held.set(fence, registry) }
  if (registry.has(binding.missionID)) throw new ScheduledHoldError(409, "Mission schedule request remains held")
  if (registry.size >= 128) throw new ScheduledHoldError(409, "Mission schedule hold capacity exhausted")
  const handle = record(binding, release, () => { if (registry!.get(binding.missionID) === handle) registry!.delete(binding.missionID) })
  registry.set(binding.missionID, handle)
  return handle
}
export const scheduledMissionHold = (fence: WorktreeDeletionFence | undefined, missionID: string) => fence && held.get(fence)?.get(missionID)
export const scheduledMissionCreationHold = (fence: WorktreeDeletionFence | undefined, workspaceID: string, requestID: string) =>
  fence && [...held.get(fence)?.values() ?? []].find(item => item.binding.workspaceID === workspaceID
    && item.binding.action === "create" && item.binding.requestID === requestID)
