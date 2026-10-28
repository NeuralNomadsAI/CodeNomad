import { compareEvents, type MissionCleanup, type MissionCleanupReason, type MissionDeletedEvent, type MissionEvent } from "./model"
import { cleanupReference, isCleanupReason, pendingCleanupTargets, projectMissionCleanups } from "./cleanup-projection"
import { missionTaskSessionMatcher } from "./session-identity"

/** What remains of a purged deleted mission, outside the bounded journal scan:
 * enough to refuse its recreation and to answer an exact replay of its deletion. */
export interface MissionDeletionRecord {
  version: 1
  projectID: string
  missionID: string
  deletionID: string
  requestID: string
  expectedRevision: number
  deleteManagedSessions: boolean
  /** The cleanup summary's bounded label, as the tombstone projected it. */
  objective: string
  createdAt: number
  removed: number
  retained: number
  reasons: MissionCleanupReason[]
}

/** One settled deleted mission and its events in crash-safe removal order. */
export interface MissionPurge {
  missionID: string
  record: MissionDeletionRecord
  events: MissionEvent[]
}

export function parseDeletionRecord(value: unknown, projectID: string, missionID: string): MissionDeletionRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const count = (item: unknown) => Number.isSafeInteger(item) && Number(item) >= 0
  if (record.version !== 1 || record.projectID !== projectID || record.missionID !== missionID
    || typeof record.deletionID !== "string" || !record.deletionID || typeof record.requestID !== "string" || !record.requestID
    || !Number.isSafeInteger(record.expectedRevision) || Number(record.expectedRevision) < 1
    || typeof record.deleteManagedSessions !== "boolean" || typeof record.objective !== "string" || record.objective.length > 240
    || !Number.isSafeInteger(record.createdAt) || Number(record.createdAt) <= 0
    || !count(record.removed) || !count(record.retained)
    || !Array.isArray(record.reasons) || !record.reasons.every(isCleanupReason)) return undefined
  return {
    version: 1, projectID, missionID, deletionID: record.deletionID, requestID: record.requestID,
    expectedRevision: Number(record.expectedRevision), deleteManagedSessions: record.deleteManagedSessions,
    objective: record.objective, createdAt: Number(record.createdAt), removed: Number(record.removed), retained: Number(record.retained),
    reasons: [...record.reasons] as MissionCleanupReason[],
  }
}

/** The settled cleanup summary a replayed deletion answers once its events are gone. */
export function deletionRecordCleanup(record: MissionDeletionRecord): MissionCleanup {
  return { missionID: record.missionID, deletionID: record.deletionID, requestID: record.requestID,
    expectedRevision: record.expectedRevision, deleteManagedSessions: record.deleteManagedSessions, objective: record.objective,
    removed: record.removed, retained: record.retained, pending: 0, reasons: [...record.reasons], createdAt: record.createdAt }
}

/**
 * Settled deleted missions whose events may leave a healthy journal, newest
 * deletions first after the `retainRecent` newest settled ones (which keep the
 * cleanup history and lost-acknowledgement checks readable).
 *
 * A deleted mission stays while it references (as coordinator or task actor) a
 * session that another unsettled mission could still clean up: a deterministic
 * task root of a live mission, or a pending tombstone target. That reference is
 * the shared-membership evidence the cleanup authority retains such sessions on.
 */
export function planDeletionPurge(events: readonly MissionEvent[], retainRecent: number): MissionPurge[] {
  const groups = new Map<string, MissionEvent[]>()
  for (const event of [...events].sort(compareEvents)) {
    const group = groups.get(event.missionID) ?? []
    group.push(event)
    groups.set(event.missionID, group)
  }
  const liveTasks: Array<{ missionID: string; taskID: string }> = []
  const pendingTargets = new Set<string>()
  const settled: Array<{ group: MissionEvent[]; deletions: MissionDeletedEvent[] }> = []
  for (const [missionID, group] of groups) {
    const created = group.find(event => event.type === "mission.created")
    if (!created) continue
    const deletions = group.filter((event): event is MissionDeletedEvent => event.type === "mission.deleted")
    if (!deletions.length) {
      for (const event of group) {
        if (event.type === "task.created") liveTasks.push({ missionID, taskID: event.task.id })
        else if (event.type === "mission.revised") for (const task of event.addedTasks) liveTasks.push({ missionID, taskID: task.id })
      }
      continue
    }
    const pending = deletions.flatMap(deletion => pendingCleanupTargets(deletion, group))
    for (const sessionID of pending) pendingTargets.add(sessionID)
    if (!pending.length) settled.push({ group, deletions })
  }
  const liveTaskRoot = missionTaskSessionMatcher(liveTasks)
  const cleanable = (sessionID: string) => pendingTargets.has(sessionID) || liveTaskRoot(sessionID)
  const latest = (item: { deletions: MissionDeletedEvent[] }) => item.deletions.at(-1)!
  settled.sort((left, right) => latest(right).createdAt - latest(left).createdAt || latest(left).id.localeCompare(latest(right).id))
  return settled.slice(retainRecent).flatMap(({ group, deletions }) => {
    if (group.some(event => { const sessionID = cleanupReference(event); return sessionID !== undefined && cleanable(sessionID) })) return []
    // Exactly the settled summary a replay answered while the tombstone existed.
    const summary = projectMissionCleanups(group).find(item => item.deletionID === deletions[0].id)
    if (!summary) return []
    const record: MissionDeletionRecord = {
      version: 1, projectID: deletions[0].projectID, missionID: summary.missionID, deletionID: summary.deletionID,
      requestID: summary.requestID, expectedRevision: summary.expectedRevision, deleteManagedSessions: summary.deleteManagedSessions,
      objective: summary.objective, createdAt: summary.createdAt, removed: summary.removed, retained: summary.retained,
      reasons: [...summary.reasons],
    }
    // Creation first: from then on readers resolve the incomplete group through
    // the record. Intents precede their receipts so no reservation reappears.
    const rank = (event: MissionEvent) => event.type === "mission.created" ? 0 : event.type === "mission.deleted" ? 1
      : event.type === "mission.control-requested" || event.type === "task.reported" ? 2 : 3
    return [{ missionID: summary.missionID, record, events: [...group].sort((left, right) => rank(left) - rank(right)) }]
  })
}
