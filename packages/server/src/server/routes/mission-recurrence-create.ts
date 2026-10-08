import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { canonicalAuthority } from "../../missions/authority-protocol"
import type { SettingsService } from "../../settings/service"
import { recurrenceBudgetsSchema, recurrenceConfigSchema, type RecurrenceConfig } from "../../missions/recurrence-contract"
import { dailyClockSchema } from "../../missions/recurrence-clock"
import { missionProfileRoles, missionProfilesInputSchema, validateMissionProfileCatalog, validateMissionProfiles } from "../../missions/playbook-profiles"
import { missionTaskModeInputSchema } from "../../missions/task-execution-mode"
import { readMissionCatalog } from "../../missions/native-catalog"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { recurrenceConfigDigest, recurrenceScheduleID } from "../../opencode/missions/native-recurrence-create"
import { requestAdmission } from "../request-admission"
import { admitMissionCreationLocations } from "./mission-creation-admission"
import { MissionCreationHoldError, reconcileRecurrenceCreation } from "./mission-creation-holds"
import { resolveRecurrenceRoot, type WslGit } from "./mission-recurrence-roots"
import { MISSION_LIFECYCLE_TEXT_LIMIT, recurrenceStartText } from "../../missions/lifecycle-input"
import { recurrenceInputBudget, recurrenceReadBudget } from "../../missions/recurrence-read-budget"

const schema = z.object({ requestID: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/),
  instructions: z.string().trim().min(1).max(MISSION_LIFECYCLE_TEXT_LIMIT), clock: dailyClockSchema,
  notes: z.string().max(20_000).optional(),
  template: z.enum(["custom", "pocock-fix-bug", "wayfinder"]),
  directory: z.string().min(1).max(4096).optional(),
  watchedConversationIDs: z.array(z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/)).max(32)
    .refine(ids => new Set(ids).size === ids.length),
  // Native admission reserves create, start and coordinator-message before any
  // optional calls. Do not publish a schedule that cannot run once authorized.
  budgets: recurrenceBudgetsSchema.refine(value => value.effects >= 3, "Recurrence needs three fixed effects"),
  profiles: missionProfilesInputSchema,
  taskMode: missionTaskModeInputSchema,
}).strict()
type Manager = Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection" | "ownsLocation"
  | "getServiceDirectoryForPath" | "getWorktreeIdentityForPath" | "getHostPathForServicePath" | "getServiceWslDistro">
type NativeSummary = { schedule: { id: string; revision: number; state: string; digest: string;
  projectID: string; projectCanonical: string } | null }
type NativeCreateReply = NativeSummary & { noEffect?: { code: "capacity"; id: string; requestID: string;
  digest: string; projectID: string; projectCanonical: string } }

/** Authenticated HTTP admission only. The sole native write is a paused CAS
 * schedule; a lost ACK is checked by exact key+digest, never retried blindly. */
export function registerMissionRecurrenceCreate(app: FastifyInstance, deps: { workspaceManager: Manager;
  settings?: Pick<SettingsService, "getProfileScope">; wslGit?: WslGit;
  worktreeDeletionFence?: WorktreeDeletionFence }) {
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/missions/recurrence", async (request, reply) => {
    const lifetime = requestAdmission(request, reply)
    let admission: Awaited<ReturnType<typeof admitMissionCreationLocations>> | undefined
    try {
      const parsed = schema.safeParse(request.body)
      if (!parsed.success || !z.string().min(1).max(200).safeParse(request.params.id).success) {
        return reply.code(400).send({ error: "Invalid recurrence creation request" })
      }
      const input = parsed.data, manager = deps.workspaceManager, workspaceID = request.params.id
      if (!recurrenceReadBudget(input.watchedConversationIDs.length, input.budgets).sufficient) {
        return reply.code(400).send({ error: "Every followed conversation needs a funded read", code: "recurrence-source-budget" })
      }
      try { recurrenceStartText({ consigne: input.instructions, template: input.template, taskMode: input.taskMode }) }
      catch { return reply.code(400).send({ error: "Recurrence start input exceeds lifecycle capacity", code: "recurrence-input-capacity" }) }
      if (!input.profiles?.coordinator || missionProfileRoles[input.template].some(role => !input.profiles?.roles?.[role])
        || [input.profiles.coordinator, ...Object.values(input.profiles.roles ?? {})].some(selection => !selection.agent || !selection.model)) {
        return reply.code(400).send({ error: "Explicit coordinator and playbook role selections required" })
      }
      try { validateMissionProfiles(input.template, input.profiles) }
      catch { return reply.code(400).send({ error: "Invalid recurrence profile selection" }) }
      const workspace = manager.get(workspaceID), base = manager.getServiceLocation(workspaceID), fence = deps.worktreeDeletionFence
      if (!workspace || !base) return reply.code(404).send({ error: "Workspace unavailable" })
      if (!fence) return reply.code(503).send({ error: "Recurrence deletion fence unavailable" })
      if (!deps.settings) return reply.code(503).send({ error: "Recurrence profile unavailable" })
      const profileScope = deps.settings.getProfileScope(), selectedDistro = manager.getServiceWslDistro(workspaceID)
      const executionHost = selectedDistro ? `wsl:${selectedDistro}` : "local"
      const assertScopeCurrent = () => {
        if (canonicalAuthority(deps.settings!.getProfileScope()) !== canonicalAuthority(profileScope)
          || manager.getServiceWslDistro(workspaceID) !== selectedDistro) throw new Error("Recurrence authority changed")
      }
      assertScopeCurrent()
      const connection = await lifetime.wait(manager.getSharedServiceConnection(workspaceID))
      if (!connection) return reply.code(503).send({ error: "Mission service unavailable" })
      const check = () => {
        lifetime.signal.throwIfAborted(); connection.assertCurrent()
        assertScopeCurrent()
        if (manager.get(workspaceID) !== workspace || !sameLocation(manager.getServiceLocation(workspaceID) ?? { directory: "" }, base)) {
          throw new Error("Recurrence workspace changed")
        }
      }
      const client = connection.client, requested = input.directory ? { directory: input.directory } : base
      if (!await lifetime.wait(manager.ownsLocation(workspaceID, requested, client, lifetime.signal))) {
        return reply.code(403).send({ error: "Recurrence directory is not owned" })
      }
      const directory = await lifetime.wait(manager.getServiceDirectoryForPath(workspaceID, requested.directory))
      if (!directory) return reply.code(403).send({ error: "Recurrence directory is not owned" })
      const location = { directory }, options = { location, ...locationRequestOptions(location), signal: lifetime.signal }
      const [resolved, baseResolved] = await lifetime.wait(Promise.all([
        client.location.get({ location }, options),
        client.location.get({ location: { directory: base.directory } }, { ...locationRequestOptions(base), signal: lifetime.signal }),
      ]))
      check()
      if (!sameLocation(resolved, location) || !await lifetime.wait(manager.ownsLocation(workspaceID, resolved, client, lifetime.signal))
        || resolved.project.id !== baseResolved.project.id || resolved.project.canonical !== baseResolved.project.canonical) {
        return reply.code(403).send({ error: "Recurrence project is not owned" })
      }
      const root = await lifetime.wait(resolveRecurrenceRoot(manager, workspaceID, directory,
        resolved.project.canonical, selectedDistro, deps.wslGit))
      if (!recurrenceInputBudget({ consigne: input.instructions, watchedConversationIDs: input.watchedConversationIDs, roots: [root] }).sufficient) {
        return reply.code(400).send({ error: "Recurrence whole source input exceeds lifecycle capacity", code: "recurrence-input-capacity" })
      }
      const checkout = root.checkout, family = root.family
      const physicalCheckout = await lifetime.wait(manager.getWorktreeIdentityForPath(workspaceID, directory))
      if (!physicalCheckout) return reply.code(403).send({ error: "Physical recurrence checkout unavailable" })
      const inventory = await lifetime.wait(client.plugin.list({ location }, options))
      if (!inventory.data.some(item => item.id === CODENOMAD_MISSIONS_RPC_ID && item.state.status === "active")) {
        return reply.code(503).send({ error: "Mission plugin unavailable" })
      }
      const catalog = await lifetime.wait(readMissionCatalog(client, directory))
      try { validateMissionProfileCatalog(input.profiles, catalog, input.taskMode) }
      catch { return reply.code(400).send({ error: "Invalid recurrence profile selection" }) }
      const watchedCurrent = async () => {
        for (const sessionID of input.watchedConversationIDs) {
          const session = await client.session.get({ sessionID }, { signal: lifetime.signal })
          check()
          if (session.id !== sessionID || session.projectID !== resolved.project.id
            || !sameLocation(session.location, location)
            || !await manager.ownsLocation(workspaceID, session.location, client, lifetime.signal)) return false
          check()
        }
        return true
      }
      if (!await lifetime.wait(watchedCurrent())) return reply.code(403).send({ error: "Watched conversation is not owned by this root" })
      // These labels describe frozen selections/host, not a grant or provisioned
      // authority. Provider credentials and profile YAML never enter the RPC.
      const config: RecurrenceConfig = {
        consigne: input.instructions, clock: input.clock, template: input.template,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        profileID: profileScope.key, executionHost,
        profiles: input.profiles, taskMode: input.taskMode,
        roots: [root],
        watchedConversationIDs: input.watchedConversationIDs, budgets: input.budgets,
        publication: { policy: "disabled", conversationIDs: [] },
      }
      if (!recurrenceConfigSchema.safeParse(config).success) return reply.code(400).send({ error: "Invalid or oversized recurrence configuration" })
      const id = recurrenceScheduleID(resolved.project.id, resolved.project.canonical, input.requestID)
      const digest = recurrenceConfigDigest(config), key = `recurrence:${resolved.project.id}:${id}`
      const holdDigest = recurrenceConfigDigest({ digest, workspaceID, directory, checkout, family })
      const readCurrent = fence.captureDisplay([physicalCheckout])
      const assertPhysicalCurrent = async () => {
        if (!readCurrent()) throw new Error("Recurrence root is being deleted")
        const [currentRoot, currentCheckout] = await Promise.all([
          resolveRecurrenceRoot(manager, workspaceID, directory, resolved.project.canonical, selectedDistro, deps.wslGit),
          manager.getWorktreeIdentityForPath(workspaceID, directory),
        ])
        if (canonicalAuthority(currentRoot) !== canonicalAuthority(root) || currentCheckout !== physicalCheckout
          || !await manager.ownsLocation(workspaceID, location, client, lifetime.signal)
          || !readCurrent()) throw new Error("Recurrence physical root changed")
        check()
      }
      await lifetime.wait(assertPhysicalCurrent())
      check()
      const rpc = client.rpc(CODENOMAD_MISSIONS_RPC)
      const previous = await lifetime.wait(rpc.recurrenceRead({ id }, options) as Promise<NativeSummary>)
      await lifetime.wait(assertPhysicalCurrent())
      if (previous.schedule) {
        if (previous.schedule.id !== id || previous.schedule.projectID !== resolved.project.id
          || previous.schedule.projectCanonical !== resolved.project.canonical || previous.schedule.digest !== digest
          || previous.schedule.state !== "paused" || previous.schedule.revision !== 0) {
          return reply.code(409).send({ error: "Recurrence request conflict" })
        }
        reconcileRecurrenceCreation(fence, key, holdDigest)
        return { schedule: previous.schedule }
      }
      admission = await admitMissionCreationLocations(manager, fence, workspaceID, connection, [location], lifetime.signal,
        { key, workspaceID, projectID: resolved.project.id, missionID: id, sessionID: id, requestDigest: holdDigest })
      await admission.assertCurrent()
      await assertPhysicalCurrent()
      await admission.assertCurrent()
      if (!await watchedCurrent()) throw new Error("Watched conversation moved before recurrence creation")
      check()
      admission.dispatched()
      // After dispatch, do not abort a native operation on HTTP disconnect.
      const created = await rpc.recurrenceCreate({ id, requestID: input.requestID, digest, config, directory,
        scope: profileScope, executionHost }, { location, ...locationRequestOptions(location) }) as NativeCreateReply
      if (created.noEffect) {
        if (created.schedule !== null || created.noEffect.code !== "capacity" || created.noEffect.id !== id
          || created.noEffect.requestID !== input.requestID || created.noEffect.digest !== digest
          || created.noEffect.projectID !== resolved.project.id
          || created.noEffect.projectCanonical !== resolved.project.canonical) throw new Error("Invalid recurrence no-effect receipt")
        admission.settled()
        return reply.code(503).send({ error: "Recurrence schedule capacity reached", code: "recurrence-capacity" })
      }
      if (created.schedule?.id !== id || created.schedule.digest !== digest || created.schedule.revision !== 0
        || created.schedule.state !== "paused" || created.schedule.projectID !== resolved.project.id
        || created.schedule.projectCanonical !== resolved.project.canonical) throw new Error("Recurrence creation acknowledgement unknown")
      admission.settled()
      return { schedule: created.schedule }
    } catch (error) {
      if (error instanceof MissionCreationHoldError) return reply.code(error.code === "creation-capacity" ? 503 : 409).send({ error: error.message })
      request.log.warn({ err: error }, "Recurrence creation unavailable or uncertain")
      return reply.code(503).send({ error: "Recurrence creation unavailable or uncertain" })
    } finally { admission?.release(); lifetime.dispose() }
  })
}
