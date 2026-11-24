import type { SessionCompaction, SessionHttpRequest, SessionTitle } from "@opencode/plugin/effect/session"

export const NATIVE_SCHEDULE_CARRIER_MODEL = Object.freeze({ providerID: "codenomad-missions-local", id: "schedule-noop" })
type CarrierModelRef = { providerID?: unknown; id?: unknown } | undefined
/** Recognize model-less carriers and the retained noop model identity. */
export const isAllowedScheduleCarrierModel = (model: CarrierModelRef) =>
  model === undefined || model.providerID === NATIVE_SCHEDULE_CARRIER_MODEL.providerID && model.id === NATIVE_SCHEDULE_CARRIER_MODEL.id
export const NATIVE_SCHEDULE_CARRIER_TITLE = "Mission schedule carrier"
const summary = "Mission schedule carrier. Read durable mappings for correlation."
/** Register through the public session/aisdk hooks. owns must use exact durable
 * carrier identities; admission belongs exclusively to the context → RPC path. */
export function nativeScheduleCarrierHooks(owns: (sessionID: string) => boolean) {
  return {
    title(event: SessionTitle) { if (owns(event.sessionID)) event.result = NATIVE_SCHEDULE_CARRIER_TITLE },
    compaction(event: SessionCompaction) { if (owns(event.sessionID)) event.result = { summary } },
    httpRequest(event: SessionHttpRequest) { if (owns(event.sessionID)) throw new Error("schedule-carrier-provider-http") },
  }
}
