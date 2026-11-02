import { canonicalAuthority } from "./authority-protocol"
import { requiresMissionCalendar } from "./launch-policy"
import { missionScheduleActivationSchema, type MissionDocument, type MissionScheduleActivation } from "./mission-document"

export function prepareMissionScheduleActivation(doc: MissionDocument, input: MissionScheduleActivation) {
  const intent = missionScheduleActivationSchema.parse(input)
  if (doc.state !== "paused" || doc.pending || doc.preparation?.pending || doc.oneTime && !doc.dormantJournal || doc.deletion || doc.synchronization || doc.blocked
    || !requiresMissionCalendar(doc.configuration.launch)) throw new Error("Mission activation unavailable")
  if (doc.scheduleActivation) {
    // A failed preparation with no attempted write has no config effect in
    // flight: every writer must first CAS its attempted barrier. A fresh human
    // request may refresh the plan; an old phase then fails the request fence.
    if (doc.scheduleActivation.state === "failed" && doc.scheduleActivation.targets.every(target => !target.attempted)
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
export function acknowledgeMissionScheduleActivation(doc: MissionDocument, requestID: string, scope: "global" | "project", resultDigest: string) {
  const intent = exact(doc, requestID), target = intent.targets.find(target => target.scope === scope)
  if (!target || !target.attempted || target.resultDigest !== resultDigest) throw new Error("Mission activation acknowledgement conflict")
  target.acknowledged = true
  if (intent.state !== "ready") intent.state = "partial"
  delete intent.errorCode
}
export function attemptingMissionScheduleActivation(doc: MissionDocument, requestID: string, scope: "global" | "project", resultDigest: string) {
  const intent = exact(doc, requestID), target = intent.targets.find(target => target.scope === scope)
  if (!target || target.attempted || target.resultDigest !== resultDigest) throw new Error("Mission activation write already attempted or changed")
  target.attempted = true
  intent.state = "partial"
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
