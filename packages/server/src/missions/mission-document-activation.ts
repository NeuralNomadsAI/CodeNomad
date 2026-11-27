import { canonicalAuthority } from "./authority-protocol"
import { requiresMissionCalendar } from "./launch-policy"
import { missionScheduleActivationSchema, type MissionDocument, type MissionScheduleActivation } from "./mission-document"

export function prepareMissionScheduleActivation(doc: MissionDocument, input: MissionScheduleActivation) {
  const intent = missionScheduleActivationSchema.parse(input)
  if (doc.state !== "paused" || doc.pending || doc.preparation?.pending || doc.oneTime && !doc.dormantJournal || doc.deletion || doc.synchronization || doc.blocked
    || !requiresMissionCalendar(doc.configuration.launch)) throw new Error("Mission activation unavailable")
  if (doc.scheduleActivation) {
    // A preparation that failed, or that stored configuration targets, has no
    // effect in flight: a fresh human request replaces it, and an old phase then
    // fails the request fence.
    if ((doc.scheduleActivation.state === "failed" || doc.scheduleActivation.state === "partial")
      && intent.requestID !== doc.scheduleActivation.requestID && intent.expectedRevision === doc.revision) {
      doc.scheduleActivation = null
      prepareMissionScheduleActivation(doc, intent)
      return
    }
    const frozen = (value: MissionScheduleActivation) => ({ requestID: value.requestID, expectedRevision: value.expectedRevision,
      authority: value.authority, targets: value.targets.map(({ acknowledged: _ack, attempted: _attempted, ...target }) => target) })
    if (canonicalAuthority(frozen(doc.scheduleActivation)) !== canonicalAuthority(frozen(intent))) throw new Error("Mission activation request conflict")
    return
  }
  if (intent.state !== "prepared" || intent.expectedRevision !== doc.revision || intent.targets.some(target => target.acknowledged || target.attempted)
    || intent.effectiveOrigin !== undefined || intent.errorCode) throw new Error("Invalid Mission activation preparation")
  doc.scheduleActivation = intent
}
export function readyMissionScheduleActivation(doc: MissionDocument, requestID: string, effectiveOrigin: string | null) {
  const intent = exact(doc, requestID)
  if (!intent.targets.every(target => target.acknowledged)) throw new Error("Mission activation writes pending")
  intent.state = "ready"
  intent.effectiveOrigin = effectiveOrigin
  delete intent.errorCode
  missionScheduleActivationSchema.parse(intent)
}
export function failMissionScheduleActivation(doc: MissionDocument, requestID: string, errorCode: string) {
  const intent = exact(doc, requestID)
  if (intent.state === "ready") throw new Error("Mission activation already ready")
  intent.state = "failed"
  intent.errorCode = errorCode
  missionScheduleActivationSchema.parse(intent)
}
function exact(doc: MissionDocument, requestID: string) {
  if (doc.state !== "paused" || !doc.scheduleActivation || doc.scheduleActivation.requestID !== requestID)
    throw new Error("Mission activation request conflict")
  return doc.scheduleActivation
}
