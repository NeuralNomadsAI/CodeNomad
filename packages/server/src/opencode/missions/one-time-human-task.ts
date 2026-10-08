import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, stableToken, type MissionStorage } from "../../missions/journal"
import type { MissionJsonValue, MissionNativeBinding } from "../../missions/model"
import { sameNativeCall } from "../../missions/native-report-provenance"
import { sameLocation } from "../compatibility/location"

/** Read only the owned ordinary journal. No artifact, task-name inference,
 * standing parent, synthetic conversation or compatibility namespace. */
export async function selectOneTimeHumanTask(input: {
  entries: readonly { key: string; value: MissionJsonValue }[]
  projectID: string; projectCanonical: string; location: { directory: string; workspaceID?: string }
  rootID: string; sessionID: string; purpose: "reply" | "evidence"
}) {
  const prefix = `${MISSION_JOURNAL_STORAGE_PREFIX}/${stableToken(`${input.projectID}\0${input.projectCanonical}`, 24)}`
  const storage: MissionStorage = {
    get: async key => input.entries.find(entry => entry.key === key)?.value,
    set: async () => { throw new Error("Human decision journal is read-only") },
    scan: async ({ prefix: requested, after, limit = 100 }) => {
      if (requested !== prefix || limit !== 100) throw new Error("Human decision journal scope mismatch")
      const entries = input.entries.filter(entry => entry.key.startsWith(`${prefix}/`) && (!after || entry.key > after))
      return { entries: entries.slice(0, limit), ...(entries.length > limit ? { next: entries[limit - 1].key } : {}) }
    },
  }
  const journal = new MissionJournal(storage, input.projectID, input.projectCanonical)
  const snapshot = await journal.snapshot()
  if (snapshot.discardedEvents || snapshot.cleanupUnavailable || snapshot.controlUnavailable || snapshot.notificationUnavailable)
    throw new Error("Ordinary human decision journal is incomplete")
  const missions = snapshot.missions.filter(mission => mission.template === "wayfinder"
    && mission.coordinatorSessionId === input.rootID)
  if (!missions.length) return undefined
  const candidates = missions.flatMap(mission => mission.tasks.filter(task => task.role === "decision"
    && task.actorSessionId === input.sessionID).map(task => ({ mission, task })))
  if (candidates.length !== 1) throw new Error("Exact ordinary Wayfinder decision actor unavailable")
  const { mission, task } = candidates[0], call = task.nativeExecution?.binding
  if (mission.projectID !== input.projectID || mission.projectCanonical !== input.projectCanonical
    || task.executionMode?.kind !== "native" || !call || !task.nativeBinding
    || task.nativeBinding.generation !== call.generation || task.nativeBinding.parentSessionID !== call.parentSessionID
    || call.generation !== task.contractGeneration || task.nativeExecution?.observationConflict)
    throw new Error("Ordinary human decision current call mismatch")
  if (input.purpose === "reply" && (mission.status !== "active" || mission.runState !== "running"
    || mission.control?.pending.length || !["queued", "dispatching"].includes(task.status) || task.nativeExecution?.ended))
    throw new Error("Ordinary human decision is inactive")
  const mode = task.executionMode
  const parentID = mode.parentTaskKey === null ? mission.coordinatorSessionId
    : mission.tasks.find(parent => parent.key === mode.parentTaskKey)?.actorSessionId
  const actor = mission.actors.find(actor => actor.sessionId === input.sessionID)
  const root = mission.actors.find(actor => actor.sessionId === input.rootID && actor.kind === "coordinator")
  if (!actor || actor.kind !== "specialist" || !actor.roles.includes("decision") || !root
    || !sameLocation(actor.location, input.location) || !sameLocation(root.location, input.location)
    || call.parentSessionID !== parentID) throw new Error("Ordinary human decision family mismatch")
  const history = await journal.events()
  if (!history.events.some(event => event.missionID === mission.id
    && (event.type === "task.native-bound" || event.type === "task.native-call-started")
    && event.taskKey === task.key && sameNativeCall(event.binding, call)
    && (event.type === "task.native-bound" ? event.actor.sessionID : event.childSessionID) === input.sessionID))
    throw new Error("Ordinary human decision call was not accepted")
  return { mission, task, call: { ...call } as MissionNativeBinding,
    execution: task.execution ?? mission.profiles?.roles?.decision }
}
