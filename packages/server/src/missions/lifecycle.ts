import { MissionControlError } from "./control-error"
import type { MissionInputTransport } from "./control-types"
import { MissionJournal, parseMissionEvent } from "./journal"
import { isDeepStrictEqual } from "node:util"
import { parseMissionLifecycleReply } from "./lifecycle-schema"
import { controlOperationID, controlReceiptID, recurrenceMessageID } from "./receipt-identity"
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
  const eventID = controlOperationID(input.missionID, input.requestID)
  let snapshot = await journal.snapshot()
  let mission = snapshot.missions.find(mission => mission.id === input.missionID)
  if (!mission) throw new MissionControlError("Mission not found", "mission-not-found")
  if (snapshot.controlUnavailable || mission.controlUnavailable) throw new MissionControlError("Mission control evidence unavailable; damaged journal", "control-pending")
  const previous = await journal.event(input.missionID, eventID)
  if (previous) {
    if (previous.type !== "mission.control-requested" || previous.requestID !== input.requestID || previous.action !== input.action || previous.expectedRevision !== input.expectedRevision
      || !isDeepStrictEqual(previous.recurrence, input.recurrence)) {
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
    if (input.recurrence && (input.action !== "start" || input.requestID !== input.recurrence.passageID
      || input.recurrence.messageID !== recurrenceMessageID(input.recurrence.passageID)
      || input.recurrence.coordinatorSessionID !== mission.coordinatorSessionId || targets.length !== 1
      || targets[0].sessionID !== mission.coordinatorSessionId)) throw new MissionControlError("Invalid recurrence start identity", "control-conflict")
    const event: MissionControlRequestedEvent = {
      ...input, version: MISSION_SCHEMA_VERSION, id: eventID, type: "mission.control-requested", projectID: mission.projectID,
      targets, createdAt: options.timestamp(snapshot),
    }
    await journal.assertCanAppend(event)
    await journal.append(event)
    snapshot = await journal.snapshot()
    mission = snapshot.missions.find(mission => mission.id === input.missionID)!
    await options.changed(mission.id, mission.revision)
  }
  const operation = structuredClone(mission.control!)
  const coordinatorID = mission.coordinatorSessionId, projectID = mission.projectID
  const currentMission = (snapshot: MissionSnapshot) => {
    const fresh = snapshot.missions.find(item => item.id === input.missionID)
    if (snapshot.controlUnavailable || !fresh || fresh.controlUnavailable || options.isActive?.() === false
      || fresh.projectID !== projectID || fresh.coordinatorSessionId !== coordinatorID
      || fresh.control?.id !== operation.id || fresh.control.action !== operation.action
      || fresh.control.requestID !== operation.requestID || fresh.control.expectedRevision !== operation.expectedRevision
      || !isDeepStrictEqual(fresh.control.recurrence, operation.recurrence)
      || !isDeepStrictEqual(fresh.control.targets, operation.targets)) throw new Error("Mission control authority changed")
    return fresh
  }
  const results = await Promise.allSettled(operation.pending.map(async sessionID => {
    const before = await journal.snapshot()
    const fresh = currentMission(before)
    if (!fresh.control!.pending.includes(sessionID)) return
    if (options.isActive?.() === false || !options.transport?.lifecycle) throw new Error("Mission controls unavailable")
    const reply = await options.transport.lifecycle(fresh.coordinatorSessionId, { missionID: fresh.id, operationID: operation.id, sessionID,
      ...(operation.recurrence ? { recurrence: operation.recurrence } : {}) })
    const nativeAcknowledgement = parseMissionLifecycleReply(reply, { missionID: fresh.id, operationID: operation.id, sessionID,
      action: operation.action, ...(operation.recurrence ? { recurrence: operation.recurrence } : {}) })
    if (!nativeAcknowledgement) throw new Error("Unknown native control acknowledgement")
    const after = await journal.snapshot()
    const settled = currentMission(after)
    if (!settled.control!.pending.includes(sessionID)) return
    const receipt = {
      version: MISSION_SCHEMA_VERSION, id: controlReceiptID(operation.id, sessionID),
      type: "mission.control-applied" as const, projectID: fresh.projectID, missionID: fresh.id,
      operationID: operation.id, sessionID, nativeAcknowledgement, createdAt: options.timestamp(after),
    }
    // Never let a not-yet-adopted journal parser silently turn new known evidence
    // into a historical unknown receipt. The original target stays pending.
    const durable = parseMissionEvent(receipt)
    if (durable?.type !== "mission.control-applied" || !isDeepStrictEqual(durable.nativeAcknowledgement, nativeAcknowledgement)) {
      throw new Error("Journal cannot retain native control acknowledgement")
    }
    await journal.append(receipt, () => { if (options.isActive?.() === false) throw new Error("Mission controls unavailable") })
  }))
  mission = (await journal.snapshot()).missions.find(mission => mission.id === input.missionID)!
  await options.changed(mission.id, mission.revision)
  if (results.some(result => result.status === "rejected")) throw new MissionControlError("Mission state saved; retry the remaining native controls", "control-pending")
  return { mission }
}
