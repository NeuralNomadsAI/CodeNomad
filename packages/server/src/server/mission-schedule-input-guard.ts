import { isReservedMissionScheduleSessionID } from "../missions/mission-schedule-carrier-identity"

/** What a technical carrier conversation of Missions is recognized by: its reserved ID, or the
 * marker, model and title that carriers created outside the reserved namespace still hold. */
const CARRIER_MARKER = "codenomad.schedule-carrier"
const CARRIER_PROVIDER = "codenomad-missions-local", CARRIER_TITLE = "Mission schedule carrier"

export class MissionScheduleInputError extends Error {
  constructor(readonly statusCode: 400 | 403) {
    super(statusCode === 400 ? "Session input requires a JSON object" : "Mission carriers and their metadata are not ordinary session input")
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value)
const reserved = (metadata: Record<string, unknown> | undefined) =>
  metadata?.schedule !== undefined || metadata?.automation !== undefined || metadata?.[CARRIER_MARKER] !== undefined

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
    if (reserved(object(value.metadata) ? value.metadata : undefined)) throw new MissionScheduleInputError(403)
    if (importing) for (const entry of Object.values(value)) if (entry && typeof entry === "object") pending.push(entry)
  }
}

/** Ordinary sends, moves, deletions and prunes stay off a carrier conversation. */
export function assertOrdinaryMissionScheduleSession(session: {
  id: string; metadata?: Record<string, unknown>; model?: { providerID: string; id: string }; title?: string
}): void {
  if (isReservedMissionScheduleSessionID(session.id) || session.metadata?.[CARRIER_MARKER] !== undefined
    || session.model?.providerID === CARRIER_PROVIDER || session.title === CARRIER_TITLE) throw new MissionScheduleInputError(403)
}
