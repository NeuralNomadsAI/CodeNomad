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

/** Status joins the two durable control ledgers. Calendar completion alone never
 * releases an actor-family control whose receipt is still absent or partial. */
export async function nativeMissionScheduleResult(ctx: Plugin.Context, doc: MissionDocument | MissionDocumentTombstone | undefined,
  run: MissionNativeRunner, forcePending = false, requestID?: string) {
  const result = missionScheduleView(doc, undefined, doc && !("deletedAt" in doc) ? await nativeMissionScheduleObservation(ctx, doc, run) : undefined)
  if (!doc || "deletedAt" in doc) return { ...result,
    pending: result.pending || forcePending || !!(requestID && (!doc || doc.requestID !== requestID)) }
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
  let actorPending = false
  if (control && (["pause", "stop", "resume", "delete"].includes(control.action)
    || control.action === "play" && !initial && doc.pending.createdAt < control.startedAt)) {
    try {
      const storage: MissionStorage = { get: key => run(ctx.storage.get(key)), scan: input => run(ctx.storage.scan(input)),
        set: async () => { throw new Error("schedule-status-read-only") } }
      const snapshot = await missionDocumentPassage(storage, doc, () => true).journal.snapshot()
      const journal = snapshot.missions[0]
      actorPending = !!(snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable)
        || snapshot.missions.length > 1 || (!journal ? doc.pending.admittedAt !== null || !!doc.pending.admissionAttempted
          : journal.control?.requestID !== control.requestID || !!journal.control.pending.length)
    } catch { actorPending = true }
  }
  return { ...view, pending: unresolved || actorPending || forcePending }
}
