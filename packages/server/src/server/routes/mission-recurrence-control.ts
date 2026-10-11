import type { FastifyInstance } from "fastify"
import { prepareHumanRecurrenceControl } from "./mission-recurrence-play-preparation"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { recurrenceControlStatusSchema, recurrenceControlRouteSchema, recurrenceControlStateMatches, recurrenceRefusalCode } from "../../missions/recurrence-control-contract"
import { requestAdmission } from "../request-admission"
import { locationRequestOptions } from "../../opencode/compatibility/location"
import { recurrenceHumanSession } from "./mission-recurrence-proof"
import { recurrenceNotDispatchedReply } from "./mission-recurrence-holds"

/** The sole authenticated human control path. Unknown mutations get one bounded
 * exact receipt read; they are never submitted a second time. Native remains the
 * authoritative CAS: only its exact read can prove a refusal. */
export function registerMissionRecurrenceControl(app: FastifyInstance, deps: {
} & Parameters<typeof prepareHumanRecurrenceControl>[3]) {
  app.post<{ Params: { id: string; scheduleID: string } }>("/api/workspaces/:id/missions/recurrence/:scheduleID/control", async (request, reply) => {
    // Refused before any permit/hold: an unqualified principal can never verify.
    if (!recurrenceHumanSession(request, deps)) return reply.code(401).send({ error: "Authenticated human session required" })
    const input = recurrenceControlRouteSchema.safeParse({ ...(request.body as Record<string, unknown>), scheduleID: request.params.scheduleID })
    if (!input.success || !request.params.id || request.params.id.length > 200) return reply.code(400).send({ error: "Invalid exact recurrence control request" })
    const lifetime = requestAdmission(request, reply)
    let prepared: Awaited<ReturnType<typeof prepareHumanRecurrenceControl>> | undefined
    let dispatched = false
    try {
      // Preparation owns its permit once allocated. Do not race its cleanup
      // against downstream observer cancellation either.
      prepared = await prepareHumanRecurrenceControl(request, request.params.id, input.data, deps, lifetime.signal)
      prepared.current()
      const options = { location: prepared.location, ...locationRequestOptions(prepared.location) }
      prepared.hold.dispatched()
      dispatched = true
      try {
        // Human admission linearizes here. The actual native write is awaited
        // without the HTTP observer's cancellation signal/race; its permit is
        // held even when the downstream socket disappears.
        const result = await prepared.client.rpc(CODENOMAD_MISSIONS_RPC).recurrenceControl(prepared.body, options) as {
          requestID: string; scheduleID: string; revision: number; controlsComplete: boolean
        }
        if (result.requestID !== prepared.body.requestID || result.scheduleID !== prepared.body.scheduleID
          || result.revision !== prepared.body.expectedRevision + 1
          || typeof result.controlsComplete !== "boolean") throw new Error("Foreign or incomplete control receipt")
        const { targetsKnown: _known, ...record } = result as typeof result & { targetsKnown?: boolean }
        recurrenceControlStatusSchema.parse({ expectedRevision: prepared.body.expectedRevision, ...record,
          outcome: result.controlsComplete ? "committed" : "unknown" })
        if (result.controlsComplete === false) prepared.hold.partial()
        else prepared.hold.settled()
        return result
      } catch {
        const body = prepared.body
        const result = recurrenceControlStatusSchema.parse(await prepared.client.rpc(CODENOMAD_MISSIONS_RPC).recurrenceControlStatus({
          scheduleID: body.scheduleID, requestID: body.requestID, action: body.action,
          expectedRevision: body.expectedRevision,
        }, { ...options, signal: AbortSignal.timeout(10_000) }))
        if (result.scheduleID !== body.scheduleID || result.requestID !== body.requestID
          || result.expectedRevision !== body.expectedRevision) throw new Error("Foreign control receipt")
        // Refused before any record (stale revision or inadmissible state): proven
        // no effect, so the permit is released and the refusal is definitive.
        if (result.outcome === "rejected" && result.reason) {
          prepared.hold.settled()
          return reply.code(409).send({ error: "Recurrence control refused; nothing was applied", code: recurrenceRefusalCode(result.reason) })
        }
        if (result.outcome === "committed" && result.controlsComplete === true && result.revision === body.expectedRevision + 1
          && recurrenceControlStateMatches(body.action, result.state)) prepared.hold.settled()
        else if (result.controlsComplete === false) prepared.hold.partial()
        return reply.code(result.outcome === "committed" ? 200 : 503).send(result)
      }
    } catch (error) {
      // Nothing reached native in this attempt: definitive for its identity.
      const refused = dispatched ? undefined : recurrenceNotDispatchedReply(error)
      if (refused) return reply.code(refused.status).send(refused.body)
      request.log.warn({ code: "recurrence-control-unavailable" }, "Mission recurrence control unavailable")
      return reply.code(503).send({ error: "Recurrence control uncertain; read exact status before another action" })
    } finally { prepared?.dispose(); lifetime.dispose() }
  })
}
