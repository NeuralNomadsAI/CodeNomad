import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { MissionRecurrenceCurrent, MissionRecurrenceCurrentContent } from "../../api-types"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { projectMissionActivity } from "../../missions/activity"
import { recurrenceIDSchema } from "../../missions/recurrence-contract"
import { recurrenceCurrentContentInput, recurrenceCurrentContentPage } from "../../missions/recurrence-current"
import { stableToken } from "../../missions/journal"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { requestAdmission } from "../request-admission"

type Deps = { workspaceManager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection" | "ownsLocation">;
  worktreeDeletionFence?: WorktreeDeletionFence }
type Params = { id: string; scheduleID: string; passageID?: string }
type NativeCurrent = Omit<MissionRecurrenceCurrent, "activity"> & { projectCanonical: string; location: { directory: string; workspaceID?: string } }
type NativeContent = MissionRecurrenceCurrentContent & Pick<NativeCurrent, "projectCanonical" | "location">
const paramsSchema = z.object({ id: z.string().trim().min(1).max(200), scheduleID: recurrenceIDSchema, passageID: recurrenceIDSchema.optional() }).strict()
const querySchema = z.object({ kind: z.enum(["overview", "task", "report", "change"]), itemId: z.string().min(1).max(240).optional(),
  section: z.enum(["summary", "objective", "notes", "evidence", "next", "brief", "artifact", "achieved", "ongoing", "obstacles"]).default("summary"),
  page: z.coerce.number().int().min(0).max(63).default(0), revision: z.coerce.number().int().positive().safe().optional() }).strict()

export function registerMissionRecurrenceCurrent(app: FastifyInstance, deps: Deps): void {
  const route = (content: boolean) => async (request: import("fastify").FastifyRequest<{ Params: Params }>, reply: import("fastify").FastifyReply) => {
    const params = paramsSchema.safeParse(request.params)
    const query = (content ? querySchema : z.object({}).strict()).safeParse(request.query)
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid current recurrence request" })
    if (content && !recurrenceCurrentContentInput.safeParse({ ...query.data, scheduleID: params.data.scheduleID,
      passageID: params.data.passageID }).success) return reply.code(400).send({ error: "Invalid current recurrence reader target" })
    const lifetime = requestAdmission(request, reply), manager = deps.workspaceManager
    const workspace = manager.get(params.data.id), owned = manager.getServiceLocation(params.data.id)
    if (!workspace || !owned) { lifetime.dispose(); return reply.code(404).send({ error: "Workspace unavailable" }) }
    const deletionCurrent = deps.worktreeDeletionFence?.captureDisplay([owned.directory])
    try {
      const connection = await lifetime.wait(manager.getSharedServiceConnection(params.data.id))
      if (!connection) return reply.code(503).send({ error: "Mission service unavailable" })
      const current = () => {
        lifetime.signal.throwIfAborted(); connection.assertCurrent()
        if (deletionCurrent && !deletionCurrent() || manager.get(params.data.id) !== workspace
          || !sameLocation(manager.getServiceLocation(params.data.id) ?? { directory: "" }, owned)) throw new Error("Mission Location changed")
      }
      current()
      const client = connection.client, location = { directory: owned.directory }, options = locationRequestOptions(owned)
      if (!await manager.ownsLocation(params.data.id, owned, client)) return reply.code(403).send({ error: "Mission Location is not owned" })
      current()
      const resolved = await client.location.get({ location }, options)
      current()
      const inventory = await client.plugin.list({ location }, options)
      current()
      if (!inventory.data.some(item => item.id === CODENOMAD_MISSIONS_RPC_ID && item.state.status === "active")) return reply.code(503).send({ error: "Mission plugin unavailable" })
      const rpc = client.rpc(CODENOMAD_MISSIONS_RPC)
      const validate = (result: NativeCurrent | NativeContent) => {
        current()
        canonicalAuthority(result, 32 * 1024 * 1024)
        if (result.version !== 1 || result.scheduleID !== params.data.scheduleID || result.projectID !== resolved.project.id
          || result.projectCanonical !== resolved.project.canonical || !sameLocation(result.location, owned)
          || result.passageID !== null && !recurrenceIDSchema.safeParse(result.passageID).success) throw new Error("Foreign current recurrence response")
        const missionID = result.passageID ? `msn_${stableToken(`${result.projectID}\0${result.passageID}`, 24)}` : undefined
        if ("mission" in result && result.mission && (result.mission.id !== missionID || result.mission.projectID !== result.projectID
          || result.mission.projectCanonical !== result.projectCanonical
          || result.mission.coordinatorSessionId !== `ses_${stableToken(`${missionID}\0coordinator`, 26)}`
          || result.mission.actors.length > 8 || result.mission.tasks.length > 96)) throw new Error("Foreign current recurrence mission")
        if ("missionID" in result && (result.passageID !== params.data.passageID || result.missionID !== missionID)) throw new Error("Foreign current recurrence content")
      }
      if (content) {
        const input = recurrenceCurrentContentInput.parse({ ...query.data, scheduleID: params.data.scheduleID, passageID: params.data.passageID })
        const result = await lifetime.wait(rpc.recurrenceCurrentContent(input, { location, ...options })) as NativeContent
        validate(result)
        if (result.page !== input.page || input.revision !== undefined && result.revision !== input.revision) throw new Error("Current recurrence content changed")
        if (!await manager.ownsLocation(params.data.id, owned, client)) return reply.code(403).send({ error: "Mission Location is not owned" })
        current()
        const fresh = await lifetime.wait(rpc.recurrenceCurrent({ scheduleID: params.data.scheduleID }, { location, ...options })) as NativeCurrent
        validate(fresh)
        if (fresh.passageID !== result.passageID || fresh.mission?.id !== result.missionID || fresh.mission.revision !== result.revision) throw new Error("Current recurrence content changed")
        const { projectCanonical: _canonical, location: _location, ...page } = result
        return recurrenceCurrentContentPage.parse(page)
      }
      const result = await lifetime.wait(rpc.recurrenceCurrent({ scheduleID: params.data.scheduleID }, { location, ...options })) as NativeCurrent
      validate(result)
      let activity: MissionRecurrenceCurrent["activity"]
      if (result.mission) {
        const mission = result.mission
        const actorCurrent = deps.worktreeDeletionFence?.captureDisplay(mission.actors.map(actor => actor.location.directory))
        activity = await lifetime.wait(projectMissionActivity({ client, workspaceID: params.data.id,
          snapshot: { version: 1, projectID: result.projectID, generatedAt: Date.now(), missions: [mission], discardedEvents: 0 },
          ownsLocation: manager.ownsLocation.bind(manager), isCurrent: () => {
            try { current(); return Boolean(deletionCurrent?.() && actorCurrent?.()) } catch { return false }
          } }))
        current()
      }
      if (!await manager.ownsLocation(params.data.id, owned, client)) return reply.code(403).send({ error: "Mission Location is not owned" })
      current()
      // Activity/ownership IO cannot publish a former passage after the calendar advances.
      const fresh = await lifetime.wait(rpc.recurrenceCurrent({ scheduleID: params.data.scheduleID }, { location, ...options })) as NativeCurrent
      validate(fresh)
      if (fresh.passageID !== result.passageID || fresh.mission?.id !== result.mission?.id
        || fresh.mission?.revision !== result.mission?.revision) throw new Error("Current recurrence passage changed")
      return { version: 1, projectID: result.projectID, scheduleID: result.scheduleID, passageID: result.passageID,
        ...(result.mission ? { mission: result.mission } : {}), ...(activity ? { activity } : {}) } satisfies MissionRecurrenceCurrent
    } catch (error) {
      request.log.warn({ err: error, workspaceId: params.data.id }, "Current Mission recurrence unavailable")
      return reply.code(503).send({ error: "Current Mission recurrence unavailable" })
    } finally { lifetime.dispose() }
  }
  app.get<{ Params: Params }>("/api/workspaces/:id/missions/recurrence/:scheduleID/current", route(false))
  app.get<{ Params: Params }>("/api/workspaces/:id/missions/recurrence/:scheduleID/current/:passageID/content", route(true))
}
