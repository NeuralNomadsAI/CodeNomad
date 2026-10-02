import type { MissionEvent, MissionLocation, MissionMap } from "./model"

export type MissionAction = "start" | "pause" | "stop"
export type MissionRunState = "prepared" | "running" | "paused" | "stopped"
export interface MissionLifecycleInput {
  missionID: string
  requestID: string
  expectedRevision: number
  action: MissionAction
}
export interface MissionLifecycleOperation extends MissionLifecycleInput {
  id: string
  targets: Array<{ sessionID: string; location: MissionLocation }>
  pending: string[]
}
export interface MissionControlRequestedEvent extends MissionLifecycleInput {
  version: 1
  id: string
  projectID: string
  type: "mission.control-requested"
  targets: MissionLifecycleOperation["targets"]
  createdAt: number
}
export interface MissionControlAppliedEvent {
  version: 1
  id: string
  projectID: string
  missionID: string
  type: "mission.control-applied"
  operationID: string
  sessionID: string
  createdAt: number
}

export function projectLifecycle(events: readonly MissionEvent[]): { runState: MissionRunState; control?: MissionLifecycleOperation } {
  const created = events.find(event => event.type === "mission.created")
  const operation = [...events].reverse().find(event => event.type === "mission.control-requested")
  if (!operation || operation.type !== "mission.control-requested") return { runState: created?.type === "mission.created" && created.prepared ? "prepared" : "running" }
  const acknowledged = new Set(events.flatMap(event => event.type === "mission.control-applied" && event.operationID === operation.id ? [event.sessionID] : []))
  return {
    runState: operation.action === "stop" ? "stopped" : operation.action === "pause" ? "paused" : "running",
    control: {
      id: operation.id, missionID: operation.missionID, requestID: operation.requestID, expectedRevision: operation.expectedRevision,
      action: operation.action, targets: operation.targets, pending: operation.targets.filter(target => !acknowledged.has(target.sessionID)).map(target => target.sessionID),
    },
  }
}

export function missionIsRunning(mission: Pick<MissionMap, "status" | "runState">): boolean {
  return mission.status === "active" && (mission.runState === undefined || mission.runState === "running")
}
