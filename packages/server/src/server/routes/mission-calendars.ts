import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { isSessionNotFoundError } from "@opencode/client"
import { missionCalendarAutomations, type MissionCalendarUnsupported } from "../../missions/calendar-automation"
import { missionCalendarIDSchema } from "../../missions/calendar-run"
import { missionConfigurationSchema } from "../../missions/launch-policy"
import type { LegacySchedule } from "../../missions/legacy-schedules"
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

// Per service connection, the directories where no schedule of the recurring engine is left.
const takenOver = new WeakMap<object, Set<string>>()

/** One operation on the programmed Missions ("calendars") of a directory, for the panel's routes and
 * the agents' tool alike: list them, or first save, pause, resume or delete one. Saving creates the
 * programming its caller names, or replaces it, and prepares the Mission its first launch starts.
 * The schedules the recurring engine left in the directory are taken over first, and a paused
 * programmed Mission whose Mission is gone has one prepared again.
 * Throws `MissionCalendarMissing` and `MissionMapMutationError`. */
export async function runMissionCalendarOperation(deps: MissionCalendarDeps, target: { workspaceID: string; directory?: string; signal: AbortSignal
  wait<T>(operation: Promise<T>): Promise<T> }, operation: MissionCalendarOperation): Promise<MissionCalendarOutcome> {
  const { workspaceID, signal, wait } = target
  const owned = await prepareMissionMapMutation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence, workspaceID, directory: target.directory, signal, wait })
  return owned.run(async (rpc, options) => {
    const calendars = missionCalendars(owned.client, owned.location, owned.projectID, signal), call = { ...options, signal }
    type Configuration = z.infer<typeof missionCalendarConfigurationSchema>
    const prepare = async (config: Pick<Configuration, "objective" | "title" | "notes" | "template" | "profiles" | "taskMode" | "coordinatorGoal">, request: string, coordinatorSessionId?: string) =>
      (await (await prepareMissionCreation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence, workspaceID, signal, wait, permissionModes: deps.permissionModes,
        request: JSON.parse(JSON.stringify({ requestId: `calendar_${request}_${randomUUID().slice(0, 8)}`, objective: config.objective, title: config.title, notes: config.notes,
          template: config.template, profiles: config.profiles, taskMode: config.taskMode, coordinatorGoal: config.coordinatorGoal, coordinatorSessionId,
          directory: owned.location.directory })) })).execute()).mission.id
    /** `restoring` prepares the Mission a programming lost: what a person could not have saved is accepted as it stands. */
    const save = async (id: string, configuration: Configuration, paused?: boolean, restoring = false): Promise<Exclude<MissionCalendarOutcome, { calendars: unknown }> | undefined> => {
      const scope = deps.settings?.getProfileScope(), distro = deps.workspaceManager.getServiceWslDistro(workspaceID)
      const parsed = missionConfigurationSchema.safeParse({ ...configuration, profileID: scope?.key ?? null,
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
        const session = config.coordinatorSessionID ?? (pristine ? current.coordinatorSessionId : undefined)
        // A lost Mission is prepared in another conversation when the one it names cannot coordinate.
        prepared = await prepare(config, id, session).catch(error => { if (!restoring || !session) throw error; return prepare(config, id) })
      }
      await owned.refresh()
      // After its first launch an edited programming keeps naming the Mission of its current launch.
      const automations = missionCalendarAutomations(config, id, prepared ?? current?.id)
      await wait(calendars.save(id, Array.isArray(automations) ? automations : [], paused))
    }
    /** A schedule of the recurring engine becomes the programmed Mission of the same identity, running or paused as it was,
     * or an ordinary prepared Mission when its launch criteria do not carry over; then nothing of the schedule is left.
     * The programmed Mission is saved paused and resumed last, so the two never launch together. */
    const takeOver = async (schedule: LegacySchedule) => {
      let programmed = (await wait(calendars.list())).some(item => item.id === schedule.id)
      if (!programmed) {
        const { roots: _roots, profileID: _profile, executionHost: _host, coordinatorSelectionAuthor: _author, ...stored } = schedule.configuration
        const configuration = missionCalendarConfigurationSchema.safeParse(stored).data
        if (!configuration) return
        // A conversation that no longer exists cannot coordinate: the first launch opens another.
        if (configuration.coordinatorSessionID && await wait(owned.client.session.get({ sessionID: configuration.coordinatorSessionID }, { signal })
          .then(() => false, isSessionNotFoundError))) delete configuration.coordinatorSessionID
        programmed = !await save(schedule.id, configuration, true)
        if (!programmed) await prepare(configuration, schedule.id)
      }
      await Promise.allSettled(schedule.automations.map(automationID => owned.client.experimental.automation.delete({ automationID }, { signal })))
      await wait(rpc.retireLegacySchedule({ id: schedule.id }, call))
      if (programmed && schedule.running) await wait(calendars.resume(schedule.id))
    }
    const directories = takenOver.get(owned.connection) ?? takenOver.set(owned.connection, new Set()).get(owned.connection)!
    const directoryKey = JSON.stringify([owned.projectID, owned.location.directory])
    if (!directories.has(directoryKey)) {
      // A plugin without this reading answers nothing: there is nothing to take over through it.
      const legacy = await wait((rpc.legacySchedules({}, call) as Promise<{ schedules: LegacySchedule[] }>).then(result => result.schedules, () => undefined))
      // One after the other: each reads the list the previous one changed. What is left is tried again by the next operation.
      for (const schedule of legacy ?? []) await takeOver(schedule).catch(() => undefined)
      if (legacy && !legacy.length) directories.add(directoryKey)
      await owned.refresh()
    }
    // A programmed Mission is listed as its Mission. A paused one has no run under way that could be replacing it.
    for (const calendar of await wait(calendars.list())) {
      if (!calendar.paused || calendar.missionID && (await wait(rpc.mission({ missionID: calendar.missionID }, call)) as MissionRead).mission) continue
      const { when: _when, ...stored } = calendar.mission
      const configuration = missionCalendarConfigurationSchema.safeParse({ ...stored, watchedConversationIDs: [], launch: calendar.launch }).data
      if (configuration) await save(calendar.id, configuration, true, true).catch(() => undefined)
    }
    if (operation.kind === "save") {
      const refused = await save(operation.calendar, operation.configuration, operation.paused)
      if (refused) return refused
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
