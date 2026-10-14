import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { z } from "zod"
import type { MissionRecurrenceSnapshot } from "../../api-types"
import { sameLocation, locationRequestOptions } from "../../opencode/compatibility/location"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"
import { requestAdmission } from "../request-admission"
import { recurrenceReadInput, recurrenceReadPage } from "../../missions/recurrence-reader-contract"
import { recurrenceSnapshotSchema as snapshotSchema } from "../../missions/recurrence-control-contract"

const pageSchema = recurrenceReadPage.extend({ projectCanonical: z.string().min(1).max(4096),
  location: z.object({ directory: z.string().min(1).max(4096), workspaceID: z.string().optional() }).strict() })
const pageQuery = z.object({ section: z.coerce.number().int().nonnegative().optional(), page: z.coerce.number().int().nonnegative().optional(),
  revision: z.coerce.number().int().positive().optional() }).strict()

export function registerMissionRecurrenceSnapshot(app: FastifyInstance, deps: {
  workspaceManager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath">
  worktreeDeletionFence?: WorktreeDeletionFence
}): void {
  const read = async (request: FastifyRequest<{ Params: { id: string; scheduleID?: string; passageID?: string }; Querystring: unknown }>, reply: FastifyReply) => {
    const lifetime = requestAdmission(request, reply)
    const query = (request.params.scheduleID ? pageQuery : z.object({}).strict()).safeParse(request.query)
    const pageInput = request.params.scheduleID ? recurrenceReadInput.safeParse({ scheduleID: request.params.scheduleID,
      passageID: request.params.passageID, ...(query.success ? query.data : {}) }) : undefined
    if (!query.success || pageInput && !pageInput.success) { lifetime.dispose(); return reply.code(400).send({ error: "Invalid recurrence read request" }) }
    const parsed = z.string().trim().min(1).max(200).safeParse(request.params.id)
    const manager = deps.workspaceManager
    const workspace = parsed.success && manager.get(parsed.data)
    const owned = parsed.success && manager.getServiceLocation(parsed.data)
    if (!workspace || !owned) { lifetime.dispose(); return reply.code(404).send({ error: "Workspace unavailable" }) }
    const capture = captureDisplayIdentities(deps.worktreeDeletionFence, manager, parsed.data, [owned.directory])
    try {
      const connection = await lifetime.wait(manager.getSharedServiceConnection(parsed.data))
      if (!connection) return reply.code(503).send({ error: "Mission service unavailable" })
      const current = await lifetime.wait(capture)
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
      if (pageInput?.success) {
        const page = pageSchema.parse(await client.rpc(CODENOMAD_MISSIONS_RPC).recurrencePassageRead(pageInput.data, { location, ...options }))
        assertCurrent()
        if (!await manager.ownsLocation(parsed.data, owned, client)) return reply.code(403).send({ error: "Mission Location is not owned" })
        assertCurrent()
        if (page.projectID !== resolved.project.id || page.projectCanonical !== resolved.project.canonical || !sameLocation(page.location, owned)
          || page.scheduleID !== pageInput.data.scheduleID || page.passageID !== pageInput.data.passageID
          || page.section !== pageInput.data.section || page.page !== pageInput.data.page
          || pageInput.data.revision !== undefined && page.revision !== pageInput.data.revision) return reply.code(502).send({ error: "Foreign archived recurrence page" })
        const { projectCanonical: _canonical, location: _location, ...result } = page
        return result
      }
      const snapshot = snapshotSchema.parse(await client.rpc(CODENOMAD_MISSIONS_RPC).recurrenceSnapshot({}, { location, ...options }))
      assertCurrent()
      if (!await manager.ownsLocation(parsed.data, owned, client)) return reply.code(403).send({ error: "Mission Location is not owned" })
      assertCurrent()
      if (snapshot.projectID !== resolved.project.id || snapshot.projectCanonical !== resolved.project.canonical
        || !sameLocation(snapshot.location, owned)) return reply.code(502).send({ error: "Foreign Mission recurrence snapshot" })
      const result: MissionRecurrenceSnapshot = { version: 1, projectID: snapshot.projectID, schedules: snapshot.schedules }
      return result
    } catch {
      request.log.warn({ code: "recurrence-snapshot-unavailable" }, "Mission recurrence snapshot unavailable")
      return reply.code(503).send({ error: "Mission recurrence unavailable" })
    } finally { lifetime.dispose() }
  }
  app.get("/api/workspaces/:id/missions/recurrence", read)
  app.get("/api/workspaces/:id/missions/recurrence/:scheduleID/passages/:passageID", read)
}
