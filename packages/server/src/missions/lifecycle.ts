import { MissionControlError } from "./control-error"
import type { MissionInputTransport } from "./control-types"
import { MissionJournal, stableToken } from "./journal"
import type { MissionLifecycleInput, MissionControlRequestedEvent } from "./lifecycle-model"
import { MISSION_SCHEMA_VERSION, type MissionMap, type MissionSnapshot } from "./model"

// Explicit user actions only. Report recovery never calls this module.
// The caller owns the same project lock used by dispatch and report admission.
export async function controlMission(input: MissionLifecycleInput, options: {
  journal: MissionJournal
  transport?: MissionInputTransport
  isActive?: () => boolean
  timestamp(snapshot: MissionSnapshot): number
  changed(missionID: string, revision: number): Promise<void>
}): Promise<{ mission: MissionMap }> {
  const { journal } = options
  const eventID = `evt_${stableToken(`${input.missionID}\0control-${input.requestID}`, 28)}`
  let snapshot = await journal.snapshot()
  let mission = snapshot.missions.find(mission => mission.id === input.missionID)
  if (!mission) throw new MissionControlError("Mission not found", "mission-not-found")
  const previous = await journal.event(input.missionID, eventID)
  if (previous) {
    if (previous.type !== "mission.control-requested" || previous.action !== input.action || previous.expectedRevision !== input.expectedRevision) {
      throw new MissionControlError("Control request ID already used", "request-conflict")
    }
    // A completed old action must never undo a newer pause or terminal stop.
    if (mission.control?.id !== eventID || !mission.control.pending.length) return { mission }
  } else {
    if (mission.status !== "active") throw new MissionControlError("Finished missions cannot be restarted", "mission-finished")
    if (mission.revision !== input.expectedRevision) throw new MissionControlError("Mission changed; reload before controlling it", "revision-conflict")
    if (mission.control?.pending.length && input.action !== "stop") throw new MissionControlError("Retry the pending control action first", "control-pending")
    const state = mission.runState ?? "running"
    if ((input.action === "start" && state !== "prepared" && state !== "paused") || (input.action === "pause" && state !== "running")) {
      throw new MissionControlError("Action is not valid in the current mission state", "control-conflict")
    }
    const targets = mission.actors.filter(actor => input.action !== "start" || actor.kind === "coordinator"
      || mission!.tasks.some(task => task.actorSessionId === actor.sessionId && (task.status === "queued" || task.status === "dispatching" || task.outstandingExecution)))
      .map(actor => ({ sessionID: actor.sessionId, location: { ...actor.location } }))
    await journal.assertCanAppend(1 + targets.length)
    const event: MissionControlRequestedEvent = {
      ...input, version: MISSION_SCHEMA_VERSION, id: eventID, type: "mission.control-requested", projectID: mission.projectID,
      targets, createdAt: options.timestamp(snapshot),
    }
    await journal.append(event)
    snapshot = await journal.snapshot()
    mission = snapshot.missions.find(mission => mission.id === input.missionID)!
    await options.changed(mission.id, mission.revision)
  }
  const operation = mission.control!
  const results = await Promise.allSettled(operation.pending.map(async sessionID => {
    if (options.isActive?.() === false || !options.transport?.lifecycle) throw new Error("Mission controls unavailable")
    await options.transport.lifecycle(mission!.coordinatorSessionId, { missionID: mission!.id, operationID: operation.id, sessionID })
    await journal.append({
      version: MISSION_SCHEMA_VERSION, id: `evt_${stableToken(`${operation.id}\0applied\0${sessionID}`, 28)}`,
      type: "mission.control-applied", projectID: mission!.projectID, missionID: mission!.id,
      operationID: operation.id, sessionID, createdAt: options.timestamp(await journal.snapshot()),
    })
  }))
  mission = (await journal.snapshot()).missions.find(mission => mission.id === input.missionID)!
  await options.changed(mission.id, mission.revision)
  if (results.some(result => result.status === "rejected")) throw new MissionControlError("Mission state saved; retry the remaining native controls", "control-pending")
  return { mission }
}
