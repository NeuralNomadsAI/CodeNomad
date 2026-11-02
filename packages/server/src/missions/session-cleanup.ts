import type { MissionDeleteInput, MissionInputTransport, MissionSessionAdapter } from "./control-types"
import { removeCleanupTarget, type MissionCleanupTarget } from "./native-session-cleanup"
import { MissionControlError } from "./control-error"
import { MissionJournal, stableToken } from "./journal"
import { isMissionTaskSession } from "./session-identity"
import { MISSION_SCHEMA_VERSION, compareEvents, type MissionDeletedEvent, type MissionEvent, type MissionMap, type MissionSnapshot } from "./model"
import { cleanupReceiptID, cleanupReference, documentCleanupReceiptID, hasInvalidCleanupHistory, isCleanupReceipt,
  isCleanupReason, isDocumentCleanupReceipt, projectMissionCleanups } from "./cleanup-projection"
import { deletionRecordCleanup } from "./journal-purge"

// Called under the project's mutation lock, including retries across plugin reloads.
export async function deleteMission(input: MissionDeleteInput, options: {
  journal: MissionJournal
  sessions: MissionSessionAdapter
  transport?: MissionInputTransport
  isActive?: () => boolean
  timestamp(snapshot: MissionSnapshot): number
  changed(missionID: string, revision: number): Promise<void>
  beforeDelete?(deletion: MissionDeletedEvent): Promise<void>
  documentCleanupRequired?(missionID: string): Promise<boolean>
  finishDocumentCleanup?(deletion: MissionDeletedEvent): Promise<void>
}): Promise<{ deleted: true; cleanup?: import("./model").MissionCleanup }> {
  const { journal } = options
  if (options.isActive?.() === false) throw new Error("CodeNomad Missions is no longer available")
  const deleteManagedSessions = input.deleteManagedSessions ?? false
  if (typeof deleteManagedSessions !== "boolean") throw new MissionControlError("deleteManagedSessions must be a boolean", "invalid-delete-option")
  const eventID = `evt_${stableToken(`${input.missionID}\0deleted-${input.requestID}`, 28)}`
  const purged = await purgedDeletion(journal, input, eventID, deleteManagedSessions)
  if (purged) return purged
  const previous = await journal.event(input.missionID, eventID)
  let deletion: MissionDeletedEvent
  if (previous) {
    if (previous.type !== "mission.deleted" || previous.requestID !== input.requestID || previous.expectedRevision !== input.expectedRevision
      || (previous.deleteManagedSessions ?? false) !== deleteManagedSessions) {
      throw new MissionControlError("Delete request ID was already used with a different request", "request-conflict")
    }
    deletion = previous
    if (!await documentConfirmed(journal, deletion)) await options.beforeDelete?.(deletion)
  } else {
    const snapshot = await journal.snapshot()
    const mission = snapshot.missions.find((candidate) => candidate.id === input.missionID)
    if (!mission) throw new MissionControlError("Mission not found", "mission-not-found")
    if (mission.control?.pending.length) throw new MissionControlError("Finish the pending native controls before deletion", "control-pending")
    if (mission.revision !== input.expectedRevision) throw new MissionControlError("Mission changed; reload before deleting", "revision-conflict")
    const cleanupTargets = deleteManagedSessions ? managedTargets(mission) : []
    deletion = {
      version: MISSION_SCHEMA_VERSION, id: eventID, type: "mission.deleted", missionID: mission.id,
      projectID: mission.projectID, requestID: input.requestID, expectedRevision: input.expectedRevision,
      createdAt: options.timestamp(snapshot), deleteManagedSessions,
      ...(deleteManagedSessions ? { cleanupTargets } : {}),
      ...(await options.documentCleanupRequired?.(mission.id) ? { documentCleanup: true as const } : {}),
    }
    // Reserve enough room for terminal receipts before committing a destructive intent.
    await journal.assertCanAppend(deletion)
    await options.beforeDelete?.(deletion)
    await journal.append(deletion)
  }
  await options.changed(input.missionID, input.expectedRevision + 1)
  if (deleteManagedSessions) {
    const complete = await cleanup(deletion, options)
    // Receipts change cleanup display even though the active map is tombstoned.
    await options.changed(input.missionID, input.expectedRevision + 1)
    if (!complete) throw new MissionControlError("Mission deleted; managed-session cleanup is pending. Retry the same deletion request.", "cleanup-pending")
  }
  await finishDocumentCleanup(deletion, options)
  if (deletion.documentCleanup) await options.changed(input.missionID, input.expectedRevision + 1)
  if (!deleteManagedSessions && !deletion.documentCleanup) {
    await purgeSettled(journal)
    return { deleted: true }
  }
  const history = await journal.events()
  if (history.discardedEvents || hasInvalidCleanupHistory(history.events)) {
    throw new MissionControlError("Cannot confirm managed-session cleanup from a damaged journal", "cleanup-pending")
  }
  const summary = projectMissionCleanups(history.events.filter(event => event.missionID === deletion.missionID))
    .find(item => item.deletionID === deletion.id)
  if (!summary || summary.pending || summary.documentPending) throw new MissionControlError("Cannot confirm mission cleanup", "cleanup-pending")
  await purgeSettled(journal)
  return { deleted: true, cleanup: summary }
}

async function documentConfirmed(journal: MissionJournal, deletion: MissionDeletedEvent): Promise<boolean> {
  if (!deletion.documentCleanup) return false
  const receipt = await journal.event(deletion.missionID, documentCleanupReceiptID(deletion.id))
  if (receipt && !isDocumentCleanupReceipt(receipt, deletion)) throw new MissionControlError("Document cleanup evidence is invalid", "cleanup-pending")
  return receipt !== undefined
}

async function finishDocumentCleanup(deletion: MissionDeletedEvent, options: {
  journal: MissionJournal; isActive?: () => boolean
  finishDocumentCleanup?(deletion: MissionDeletedEvent): Promise<void>
}) {
  if (await documentConfirmed(options.journal, deletion)) return
  try {
    if (deletion.documentCleanup && !options.finishDocumentCleanup) throw new Error("Document cleanup unavailable")
    if (options.isActive?.() === false) throw new Error("Mission cleanup unavailable")
    await options.finishDocumentCleanup?.(deletion)
    if (!deletion.documentCleanup) return
    const history = await options.journal.missionEvents(deletion.missionID)
    if (history.discardedEvents || hasInvalidCleanupHistory(history.events)) throw new Error("Document cleanup journal is damaged")
    await options.journal.append({ version: MISSION_SCHEMA_VERSION, id: documentCleanupReceiptID(deletion.id),
      type: "mission.document-cleaned", missionID: deletion.missionID, projectID: deletion.projectID,
      deletionID: deletion.id, createdAt: deletion.createdAt }, () => {
      if (options.isActive?.() === false) throw new Error("Mission cleanup unavailable")
    })
  } catch {
    throw new MissionControlError("Mission deleted; document cleanup confirmation is pending. Retry the same deletion request.", "cleanup-pending")
  }
}

// Best effort: the deletion already committed. Older settled deletions leave the
// journal; the newest stay readable as cleanup history.
async function purgeSettled(journal: MissionJournal): Promise<void> {
  await journal.purgeDeleted().catch(() => undefined)
}

// An exact replay of a deletion whose events were purged answers from its record.
async function purgedDeletion(journal: MissionJournal, input: MissionDeleteInput, eventID: string, deleteManagedSessions: boolean) {
  const record = await journal.deletionRecord(input.missionID)
  if (!record) return undefined
  if (record.deletionID !== eventID) throw new MissionControlError("Mission not found", "mission-not-found")
  if (record.requestID !== input.requestID || record.expectedRevision !== input.expectedRevision
    || record.deleteManagedSessions !== deleteManagedSessions) {
    throw new MissionControlError("Delete request ID was already used with a different request", "request-conflict")
  }
  return deleteManagedSessions || record.documentCleanup ? { deleted: true as const, cleanup: deletionRecordCleanup(record) } : { deleted: true as const }
}

function managedTargets(mission: MissionMap): NonNullable<MissionDeletedEvent["cleanupTargets"]> {
  return mission.actors.filter((actor) => actor.kind === "specialist" && actor.managed
    && actor.sessionId !== mission.coordinatorSessionId
    && mission.tasks.some((task) => task.actorSessionId === actor.sessionId
      && isMissionTaskSession(actor.sessionId, mission.id, task.id)))
    .map((actor) => ({ sessionID: actor.sessionId, location: { ...actor.location } }))
}

async function cleanup(deletion: MissionDeletedEvent, options: {
  journal: MissionJournal
  sessions: MissionSessionAdapter
  transport?: MissionInputTransport
  isActive?: () => boolean
}): Promise<boolean> {
  const { journal, sessions } = options
  let complete = true
  const initial = await journal.events()
  if (initial.discardedEvents || hasInvalidCleanupHistory(initial.events)) return false
  for (const [index, target] of (deletion.cleanupTargets ?? []).entries()) {
    if (options.isActive?.() === false) return false
    const receiptID = cleanupReceiptID(deletion.id, target.sessionID)
    let history: MissionEvent[]
    try {
      const observation = await journal.events()
      // Display snapshots hide tombstones. Authority needs the complete bounded journal,
      // including finished and deleted memberships.
      if (observation.discardedEvents || hasInvalidCleanupHistory(observation.events)) return false
      history = observation.events
      const receipt = await journal.event(deletion.missionID, receiptID)
      if (receipt) {
        if (!isCleanupReceipt(receipt, deletion, target.sessionID)) return false
        continue
      }
    } catch {
      // Unknown receipt reads are not native-operation failures: stop before
      // touching any remaining target, rather than treating corruption as absence.
      return false
    }
    try {
      let outcome: "removed" | "retained" = "retained"
      let reason: import("./model").MissionCleanupReason | undefined = "shared"
      if (!referencedElsewhere(history, deletion.missionID, target.sessionID)) {
        const created = history.filter(event => ["mission.created", "mission.prepared"].includes(event.type) && event.missionID === deletion.missionID).sort(compareEvents).at(-1)
        if (options.transport?.cleanup && (created?.type === "mission.created" || created?.type === "mission.prepared")) {
          const result = await options.transport.cleanup(created.coordinator.sessionID, {
            missionID: deletion.missionID, deletionID: deletion.id, sessionID: target.sessionID,
          })
          outcome = result.outcome
          reason = isCleanupReason(result.reason) ? result.reason : "guarded"
        } else {
          outcome = await removeCleanupTarget(sessions, {
            ...target, projectID: deletion.projectID, missionID: deletion.missionID,
            coordinatorSessionID: created?.type === "mission.created" || created?.type === "mission.prepared" ? created.coordinator.sessionID : "",
          }, options.isActive, value => { reason = value })
        }
      }
      await journal.append({
        version: MISSION_SCHEMA_VERSION, id: receiptID, type: "mission.session-cleaned",
        missionID: deletion.missionID, projectID: deletion.projectID, deletionID: deletion.id,
        sessionID: target.sessionID, outcome, createdAt: deletion.createdAt + index + 1,
        ...(outcome === "retained" ? { reason } : {}),
      })
    } catch {
      // Keep the tombstone's immutable targets; independent targets can still finish.
      complete = false
    }
  }
  return complete
}

// Read-only authority for the authenticated desktop bridge. The mutation lock stays
// with the deleting caller while its native HTTP operation is in flight.
export async function missionCleanupTarget(journal: MissionJournal, input: {
  missionID: string; deletionID: string; sessionID: string
}): Promise<{ target?: MissionCleanupTarget }> {
  const history = await journal.events()
  if (history.discardedEvents || hasInvalidCleanupHistory(history.events)) throw new Error("Cannot establish cleanup ownership from a damaged journal")
  const deletion = history.events.find(event => event.id === input.deletionID && event.missionID === input.missionID)
  const created = history.events.filter(event => ["mission.created", "mission.prepared"].includes(event.type) && event.missionID === input.missionID).sort(compareEvents).at(-1)
  if (deletion?.type !== "mission.deleted" || !deletion.deleteManagedSessions || created?.type !== "mission.created" && created?.type !== "mission.prepared") return {}
  if (history.events.some(event => isCleanupReceipt(event, deletion, input.sessionID))) return {}
  const target = deletion.cleanupTargets?.find(target => target.sessionID === input.sessionID)
  if (!target || target.sessionID === created.coordinator.sessionID || referencedElsewhere(history.events, input.missionID, input.sessionID)) return {}
  return { target: { ...target, projectID: deletion.projectID, missionID: deletion.missionID, coordinatorSessionID: created.coordinator.sessionID } }
}

function referencedElsewhere(events: readonly MissionEvent[], missionID: string, sessionID: string): boolean {
  return events.some((event) => event.missionID !== missionID && cleanupReference(event) === sessionID)
}
