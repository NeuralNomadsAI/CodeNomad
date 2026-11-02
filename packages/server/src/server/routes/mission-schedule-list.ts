import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { MissionScheduleCapability } from "../../api-types"
import { MISSION_SCHEDULE_PAGE_MAX, missionScheduleListInput, type MissionScheduleList } from "../../missions/mission-schedule-list"
import type { NativeScheduleCapabilityReader } from "../../opencode/native-schedule-capability"
import type { NativeScheduleSettingsActivation } from "../../opencode/native-schedule-settings-activation"
import { PluginControlsError } from "../../opencode/plugin-controls"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { requestAdmission } from "../request-admission"
import { MissionMapMutationError, prepareMissionMapMutation, type MissionMapMutationManager } from "./mission-map-mutation"

const params = z.object({ id: z.string().min(1).max(200) }).strict()
const directory = z.string().min(1).max(4096).refine(value => !value.includes("\0")).optional()
const listQuery = missionScheduleListInput.extend({ directory, limit: z.coerce.number().int().min(1).max(MISSION_SCHEDULE_PAGE_MAX).default(MISSION_SCHEDULE_PAGE_MAX) })
type Deps = { workspaceManager: MissionMapMutationManager; worktreeDeletionFence?: WorktreeDeletionFence;
  scheduleCapability?: Pick<NativeScheduleCapabilityReader, "read">;
  scheduleSettingsActivation?: Pick<NativeScheduleSettingsActivation, "prepare"> }

/** Display reads share workspace/physical fences, without retaining a mutation
 * permit, activating settings, reconciling work or falling back to a full scan. */
export function registerMissionScheduleList(app: FastifyInstance, deps: Deps) {
  for (const capability of [false, true]) app.get(capability
    ? "/api/workspaces/:id/missions/scheduled/capabilities" : "/api/workspaces/:id/missions/scheduled", async (request, reply) => {
    const selected = params.safeParse(request.params)
    const input = (capability ? z.object({ directory }).strict() : listQuery).safeParse(request.query)
    if (!selected.success || !input.success) return reply.code(400).send({ error: "Invalid Mission schedule read", code: "schedule-input-invalid" })
    const lifetime = requestAdmission(request, reply)
    try {
      const owned = await prepareMissionMapMutation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence,
        workspaceID: selected.data.id, directory: input.data.directory, signal: lifetime.signal, wait: lifetime.wait })
      return await owned.run(async (rpc, options) => {
        const call = { ...options, signal: lifetime.signal }
        if (!capability) {
          const query = listQuery.parse(request.query)
          const location = await lifetime.wait(owned.client.location.get({ location: owned.location }, call))
          await owned.refresh()
          const page = await lifetime.wait(rpc.scheduleList({ after: query.after, limit: query.limit }, call)) as MissionScheduleList
          await owned.refresh()
          if (page.projectID !== location.project.id) throw new Error("Foreign Mission schedule list")
          return page
        }
        if (!deps.scheduleCapability) throw new Error("Mission schedule capability unavailable")
        const view = await lifetime.wait(deps.scheduleCapability.read(selected.data.id, owned.location))
        await owned.refresh()
        let activation: MissionScheduleCapability["activation"] = { available: false, reason: "unavailable", targets: [] }
        if (view.api.available && deps.scheduleSettingsActivation) {
          try {
            const plan = await lifetime.wait(deps.scheduleSettingsActivation.prepare(selected.data.id, owned.location))
            activation = { available: true, targets: plan.targets.map(({ path, scope }) => ({ path, scope })) }
          } catch (error) {
            activation = { available: false, reason: error instanceof PluginControlsError ? error.kind : "unavailable", targets: [] }
          }
        }
        await owned.refresh()
        return { ...view, activation } satisfies MissionScheduleCapability
      })
    } catch (error) {
      const status = error instanceof MissionMapMutationError ? error.status : 503
      return reply.code(status).send({ error: "Mission schedule read unavailable", code: "schedule-read-unavailable" })
    } finally { lifetime.dispose() }
  })
}
