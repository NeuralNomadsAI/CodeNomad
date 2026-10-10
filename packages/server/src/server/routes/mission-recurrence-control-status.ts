import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AuthManager } from "../../auth/manager"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"
import { recurrenceControlRequestSchema, recurrenceControlStatusSchema } from "../../missions/recurrence-control-contract"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { requestAdmission } from "../request-admission"
import { captureRecurrenceControlHoldRead, readRecurrenceHoldOwner, reconcileRecurrenceControlHold,
  recurrenceControlHeldElsewhere } from "./mission-recurrence-holds"

/** Explicit bounded read of an uncertain action. No mutation retry and no
 * generic RPC proxy, even when a signed archive establishes prior commitment. */
export function registerMissionRecurrenceControlStatus(app: FastifyInstance, deps: {
  auth: Pick<AuthManager, "isAuthEnabled" | "getSessionFromRequest">
  manager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getServiceDirectoryForPath" | "getSharedServiceConnection" | "ownsLocation"
    | "getWorktreeIdentityForPath">
  fence: WorktreeDeletionFence
}) {
  app.post<{ Params: { id: string; scheduleID: string } }>("/api/workspaces/:id/missions/recurrence/:scheduleID/control/status", async (request, reply) => {
    const session = deps.auth.getSessionFromRequest(request)
    if (!deps.auth.isAuthEnabled() || !session || session.sessionId === "auth-disabled") return reply.code(401).send({ error: "Human authentication required" })
    const parsed = z.object({ requestID: z.string(), action: z.enum(["play", "pause", "stop", "resume", "run-now", "check"]),
      expectedRevision: z.number(), directory: z.string().min(1).max(4096).optional() }).strict().safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid exact control status request" })
    const { directory: requestedDirectory, ...identity } = parsed.data
    const input = recurrenceControlRequestSchema.safeParse({ ...identity, scheduleID: request.params.scheduleID })
    if (!input.success) return reply.code(400).send({ error: "Invalid exact control status request" })
    const lifetime = requestAdmission(request, reply), id = request.params.id
    try {
      const workspace = deps.manager.get(id), base = deps.manager.getServiceLocation(id)
      if (!workspace || !base) return reply.code(404).send({ error: "Workspace unavailable" })
      const directory = requestedDirectory ? await lifetime.wait(deps.manager.getServiceDirectoryForPath(id, requestedDirectory)) : base.directory
      if (!directory) return reply.code(403).send({ error: "Location unavailable" })
      const connection = await lifetime.wait(deps.manager.getSharedServiceConnection(id))
      if (!connection) throw new Error("Native connection unavailable")
      const heldRead = captureRecurrenceControlHoldRead(deps.fence, id, { directory }, input.data, connection)
      const currentDeletion = heldRead ?? await lifetime.wait(captureDisplayIdentities(deps.fence, deps.manager, id, [base.directory, directory])) ?? (() => false)
      const current = () => {
        lifetime.signal.throwIfAborted(); connection.assertCurrent()
        if (!currentDeletion() || deps.manager.get(id) !== workspace
          || !sameLocation(deps.manager.getServiceLocation(id) ?? { directory: "" }, base)
          || deps.auth.getSessionFromRequest(request)?.sessionId !== session.sessionId) throw new Error("Control read changed")
      }
      const location = { directory }, signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])
      if (!heldRead && !await lifetime.wait(deps.manager.ownsLocation(id, location, connection.client, signal))) return reply.code(403).send({ error: "Foreign Location" })
      current()
      const raw = await lifetime.wait(connection.client.rpc(CODENOMAD_MISSIONS_RPC).recurrenceControlStatus(input.data, {
        location, ...locationRequestOptions(location), signal,
      }))
      current()
      if (!heldRead && !await lifetime.wait(deps.manager.ownsLocation(id, location, connection.client, signal))) throw new Error("Location changed")
      current()
      const result = recurrenceControlStatusSchema.parse(raw)
      if (result.scheduleID !== input.data.scheduleID || result.requestID !== input.data.requestID
        || result.expectedRevision !== input.data.expectedRevision) throw new Error("Foreign control receipt")
      // A permit retained from a replaced connection settles only after this fresh
      // read re-proves the same workspace, native project storage and checkout.
      const owner = recurrenceControlHeldElsewhere(deps.fence, id, input.data, connection)
        ? await lifetime.wait(readRecurrenceHoldOwner(deps.manager, id, workspace, directory, connection.client, signal)) : undefined
      current()
      reconcileRecurrenceControlHold(deps.fence, id, location, input.data, result, connection, owner)
      return result
    } catch {
      request.log.warn({ code: "recurrence-control-status-unavailable" }, "Mission recurrence control status unavailable")
      return reply.code(503).send({ error: "Exact recurrence control status unavailable" })
    } finally { lifetime.dispose() }
  })
}
