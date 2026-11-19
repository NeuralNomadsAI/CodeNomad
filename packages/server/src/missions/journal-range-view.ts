import { createOrderedMissionFold, type MissionEvent } from "./model"
import type { NativeJournalRange } from "../opencode/missions/native-journal-range"
import { cleanupReceiptID, documentCleanupReceiptID, isCleanupReceipt, isDocumentCleanupReceipt,
  hasInvalidCleanupHistory, projectMissionCleanups } from "./cleanup-projection"

/** Keep only references used by the project index, not historical bodies. */
function reference(event: MissionEvent): MissionEvent | undefined {
  switch (event.type) {
    case "mission.created":
    case "mission.prepared": return { ...event, objective: "", notes: undefined }
    case "task.dispatching":
    case "task.native-bound": return event
  }
}

export async function foldJournalRange(range: NativeJournalRange, missionID: string, cachedDigest?: string) {
  let fold: ReturnType<typeof createOrderedMissionFold> | undefined
  let related: ReadonlyMap<string, MissionEvent>, reports: ReadonlyMap<string, MissionEvent>
  const references: MissionEvent[] = [], cleanupEvents: MissionEvent[] = []
  let objective: MissionEvent | undefined
  let cleanupUnavailable = false, created = false, validEvents = 0, first: Pick<MissionEvent, "id" | "createdAt"> | undefined
  const observation = await range.readOrdered(missionID, (batch, relatedBatch, reportBatch) => {
    related = relatedBatch; reports = reportBatch
    fold!.append(batch)
    validEvents += batch.length
    for (const event of batch) {
      first ??= { id: event.id, createdAt: event.createdAt }
      const ref = reference(event)
      if (ref) references.push(ref)
      if ((event.type === "mission.updated" || event.type === "mission.prepared" || event.type === "mission.revised")
        && event.objective !== undefined) {
        objective = { ...event, objective: event.objective.slice(0, 240), notes: undefined }
      } else if (event.type === "mission.deleted") {
        if (objective) { cleanupEvents.push(objective); objective = undefined }
        cleanupEvents.push(event)
        for (const target of event.cleanupTargets ?? []) {
          const occupied = related.get(cleanupReceiptID(event.id, target.sessionID))
          if (occupied && !isCleanupReceipt(occupied, event, target.sessionID)) cleanupUnavailable = true
        }
        if (event.documentCleanup) {
          const occupied = related.get(documentCleanupReceiptID(event.id))
          if (occupied && !isDocumentCleanupReceipt(occupied, event)) cleanupUnavailable = true
        }
      } else if (event.type === "mission.session-cleaned" || event.type === "mission.document-cleaned") cleanupEvents.push(event)
    }
  }, (_, creation) => {
    created = creation !== undefined
    if (creation) cleanupEvents.push({ ...creation, objective: creation.objective.slice(0, 240), notes: undefined })
    fold = createOrderedMissionFold({ created: creation, readEvent: id => related.get(id),
      readReport: id => { const event = reports.get(id); return event?.type === "task.reported" ? event : undefined } })
    return true
  }, cachedDigest)
  if (!fold) return { observation, unchanged: true as const }
  return { observation, unchanged: false as const, ...fold.finish(), references, created, validEvents, first,
    cleanups: projectMissionCleanups(cleanupEvents), cleanupUnavailable: cleanupUnavailable || hasInvalidCleanupHistory(cleanupEvents) }
}
