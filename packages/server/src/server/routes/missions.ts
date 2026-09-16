import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { MissionListResponse, MissionSnapshot } from "../../missions/model"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import type { WorkspaceManager } from "../../workspaces/manager"
import { locationRequestOptions } from "../../opencode/compatibility/location"

interface MissionRouteDeps {
  workspaceManager: WorkspaceManager
}

const MissionParamsSchema = z.object({ id: z.string().trim().min(1).max(200) })

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
}

function unavailable(reason: "plugin-unavailable" | "workspace-unavailable"): MissionListResponse {
  return { available: false, reason, missions: [] }
}

function isRpcFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const type = "type" in error ? (error as { type?: unknown }).type : undefined
  return typeof type === "string" && type.startsWith("rpc.")
}
