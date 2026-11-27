import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { missionCalendarAutomations, type MissionCalendarUnsupported } from "../../missions/calendar-automation"
import { missionCalendarIDSchema } from "../../missions/calendar-run"
import { missionConfigurationSchema } from "../../missions/launch-policy"
import type { MissionRead } from "../../missions/model"
import { MissionCalendarMissing, missionCalendars, type MissionCalendarView } from "../../opencode/mission-calendars"
import { requestAdmission } from "../request-admission"
import { prepareMissionCreation } from "./mission-creation-pipeline"
import { MissionMapMutationError, prepareMissionMapMutation } from "./mission-map-mutation"
import type { MissionRouteDeps } from "./missions"

export type MissionCalendarDeps = Pick<MissionRouteDeps, "workspaceManager" | "worktreeDeletionFence" | "settings" | "permissionModes">
const directory = z.string().min(1).max(4096).refine(value => !value.includes("\0")).optional()
const params = z.object({ id: z.string().min(1).max(200), calendar: missionCalendarIDSchema.optional(), action: z.enum(["pause", "resume"]).optional() }).strict()
export const missionCalendarConfigurationSchema = z.object(missionConfigurationSchema.shape).strict()
  .omit({ roots: true, profileID: true, executionHost: true, coordinatorSelectionAuthor: true })
const body = z.object({ configuration: missionCalendarConfigurationSchema, directory, paused: z.boolean().optional() }).strict()

export type MissionCalendarOperation = { kind: "list" } | { kind: "pause" | "resume" | "delete"; calendar: string }
  | { kind: "save"; calendar: string; configuration: z.infer<typeof missionCalendarConfigurationSchema>; paused?: boolean }
export type MissionCalendarOutcome = { calendars: MissionCalendarView[] } | { refused: "calendar-input-invalid" }
  | { refused: "calendar-unsupported"; reason: MissionCalendarUnsupported }

/** One operation on the programmed Missions ("calendars") of a directory, for the panel's routes and
 * the agents' tool alike: list them, or first save, pause, resume or delete one. Saving creates the
 * programming its caller names, or replaces it, and prepares the Mission its first launch starts.
 * Throws `MissionCalendarMissing` and `MissionMapMutationError`. */
export async function runMissionCalendarOperation(deps: MissionCalendarDeps, target: { workspaceID: string; directory?: string; signal: AbortSignal
  wait<T>(operation: Promise<T>): Promise<T> }, operation: MissionCalendarOperation): Promise<MissionCalendarOutcome> {
  const { workspaceID, signal, wait } = target
  const owned = await prepareMissionMapMutation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence, workspaceID, directory: target.directory, signal, wait })
  return owned.run(async (rpc, options) => {
    const calendars = missionCalendars(owned.client, owned.location, owned.projectID, signal), call = { ...options, signal }
    if (operation.kind === "save") {
      const id = operation.calendar, scope = deps.settings?.getProfileScope(), distro = deps.workspaceManager.getServiceWslDistro(workspaceID)
      const parsed = missionConfigurationSchema.safeParse({ ...operation.configuration, profileID: scope?.key ?? null,
        executionHost: distro ? `wsl:${distro}` : "local", roots: [{ mode: "directory-only", directory: owned.location.directory }] })
      if (!parsed.success) return { refused: "calendar-input-invalid" }
      const config = parsed.data, unsupported = missionCalendarAutomations(config, id)
      if (!Array.isArray(unsupported)) return { refused: "calendar-unsupported", reason: unsupported.unsupported }
      // Its caller names the programming, so saving it twice is saving the same one.
      const existing = (await wait(calendars.list())).find(item => item.id === id)
      // Until its first launch the programmed Mission is an ordinary prepared one: it has its line and can be played by hand.
      const current = existing?.missionID ? (await wait(rpc.mission({ missionID: existing.missionID }, call)) as MissionRead).mission : undefined
      const pristine = current?.status === "active" && current.runState === "prepared"
      let prepared: string | undefined
      if (!current || pristine) {
        // An edit before the first launch prepares the Mission again, in the same conversation.
        if (pristine) await wait(rpc.delete({ missionID: current.id, expectedRevision: current.revision, requestID: `calendar_edit_${randomUUID().slice(0, 8)}`, deleteManagedSessions: false }, call))
        const coordinatorSessionId = config.coordinatorSessionID ?? (pristine ? current.coordinatorSessionId : undefined)
        const creation = await prepareMissionCreation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence, workspaceID,
          signal, wait, permissionModes: deps.permissionModes,
          request: JSON.parse(JSON.stringify({ requestId: `calendar_${id}_${randomUUID().slice(0, 8)}`, objective: config.objective, title: config.title, notes: config.notes,
            template: config.template, profiles: config.profiles, taskMode: config.taskMode, coordinatorGoal: config.coordinatorGoal, coordinatorSessionId,
            directory: owned.location.directory })) })
        prepared = (await creation.execute()).mission.id
      }
      await owned.refresh()
      // After its first launch an edited programming keeps naming the Mission of its current launch.
      const automations = missionCalendarAutomations(config, id, prepared ?? current?.id)
      await wait(calendars.save(id, Array.isArray(automations) ? automations : [], operation.paused))
    } else if (operation.kind !== "list") await wait(calendars[operation.kind](operation.calendar))
    await owned.refresh()
    return { calendars: await wait(calendars.list()) }
  })
}

/** Programmed Missions are native Automations: `PUT` creates the programming its caller names, or replaces it. */
export function registerMissionCalendars(app: FastifyInstance, deps: MissionCalendarDeps) {
  const serve = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, saves = false) => app.route({ method, url, handler: async (request, reply) => {
    const selected = params.safeParse(request.params), input = saves ? body.safeParse(request.body) : undefined
    const query = z.object({ directory }).strict().safeParse(request.query)
    if (!selected.success || !query.success || input && !input.success) return reply.code(400).send({ error: "Invalid Mission calendar request", code: "calendar-input-invalid" })
    const lifetime = requestAdmission(request, reply), calendar = selected.data.calendar
    try {
      const outcome = await runMissionCalendarOperation(deps, { workspaceID: selected.data.id, directory: input?.data.directory ?? query.data.directory,
        signal: lifetime.signal, wait: lifetime.wait },
      input ? { kind: "save", calendar: calendar!, configuration: input.data.configuration, paused: input.data.paused }
        : method === "POST" ? { kind: selected.data.action!, calendar: calendar! } : method === "DELETE" ? { kind: "delete", calendar: calendar! } : { kind: "list" })
      if ("calendars" in outcome) return outcome
      if (outcome.refused === "calendar-unsupported") return reply.code(422).send({ error: "Launch criteria a calendar cannot carry", code: outcome.refused, reason: outcome.reason })
      return reply.code(400).send({ error: "Invalid Mission calendar configuration", code: outcome.refused })
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
