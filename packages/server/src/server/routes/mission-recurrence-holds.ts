import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { recurrenceControlStateMatches, recurrenceNotDispatchedCode, type RecurrenceControlRequest, type RecurrenceControlStatus } from "../../missions/recurrence-control-contract"
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
interface Held { binding: Binding; state: "preparing" | "dispatched" | "uncertain" | "partial"; retrying?: boolean; release(): void
  /** The uncertain start intent this explicit request supersedes, retained under its own key. */
  supersedes?: Held }
// Same bounded, fence-scoped mutation-admission retention as mission-creation-holds.
// This tracks physical permits, never auth, timers, authority, scheduling or replay.
const held = new WeakMap<WorktreeDeletionFence, Map<string, Held>>()
const key = (workspaceID: string, scheduleID: string) => JSON.stringify([workspaceID, scheduleID])
const retainedKey = (binding: Binding) => JSON.stringify([binding.workspaceID, binding.scheduleID, binding.requestID])
// Native admits these over an incomplete start intent and completes it with them (recurrence-store).
const START_INTENTS: readonly string[] = ["play", "resume", "check", "run-now"]
const SUPERSEDING: readonly string[] = ["resume", "pause", "stop", "check"]

/** The exact request's permit: the schedule's current one, or a superseded start intent. */
function locate(registry: Map<string, Held> | undefined, workspaceID: string, request: Pick<RecurrenceControlRequest, "scheduleID" | "requestID">) {
  const id = key(workspaceID, request.scheduleID), main = registry?.get(id)
  if (main?.binding.requestID === request.requestID) return { id, record: main }
  const retained = JSON.stringify([workspaceID, request.scheduleID, request.requestID]), record = registry?.get(retained)
  return record ? { id: retained, record } : { id, record: main }
}

/** Releases a settled permit. A committed superseding request also retires every start
 * intent it superseded (native completed them in the same write); a no-effect one
 * returns its superseded intent to the schedule's slot, still uncertain. */
function drop(registry: Map<string, Held>, id: string, record: Held, effective: boolean) {
  registry.delete(id); record.release()
  for (let old = record.supersedes; old; old = effective ? old.supersedes : undefined) {
    if (registry.get(retainedKey(old.binding)) !== old) continue
    if (effective) { registry.delete(retainedKey(old.binding)); old.release() }
    else if (id === key(old.binding.workspaceID, old.binding.scheduleID)) { registry.delete(retainedKey(old.binding)); registry.set(id, old) }
  }
}

export function captureRecurrenceControlHoldRead(fence: WorktreeDeletionFence, workspaceID: string,
  location: Binding["location"], request: RecurrenceControlRequest, connection: ServiceConnection): (() => boolean) | undefined {
  const registry = held.get(fence), { id, record } = locate(registry, workspaceID, request)
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
  const { record } = locate(held.get(fence), workspaceID, request)
  return !!record && record.state !== "preparing" && record.binding.connection !== connection && !!record.binding.owner
    && record.binding.requestID === request.requestID
}

/** Admission refused before preparation could hold the schedule: another
 * request's permit, a deletion entering the checkout, capacity, or a missing
 * original partial permit. A refused repeat of the held identity itself is not
 * one: that identity may already have been dispatched. */
export class RecurrenceControlBusy extends Error {}
class RecurrenceControlOutstanding extends Error {}

/** Reply for a failure strictly before `dispatched()`: this attempt sent nothing.
 * Busy admission is a conflict; other preparation failures stay unavailable. A
 * refused repeat of an outstanding identity remains uncoded and uncertain. */
export function recurrenceNotDispatchedReply(error: unknown, context?: {
  fence: WorktreeDeletionFence; workspaceID: string; request: RecurrenceControlRequest & { retry?: boolean }
}) {
  // No dispatch in this attempt is not proof about an earlier attempt with the
  // same identity. In particular an early connection failure precedes hold lookup.
  const original = context && locate(held.get(context.fence), context.workspaceID, context.request).record
  if (error instanceof RecurrenceControlOutstanding || context?.request.retry
    || original && original.binding.requestID === context?.request.requestID) return undefined
  return { status: error instanceof RecurrenceControlBusy ? 409 : 503,
    body: { error: "Recurrence request refused before dispatch; nothing was sent", code: recurrenceNotDispatchedCode } }
}

export function holdRecurrenceControl(fence: WorktreeDeletionFence, binding: Binding,
  enter: () => (() => void) | undefined, retry = false) {
  let registry = held.get(fence)
  if (!registry) { registry = new Map(); held.set(fence, registry) }
  const id = key(binding.workspaceID, binding.scheduleID)
  const previous = registry.get(id)
  // A new explicit Resume/Pause/Stop/Check may supersede an uncertain start intent
  // whose call has returned. It never takes that permit: it gets its own, and must
  // prove the exact recorded intent and same owner before dispatch. Preparing or
  // in-flight requests and partial Pause/Stop keep their exclusive permit.
  // An exact read may mark an unknown start intent `partial`; it is never retried.
  const superseding = previous && !retry && (previous.state === "uncertain" || previous.state === "partial") && !previous.retrying
    && previous.binding.requestID !== binding.requestID
    && START_INTENTS.includes(previous.binding.action) && SUPERSEDING.includes(binding.action)
    && sameLocation(previous.binding.location, binding.location) && !!previous.binding.owner && !!binding.owner
    && !registry.has(retainedKey(previous.binding)) ? previous : undefined
  if (previous && !superseding && (!retry || previous.state !== "partial" || previous.retrying || previous.binding.connection !== binding.connection
    || !sameLocation(previous.binding.location, binding.location) || previous.binding.requestID !== binding.requestID
    || previous.binding.expectedRevision !== binding.expectedRevision
    || previous.binding.action !== binding.action)) {
    const message = "Recurrence control remains uncertain; read its exact request status"
    throw previous.binding.requestID === binding.requestID ? new RecurrenceControlOutstanding(message) : new RecurrenceControlBusy(message)
  }
  const resumed = superseding ? undefined : previous
  if (!resumed && registry.size >= 128) throw new RecurrenceControlBusy("Recurrence mutation admission capacity exhausted")
  const release = resumed?.release ?? enter()
  if (!release) return undefined
  const record: Held = resumed ?? { binding: { ...binding, location: { ...binding.location } }, state: "preparing", release,
    ...(superseding ? { supersedes: superseding } : {}) }
  if (resumed) record.retrying = true
  else {
    if (superseding) registry.set(retainedKey(superseding.binding), superseding)
    registry.set(id, record)
  }
  let proven = false, effective = true
  const requiresPartialProof = retry && !previous
  let partialProven = false, supersedeProven = false
  return {
    requiresPartialProof,
    /** The exact uncertain start intent this request must prove before dispatch. */
    superseded: superseding ? { scheduleID: superseding.binding.scheduleID, requestID: superseding.binding.requestID,
      action: superseding.binding.action, expectedRevision: superseding.binding.expectedRevision } : undefined,
    /** A fresh exact native read through the current connection must show the
     * superseded request recorded and still incomplete, under the re-proven owner. */
    confirmSuperseded(receipt: RecurrenceControlStatus, owner: RecurrenceHoldOwner) {
      const old = record.supersedes, original = old?.binding
      record.binding.connection.assertCurrent()
      if (!old || !original || registry!.get(id) !== record || record.state !== "preparing" || registry!.get(retainedKey(original)) !== old
        || old.state !== "uncertain" && old.state !== "partial" || !sameOwner(original.owner, owner) || !sameOwner(record.binding.owner, owner)
        || receipt.version !== 1 || receipt.scheduleID !== original.scheduleID || receipt.requestID !== original.requestID
        || receipt.action !== original.action || receipt.expectedRevision !== original.expectedRevision
        || receipt.revision !== original.expectedRevision + 1 || receipt.outcome !== "unknown" || receipt.controlsComplete !== false
        || original.action !== "run-now" && !recurrenceControlStateMatches(original.action, receipt.state)) {
        throw new Error("Exact native start intent unavailable")
      }
      supersedeProven = true
    },
    /** A fresh backend may admit an explicit retry, never reconstruct an old
     * permit. Only an exact native partial record authorizes its first dispatch. */
    confirmPartial(receipt: RecurrenceControlStatus) {
      const original = record.binding
      original.connection.assertCurrent()
      if (registry!.get(id) !== record || !requiresPartialProof || record.state !== "preparing"
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
      if (registry!.get(id) !== record || requiresPartialProof && !partialProven || record.supersedes && !supersedeProven
        || record.state !== "preparing" && !(record.state === "partial" && record.retrying)) throw new Error("Recurrence dispatch unavailable")
      record.state = "dispatched"
    },
    /** Proven outcome: a committed receipt, or (`applied` false) a native proof that nothing applied. */
    settled(applied = true) { if (record.state === "dispatched") { proven = true; effective = applied } },
    partial() { if (record.state === "dispatched") record.state = "partial" },
    dispose() {
      if (registry!.get(id) !== record) return
      record.retrying = false
      if (record.state !== "preparing" && !proven) { if (record.state !== "partial") record.state = "uncertain"; return }
      drop(registry!, id, record, record.state !== "preparing" && effective)
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
  const registry = held.get(fence), { id, record } = locate(registry, workspaceID, request)
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
    drop(registry!, id, record, false)
    return
  }
  if (!sameLocation(location, original.location) || request.requestID !== original.requestID
    || request.expectedRevision !== original.expectedRevision
    || request.action !== original.action || receipt.scheduleID !== original.scheduleID
    || receipt.requestID !== original.requestID || receipt.expectedRevision !== original.expectedRevision
    || receipt.revision !== original.expectedRevision + 1
    || original.action !== "run-now" && !recurrenceControlStateMatches(original.action, receipt.state)) return
  ;(replaced ? connection : original.connection).assertCurrent()
  if (receipt.outcome === "committed" && receipt.controlsComplete === true) drop(registry!, id, record, true)
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
