import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { MissionListResponse, MissionMap, MissionSnapshot } from "../../missions/model"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import type { WorkspaceManager } from "../../workspaces/manager"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { readMissionMutationError } from "../../missions/rpc-errors"
import { projectMissionActivity } from "../../missions/activity"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { prepareMissionCreation, MissionCreationPreparationError } from "./mission-creation-pipeline"
import { requestAdmission } from "../request-admission"
import { MissionCreationHoldError } from "./mission-creation-holds"

interface MissionRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceClient" | "ownsLocation"
    | "getSharedServiceConnection" | "getServiceDirectoryForPath" | "getWorktreeIdentityForPath">
  worktreeDeletionFence?: WorktreeDeletionFence
}

const MissionParamsSchema = z.object({ id: z.string().trim().min(1).max(200) })
const RequestID = z.string().trim().min(1).max(128)
const UpdateSchema = z.object({
  objective: z.string().trim().min(1).max(20_000), notes: z.string().max(20_000).optional(),
  expectedRevision: z.number().int().positive(), requestId: RequestID,
}).strict()
const DeleteSchema = z.object({ expectedRevision: z.number().int().positive(), requestId: RequestID, deleteManagedSessions: z.boolean().optional() }).strict()

export function registerMissionRoutes(app: FastifyInstance, deps: MissionRouteDeps): void {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/missions", async (request, reply): Promise<MissionListResponse> => {
    const lifetime = requestAdmission(request, reply)
    const parsed = MissionParamsSchema.safeParse(request.params)
    if (!parsed.success || !deps.workspaceManager.get(parsed.data.id)) {
      lifetime.dispose()
      reply.code(404)
      return unavailable("workspace-unavailable")
    }

    const ownedLocation = deps.workspaceManager.getServiceLocation(parsed.data.id)
    if (!ownedLocation) { lifetime.dispose(); return unavailable("workspace-unavailable") }
    const workspace = deps.workspaceManager.get(parsed.data.id)
    const displayCurrent = deps.worktreeDeletionFence?.captureDisplay([ownedLocation.directory])
    const location = { directory: ownedLocation.directory }
    const options = locationRequestOptions(ownedLocation)

    try {
      const connection = await lifetime.wait(deps.workspaceManager.getSharedServiceConnection(parsed.data.id))
      if (!connection) return unavailable("workspace-unavailable")
      connection.assertCurrent()
      const client = connection.client
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
      const activity = await projectMissionActivity({
        client,
        snapshot,
        workspaceID: parsed.data.id,
        ownsLocation: deps.workspaceManager.ownsLocation.bind(deps.workspaceManager),
        isCurrent: (() => {
          const deletionCurrent = deps.worktreeDeletionFence?.captureDisplay([
            ownedLocation.directory, ...snapshot.missions.flatMap(mission => mission.actors.map(actor => actor.location.directory)),
          ])
          return () => {
            if (!displayCurrent?.() || !deletionCurrent?.() || lifetime.signal.aborted
              || deps.workspaceManager.get(parsed.data.id) !== workspace
              || !sameLocation(deps.workspaceManager.getServiceLocation(parsed.data.id) ?? { directory: "" }, ownedLocation)) return false
            try { connection.assertCurrent(); return true } catch { return false }
          }
        })(),
      })
      return { available: true, ...snapshot, activity }
    } catch (error) {
      request.log.warn({ err: error, workspaceId: parsed.data.id }, "Mission plugin snapshot is unavailable")
      return unavailable(isRpcFailure(error) ? "plugin-unavailable" : "workspace-unavailable")
    } finally { lifetime.dispose() }
  })

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/missions", async (request, reply) => {
    const lifetime = requestAdmission(request, reply)
    try {
      lifetime.signal.throwIfAborted()
      const creation = await prepareMissionCreation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence,
        workspaceID: request.params.id, request: request.body, signal: lifetime.signal, wait: lifetime.wait })
      return await creation.execute()
    } catch (error) {
      if (error instanceof MissionCreationPreparationError) return reply.code(error.status).send({ error: error.message })
      if (error instanceof MissionCreationHoldError) {
        return reply.code(error.code === "creation-capacity" ? 503 : 409).send({ error: error.message, code: error.code })
      }
      if (error instanceof Error && "code" in error && error.code === "worktree-deleting") {
        return reply.code(409).send({ error: "Worktree deletion is in progress" })
      }
      return mutationError(reply, error)
    } finally { lifetime.dispose() }
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

  app.post<{ Params: { id: string; missionID: string } }>("/api/workspaces/:id/missions/:missionID/control", async (request, reply) => {
    const parsed = z.object({ action: z.enum(["start", "pause", "stop"]), expectedRevision: z.number().int().positive(), requestId: RequestID }).strict().safeParse(request.body)
    const params = z.object({ id: z.string().trim().min(1).max(200), missionID: z.string().trim().min(1).max(100) }).safeParse(request.params)
    if (!parsed.success || !params.success) return reply.code(400).send({ error: "Invalid mission control request" })
    const setup = await mutationLocation(params.data.id, undefined, deps, reply)
    if (!setup) return
    try {
      return await setup.client.rpc(CODENOMAD_MISSIONS_RPC).lifecycle({
        missionID: params.data.missionID, requestID: parsed.data.requestId, action: parsed.data.action, expectedRevision: parsed.data.expectedRevision,
      }, setup.options) as { mission: MissionMap }
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
        ...(parsed.data.deleteManagedSessions === undefined ? {} : { deleteManagedSessions: parsed.data.deleteManagedSessions }),
      }, setup.options) as { deleted: true }
    } catch (error) { return mutationError(reply, error) }
  })

  app.post<{ Params: { id: string; missionID: string } }>("/api/workspaces/:id/missions/:missionID/recover", async (request, reply) => {
    const parsed = z.object({ expectedRevision: z.number().int().positive(), target: z.enum(["coordinator", "report"]), taskKey: z.string().min(1).max(100).optional() }).strict().safeParse(request.body)
    const params = z.object({ id: z.string().trim().min(1).max(200), missionID: z.string().trim().min(1).max(100) }).safeParse(request.params)
    if (!parsed.success || !params.success) return reply.code(400).send({ error: "Invalid mission recovery request" })
    const setup = await mutationLocation(params.data.id, undefined, deps, reply)
    if (!setup) return
    try {
      return await setup.client.rpc(CODENOMAD_MISSIONS_RPC).recover({ missionID: params.data.missionID, ...parsed.data }, setup.options)
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
  const rejection = readMissionMutationError(error)
  if (rejection) return reply.code(rejection.status).send({ error: rejection.message, code: rejection.code })
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
