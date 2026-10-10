import type { MissionEvent, MissionLocation, MissionMap } from "./model"
import type { SessionInboxSynthetic, SessionInterruptResponse } from "@opencode/client"
import { hasInvalidControlHistory, isControlReceipt } from "./receipt-identity"
import { MAX_REPORTED_DESCENDANTS, type MissionDescendantControl } from "./native-family-interrupt"

export type MissionAction = "start" | "pause" | "stop"
export type MissionRunState = "prepared" | "running" | "paused" | "stopped"
interface MissionNativeAcknowledgementIdentity {
  missionID: string
  operationID: string
  sessionID: string
}
/** Exact native admission/interrupt evidence, not activity or suspension proof. */
export type MissionNativeAcknowledgement = MissionNativeAcknowledgementIdentity & (
  | { action: "start"; disposition: "start-admitted"; admission: SessionInboxSynthetic }
  | { action: "pause" | "stop"; disposition: "interrupt-observed"; interrupt: SessionInterruptResponse
      cancellations: Array<{ inboxID: string; disposition: "native-acknowledged" | "observed-absent" }>
      /** Recursive native subagent interruption under this target; absent on older receipts. */
      descendants?: MissionDescendantControl }
  | { action: "pause" | "stop"; disposition: "target-missing" }
  /** Stop only: the actor now serves another active mission and was left untouched. */
  | { action: "stop"; disposition: "target-reused" }
)
export interface MissionLifecycleReceipt {
  receiptID: string
  sessionID: string
  acknowledgementState: "known" | "unknown"
  nativeAcknowledgement?: MissionNativeAcknowledgement
}
export interface MissionLifecycleInput {
  missionID: string
  requestID: string
  expectedRevision: number
  action: MissionAction
  /** Internal signed finite passage only; ordinary lifecycle omits this. */
  recurrence?: { grantID: string; passageID: string; messageID: string; coordinatorSessionID: string }
}
export interface MissionLifecycleOperation extends MissionLifecycleInput {
  id: string
  targets: Array<{ sessionID: string; location: MissionLocation }>
  pending: string[]
  receipts?: MissionLifecycleReceipt[]
  /** Journal revision when this exact operation's final target ACK was saved. */
  completedRevision?: number
  /** Start only: descendant sessions the latest preceding Pause reported interrupting. */
  pausedDescendants?: { sessions: string[]; partial: boolean }
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
  nativeAcknowledgement?: MissionNativeAcknowledgement
  createdAt: number
}

export function projectLifecycle(events: readonly MissionEvent[]): { runState: MissionRunState; control?: MissionLifecycleOperation; controlUnavailable?: boolean } {
  const created = events.find(event => event.type === "mission.created")
  const scoped = events.filter(event => !created || event.projectID === created.projectID && event.missionID === created.missionID)
  const operation = [...scoped].reverse().find(event => event.type === "mission.control-requested")
  const foreignControl = created && events.some(event => (event.type === "mission.control-requested" || event.type === "mission.control-applied")
    && (event.projectID !== created.projectID || event.missionID !== created.missionID))
  const unavailable = foreignControl || hasInvalidControlHistory(events) ? { controlUnavailable: true } : {}
  if (!operation || operation.type !== "mission.control-requested") return { ...unavailable, runState: created?.type === "mission.created" && created.prepared ? "prepared" : "running" }
  const receiptCounts = new Map<string, number>()
  for (const event of scoped) if (event.type === "mission.control-applied") receiptCounts.set(event.id, (receiptCounts.get(event.id) ?? 0) + 1)
  const receipts: MissionLifecycleReceipt[] = scoped.flatMap(event => event.type === "mission.control-applied" && receiptCounts.get(event.id) === 1 && isControlReceipt(event, operation, event.sessionID) ? [{
    receiptID: event.id, sessionID: event.sessionID, acknowledgementState: event.nativeAcknowledgement ? "known" as const : "unknown" as const,
    ...(event.nativeAcknowledgement ? { nativeAcknowledgement: event.nativeAcknowledgement } : {}),
  }] : [])
  const acknowledged = new Set(receipts.map(receipt => receipt.sessionID))
  const pending = operation.targets.filter(target => !acknowledged.has(target.sessionID)).map(target => target.sessionID)
  const completedRevision = pending.length ? undefined : events.reduce((revision, event, index) =>
    event.id === operation.id || event.type === "mission.control-applied" && isControlReceipt(event, operation, event.sessionID) ? index + 1 : revision, 0)
  const paused = operation.action === "start" ? pausedDescendants(scoped, operation) : undefined
  return {
    ...unavailable,
    runState: operation.action === "stop" ? "stopped" : operation.action === "pause" ? "paused" : "running",
    control: {
      id: operation.id, missionID: operation.missionID, requestID: operation.requestID, expectedRevision: operation.expectedRevision,
      action: operation.action, targets: operation.targets, pending, receipts,
      ...(operation.recurrence ? { recurrence: operation.recurrence } : {}),
      ...(completedRevision !== undefined ? { completedRevision } : {}),
      ...(paused ? { pausedDescendants: paused } : {}),
    },
  }
}

/** Exact receipts of the latest Pause before `start`, so Play attributes only
 * the interruptions that Pause made, never older or user interruptions. */
function pausedDescendants(events: readonly MissionEvent[], start: MissionControlRequestedEvent) {
  const before = events.slice(0, events.indexOf(start))
  const pause = [...before].reverse().find(event => event.type === "mission.control-requested")
  if (!pause || pause.type !== "mission.control-requested" || pause.action !== "pause") return undefined
  const sessions = new Set<string>()
  let partial = false
  for (const target of pause.targets) {
    const receipts = before.filter(event => event.type === "mission.control-applied" && isControlReceipt(event, pause, target.sessionID))
    const ack = receipts.length === 1 && receipts[0].type === "mission.control-applied" ? receipts[0].nativeAcknowledgement : undefined
    if (ack?.disposition === "target-missing") continue
    const descendants = ack?.disposition === "interrupt-observed" ? ack.descendants : undefined
    if (!descendants || !descendants.complete || descendants.sessions.length < descendants.interrupted) partial = true
    for (const id of descendants?.sessions ?? []) if (sessions.size < MAX_REPORTED_DESCENDANTS) sessions.add(id)
  }
  return { sessions: [...sessions], partial }
}

export function missionIsRunning(mission: Pick<MissionMap, "status" | "runState" | "controlUnavailable">): boolean {
  return !mission.controlUnavailable && mission.status === "active" && (mission.runState === undefined || mission.runState === "running")
}
