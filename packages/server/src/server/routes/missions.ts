import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { MissionListResponse, MissionMap, MissionSnapshot } from "../../missions/model"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import type { WorkspaceManager } from "../../workspaces/manager"
import { locationRequestOptions } from "../../opencode/compatibility/location"

interface MissionRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceClient" | "ownsLocation">
}

const MissionParamsSchema = z.object({ id: z.string().trim().min(1).max(200) })
const RequestID = z.string().trim().min(1).max(128)
const CreateSchema = z.object({
  objective: z.string().trim().min(1).max(20_000), notes: z.string().max(20_000).optional(),
  template: z.enum(["custom", "wayfinder", "pocock-fix-bug"]), coordinatorSessionId: z.string().trim().min(1).max(240).optional(),
  directory: z.string().trim().min(1).max(4_096).optional(), requestId: RequestID,
}).strict()
const UpdateSchema = z.object({
  objective: z.string().trim().min(1).max(20_000), notes: z.string().max(20_000).optional(),
  expectedRevision: z.number().int().positive(), requestId: RequestID,
}).strict()
const DeleteSchema = z.object({ expectedRevision: z.number().int().positive(), requestId: RequestID }).strict()

export function registerMissionRoutes(app: FastifyInstance, deps: MissionRouteDeps): void {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/missions", async (request, reply): Promise<MissionListResponse> => {
    const parsed = MissionParamsSchema.safeParse(request.params)
    if (!parsed.success || !deps.workspaceManager.get(parsed.data.id)) {
      reply.code(404)
      return unavailable("workspace-unavailable")
    }

    const ownedLocation = deps.workspaceManager.getServiceLocation(parsed.data.id)
    if (!ownedLocation) return unavailable("workspace-unavailable")
    const location = { directory: ownedLocation.directory }
    const options = locationRequestOptions(ownedLocation)

    try {
      const client = await deps.workspaceManager.getSharedServiceClient()
      const resolved = await client.location.get({ location }, options)
      const inventory = await client.plugin.list({ location }, options)
      const plugin = inventory.data.find((entry) => entry.id === CODENOMAD_MISSIONS_RPC_ID)
      // Local V2 plugins currently advertise `server` but do not set `features.rpc`
      // after registration. The reviewed typed call below is the RPC capability check.
      if (!plugin || plugin.state.status !== "active") {
        return unavailable("plugin-unavailable")
      }

      // The registered RPC validates this JSON-Schema output before the generated client returns it.
      const snapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location, ...options }) as MissionSnapshot
      if (snapshot.projectID !== resolved.project.id) {
        request.log.error({ workspaceId: parsed.data.id }, "Mission RPC returned a foreign project snapshot")
        reply.code(502)
        return unavailable("plugin-unavailable")
      }
      return { available: true, ...snapshot }
    } catch (error) {
      request.log.warn({ err: error, workspaceId: parsed.data.id }, "Mission plugin snapshot is unavailable")
      return unavailable(isRpcFailure(error) ? "plugin-unavailable" : "workspace-unavailable")
    }
  })

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/missions", async (request, reply) => {
    const parsed = CreateSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid mission creation request" })
    const setup = await mutationLocation(request.params.id, parsed.data.directory, deps, reply)
    if (!setup) return
    try {
      const rpc = setup.client.rpc(CODENOMAD_MISSIONS_RPC)
      if (parsed.data.coordinatorSessionId) {
        const coordinator = await setup.client.session.get({ sessionID: parsed.data.coordinatorSessionId })
        if (coordinator.parentID || coordinator.projectID !== setup.projectID
          || !await deps.workspaceManager.ownsLocation(request.params.id, coordinator.location, setup.client)) {
          return reply.code(403).send({ error: "Coordinator session does not belong to workspace project" })
        }
      }
      const result = await rpc.create({
        requestID: parsed.data.requestId,
        objective: parsed.data.objective,
        ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }),
        template: parsed.data.template,
        ...(parsed.data.coordinatorSessionId ? { coordinatorSessionID: parsed.data.coordinatorSessionId } : {}),
      }, setup.options) as { mission: MissionMap }
      return { mission: result.mission }
    } catch (error) { return mutationError(reply, error) }
  })

  app.patch<{ Params: { id: string; missionID: string } }>("/api/workspaces/:id/missions/:missionID", async (request, reply) => {
    const parsed = UpdateSchema.safeParse(request.body)
    const params = z.object({ id: z.string().trim().min(1).max(200), missionID: z.string().trim().min(1).max(100) }).safeParse(request.params)
    if (!parsed.success || !params.success) return reply.code(400).send({ error: "Invalid mission update request" })
    const setup = await mutationLocation(params.data.id, undefined, deps, reply)
    if (!setup) return
    try {
      const result = await setup.client.rpc(CODENOMAD_MISSIONS_RPC).update({
        missionID: params.data.missionID, requestID: parsed.data.requestId, objective: parsed.data.objective,
        ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }), expectedRevision: parsed.data.expectedRevision,
      }, setup.options) as { mission: MissionMap }
      return { mission: result.mission }
    } catch (error) { return mutationError(reply, error) }
  })

  app.delete<{ Params: { id: string; missionID: string } }>("/api/workspaces/:id/missions/:missionID", async (request, reply) => {
    const parsed = DeleteSchema.safeParse(request.body)
    const params = z.object({ id: z.string().trim().min(1).max(200), missionID: z.string().trim().min(1).max(100) }).safeParse(request.params)
    if (!parsed.success || !params.success) return reply.code(400).send({ error: "Invalid mission deletion request" })
    const setup = await mutationLocation(params.data.id, undefined, deps, reply)
    if (!setup) return
    try {
      return await setup.client.rpc(CODENOMAD_MISSIONS_RPC).delete({
        missionID: params.data.missionID, requestID: parsed.data.requestId, expectedRevision: parsed.data.expectedRevision,
      }, setup.options) as { deleted: true }
    } catch (error) { return mutationError(reply, error) }
  })
}

async function mutationLocation(workspaceID: string, requestedDirectory: string | undefined, deps: MissionRouteDeps, reply: import("fastify").FastifyReply) {
  if (!deps.workspaceManager.get(workspaceID)) {
    reply.code(404).send({ error: "Workspace unavailable" })
    return
  }
  const base = deps.workspaceManager.getServiceLocation(workspaceID)
  if (!base) {
    reply.code(404).send({ error: "Workspace unavailable" })
    return
  }
  try {
    const client = await deps.workspaceManager.getSharedServiceClient()
    const location = requestedDirectory ? { directory: requestedDirectory } : base
    if (!await deps.workspaceManager.ownsLocation(workspaceID, location, client)) {
      reply.code(403).send({ error: "Mission directory does not belong to workspace" })
      return
    }
    const resolved = await client.location.get({ location: { directory: location.directory } }, locationRequestOptions(location))
    const baseResolved = await client.location.get({ location: { directory: base.directory } }, locationRequestOptions(base))
    if (resolved.project.id !== baseResolved.project.id) {
      reply.code(403).send({ error: "Mission directory belongs to another project" })
      return
    }
    const inventory = await client.plugin.list({ location: { directory: location.directory } }, locationRequestOptions(location))
    const plugin = inventory.data.find((entry) => entry.id === CODENOMAD_MISSIONS_RPC_ID)
    if (!plugin || plugin.state.status !== "active") {
      reply.code(503).send({ error: "Mission plugin unavailable" })
      return
    }
    return { client, projectID: resolved.project.id, options: { location: { directory: location.directory }, ...locationRequestOptions(location) } }
  } catch {
    reply.code(503).send({ error: "Mission plugin unavailable" })
    return
  }
}

function mutationError(reply: import("fastify").FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "Mission operation failed"
  if (/revision-conflict|request-conflict|task-conflict|already-member|mission-finished|Mission changed|request ID was already used|already belongs|already finished|Only active missions/.test(message)) {
    return reply.code(409).send({ error: message })
  }
  if (/mission-not-found|mission-deleted/.test(message)) return reply.code(404).send({ error: message })
  if (/foreign-session|child-session|target-claimed|belongs to another project|root sessions only/.test(message)) return reply.code(403).send({ error: message })
  reply.code(503).send({ error: "Mission plugin unavailable" })
}

function unavailable(reason: "plugin-unavailable" | "workspace-unavailable"): MissionListResponse {
  return { available: false, reason, missions: [] }
}

function isRpcFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const type = "type" in error ? (error as { type?: unknown }).type : undefined
  return typeof type === "string" && type.startsWith("rpc.")
}
