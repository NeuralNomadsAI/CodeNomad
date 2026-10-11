import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { recurrenceControlStatusSchema, type RecurrenceControlRequest, type RecurrenceControlStatus } from "../../missions/recurrence-control-contract"
import { recurrenceManualResultSchema } from "../../missions/recurrence-manual-rpc"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import type { ServiceConnection } from "../../workspaces/opencode-service"

/** Exact read-only native status of a superseded start intent, in the control
 * status shape. A Run now is recorded once its passage is reserved; accepted or
 * settled completes it. Never a resend, and never inferred from an unknown read. */
export async function readSupersededRecurrenceIntent(client: ServiceConnection["client"], request: RecurrenceControlRequest,
  location: { directory: string }, signal: AbortSignal): Promise<RecurrenceControlStatus> {
  const options = { location, ...locationRequestOptions(location), signal }
  const identity = { scheduleID: request.scheduleID, requestID: request.requestID, expectedRevision: request.expectedRevision }
  if (request.action !== "run-now") {
    const status = recurrenceControlStatusSchema.parse(await client.rpc(CODENOMAD_MISSIONS_RPC).recurrenceControlStatus({ ...identity,
      action: request.action }, options))
    if (status.scheduleID !== identity.scheduleID || status.requestID !== identity.requestID
      || status.expectedRevision !== identity.expectedRevision) throw new Error("Foreign control receipt")
    return status
  }
  const result = recurrenceManualResultSchema.parse(await client.rpc(CODENOMAD_MISSIONS_RPC).recurrenceRunNowStatus(identity, options))
  if (result.scheduleID !== identity.scheduleID || result.requestID !== identity.requestID
    || result.expectedRevision !== identity.expectedRevision || !sameLocation(result.location, location)) throw new Error("Foreign manual status")
  const base = { version: 1 as const, ...identity, action: "run-now" as const }
  if (result.outcome === "rejected" && result.reason) return { ...base, outcome: "rejected", reason: result.reason }
  if (result.outcome === "unknown" && !result.passageID) return { ...base, outcome: "unknown" }
  return { ...base, revision: identity.expectedRevision + 1, outcome: result.outcome === "unknown" ? "unknown" : "committed",
    controlsComplete: result.outcome !== "unknown" }
}
