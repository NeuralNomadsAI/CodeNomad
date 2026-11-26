import type { Plugin } from "@opencode/plugin/effect"
import type { MissionDocument, MissionDocumentTombstone } from "../../missions/mission-document"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import type { MissionStorage } from "../../missions/journal"
import { missionScheduleView } from "../../missions/mission-schedule-view"
import type { MissionNativeRunner } from "./native-service-adapter"
import { nativeScheduleOwnerControlReceipt } from "./native-schedule-owner"
import { nativeMissionScheduleObservation } from "./native-mission-schedule-display"

export const nativeImmediatePlayPassage = (doc: MissionDocument, requestID: string) =>
  [doc.pending, ...doc.history].find(item => item?.origin.kind === "immediate" && item.origin.requestID === requestID)

/** Check keeps its public receipt identity while reconciling the original actor control. */
export function nativeMissionScheduleActorControl(doc: MissionDocument, requestID?: string) {
  const owner = doc.calendarOwner
  const control = requestID ? nativeScheduleOwnerControlReceipt(doc, requestID) : owner?.receipts.at(-1) ?? owner?.operation
  if (control?.action !== "check") return control
  const original = owner?.checks.find(item => item.requestID === control.requestID)?.originalRequestID
  return original ? nativeScheduleOwnerControlReceipt(doc, original)
    : [...owner?.receipts ?? []].reverse().find(item => ["pause", "stop", "resume", "play"].includes(item.action))
}

/** Status joins the two durable control ledgers. Calendar completion alone never
 * releases an actor-family control whose receipt is still absent or partial. */
export async function nativeMissionScheduleResult(ctx: Plugin.Context, doc: MissionDocument | MissionDocumentTombstone | undefined,
  run: MissionNativeRunner, forcePending = false, requestID?: string) {
  const result = missionScheduleView(doc, undefined, doc && !("deletedAt" in doc) ? await nativeMissionScheduleObservation(ctx, doc, run) : undefined)
  if (!doc || "deletedAt" in doc) {
    const checked = doc && requestID ? doc.checks?.find(item => item.requestID === requestID) : undefined
    return { ...result,
      ...(checked ? { checkReceipt: { id: doc!.id, requestID: checked.requestID, expectedRevision: checked.expectedRevision, action: "check" as const } } : {}),
      pending: result.pending || forcePending || !!(requestID && (!doc || doc.requestID !== requestID && !checked)) }
  }
  const owner = doc.calendarOwner
  const control = requestID ? nativeScheduleOwnerControlReceipt(doc, requestID) : owner?.receipts.at(-1) ?? owner?.operation
  const initial = control?.action === "play" ? nativeImmediatePlayPassage(doc, control.requestID) : undefined
  const initialUnconfirmed = !!initial && initial.admittedAt === null && !("reason" in initial && initial.reason === "not-started")
  const manual = requestID ? [doc.pending, ...doc.history].find(item => item?.origin.kind === "manual" && item.origin.requestID === requestID) : undefined
  const manualRevision = manual && "manualExpectedRevision" in manual ? manual.manualExpectedRevision : undefined
  const manualControl = manual && typeof manualRevision === "number" && Number.isSafeInteger(manualRevision) && manualRevision >= 0
    ? { requestID: requestID!, expectedRevision: manualRevision, action: "run-now", pending: manual.admittedAt === null && !("reason" in manual && manual.reason === "not-started") } : null
  const controlView = control ? { requestID: control.requestID, expectedRevision: control.expectedRevision, action: control.action, pending: control.pending || initialUnconfirmed }
    : manualControl ?? (requestID && doc.creation?.requestID === requestID ? { requestID, expectedRevision: 0, action: "create", pending: false } : null)
  const view = { ...result, document: { ...result.document!, control: requestID || initial ? controlView : result.document!.control } }
  const originalUnconfirmed = doc.pending?.origin.kind === "immediate" && doc.pending.admittedAt === null
  const unresolved = !!doc.deletion || originalUnconfirmed || initialUnconfirmed || (requestID ? !controlView || controlView.pending : result.pending)
  if (!doc.pending) return { ...view, pending: unresolved || forcePending }
  const actorControl = nativeMissionScheduleActorControl(doc, requestID)
  const actorInitial = actorControl?.action === "play" ? nativeImmediatePlayPassage(doc, actorControl.requestID) : undefined
  let actorPending = control?.action === "check" && !actorControl
  if (actorControl && (["pause", "stop", "resume", "delete"].includes(actorControl.action)
    || actorControl.action === "play" && !actorInitial && doc.pending.createdAt < actorControl.startedAt)) {
    try {
      const storage: MissionStorage = { get: key => run(ctx.storage.get(key)), scan: input => run(ctx.storage.scan(input)),
        set: async () => { throw new Error("schedule-status-read-only") } }
      const snapshot = await missionDocumentPassage(storage, doc, () => true).journal.snapshot()
      const journal = snapshot.missions[0]
      actorPending = !!(snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable)
        || snapshot.missions.length > 1 || (!journal ? doc.pending.admittedAt !== null || !!doc.pending.admissionAttempted
          : journal.control?.requestID !== actorControl.requestID || !!journal.control.pending.length)
    } catch { actorPending = true }
  }
  return { ...view, pending: unresolved || actorPending || forcePending }
}
