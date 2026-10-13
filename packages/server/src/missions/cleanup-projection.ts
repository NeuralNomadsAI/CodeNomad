import { createHash } from "node:crypto"
import { MISSION_MAX_EVENTS, MISSION_MAX_MISSIONS, type MissionCleanup, type MissionCleanupReason, type MissionDeletedEvent, type MissionEvent } from "./model"

export function cleanupReceiptID(deletionID: string, sessionID: string): string {
  return `evt_${createHash("sha256").update(`${deletionID}\0cleanup\0${sessionID}`).digest("hex").slice(0, 28)}`
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
    } else if (event.type === "mission.session-cleaned") {
      const deletion = events.find(record => record.type === "mission.deleted" && record.missionID === event.missionID
        && record.projectID === event.projectID && record.id === event.deletionID)
      if (deletion?.type !== "mission.deleted" || !deletion.deleteManagedSessions
        || !deletion.cleanupTargets?.some(target => isCleanupReceipt(event, deletion, target.sessionID))) return true
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
  results.sort((a, b) => b.createdAt - a.createdAt || a.deletionID.localeCompare(b.deletionID))
  // Keep EVERY pending intent within the journal's existing hard bound, even if
  // newer completed deletions would otherwise push it out of the display window.
  return [...results.filter(item => item.pending > 0), ...results.filter(item => item.pending === 0).slice(0, MISSION_MAX_MISSIONS)]
    .slice(0, MISSION_MAX_EVENTS)
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
    objective: objective.slice(0, 240), removed, retained, pending, reasons: [...reasons], createdAt: deletion.createdAt }
}

export const missionCleanupSchema = {
  type: "object", properties: {
    missionID: { type: "string" }, deletionID: { type: "string" }, requestID: { type: "string" },
    expectedRevision: { type: "integer", minimum: 1 }, deleteManagedSessions: { type: "boolean" },
    objective: { type: "string", maxLength: 240 }, createdAt: { type: "number" },
    removed: { type: "integer", minimum: 0 }, retained: { type: "integer", minimum: 0 }, pending: { type: "integer", minimum: 0 },
    reasons: { type: "array", maxItems: cleanupReasons.length, items: { type: "string", enum: cleanupReasons } },
  }, required: ["missionID", "deletionID", "requestID", "expectedRevision", "deleteManagedSessions", "objective", "createdAt", "removed", "retained", "pending", "reasons"],
  additionalProperties: false,
} as const
