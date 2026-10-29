import { createHash } from "node:crypto"
import type { MissionCleanup, MissionCleanupReason, MissionDeletedEvent, MissionEvent } from "./model"

/** Settled cleanups shown after the pending ones. */
export const SETTLED_CLEANUP_HISTORY = 20
/** Payload bound of the displayed cleanups. */
export const MAX_PROJECTED_CLEANUPS = 2_000

/** The session a mission event makes that mission's member for shared-session cleanup checks. */
export function cleanupReference(event: MissionEvent): string | undefined {
  return event.type === "mission.created" ? event.coordinator.sessionID
    : event.type === "task.dispatching" ? event.actor.sessionID : undefined
}

/** Targets of a tombstone still awaiting their exact receipt in these events. */
export function pendingCleanupTargets(deletion: MissionDeletedEvent, events: readonly MissionEvent[]): string[] {
  return (deletion.cleanupTargets ?? []).filter(target => !events.some(event => isCleanupReceipt(event, deletion, target.sessionID)))
    .map(target => target.sessionID)
}

export function cleanupReceiptID(deletionID: string, sessionID: string): string {
  return `evt_${createHash("sha256").update(`${deletionID}\0cleanup\0${sessionID}`).digest("hex").slice(0, 28)}`
}

export const documentCleanupReceiptID = (deletionID: string) =>
  `evt_${createHash("sha256").update(`${deletionID}\0document-cleaned`).digest("hex").slice(0, 28)}`

export function isDocumentCleanupReceipt(event: MissionEvent, deletion: MissionDeletedEvent): boolean {
  return deletion.documentCleanup === true && event.type === "mission.document-cleaned"
    && event.missionID === deletion.missionID && event.projectID === deletion.projectID
    && event.deletionID === deletion.id && event.id === documentCleanupReceiptID(deletion.id)
}

export function documentCleanupPending(deletion: MissionDeletedEvent, events: readonly MissionEvent[]): boolean {
  return deletion.documentCleanup === true && !events.some(event => isDocumentCleanupReceipt(event, deletion))
}

export function isCleanupReceipt(event: MissionEvent, deletion: MissionDeletedEvent, sessionID: string): boolean {
  return event.type === "mission.session-cleaned" && event.missionID === deletion.missionID
    && event.projectID === deletion.projectID && event.deletionID === deletion.id && event.sessionID === sessionID
    && event.id === cleanupReceiptID(deletion.id, sessionID)
}

// Only cleanup-relevant orphans/identity conflicts, not display truncation or
// unrelated reducer omissions. Physical record/key identity is checked by the journal.
export function hasInvalidCleanupHistory(events: readonly MissionEvent[]): boolean {
  for (const event of events) {
    if (event.type === "mission.deleted") {
      if (!events.some(created => created.type === "mission.created" && created.missionID === event.missionID
        && created.projectID === event.projectID)) return true
      for (const target of event.cleanupTargets ?? []) {
        const receiptID = cleanupReceiptID(event.id, target.sessionID)
        const occupied = events.find(record => record.missionID === event.missionID && record.id === receiptID)
        if (occupied && !isCleanupReceipt(occupied, event, target.sessionID)) return true
      }
      if (event.documentCleanup) {
        const occupied = events.find(record => record.missionID === event.missionID && record.id === documentCleanupReceiptID(event.id))
        if (occupied && !isDocumentCleanupReceipt(occupied, event)) return true
      }
    } else if (event.type === "mission.session-cleaned") {
      const deletion = events.find(record => record.type === "mission.deleted" && record.missionID === event.missionID
        && record.projectID === event.projectID && record.id === event.deletionID)
      if (deletion?.type !== "mission.deleted" || !deletion.deleteManagedSessions
        || !deletion.cleanupTargets?.some(target => isCleanupReceipt(event, deletion, target.sessionID))) return true
    } else if (event.type === "mission.document-cleaned") {
      const deletion = events.find(record => record.type === "mission.deleted" && record.missionID === event.missionID
        && record.projectID === event.projectID && record.id === event.deletionID)
      if (deletion?.type !== "mission.deleted" || !isDocumentCleanupReceipt(event, deletion)) return true
    }
  }
  return false
}

export const cleanupReasons = ["children", "shared", "moved", "identity", "guarded"] as const
export function isCleanupReason(value: unknown): value is MissionCleanupReason {
  return typeof value === "string" && (cleanupReasons as readonly string[]).includes(value)
}

// Display/recovery metadata only. Never authorizes native removal or invents a
// target: retries still enter deleteMission's original tombstone and bridge.
export function projectMissionCleanups(events: readonly MissionEvent[]): MissionCleanup[] {
  const ordered = [...events].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const groups = new Map<string, MissionEvent[]>()
  for (const event of ordered) {
    const group = groups.get(event.missionID) ?? []
    group.push(event)
    groups.set(event.missionID, group)
  }
  const results: MissionCleanup[] = []
  for (const group of groups.values()) {
    const created = group.find(event => event.type === "mission.created")
    if (created?.type !== "mission.created") continue
    let objective = created.objective
    for (const event of group) {
      if ((event.type === "mission.updated" || event.type === "mission.revised") && event.objective !== undefined) objective = event.objective
      if (event.type !== "mission.deleted" || event.projectID !== created.projectID) continue
      results.push(projectDeletion(event, group, objective))
    }
  }
  return orderMissionCleanups(results)
}

/** Newest first: every pending cleanup, then the `settled` newest settled ones. */
export function orderMissionCleanups(results: MissionCleanup[], settled = SETTLED_CLEANUP_HISTORY): MissionCleanup[] {
  results.sort((a, b) => b.createdAt - a.createdAt || a.deletionID.localeCompare(b.deletionID))
  // Pending intents come first, so newer completed deletions never push one out of the display window.
  const pending = (item: MissionCleanup) => item.pending > 0 || item.documentPending === true
  return [...results.filter(pending), ...results.filter(item => !pending(item)).slice(0, settled)]
    .slice(0, MAX_PROJECTED_CLEANUPS)
}

function projectDeletion(deletion: MissionDeletedEvent, group: readonly MissionEvent[], objective: string): MissionCleanup {
  let removed = 0, retained = 0, pending = 0
  const reasons = new Set<MissionCleanupReason>()
  for (const target of deletion.cleanupTargets ?? []) {
    const receipt = group.find(event => isCleanupReceipt(event, deletion, target.sessionID))
    if (receipt?.type !== "mission.session-cleaned") pending++
    else if (receipt.outcome === "removed") removed++
    else { retained++; reasons.add(receipt.reason ?? "guarded") }
  }
  return { missionID: deletion.missionID, deletionID: deletion.id, requestID: deletion.requestID,
    expectedRevision: deletion.expectedRevision, deleteManagedSessions: deletion.deleteManagedSessions ?? false,
    objective: objective.slice(0, 240), removed, retained, pending, reasons: [...reasons], createdAt: deletion.createdAt,
    ...(deletion.documentCleanup ? { documentPending: documentCleanupPending(deletion, group) } : {}) }
}

export const missionCleanupSchema = {
  type: "object", properties: {
    missionID: { type: "string" }, deletionID: { type: "string" }, requestID: { type: "string" },
    expectedRevision: { type: "integer", minimum: 1 }, deleteManagedSessions: { type: "boolean" },
    objective: { type: "string", maxLength: 240 }, createdAt: { type: "number" },
    removed: { type: "integer", minimum: 0 }, retained: { type: "integer", minimum: 0 }, pending: { type: "integer", minimum: 0 },
    documentPending: { type: "boolean" },
    reasons: { type: "array", maxItems: cleanupReasons.length, items: { type: "string", enum: cleanupReasons } },
  }, required: ["missionID", "deletionID", "requestID", "expectedRevision", "deleteManagedSessions", "objective", "createdAt", "removed", "retained", "pending", "reasons"],
  additionalProperties: false,
} as const
