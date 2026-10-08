import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { MissionRecurrenceSnapshot } from "../../api-types"
import { sameLocation, locationRequestOptions } from "../../opencode/compatibility/location"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { requestAdmission } from "../request-admission"

export function registerMissionRecurrenceSnapshot(app: FastifyInstance, deps: {
  workspaceManager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection" | "ownsLocation">
  worktreeDeletionFence?: WorktreeDeletionFence
}): void {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/missions/recurrence", async (request, reply) => {
    const lifetime = requestAdmission(request, reply)
    const parsed = z.string().trim().min(1).max(200).safeParse(request.params.id)
    const manager = deps.workspaceManager
    const workspace = parsed.success && manager.get(parsed.data)
    const owned = parsed.success && manager.getServiceLocation(parsed.data)
    if (!workspace || !owned) { lifetime.dispose(); return reply.code(404).send({ error: "Workspace unavailable" }) }
    const current = deps.worktreeDeletionFence?.captureDisplay([owned.directory])
    try {
      const connection = await lifetime.wait(manager.getSharedServiceConnection(parsed.data))
      if (!connection) return reply.code(503).send({ error: "Mission service unavailable" })
      const assertCurrent = () => {
        lifetime.signal.throwIfAborted()
        connection.assertCurrent()
        if (current && !current() || manager.get(parsed.data) !== workspace
          || !sameLocation(manager.getServiceLocation(parsed.data) ?? { directory: "" }, owned)) {
          throw new Error("Mission Location changed")
        }
      }
      assertCurrent()
      const client = connection.client, location = { directory: owned.directory }, options = locationRequestOptions(owned)
      if (!await manager.ownsLocation(parsed.data, owned, client)) return reply.code(403).send({ error: "Mission Location is not owned" })
      assertCurrent()
      const resolved = await client.location.get({ location }, options)
      assertCurrent()
      const inventory = await client.plugin.list({ location }, options)
      assertCurrent()
      if (!inventory.data.some(item => item.id === CODENOMAD_MISSIONS_RPC_ID && item.state.status === "active")) {
        return reply.code(503).send({ error: "Mission plugin unavailable" })
      }
      const snapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).recurrenceSnapshot({}, { location, ...options }) as {
        version: 1; projectID: string; projectCanonical: string; location: { directory: string; workspaceID?: string };
        schedules: MissionRecurrenceSnapshot["schedules"]
      }
      assertCurrent()
      if (!await manager.ownsLocation(parsed.data, owned, client)) return reply.code(403).send({ error: "Mission Location is not owned" })
      assertCurrent()
      if (snapshot.projectID !== resolved.project.id || snapshot.projectCanonical !== resolved.project.canonical
        || !sameLocation(snapshot.location, owned)) return reply.code(502).send({ error: "Foreign Mission recurrence snapshot" })
      const result: MissionRecurrenceSnapshot = { version: 1, projectID: snapshot.projectID, schedules: snapshot.schedules }
      return result
    } catch (error) {
      request.log.warn({ err: error, workspaceId: parsed.data }, "Mission recurrence snapshot unavailable")
      return reply.code(503).send({ error: "Mission recurrence unavailable" })
    } finally { lifetime.dispose() }
  })
}
