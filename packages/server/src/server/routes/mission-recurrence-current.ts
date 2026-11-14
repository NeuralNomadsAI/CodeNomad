import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { z } from "zod"
import { projectMissionActivity } from "../../missions/activity"
import { recurrenceIDSchema } from "../../missions/recurrence-contract"
import { recurrenceCurrentContentInput, recurrenceCurrentContentPage, recurrenceCurrentPageInput } from "../../missions/recurrence-current"
import { missionCurrentIdentitySchema, type MissionCurrentIdentity } from "../../missions/mission-current-source"
import { isMissionPanelPageResult, missionPanelBytes, MISSION_PANEL_PAGE_BYTES, MISSION_PANEL_REQUEST_BYTES } from "../../missions/mission-panel-page"
import { readMissionPanelObservation } from "../../missions/mission-panel-observation"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"
import { requestAdmission } from "../request-admission"

type Deps = { workspaceManager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath">;
  worktreeDeletionFence?: WorktreeDeletionFence }
type Params = { id: string; scheduleID: string; passageID?: string }
const paramsSchema = z.object({ id: z.string().trim().min(1).max(200), scheduleID: recurrenceIDSchema, passageID: recurrenceIDSchema.optional() }).strict()
const owner = z.enum(["daily", "scheduled"]).default("daily")
const querySchema = z.object({ owner, kind: z.enum(["overview", "task", "report", "change"]), itemId: z.string().min(1).max(240).optional(),
  section: z.enum(["summary", "objective", "notes", "evidence", "next", "brief", "artifact", "achieved", "ongoing", "obstacles"]).default("summary"),
  page: z.coerce.number().int().min(0).safe().default(0), revision: z.coerce.number().int().positive().safe().optional() }).strict()

export function registerMissionRecurrenceCurrent(app: FastifyInstance, deps: Deps): void {
  const route = (mode: "identity" | "page" | "content") => async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
    const params = paramsSchema.safeParse(request.params), page = mode === "page" ? recurrenceCurrentPageInput.safeParse(request.body) : undefined
    const query = (mode === "content" ? querySchema : z.object({ owner }).strict()).safeParse(request.query)
    if (!params.success || !query.success || page && !page.success) return reply.code(400).send({ error: "Invalid current passage request" })
    if (mode === "content" && !recurrenceCurrentContentInput.safeParse({ ...query.data, scheduleID: params.data.scheduleID, passageID: params.data.passageID }).success)
      return reply.code(400).send({ error: "Invalid current passage target" })
    const input = page?.success ? page.data : undefined
    if (input && (input.source.scheduleID !== params.data.scheduleID || input.source.passageID !== params.data.passageID)) return reply.code(400).send({ error: "Current passage selector differs" })
    const kind = input?.source.owner ?? query.data.owner
    const lifetime = requestAdmission(request, reply), manager = deps.workspaceManager
    const workspace = manager.get(params.data.id), owned = manager.getServiceLocation(params.data.id)
    if (!workspace || !owned) { lifetime.dispose(); return reply.code(404).send({ error: "Workspace unavailable" }) }
    const deletionCapture = captureDisplayIdentities(deps.worktreeDeletionFence, manager, params.data.id, [owned.directory])
    try {
      const connection = await lifetime.wait(manager.getSharedServiceConnection(params.data.id))
      if (!connection) throw new Error("Mission service unavailable")
      const deletionCurrent = await lifetime.wait(deletionCapture)
      const current = () => {
        lifetime.signal.throwIfAborted(); connection.assertCurrent()
        if (deletionCurrent && !deletionCurrent() || manager.get(params.data.id) !== workspace
          || !sameLocation(manager.getServiceLocation(params.data.id) ?? { directory: "" }, owned)) throw new Error("Mission Location changed")
      }
      const client = connection.client, location = { directory: owned.directory }, options = { ...locationRequestOptions(owned), signal: lifetime.signal }
      current()
      if (!await manager.ownsLocation(params.data.id, owned, client)) return reply.code(403).send({ error: "Mission Location is not owned" })
      const resolved = await lifetime.wait(client.location.get({ location }, options)); current()
      const inventory = await lifetime.wait(client.plugin.list({ location }, options)); current()
      if (!inventory.data.some(item => item.id === CODENOMAD_MISSIONS_RPC_ID && item.state.status === "active")) throw new Error("Mission plugin unavailable")
      const rpc = client.rpc(CODENOMAD_MISSIONS_RPC), call = { location, ...options }
      const identity = async (): Promise<MissionCurrentIdentity> => {
        const value = await lifetime.wait(rpc.recurrenceCurrent({ scheduleID: params.data.scheduleID, owner: kind }, call)); current()
        if (missionPanelBytes(value) > MISSION_PANEL_PAGE_BYTES) throw new Error("Current passage identity capacity")
        const result = missionCurrentIdentitySchema.parse(value)
        if (result.projectID !== resolved.project.id || result.projectCanonical !== resolved.project.canonical || !sameLocation(result.location, owned)
          || result.scheduleID !== params.data.scheduleID || result.source && result.source.owner !== kind) throw new Error("Foreign current passage")
        return result
      }
      const before = await identity()
      if (input && JSON.stringify(input.source) !== JSON.stringify(before.source)) return { available: false, reason: "changed" }
      if (mode !== "identity" && before.passageID !== params.data.passageID) throw new Error("Current passage changed")
      const { projectCanonical: _canonical, location: _location, ...publicIdentity } = before
      let result: unknown = publicIdentity
      if (input) {
        const read = async (selector: typeof input.selector) => {
          const value = await lifetime.wait(rpc.recurrenceCurrentPage({ ...input, selector }, call)); current()
          if (!isMissionPanelPageResult(value) || missionPanelBytes(value) > MISSION_PANEL_PAGE_BYTES
            || value.available && (value.projectID !== resolved.project.id || JSON.stringify(value.passage) !== JSON.stringify(input.source))) throw new Error("Foreign current passage page")
          return value
        }
        result = input.selector.source === "activity" ? await readMissionPanelObservation(input.selector, {
          projectID: resolved.project.id, read, current: () => { try { current(); return true } catch { return false } },
          observe: async (snapshot, onRequests) => {
            const actorsCurrent = await lifetime.wait(captureDisplayIdentities(deps.worktreeDeletionFence, manager, params.data.id,
              snapshot.missions.flatMap(mission => mission.actors.map(actor => actor.location.directory))))
            return lifetime.wait(projectMissionActivity({ client, workspaceID: params.data.id, snapshot, onRequests,
              ownsLocation: manager.ownsLocation.bind(manager), isCurrent: () => { try { current(); return actorsCurrent?.() ?? false } catch { return false } } }))
          },
        }) : await read(input.selector)
      } else if (mode === "content") {
        const content = recurrenceCurrentContentInput.parse({ ...query.data, scheduleID: params.data.scheduleID, passageID: params.data.passageID })
        const raw = await lifetime.wait(rpc.recurrenceCurrentContent(content, call)); current()
        if (missionPanelBytes(raw) > MISSION_PANEL_PAGE_BYTES) throw new Error("Current passage content capacity")
        const value = recurrenceCurrentContentPage.extend({ projectCanonical: z.string(), location: z.object({ directory: z.string(), workspaceID: z.string().optional() }).strict() }).parse(raw)
        if (missionPanelBytes(value) > MISSION_PANEL_PAGE_BYTES || value.projectCanonical !== before.projectCanonical || !sameLocation(value.location, owned)
          || value.scheduleID !== before.scheduleID || value.missionID !== before.source?.missionID || value.passageID !== before.passageID || value.projectID !== before.projectID
          || value.page !== content.page || content.revision !== undefined && value.revision !== content.revision) throw new Error("Foreign current passage content")
        const { projectCanonical: _canonical, location: _location, ...body } = value
        result = recurrenceCurrentContentPage.parse(body)
      }
      if (!await manager.ownsLocation(params.data.id, owned, client)) return reply.code(403).send({ error: "Mission ownership changed" })
      const fresh = await identity()
      if (JSON.stringify(fresh) !== JSON.stringify(before)) throw new Error("Current passage changed")
      current()
      if (missionPanelBytes(result) > MISSION_PANEL_PAGE_BYTES) throw new Error("Current passage response capacity")
      return result
    } catch (error) {
      request.log.warn({ err: error, workspaceId: params.data.id }, "Current Mission passage unavailable")
      return reply.code(503).send({ error: "Current Mission passage unavailable" })
    } finally { lifetime.dispose() }
  }
  app.get<{ Params: Params }>("/api/workspaces/:id/missions/recurrence/:scheduleID/current", route("identity"))
  app.post<{ Params: Params }>("/api/workspaces/:id/missions/recurrence/:scheduleID/current/:passageID/page", { bodyLimit: MISSION_PANEL_REQUEST_BYTES }, route("page"))
  app.get<{ Params: Params }>("/api/workspaces/:id/missions/recurrence/:scheduleID/current/:passageID/content", route("content"))
}
