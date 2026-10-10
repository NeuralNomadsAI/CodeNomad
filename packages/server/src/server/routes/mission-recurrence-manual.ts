import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { recurrenceManualRequestSchema, recurrenceManualResultSchema } from "../../missions/recurrence-manual-rpc"
import { prepareHumanRecurrenceControl } from "./mission-recurrence-play-preparation"
import { requestAdmission } from "../request-admission"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { captureRecurrenceControlHoldRead, reconcileRecurrenceControlHold } from "./mission-recurrence-holds"
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"

export function registerMissionRecurrenceManual(app: FastifyInstance, deps: Parameters<typeof prepareHumanRecurrenceControl>[3]) {
  app.get<{ Params: { id: string; scheduleID: string } }>("/api/workspaces/:id/missions/recurrence/:scheduleID/run-now/status", async (request, reply) => {
    const session = deps.auth.getSessionFromRequest(request)
    if (!deps.auth.isAuthEnabled() || !session || session.sessionId === "auth-disabled") return reply.code(401).send({ error: "Human authentication required" })
    const query = z.object({ requestID: z.string(), expectedRevision: z.coerce.number().int().nonnegative().safe(),
      directory: z.string().min(1).max(4096).optional() }).strict().safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: "Invalid manual status request" })
    const input = recurrenceManualRequestSchema.safeParse({ scheduleID: request.params.scheduleID,
      requestID: query.data.requestID, expectedRevision: query.data.expectedRevision })
    if (!input.success) return reply.code(400).send({ error: "Invalid manual status request" })
    const lifetime = requestAdmission(request, reply), workspace = deps.manager.get(request.params.id), base = deps.manager.getServiceLocation(request.params.id)
    if (!workspace || !base) { lifetime.dispose(); return reply.code(404).send({ error: "Workspace unavailable" }) }
    try {
      const directory = query.data.directory ? await lifetime.wait(deps.manager.getServiceDirectoryForPath(request.params.id, query.data.directory)) : base.directory
      const connection = await lifetime.wait(deps.manager.getSharedServiceConnection(request.params.id))
      if (!directory || !connection) throw new Error("Manual status unavailable")
      const location = { directory }, identity = { ...input.data, action: "run-now" as const }
      const currentDeletion = captureRecurrenceControlHoldRead(deps.fence, request.params.id, location, identity, connection)
        ?? await lifetime.wait(captureDisplayIdentities(deps.fence, deps.manager, request.params.id, [base.directory, directory])) ?? (() => false)
      const current = () => {
        lifetime.signal.throwIfAborted(); connection.assertCurrent()
        if (!currentDeletion() || deps.manager.get(request.params.id) !== workspace
          || !sameLocation(deps.manager.getServiceLocation(request.params.id) ?? { directory: "" }, base)
          || deps.auth.getSessionFromRequest(request)?.sessionId !== session.sessionId) throw new Error("Manual status changed")
      }
      if (!await lifetime.wait(deps.manager.ownsLocation(request.params.id, location, connection.client, lifetime.signal))) throw new Error("Foreign Location")
      current()
      const result = recurrenceManualResultSchema.parse(await lifetime.wait(connection.client.rpc(CODENOMAD_MISSIONS_RPC).recurrenceRunNowStatus(input.data,
        { location, ...locationRequestOptions(location), signal: lifetime.signal })))
      current()
      if (result.scheduleID !== input.data.scheduleID || result.requestID !== input.data.requestID || result.expectedRevision !== input.data.expectedRevision
        || !sameLocation(result.location, location) || !await lifetime.wait(deps.manager.ownsLocation(request.params.id, location, connection.client, lifetime.signal))) throw new Error("Foreign manual status")
      current()
      if (result.outcome !== "unknown") reconcileRecurrenceControlHold(deps.fence, request.params.id, location, identity,
        { version: 1, ...input.data, revision: input.data.expectedRevision + 1, outcome: "committed", controlsComplete: true }, connection)
      return result
    } catch { return reply.code(503).send({ error: "Manual status unavailable" }) }
    finally { lifetime.dispose() }
  })
  app.post<{ Params: { id: string; scheduleID: string } }>("/api/workspaces/:id/missions/recurrence/:scheduleID/run-now", async (request, reply) => {
    const session = deps.auth.getSessionFromRequest(request)
    if (!deps.auth.isAuthEnabled() || !session || session.sessionId === "auth-disabled") return reply.code(401).send({ error: "Human authentication required" })
    const input = z.object({ expectedRevision: z.number().int().nonnegative().safe(), requestID: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/),
      directory: z.string().min(1).max(4096).optional() }).strict().safeParse(request.body)
    if (!input.success) return reply.code(400).send({ error: "Invalid manual passage request" })
    const lifetime = requestAdmission(request, reply)
    let prepared: Awaited<ReturnType<typeof prepareHumanRecurrenceControl>> | undefined
    try {
      prepared = await prepareHumanRecurrenceControl(request, request.params.id,
        { ...input.data, scheduleID: request.params.scheduleID, action: "run-now" }, deps, lifetime.signal)
      prepared.current(); prepared.hold.dispatched()
      const options = { location: prepared.location, ...locationRequestOptions(prepared.location) }
      let raw: unknown
      try { raw = await prepared.client.rpc(CODENOMAD_MISSIONS_RPC).recurrenceRunNow(prepared.body, options) }
      catch { raw = await prepared.client.rpc(CODENOMAD_MISSIONS_RPC).recurrenceRunNowStatus({ scheduleID: prepared.body.scheduleID,
        requestID: input.data.requestID, expectedRevision: input.data.expectedRevision }, { ...options, signal: AbortSignal.timeout(10_000) }) }
      const result = recurrenceManualResultSchema.parse(raw)
      if (result.scheduleID !== prepared.body.scheduleID || result.requestID !== input.data.requestID
        || result.expectedRevision !== input.data.expectedRevision || !sameLocation(result.location, prepared.location)) throw new Error("Foreign manual reply")
      if (result.outcome !== "unknown") prepared.hold.settled()
      return reply.code(result.outcome === "unknown" ? 503 : 200).send(result)
    } catch { return reply.code(503).send({ error: "Manual admission uncertain; read status, do not resend" }) }
    finally { prepared?.dispose(); lifetime.dispose() }
  })
}
