import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { recurrenceControlStateMatches, recurrenceNotDispatchedCode, type RecurrenceControlRequest, type RecurrenceControlStatus } from "../../missions/recurrence-control-contract"
import { sameLocation } from "../../opencode/compatibility/location"
import type { ServiceConnection } from "../../workspaces/opencode-service"

/** Persistent ownership the permit was admitted under: the backend's workspace
 * object, the native project whose plugin storage holds the schedule, and the
 * physical checkout entered in the deletion fence. A replacement connection may
 * only settle the original permit after a fresh read proves all of them again. */
export interface RecurrenceHoldOwner { workspace: object; projectID: string; projectCanonical: string; checkout: string }
/** Canonical physical root and Settings profile authority of a human admission. */
export interface RecurrenceHoldAdmission { root: string; profile: string }
interface Binding extends RecurrenceControlRequest {
  workspaceID: string; location: { directory: string; workspaceID?: string }; connection: ServiceConnection; owner?: RecurrenceHoldOwner
  admission?: RecurrenceHoldAdmission
}
interface Held {
  binding: Binding; state: "preparing" | "dispatched" | "uncertain" | "partial"; retrying?: boolean; release(): void
  /** Fresh admission proving itself before it may retire this replaced-connection permit. */
  successor?: object
}
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

/** Settlement read of an exact permit retained from a retired connection, through
 * the current one. Like the original read it may proceed while a deletion waits
 * on that permit, but it only reads: the caller must still prove Location
 * ownership and re-prove the owner, and can at most release the permit. */
export function captureReplacedRecurrenceHoldRead(fence: WorktreeDeletionFence, workspaceID: string,
  location: Binding["location"], request: RecurrenceControlRequest, connection: ServiceConnection): (() => boolean) | undefined {
  const registry = held.get(fence), id = key(workspaceID, request.scheduleID), record = registry?.get(id)
  if (!record || record.state === "preparing" || record.binding.connection === connection || current(record.binding.connection)
    || !record.binding.owner || !sameRequest(record.binding, { ...request, location })) return undefined
  return () => {
    connection.assertCurrent()
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

/** Admission refused before preparation could hold the schedule: another
 * request's permit, a deletion entering the checkout, capacity, or a missing
 * original partial permit. A refused repeat of the held identity itself is not
 * one: that identity may already have been dispatched. */
export class RecurrenceControlBusy extends Error {}
class RecurrenceControlOutstanding extends Error {}

/** Reply for a failure strictly before `dispatched()`: THIS attempt sent nothing.
 * Busy admission is a conflict; other preparation failures stay unavailable.
 * The code is never evidence about another attempt with the same identity: an
 * explicit retry, or a repeat of an identity this backend still holds, stays
 * uncoded. Without such a permit (for example after a backend restart, when the
 * failure also precedes any native read) the route cannot know whether the
 * client sent that identity before, so only a client's genuine first attempt may
 * treat the code as "no effect"; a client repeating an identity must keep it
 * uncertain and read its exact status. */
export function recurrenceNotDispatchedReply(error: unknown, context?: {
  fence: WorktreeDeletionFence; workspaceID: string; request: RecurrenceControlRequest & { retry?: boolean }
}) {
  // An early connection failure precedes any native read, so an earlier
  // attempt's effect is unknowable here; only a retained permit marks it known.
  const original = context && held.get(context.fence)?.get(key(context.workspaceID, context.request.scheduleID))
  if (error instanceof RecurrenceControlOutstanding || context?.request.retry
    || original && original.binding.requestID === context?.request.requestID) return undefined
  return { status: error instanceof RecurrenceControlBusy ? 409 : 503,
    body: { error: "Recurrence request refused before dispatch; this attempt sent nothing", code: recurrenceNotDispatchedCode } }
}

export function holdRecurrenceControl(fence: WorktreeDeletionFence, binding: Binding,
  enter: () => (() => void) | undefined, retry = false) {
  let registry = held.get(fence)
  if (!registry) { registry = new Map(); held.set(fence, registry) }
  const id = key(binding.workspaceID, binding.scheduleID)
  const previous = registry.get(id)
  const reuses = !!previous && retry && previous.state === "partial" && !previous.retrying && !previous.successor
    && previous.binding.connection === binding.connection && sameRequest(previous.binding, binding)
  // Within the same backend the original partial/uncertain permit may outlive its
  // retired connection. An explicit exact retry through the current connection
  // may prepare a fresh admission beside it, but only with the identical
  // re-proven owner, root and profile; it retires the old permit at dispatch,
  // after the native partial proof, and never inherits or steals it.
  const replaces = !!previous && retry && (previous.state === "partial" || previous.state === "uncertain")
    && !previous.retrying && !previous.successor && previous.binding.connection !== binding.connection
    && !current(previous.binding.connection) && sameRequest(previous.binding, binding)
    && sameOwner(previous.binding.owner, binding.owner) && sameAdmission(previous.binding.admission, binding.admission)
  if (previous && !reuses && !replaces) {
    const message = "Recurrence control remains uncertain; read its exact request status"
    throw previous.binding.requestID === binding.requestID ? new RecurrenceControlOutstanding(message) : new RecurrenceControlBusy(message)
  }
  if (!previous && registry.size >= 128) throw new RecurrenceControlBusy("Recurrence mutation admission capacity exhausted")
  // A deletion already waiting on the old permit blocks this fresh entry.
  const release = reuses ? previous!.release : enter()
  if (!release) return undefined
  const record: Held = reuses ? previous! : { binding: { ...binding, location: { ...binding.location } }, state: "preparing", release }
  if (reuses) record.retrying = true
  else if (replaces) previous!.successor = record
  else registry.set(id, record)
  /** Whether this attempt still owns its schedule slot (a successor: still beside its predecessor). */
  const owned = () => replaces && registry!.get(id) !== record
    ? registry!.get(id) === previous && previous!.successor === record && !current(previous!.binding.connection)
    : registry!.get(id) === record
  let proven = false
  const requiresPartialProof = retry && !reuses
  let partialProven = false
  return {
    requiresPartialProof,
    /** A fresh backend may admit an explicit retry, never reconstruct an old
     * permit. Only an exact native partial record authorizes its first dispatch. */
    confirmPartial(receipt: RecurrenceControlStatus) {
      const original = record.binding
      original.connection.assertCurrent()
      if (!owned() || !requiresPartialProof || record.state !== "preparing"
        || !["pause", "stop"].includes(original.action) || receipt.version !== 1
        || receipt.scheduleID !== original.scheduleID || receipt.requestID !== original.requestID
        || receipt.action !== original.action || receipt.expectedRevision !== original.expectedRevision
        || receipt.revision !== original.expectedRevision + 1 || receipt.outcome !== "unknown"
        || receipt.controlsComplete !== false || !recurrenceControlStateMatches(original.action, receipt.state)) {
        throw new Error("Exact native partial recurrence record unavailable")
      }
      partialProven = true
    },
    dispatched() {
      if (!owned() || requiresPartialProof && !partialProven
        || record.state !== "preparing" && !(record.state === "partial" && record.retrying)) throw new Error("Recurrence dispatch unavailable")
      record.binding.connection.assertCurrent()
      if (registry!.get(id) !== record) {
        // Retire the replaced-connection permit only now: the fresh permit is
        // already entered, so deletion never observes an unheld checkout.
        previous!.successor = undefined
        registry!.set(id, record)
        previous!.release()
      }
      record.state = "dispatched"
    },
    /** Proven outcome: a committed receipt, or a native proof that nothing applied. */
    settled() { if (record.state === "dispatched") proven = true },
    partial() { if (record.state === "dispatched") record.state = "partial" },
    dispose() {
      if (replaces && registry!.get(id) !== record) {
        // Never promoted: the predecessor keeps its permit; drop only this one.
        if (previous!.successor !== record) return
        previous!.successor = undefined; release(); return
      }
      if (registry!.get(id) !== record) return
      record.retrying = false
      if (record.state !== "preparing" && !proven) { if (record.state !== "partial") record.state = "uncertain"; return }
      registry!.delete(id); release()
    },
  }
}

/** An explicit exact completed request is positive publication evidence, and an
 * exact native `rejected` receipt proves no publication. Missing, unknown or
 * mismatched reads can never release a dispatched permit. Through a
 * replacement connection, a committed complete receipt or an exact proven native
 * refusal of a non-partial request releases it only when `owner` was freshly
 * re-proven equal to the admitted owner; that connection
 * never inherits the permit, a partial retry or any other admission right. */
export function reconcileRecurrenceControlHold(fence: WorktreeDeletionFence, workspaceID: string,
  location: Binding["location"], request: RecurrenceControlRequest, receipt: RecurrenceControlStatus, connection: ServiceConnection,
  owner?: RecurrenceHoldOwner): void {
  const registry = held.get(fence), id = key(workspaceID, request.scheduleID), record = registry?.get(id)
  if (!record || record.state === "preparing") return
  const original = record.binding, replaced = original.connection !== connection
  if (replaced && !sameOwner(original.owner, owner)) return
  // Native proof that the exact request never applied and never can: no effect to hold.
  if (receipt.outcome === "rejected") {
    if (!sameLocation(location, original.location) || request.requestID !== original.requestID
      || request.expectedRevision !== original.expectedRevision || request.action !== original.action
      || receipt.scheduleID !== original.scheduleID || receipt.requestID !== original.requestID
      || receipt.expectedRevision !== original.expectedRevision || record.state === "partial") return
    ;(replaced ? connection : original.connection).assertCurrent()
    registry!.delete(id); record.release()
    return
  }
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

function sameAdmission(admitted: RecurrenceHoldAdmission | undefined, fresh: RecurrenceHoldAdmission | undefined) {
  return !!admitted && !!fresh && admitted.root === fresh.root && admitted.profile === fresh.profile
}

function sameRequest(admitted: Binding, fresh: RecurrenceControlRequest & { location: Binding["location"] }) {
  return sameLocation(admitted.location, fresh.location) && admitted.scheduleID === fresh.scheduleID
    && admitted.requestID === fresh.requestID && admitted.expectedRevision === fresh.expectedRevision
    && admitted.action === fresh.action
}

/** A retired connection never becomes current again. */
function current(connection: ServiceConnection) {
  try { connection.assertCurrent(); return true } catch { return false }
}
