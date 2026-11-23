import { compareEvents, createOrderedMissionFold, orderedMissionLookups, type MissionEvent } from "./model"
import type { NativeJournalRange } from "../opencode/missions/native-journal-range"
import { cleanupObjective, cleanupReceiptID, documentCleanupReceiptID, isCleanupReceipt, isDocumentCleanupReceipt,
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

export interface CachedJournalFold {
  digest: string
  advance(event: MissionEvent): boolean
  project: ReturnType<typeof createOrderedMissionFold>["project"]
  objectives: ReadonlyMap<number, { before: string; after: string }>
  inputSources: ReturnType<typeof createOrderedMissionFold>["inputSources"]
  taskSources: ReadonlyMap<string, string>
  reportSources: ReadonlyMap<string, string>
}

export async function foldJournalRange(range: NativeJournalRange, missionID: string, cached?: CachedJournalFold) {
  let fold: ReturnType<typeof createOrderedMissionFold> | undefined
  let related: ReadonlyMap<string, MissionEvent>, reports: ReadonlyMap<string, MissionEvent>
  const references: MissionEvent[] = [], cleanupEvents: MissionEvent[] = []
  let objective: MissionEvent | undefined
  const slots = new Set<string>()
  const objectives = new Map<number, { before: string; after: string }>()
  const seenChanges = new Set<number>()
  const taskSources = new Map<string, string>(), reportSources = new Map<string, string>()
  let last: Pick<MissionEvent, "id" | "createdAt"> | undefined
  let advanced = false
  let cleanupUnavailable = false, created = false, validEvents = 0, first: Pick<MissionEvent, "id" | "createdAt"> | undefined
  const observation = await range.readOrdered(missionID, (batch, relatedBatch, reportBatch) => {
    related = relatedBatch; reports = reportBatch
    fold!.append(batch)
    for (const id of orderedMissionLookups(batch).events) slots.add(id)
    validEvents += batch.length
    for (const event of batch) {
      first ??= { id: event.id, createdAt: event.createdAt }
      last = { id: event.id, createdAt: event.createdAt }
      const ref = reference(event)
      if (ref) references.push(ref)
      if ((event.type === "mission.updated" || event.type === "mission.prepared" || event.type === "mission.revised")
        && event.objective !== undefined) {
        objective = { ...event, objective: cleanupObjective(event.objective), notes: undefined }
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
    related = reports = new Map()
  }, (_, creation) => {
    created = creation !== undefined
    if (creation) cleanupEvents.push({ ...creation, objective: cleanupObjective(creation.objective), notes: undefined })
    fold = createOrderedMissionFold({ created: creation, readEvent: id => related.get(id),
      readReport: id => { const event = reports.get(id); return event?.type === "task.reported" ? event : undefined },
      onTask: (key, id) => taskSources.set(key, id),
      onReport: (key, id) => reportSources.set(key, reportSources.has(key) ? "" : id),
      onChange: (change, source) => {
        if (seenChanges.has(change.revision)) return
        seenChanges.add(change.revision)
        if (source.objective) objectives.set(change.revision, source.objective)
      } })
    return true
  }, cached?.digest, event => advanced = cached?.advance(event) ?? false)
  if (advanced && cached) return { observation, unchanged: false as const, advanced: true as const, ...cached.project() }
  if (!fold) return { observation, unchanged: true as const }
  const project = fold.project
  const advance = (event: MissionEvent) => {
    // These transitions have no range lookups or cleanup side effects. An
    // insert into an earlier lookup's empty slot can change the prefix's fold.
    if ((event.type !== "task.created" && event.type !== "mission.briefed") || slots.has(event.id)
      || !last || compareEvents(last, event) >= 0) return false
    fold!.append([event])
    last = { id: event.id, createdAt: event.createdAt }
    return true
  }
  return { observation, unchanged: false as const, advanced: false as const, ...project(), advance, project, objectives, inputSources: fold.inputSources, taskSources, reportSources, references, created, validEvents, first,
    cleanups: projectMissionCleanups(cleanupEvents), cleanupUnavailable: cleanupUnavailable || hasInvalidCleanupHistory(cleanupEvents) }
}
