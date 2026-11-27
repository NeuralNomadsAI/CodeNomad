import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { missionCalendarAutomations } from "../../missions/calendar-automation"
import { missionCalendarIDSchema } from "../../missions/calendar-run"
import { missionConfigurationSchema } from "../../missions/launch-policy"
import type { MissionRead } from "../../missions/model"
import { MissionCalendarMissing, missionCalendars } from "../../opencode/mission-calendars"
import { requestAdmission } from "../request-admission"
import { prepareMissionCreation } from "./mission-creation-pipeline"
import { MissionMapMutationError, prepareMissionMapMutation } from "./mission-map-mutation"
import type { MissionRouteDeps } from "./missions"

type Deps = Pick<MissionRouteDeps, "workspaceManager" | "worktreeDeletionFence" | "settings" | "permissionModes">
const directory = z.string().min(1).max(4096).refine(value => !value.includes("\0")).optional()
const params = z.object({ id: z.string().min(1).max(200), calendar: missionCalendarIDSchema.optional(), action: z.enum(["pause", "resume"]).optional() }).strict()
const configuration = z.object(missionConfigurationSchema.shape).strict().omit({ roots: true, profileID: true, executionHost: true, coordinatorSelectionAuthor: true })
const body = z.object({ configuration, directory, paused: z.boolean().optional() }).strict()

/** Programmed Missions ("calendars") are native Automations: these routes translate the
 * form's launch criteria, prepare the Mission the first launch starts, and list, pause,
 * resume or delete what OpenCode holds. `PUT` creates the programming its caller names, or replaces it. */
export function registerMissionCalendars(app: FastifyInstance, deps: Deps) {
  const serve = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, saves = false) => app.route({ method, url, handler: async (request, reply) => {
    const selected = params.safeParse(request.params), input = saves ? body.safeParse(request.body) : undefined
    const query = z.object({ directory }).strict().safeParse(request.query)
    if (!selected.success || !query.success || input && !input.success) return reply.code(400).send({ error: "Invalid Mission calendar request", code: "calendar-input-invalid" })
    const lifetime = requestAdmission(request, reply)
    try {
      const requested = input?.data.directory ?? query.data.directory
      const owned = await prepareMissionMapMutation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence, workspaceID: selected.data.id,
        directory: requested, signal: lifetime.signal, wait: lifetime.wait })
      return await owned.run(async (rpc, options) => {
        const calendars = missionCalendars(owned.client, owned.location, owned.projectID, lifetime.signal)
        const calendar = selected.data.calendar, call = { ...options, signal: lifetime.signal }
        if (input) {
          const scope = deps.settings?.getProfileScope(), distro = deps.workspaceManager.getServiceWslDistro(selected.data.id)
          const parsed = missionConfigurationSchema.safeParse({ ...input.data.configuration, profileID: scope?.key ?? null,
            executionHost: distro ? `wsl:${distro}` : "local", roots: [{ mode: "directory-only", directory: owned.location.directory }] })
          if (!parsed.success) return reply.code(400).send({ error: "Invalid Mission calendar configuration", code: "calendar-input-invalid" })
          const id = calendar!, config = parsed.data
          const unsupported = missionCalendarAutomations(config, id)
          if (!Array.isArray(unsupported)) return reply.code(422).send({ error: "Launch criteria a calendar cannot carry", code: "calendar-unsupported", reason: unsupported.unsupported })
          // The form names the programming, so saving it twice is saving the same one.
          const existing = (await lifetime.wait(calendars.list())).find(item => item.id === id)
          // Until its first launch the programmed Mission is an ordinary prepared one: it has its line and can be played by hand.
          const current = existing?.missionID ? (await lifetime.wait(rpc.mission({ missionID: existing.missionID }, call)) as MissionRead).mission : undefined
          const pristine = current?.status === "active" && current.runState === "prepared"
          let prepared: string | undefined
          if (!current || pristine) {
            // An edit before the first launch prepares the Mission again, in the same conversation.
            if (pristine) await lifetime.wait(rpc.delete({ missionID: current.id, expectedRevision: current.revision, requestID: `calendar_edit_${randomUUID().slice(0, 8)}`, deleteManagedSessions: false }, call))
            const coordinatorSessionId = config.coordinatorSessionID ?? (pristine ? current.coordinatorSessionId : undefined)
            const creation = await prepareMissionCreation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence, workspaceID: selected.data.id,
              signal: lifetime.signal, wait: lifetime.wait, permissionModes: deps.permissionModes,
              request: JSON.parse(JSON.stringify({ requestId: `calendar_${id}_${randomUUID().slice(0, 8)}`, objective: config.objective, title: config.title, notes: config.notes,
                template: config.template, profiles: config.profiles, taskMode: config.taskMode, coordinatorGoal: config.coordinatorGoal, coordinatorSessionId,
                directory: owned.location.directory })) })
            prepared = (await creation.execute()).mission.id
          }
          await owned.refresh()
          // After its first launch an edited programming keeps naming the Mission of its current launch.
          const automations = missionCalendarAutomations(config, id, prepared ?? current?.id)
          await lifetime.wait(calendars.save(id, Array.isArray(automations) ? automations : [], input.data.paused))
        } else if (method === "POST") await lifetime.wait(calendars[selected.data.action!](calendar!))
        else if (method === "DELETE") await lifetime.wait(calendars.delete(calendar!))
        await owned.refresh()
        return { calendars: await lifetime.wait(calendars.list()) }
      })
    } catch (error) {
      if (error instanceof MissionCalendarMissing) return reply.code(404).send({ error: "Mission calendar not found", code: "calendar-missing" })
      return reply.code(error instanceof MissionMapMutationError ? error.status : 503).send({ error: "Mission calendars unavailable", code: "calendar-unavailable" })
    } finally { lifetime.dispose() }
  } })
  serve("GET", "/api/workspaces/:id/missions/calendars")
  serve("PUT", "/api/workspaces/:id/missions/calendars/:calendar", true)
  serve("POST", "/api/workspaces/:id/missions/calendars/:calendar/:action")
  serve("DELETE", "/api/workspaces/:id/missions/calendars/:calendar")
}
