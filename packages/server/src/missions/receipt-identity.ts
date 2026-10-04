import { createHash } from "node:crypto"
import type { MissionControlRequestedEvent } from "./lifecycle-model"
import type { MissionEvent } from "./model"
import { parseMissionNativeAcknowledgement } from "./lifecycle-schema"

export function stableToken(value: string, length = 26): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length)
}

export function controlOperationID(missionID: string, requestID: string): string {
  return `evt_${stableToken(`${missionID}\0control-${requestID}`, 28)}`
}

export function controlReceiptID(operationID: string, sessionID: string): string {
  return `evt_${stableToken(`${operationID}\0applied\0${sessionID}`, 28)}`
}

export function controlResumeAdmissionID(operationID: string, sessionID: string): string {
  return `msg_${stableToken(`${operationID}\0resume\0${sessionID}`, 28)}`
}

export function isControlReceipt(event: MissionEvent, intent: MissionControlRequestedEvent, sessionID: string): boolean {
  return event.type === "mission.control-applied" && event.projectID === intent.projectID
    && event.missionID === intent.missionID && event.operationID === intent.id && event.sessionID === sessionID
    && intent.targets.some(target => target.sessionID === sessionID) && event.id === controlReceiptID(intent.id, sessionID)
    && (event.nativeAcknowledgement === undefined || Boolean(parseMissionNativeAcknowledgement(event.nativeAcknowledgement,
      { missionID: intent.missionID, operationID: intent.id, sessionID, action: intent.action })))
}

export function hasInvalidControlHistory(events: readonly MissionEvent[]): boolean {
  const operations = new Map(events.flatMap(event => event.type === "mission.control-requested" ? [[`${event.missionID}\0${event.id}`, event] as const] : []))
  const slots = new Map([...operations.values()].flatMap(intent => intent.targets.map(target =>
    [`${intent.missionID}\0${controlReceiptID(intent.id, target.sessionID)}`, { intent, sessionID: target.sessionID }] as const)))
  const seen = new Set<string>()
  return events.some(event => {
    const slot = slots.get(`${event.missionID}\0${event.id}`)
    if (slot && !isControlReceipt(event, slot.intent, slot.sessionID)) return true
    if (event.type !== "mission.control-applied") return false
    const identity = `${event.missionID}\0${event.id}`
    if (seen.has(identity)) return true
    seen.add(identity)
    const intent = operations.get(`${event.missionID}\0${event.operationID}`)
    return !intent || !isControlReceipt(event, intent, event.sessionID)
  })
}

export function reportAdmissionID(reportID: string): string {
  return `msg_${stableToken(`report\0${reportID}`, 28)}`
}

export function reportNotificationID(missionID: string, reportID: string): string {
  return `evt_${stableToken(`${missionID}\0report-${reportID}-notified`, 28)}`
}

export function isReportReceipt(event: MissionEvent, intent: { missionID: string; projectID: string }, reportID: string): boolean {
  return event.type === "report.notified" && event.projectID === intent.projectID && event.missionID === intent.missionID
    && event.reportID === reportID && event.id === reportNotificationID(intent.missionID, reportID)
    && event.admissionID === reportAdmissionID(reportID)
}

export function hasInvalidNotificationHistory(events: readonly MissionEvent[]): boolean {
  const reports = new Map(events.flatMap(event => event.type === "task.reported" ? [[`${event.missionID}\0${event.report.id}`, event] as const] : []))
  const slots = new Map([...reports.values()].map(intent => [`${intent.missionID}\0${reportNotificationID(intent.missionID, intent.report.id)}`, intent] as const))
  return events.some(event => {
    const slot = slots.get(`${event.missionID}\0${event.id}`)
    if (slot && !isReportReceipt(event, slot, slot.report.id)) return true
    if (event.type !== "report.notified") return false
    const intent = reports.get(`${event.missionID}\0${event.reportID}`)
    return !intent || !isReportReceipt(event, intent, intent.report.id)
  })
}
