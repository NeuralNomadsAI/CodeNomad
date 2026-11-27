import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { missionCalendarAutomations } from "../../missions/calendar-automation"
import { missionCalendarIDSchema } from "../../missions/calendar-run"
import { missionConfigurationSchema } from "../../missions/launch-policy"
import { MissionCalendarMissing, missionCalendars } from "../../opencode/mission-calendars"
import type { SettingsService } from "../../settings/service"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { requestAdmission } from "../request-admission"
import { MissionMapMutationError, prepareMissionMapMutation, type MissionMapMutationManager } from "./mission-map-mutation"

type Deps = { workspaceManager: MissionMapMutationManager & Pick<WorkspaceManager, "getServiceWslDistro">; worktreeDeletionFence?: WorktreeDeletionFence
  settings?: Pick<SettingsService, "getProfileScope"> }
const directory = z.string().min(1).max(4096).refine(value => !value.includes("\0")).optional()
const params = z.object({ id: z.string().min(1).max(200), calendar: missionCalendarIDSchema.optional(), action: z.enum(["pause", "resume"]).optional() }).strict()
const configuration = z.object(missionConfigurationSchema.shape).strict().omit({ roots: true, profileID: true, executionHost: true, coordinatorSelectionAuthor: true })
const body = z.object({ configuration, directory }).strict()

/** Mission calendars are native Automations: these routes only translate the editor's
 * launch criteria and list, pause, resume or delete what OpenCode holds. */
export function registerMissionCalendars(app: FastifyInstance, deps: Deps) {
  const serve = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, saves = false) => app.route({ method, url, handler: async (request, reply) => {
    const selected = params.safeParse(request.params), input = saves ? body.safeParse(request.body) : undefined
    const query = z.object({ directory }).strict().safeParse(request.query)
    if (!selected.success || !query.success || input && !input.success) return reply.code(400).send({ error: "Invalid Mission calendar request", code: "calendar-input-invalid" })
    const lifetime = requestAdmission(request, reply)
    try {
      const owned = await prepareMissionMapMutation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence, workspaceID: selected.data.id,
        directory: input?.data.directory ?? query.data.directory, signal: lifetime.signal, wait: lifetime.wait })
      return await owned.run(async () => {
        const calendars = missionCalendars(owned.client, owned.location, owned.projectID, lifetime.signal)
        const calendar = selected.data.calendar
        if (input) {
          const scope = deps.settings?.getProfileScope(), distro = deps.workspaceManager.getServiceWslDistro(selected.data.id)
          const parsed = missionConfigurationSchema.safeParse({ ...input.data.configuration, profileID: scope?.key ?? null,
            executionHost: distro ? `wsl:${distro}` : "local", roots: [{ mode: "directory-only", directory: owned.location.directory }] })
          if (!parsed.success) return reply.code(400).send({ error: "Invalid Mission calendar configuration", code: "calendar-input-invalid" })
          const id = calendar ?? `cal_${randomUUID().replaceAll("-", "")}`, automations = missionCalendarAutomations(parsed.data, id)
          if (!Array.isArray(automations)) return reply.code(422).send({ error: "Launch criteria a calendar cannot carry", code: "calendar-unsupported", reason: automations.unsupported })
          await owned.refresh()
          await lifetime.wait(calendars.save(id, automations))
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
  serve("POST", "/api/workspaces/:id/missions/calendars", true)
  serve("PUT", "/api/workspaces/:id/missions/calendars/:calendar", true)
  serve("POST", "/api/workspaces/:id/missions/calendars/:calendar/:action")
  serve("DELETE", "/api/workspaces/:id/missions/calendars/:calendar")
}
