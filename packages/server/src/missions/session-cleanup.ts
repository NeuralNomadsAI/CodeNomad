import type { MissionDeleteInput, MissionInputTransport, MissionSessionAdapter } from "./control-types"
import { removeCleanupTarget, type MissionCleanupTarget } from "./native-session-cleanup"
import { MissionControlError } from "./control-error"
import { MissionJournal, stableToken } from "./journal"
import { MISSION_SCHEMA_VERSION, type MissionDeletedEvent, type MissionEvent, type MissionMap, type MissionSnapshot } from "./model"

// Called under the project's mutation lock, including retries across plugin reloads.
export async function deleteMission(input: MissionDeleteInput, options: {
  journal: MissionJournal
  sessions: MissionSessionAdapter
  transport?: MissionInputTransport
  isActive?: () => boolean
  timestamp(snapshot: MissionSnapshot): number
  changed(missionID: string, revision: number): Promise<void>
}): Promise<{ deleted: true }> {
  const { journal } = options
  if (options.isActive?.() === false) throw new Error("CodeNomad Missions is no longer available")
  const deleteManagedSessions = input.deleteManagedSessions ?? false
  if (typeof deleteManagedSessions !== "boolean") throw new MissionControlError("deleteManagedSessions must be a boolean", "invalid-delete-option")
  const eventID = `evt_${stableToken(`${input.missionID}\0deleted-${input.requestID}`, 28)}`
  const previous = await journal.event(input.missionID, eventID)
  let deletion: MissionDeletedEvent
  if (previous) {
    if (previous.type !== "mission.deleted" || previous.expectedRevision !== input.expectedRevision
      || (previous.deleteManagedSessions ?? false) !== deleteManagedSessions) {
      throw new MissionControlError("Delete request ID was already used with a different request", "request-conflict")
    }
    deletion = previous
  } else {
    const snapshot = await journal.snapshot()
    const mission = snapshot.missions.find((candidate) => candidate.id === input.missionID)
    if (!mission) throw new MissionControlError("Mission not found", "mission-not-found")
    if (mission.control?.pending.length) throw new MissionControlError("Finish the pending native controls before deletion", "control-pending")
    if (mission.revision !== input.expectedRevision) throw new MissionControlError("Mission changed; reload before deleting", "revision-conflict")
    const cleanupTargets = deleteManagedSessions ? managedTargets(mission) : []
    // Reserve enough room for terminal receipts before committing a destructive intent.
    await journal.assertCanAppend(1 + cleanupTargets.length)
    deletion = {
      version: MISSION_SCHEMA_VERSION, id: eventID, type: "mission.deleted", missionID: mission.id,
      projectID: mission.projectID, requestID: input.requestID, expectedRevision: input.expectedRevision,
      createdAt: options.timestamp(snapshot), deleteManagedSessions,
      ...(deleteManagedSessions ? { cleanupTargets } : {}),
    }
    await journal.append(deletion)
  }
  await options.changed(input.missionID, input.expectedRevision + 1)
  if (deleteManagedSessions && !await cleanup(deletion, options)) {
    throw new MissionControlError("Mission deleted; managed-session cleanup is pending. Retry the same deletion request.", "cleanup-pending")
  }
  return { deleted: true }
}

function managedTargets(mission: MissionMap): NonNullable<MissionDeletedEvent["cleanupTargets"]> {
  return mission.actors.filter((actor) => actor.kind === "specialist" && actor.managed
    && actor.sessionId !== mission.coordinatorSessionId
    && mission.tasks.some((task) => task.actorSessionId === actor.sessionId
      && actor.sessionId === `ses_${stableToken(`${mission.id}\0task\0${task.id}`, 26)}`))
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
  for (const [index, target] of (deletion.cleanupTargets ?? []).entries()) {
    if (options.isActive?.() === false) return false
    const receiptID = `evt_${stableToken(`${deletion.id}\0cleanup\0${target.sessionID}`, 28)}`
    try {
      const receipt = await journal.event(deletion.missionID, receiptID)
      if (receipt?.type === "mission.session-cleaned" && receipt.deletionID === deletion.id && receipt.sessionID === target.sessionID) continue
      const history = await journal.events()
      // Display snapshots deliberately truncate missions and hide tombstones. Authority
      // needs the complete bounded journal, including finished and deleted memberships.
      if (history.discardedEvents) throw new Error("Cannot establish cleanup ownership from a damaged journal")
      let outcome: "removed" | "retained" = "retained"
      if (!referencedElsewhere(history.events, deletion.missionID, target.sessionID)) {
        const created = history.events.find(event => event.type === "mission.created" && event.missionID === deletion.missionID)
        if (options.transport?.cleanup && created?.type === "mission.created") {
          outcome = (await options.transport.cleanup(created.coordinator.sessionID, {
            missionID: deletion.missionID, deletionID: deletion.id, sessionID: target.sessionID,
          })).outcome
        } else {
          outcome = await removeCleanupTarget(sessions, {
            ...target, projectID: deletion.projectID, missionID: deletion.missionID,
            coordinatorSessionID: created?.type === "mission.created" ? created.coordinator.sessionID : "",
          }, options.isActive)
        }
      }
      await journal.append({
        version: MISSION_SCHEMA_VERSION, id: receiptID, type: "mission.session-cleaned",
        missionID: deletion.missionID, projectID: deletion.projectID, deletionID: deletion.id,
        sessionID: target.sessionID, outcome, createdAt: deletion.createdAt + index + 1,
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
  if (history.discardedEvents) throw new Error("Cannot establish cleanup ownership from a damaged journal")
  const deletion = history.events.find(event => event.id === input.deletionID && event.missionID === input.missionID)
  const created = history.events.find(event => event.type === "mission.created" && event.missionID === input.missionID)
  if (deletion?.type !== "mission.deleted" || !deletion.deleteManagedSessions || created?.type !== "mission.created") return {}
  if (history.events.some(event => event.type === "mission.session-cleaned" && event.deletionID === deletion.id && event.sessionID === input.sessionID)) return {}
  const target = deletion.cleanupTargets?.find(target => target.sessionID === input.sessionID)
  if (!target || target.sessionID === created.coordinator.sessionID || referencedElsewhere(history.events, input.missionID, input.sessionID)) return {}
  return { target: { ...target, projectID: deletion.projectID, missionID: deletion.missionID, coordinatorSessionID: created.coordinator.sessionID } }
}

function referencedElsewhere(events: readonly MissionEvent[], missionID: string, sessionID: string): boolean {
  return events.some((event) => event.missionID !== missionID && (
    (event.type === "mission.created" && event.coordinator.sessionID === sessionID)
    || (event.type === "task.dispatching" && event.actor.sessionID === sessionID)
  ))
}
