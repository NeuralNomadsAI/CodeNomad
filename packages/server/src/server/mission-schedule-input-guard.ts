import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { CODENOMAD_MISSIONS_RPC } from "../missions/rpc"
import { isReservedMissionScheduleSessionID } from "../missions/mission-schedule-carrier-identity"
import { locationRequestOptions } from "../opencode/compatibility/location"
import { assertOrdinaryMissionScheduleInput } from "../opencode/missions/native-schedule-carrier-binding"
import { NATIVE_SCHEDULE_CARRIER_MODEL, NATIVE_SCHEDULE_CARRIER_TITLE } from "../opencode/missions/native-schedule-carrier"

export class MissionScheduleInputError extends Error {
  constructor(readonly statusCode: 400 | 403 | 503) {
    super(statusCode === 400 ? "Session input requires a JSON object"
      : statusCode === 403 ? "Mission schedule carriers and metadata require owned schedule controls"
        : "Mission schedule carrier ownership could not be verified")
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value)

/** Imported native messages can carry metadata inside a nested source. Walk the
 * parsed JSON iteratively, preserving ordinary message/metadata bytes verbatim. */
export function assertOrdinaryMissionScheduleBody(body: unknown, importing = false): void {
  if (body === undefined) return
  if (!object(body)) throw new MissionScheduleInputError(400)
  const pending: unknown[] = [body]
  while (pending.length) {
    const value = pending.pop()
    if (Array.isArray(value)) { for (const entry of value) pending.push(entry); continue }
    if (!object(value)) continue
    try {
      assertOrdinaryMissionScheduleInput({ ownedCarrier: false, metadata: object(value.metadata) ? value.metadata : undefined })
    } catch { throw new MissionScheduleInputError(403) }
    if (importing) for (const entry of Object.values(value)) if (entry && typeof entry === "object") pending.push(entry)
  }
}

/** Always point-read durable ownership. The SDK maps native router absence to
 * reserved RPC system failures; transport errors keep ownership indeterminate. */
export async function assertOrdinaryMissionScheduleSession(client: OpenCodeClient, session: {
  id: string; location: LocationRef; metadata?: Record<string, unknown>
  model?: { providerID: string; id: string }; title?: string
}, options: { signal?: AbortSignal; current?: () => void } = {}): Promise<void> {
  const current = () => { options.signal?.throwIfAborted(); options.current?.() }
  current()
  if (isReservedMissionScheduleSessionID(session.id)) throw new MissionScheduleInputError(403)
  try {
    assertOrdinaryMissionScheduleInput({ ownedCarrier: false, sessionMetadata: session.metadata })
  } catch { throw new MissionScheduleInputError(403) }
  let result: unknown
  try {
    result = await client.rpc(CODENOMAD_MISSIONS_RPC).scheduleCarrierRead({ sessionID: session.id }, {
      location: { directory: session.location.directory }, ...locationRequestOptions(session.location),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
    })
  } catch (error) {
    current()
    // Promise SDK rpc() strips the RpcError envelope to exactly type/message.
    // Plugins cannot declare their own rpc.* failures; unavailable qualifies
    // absent registration only in that complete native system-error shape.
    const absent = object(error) && (error.type === "rpc.method_not_found" || error.type === "rpc.unavailable"
      && typeof error.message === "string" && error.message.length > 0 && error.message.length <= 4096
      && Object.keys(error).length === 2 && Object.keys(error).every(key => key === "type" || key === "message"))
    if (absent
      && session.model?.providerID !== NATIVE_SCHEDULE_CARRIER_MODEL.providerID
      && session.title !== NATIVE_SCHEDULE_CARRIER_TITLE) return
    throw new MissionScheduleInputError(503)
  }
  current()
  if (!object(result) || typeof result.owned !== "boolean") throw new MissionScheduleInputError(503)
  try { assertOrdinaryMissionScheduleInput({ ownedCarrier: result.owned, sessionMetadata: session.metadata }) }
  catch { throw new MissionScheduleInputError(403) }
}
