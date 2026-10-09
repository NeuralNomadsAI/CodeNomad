import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { recurrenceControlStateMatches, type RecurrenceControlRequest, type RecurrenceControlStatus } from "../../missions/recurrence-control-contract"
import { sameLocation } from "../../opencode/compatibility/location"
import type { ServiceConnection } from "../../workspaces/opencode-service"

interface Binding extends RecurrenceControlRequest { workspaceID: string; location: { directory: string; workspaceID?: string }; connection: ServiceConnection }
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
 * unknown or mismatched reads can never release a dispatched permit. */
export function reconcileRecurrenceControlHold(fence: WorktreeDeletionFence, workspaceID: string,
  location: Binding["location"], request: RecurrenceControlRequest, receipt: RecurrenceControlStatus, connection: ServiceConnection): void {
  const registry = held.get(fence), id = key(workspaceID, request.scheduleID), record = registry?.get(id)
  if (!record || record.state === "preparing" || record.binding.connection !== connection) return
  const original = record.binding
  if (!sameLocation(location, original.location) || request.requestID !== original.requestID
    || request.expectedRevision !== original.expectedRevision
    || request.action !== original.action || receipt.scheduleID !== original.scheduleID
    || receipt.requestID !== original.requestID || receipt.expectedRevision !== original.expectedRevision
    || receipt.revision !== original.expectedRevision + 1
    || original.action !== "run-now" && !recurrenceControlStateMatches(original.action, receipt.state)) return
  original.connection.assertCurrent()
  if (receipt.outcome === "committed" && receipt.controlsComplete === true) { registry!.delete(id); record.release() }
  else if (receipt.controlsComplete === false) record.state = "partial"
}
