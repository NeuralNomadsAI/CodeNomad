import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { recurrenceControlStateMatches, type RecurrenceControlRequest, type RecurrenceControlStatus } from "../../missions/recurrence-control-contract"
import { sameLocation } from "../../opencode/compatibility/location"
import type { ServiceConnection } from "../../workspaces/opencode-service"

/** Persistent ownership the permit was admitted under: the backend's workspace
 * object, the native project whose plugin storage holds the schedule, and the
 * physical checkout entered in the deletion fence. A replacement connection may
 * only settle the original permit after a fresh read proves all of them again. */
export interface RecurrenceHoldOwner { workspace: object; projectID: string; projectCanonical: string; checkout: string }
interface Binding extends RecurrenceControlRequest {
  workspaceID: string; location: { directory: string; workspaceID?: string }; connection: ServiceConnection; owner?: RecurrenceHoldOwner
}
interface Held { binding: Binding; state: "preparing" | "dispatched" | "uncertain" | "partial"; retrying?: boolean; release(): void }
// Same bounded, fence-scoped mutation-admission retention as mission-creation-holds.
// This tracks physical permits, never auth, timers, authority, scheduling or replay.
const held = new WeakMap<WorktreeDeletionFence, Map<string, Held>>()
const key = (workspaceID: string, scheduleID: string) => JSON.stringify([workspaceID, scheduleID])

export function captureRecurrenceControlHoldRead(fence: WorktreeDeletionFence, workspaceID: string,
  location: Binding["location"], request: RecurrenceControlRequest, connection: ServiceConnection): (() => boolean) | undefined {
  const registry = held.get(fence), id = key(workspaceID, request.scheduleID), record = registry?.get(id)
  if (!record || record.state === "preparing" || record.binding.connection !== connection || !sameLocation(record.binding.location, location)
    || record.binding.requestID !== request.requestID || record.binding.expectedRevision !== request.expectedRevision
    || record.binding.action !== request.action) return undefined
  // Deletion may be queued, but cannot enter this originally owned root while
  // its physical permit is retained. This exact read is settlement, not mutation.
  return () => {
    record.binding.connection.assertCurrent()
    return registry!.get(id) === record && record.state !== "preparing"
  }
}

/** True when an exact dispatched permit survives from a replaced connection, so a
 * status read must re-prove its owner before it can settle that permit. */
export function recurrenceControlHeldElsewhere(fence: WorktreeDeletionFence, workspaceID: string,
  request: RecurrenceControlRequest, connection: ServiceConnection): boolean {
  const record = held.get(fence)?.get(key(workspaceID, request.scheduleID))
  return !!record && record.state !== "preparing" && record.binding.connection !== connection && !!record.binding.owner
    && record.binding.requestID === request.requestID
}

export function holdRecurrenceControl(fence: WorktreeDeletionFence, binding: Binding,
  enter: () => (() => void) | undefined, retry = false) {
  let registry = held.get(fence)
  if (!registry) { registry = new Map(); held.set(fence, registry) }
  const id = key(binding.workspaceID, binding.scheduleID)
  const previous = registry.get(id)
  if (retry && !previous) throw new Error("Original partial recurrence control hold unavailable; read exact status instead")
  if (previous && (!retry || previous.state !== "partial" || previous.retrying || previous.binding.connection !== binding.connection
    || !sameLocation(previous.binding.location, binding.location) || previous.binding.requestID !== binding.requestID
    || previous.binding.expectedRevision !== binding.expectedRevision
    || previous.binding.action !== binding.action)) throw new Error("Recurrence control remains uncertain; read its exact request status")
  if (!previous && registry.size >= 128) throw new Error("Recurrence mutation admission capacity exhausted")
  const release = previous?.release ?? enter()
  if (!release) return undefined
  const record: Held = previous ?? { binding: { ...binding, location: { ...binding.location } }, state: "preparing", release }
  if (previous) record.retrying = true
  else registry.set(id, record)
  let proven = false
  return {
    dispatched() {
      if (registry!.get(id) !== record || record.state !== "preparing" && !(record.state === "partial" && record.retrying)) throw new Error("Recurrence dispatch unavailable")
      record.state = "dispatched"
    },
    settled() { if (record.state === "dispatched") proven = true },
    partial() { if (record.state === "dispatched") record.state = "partial" },
    dispose() {
      if (registry!.get(id) !== record) return
      record.retrying = false
      if (record.state !== "preparing" && !proven) { if (record.state !== "partial") record.state = "uncertain"; return }
      registry!.delete(id); release()
    },
  }
}

/** An explicit exact completed request is positive publication evidence. Missing,
 * unknown or mismatched reads can never release a dispatched permit. Through a
 * replacement connection only a committed, complete receipt releases it, and only
 * when `owner` was freshly re-proven equal to the admitted owner; that connection
 * never inherits the permit, a partial retry or any other admission right. */
export function reconcileRecurrenceControlHold(fence: WorktreeDeletionFence, workspaceID: string,
  location: Binding["location"], request: RecurrenceControlRequest, receipt: RecurrenceControlStatus, connection: ServiceConnection,
  owner?: RecurrenceHoldOwner): void {
  const registry = held.get(fence), id = key(workspaceID, request.scheduleID), record = registry?.get(id)
  if (!record || record.state === "preparing") return
  const original = record.binding, replaced = original.connection !== connection
  if (replaced && !sameOwner(original.owner, owner)) return
  if (!sameLocation(location, original.location) || request.requestID !== original.requestID
    || request.expectedRevision !== original.expectedRevision
    || request.action !== original.action || receipt.scheduleID !== original.scheduleID
    || receipt.requestID !== original.requestID || receipt.expectedRevision !== original.expectedRevision
    || receipt.revision !== original.expectedRevision + 1
    || original.action !== "run-now" && !recurrenceControlStateMatches(original.action, receipt.state)) return
  ;(replaced ? connection : original.connection).assertCurrent()
  if (receipt.outcome === "committed" && receipt.controlsComplete === true) { registry!.delete(id); record.release() }
  else if (!replaced && receipt.controlsComplete === false) record.state = "partial"
}

/** Fresh owner read through the current connection; the caller has already
 * revalidated directory ownership and keeps its workspace/connection fences. */
export async function readRecurrenceHoldOwner(manager: { getWorktreeIdentityForPath(id: string, directory: string): Promise<string | undefined> },
  workspaceID: string, workspace: object, directory: string, client: ServiceConnection["client"], signal: AbortSignal): Promise<RecurrenceHoldOwner | undefined> {
  const info = await client.location.get({ location: { directory } }, { signal })
  const checkout = await manager.getWorktreeIdentityForPath(workspaceID, directory)
  if (!checkout || !sameLocation(info, { directory }) || typeof info.project?.id !== "string" || typeof info.project.canonical !== "string") return undefined
  return { workspace, projectID: info.project.id, projectCanonical: info.project.canonical, checkout }
}

function sameOwner(admitted: RecurrenceHoldOwner | undefined, fresh: RecurrenceHoldOwner | undefined) {
  return !!admitted && !!fresh && admitted.workspace === fresh.workspace && admitted.projectID === fresh.projectID
    && admitted.projectCanonical === fresh.projectCanonical && admitted.checkout === fresh.checkout
}
