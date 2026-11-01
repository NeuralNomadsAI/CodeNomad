import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import type { OpenCodeClient } from "@opencode/client"
import type { MissionActivityProjection, MissionList, MissionListResponse, MissionListUnavailableResponse, MissionMap, MissionPanelMap,
  MissionRead, MissionReadResponse, MissionSnapshot, MissionUnavailableReason } from "../../missions/model"
import { compactMissionMap, compactMissionReads, missionTaskPage, missionTaskRequestSchema } from "../../missions/mission-compact-map"
import { MISSION_TASK_PAGE, type MissionTaskPageResponse, type MissionTaskPageResult } from "../../missions/mission-panel-map"
import { projectMissionActivity, type MissionActivityInput } from "../../missions/activity"
import { MISSION_LIST_MAX_INCLUDE } from "../../missions/mission-summary"
import { missionContentRequestSchema, type MissionContentResponse, type MissionContentResult } from "../../missions/mission-content"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import type { WorkspaceManager } from "../../workspaces/manager"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { readMissionMutationError } from "../../missions/rpc-errors"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"
import { prepareMissionCreation, MissionCreationPreparationError } from "./mission-creation-pipeline"
import { requestAdmission } from "../request-admission"
import { MissionCreationHoldError } from "./mission-creation-holds"
import { registerMissionRecurrenceSnapshot } from "./mission-recurrence-snapshot"
import { registerMissionRecurrenceCreate } from "./mission-recurrence-create"
import type { SettingsService } from "../../settings/service"
import { registerMissionRecurrenceCurrent } from "./mission-recurrence-current"
import { registerMissionPlaybookRoutes } from "./mission-playbooks"
import { MissionMapMutationError, prepareMissionMapMutation } from "./mission-map-mutation"
import type { AuthManager } from "../../auth/manager"
import type { RemoteControlManager } from "../../remote-control/manager"
import { MISSION_PANEL_PAGE_BYTES, MISSION_PANEL_REQUEST_BYTES, isMissionPanelPageResult, missionPanelBytes,
  missionPanelPageRequestSchema } from "../../missions/mission-panel-page"

interface MissionRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceClient" | "ownsLocation"
    | "getSharedServiceConnection" | "getServiceDirectoryForPath" | "getWorktreeIdentityForPath"
    | "getHostPathForServicePath" | "getServiceWslDistro">
  worktreeDeletionFence?: WorktreeDeletionFence
  settings?: Pick<SettingsService, "getProfileScope"> & Partial<Pick<SettingsService, "configYamlPathForAuthority">>
  auth?: Pick<AuthManager, "isAuthEnabled" | "getSessionFromRequest">
  bridgeToken?: string
  remoteDevices?: Pick<RemoteControlManager, "isDeviceAuthorized">
  /** Whether this backend publishes the local bridge Missions dispatch through,
   * and therefore provisions the plugin. Omitted means it does. */
  missionsHost?: () => boolean
}

const MissionParamsSchema = z.object({ id: z.string().trim().min(1).max(200) })
const MissionReadParamsSchema = z.object({ id: z.string().trim().min(1).max(200), missionID: z.string().trim().min(1).max(100) })
// `include`: comma-separated mission IDs; `summaries`: the summariesVersion the caller holds.
const ListQuerySchema = z.object({
  include: z.string().max(MISSION_LIST_MAX_INCLUDE * 101).transform(value => [...new Set(value.split(",").filter(Boolean))])
    .pipe(z.array(z.string().min(1).max(100)).max(MISSION_LIST_MAX_INCLUDE)).optional(),
  summaries: z.string().min(1).max(64).optional(),
})
// A content request's selector, digest and offset (`missionContentRequestSchema` checks the rest).
const IntegerQuery = z.string().regex(/^\d{1,15}$/).transform(Number)
const ContentQuerySchema = z.object({
  kind: z.string().max(16), field: z.string().max(64), taskKey: z.string().max(64).optional(), reportId: z.string().max(240).optional(),
  change: IntegerQuery.optional(), digest: z.string().max(43).optional(), offset: IntegerQuery,
}).strict()
// A task request's window, attention window or names, comma-separated (`missionTaskRequestSchema` checks the rest).
const NameList = z.string().max(MISSION_TASK_PAGE * 241).transform(value => value.split(",").filter(Boolean))
const TaskQuerySchema = z.object({
  order: z.string().max(64).optional(), offset: IntegerQuery.optional(), attention: IntegerQuery.optional(),
  keys: NameList.optional(), ids: NameList.optional(), reports: NameList.optional(),
}).strict().transform(({ reports, ...value }) => ({ ...value, ...(reports ? { reportIds: reports } : {}) }))
const RequestID = z.string().trim().min(1).max(128)
const UpdateSchema = z.object({
  objective: z.string().trim().min(1).max(20_000), notes: z.string().max(20_000).optional(),
  expectedRevision: z.number().int().positive(), requestId: RequestID,
}).strict()
const DeleteSchema = z.object({ expectedRevision: z.number().int().positive(), requestId: RequestID, deleteManagedSessions: z.boolean().optional() }).strict()

export function registerMissionRoutes(app: FastifyInstance, deps: MissionRouteDeps): void {
  registerMissionRecurrenceSnapshot(app, deps)
  registerMissionRecurrenceCreate(app, deps)
  registerMissionRecurrenceCurrent(app, deps)
  registerMissionPlaybookRoutes(app)
  // Opt-in bounded transport. A plugin without it stays unavailable: never fall back to
  // a project snapshot or legacy list that would transfer every open mission's map.
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/missions/panel-page", { bodyLimit: MISSION_PANEL_REQUEST_BYTES }, async (request, reply) => {
    const input = missionPanelPageRequestSchema.safeParse(request.body)
    if (!input.success) return reply.code(400).send({ available: false, reason: "invalid-request" })
    return readMissionPlugin(request, reply, deps, async ({ rpc, call, projectID, foreign }) => {
      const result: unknown = await rpc.panelPage(input.data, call)
      if (!isMissionPanelPageResult(result) || missionPanelBytes(result) > MISSION_PANEL_PAGE_BYTES) return foreign()
      const missionID = input.data.source === "tasks" ? input.data.task.missionID : input.data.source === "mission" ? input.data.missionID : undefined
      const field = input.data.source === "mission" ? input.data.field : undefined
      if (result.available && (result.projectID !== projectID || result.source !== input.data.source
        || result.missionID !== missionID || result.field !== field)) return foreign()
      return result
    })
  })
  // Open and included missions as compact maps plus one summary row per mission,
  // with activity for those maps only. Maps are compacted here too: a reload can
  // briefly pair this backend with a plugin that lists full maps. A plugin without
  // `list` is unavailable: its only other read, the snapshot, carries every full map.
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>("/api/workspaces/:id/missions", async (request, reply) => {
    const query = ListQuerySchema.safeParse(request.query ?? {})
    if (!query.success) return reply.code(400).send({ error: "Invalid mission list request" })
    const input = { ...(query.data.include ? { include: query.data.include } : {}),
      ...(query.data.summaries ? { summariesVersion: query.data.summaries } : {}) }
    return readMissionPlugin(request, reply, deps, async ({ rpc, call, projectID, foreign, observe }): Promise<MissionListResponse> => {
      // The registered RPC validates this JSON-Schema output against the plugin's own schema.
      const listed = compactMissionReads(await rpc.list(input, call) as MissionList)
      if (listed.projectID !== projectID) return foreign()
      return { available: true, ...listed, activity: await observe(listed) }
    })
  })

  // One mission's range, its map compact, for display reconciliation (lost
  // acknowledgements, cleanup retries). Hints-based project flags: never admission
  // authority. A plugin without `mission` answers from its snapshot, one map compacted.
  app.get<{ Params: { id: string; missionID: string } }>("/api/workspaces/:id/missions/:missionID", async (request, reply) => {
    const params = MissionReadParamsSchema.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: "Invalid mission read request" })
    return readMissionPlugin(request, reply, deps, async ({ rpc, call, projectID, foreign }): Promise<MissionReadResponse> => {
      let read: MissionRead<MissionMap | MissionPanelMap>
      try { read = await rpc.mission({ missionID: params.data.missionID }, call) as MissionRead }
      catch (error) {
        if (!isMissingMethod(error)) throw error
        read = missionReadFromSnapshot(await rpc.snapshot({}, call) as MissionSnapshot, params.data.missionID)
      }
      if (read.projectID !== projectID) return foreign()
      return { available: true, ...read, ...(read.mission ? { mission: compactMissionMap(read.mission) } : {}) }
    })
  })

  // One mission body for display, in digest-pinned slices of one range read
  // (`MissionControl.content`); never authority. A plugin without `content` is unavailable.
  app.get<{ Params: { id: string; missionID: string }; Querystring: Record<string, unknown> }>("/api/workspaces/:id/missions/:missionID/content", async (request, reply) => {
    const params = MissionReadParamsSchema.safeParse(request.params)
    const query = ContentQuerySchema.safeParse(request.query ?? {})
    const input = params.success && query.success ? missionContentRequestSchema.safeParse({ missionID: params.data.missionID, ...query.data }) : undefined
    if (!input?.success) return reply.code(400).send({ error: "Invalid mission content request" })
    return readMissionPlugin(request, reply, deps, async ({ rpc, call, projectID, foreign }): Promise<MissionContentResponse> => {
      const result = await rpc.content(input.data, call) as MissionContentResult
      if (result.projectID !== projectID || result.missionID !== input.data.missionID) return foreign()
      return { available: true, ...result }
    })
  })

  // More of one map's tasks for display, a page at a time (`MissionControl.tasks`); never
  // authority. A plugin without `tasks` answers from its single-mission read, paged here.
  app.get<{ Params: { id: string; missionID: string }; Querystring: Record<string, unknown> }>("/api/workspaces/:id/missions/:missionID/tasks", async (request, reply) => {
    const params = MissionReadParamsSchema.safeParse(request.params)
    const query = TaskQuerySchema.safeParse(request.query ?? {})
    const input = params.success && query.success ? missionTaskRequestSchema.safeParse({ missionID: params.data.missionID, ...query.data }) : undefined
    if (!input?.success) return reply.code(400).send({ error: "Invalid mission task request" })
    return readMissionPlugin(request, reply, deps, async ({ rpc, call, projectID, foreign }): Promise<MissionTaskPageResponse> => {
      let result: MissionTaskPageResult
      try { result = await rpc.tasks(input.data, call) as MissionTaskPageResult }
      catch (error) {
        if (!isMissingMethod(error)) throw error
        const read = await rpc.mission({ missionID: input.data.missionID }, call) as MissionRead
        if (read.projectID !== projectID) return foreign()
        const base = { version: read.version, projectID: read.projectID, missionID: input.data.missionID }
        if (!read.mission) result = { ...base, refused: "mission-not-found" }
        else {
          const page = missionTaskPage(read.mission, input.data)
          result = input.data.order !== undefined && input.data.order !== page.taskPage.order
            ? { ...base, revision: read.mission.revision, refused: "order-changed" } : { ...base, revision: read.mission.revision, ...page }
        }
      }
      if (result.projectID !== projectID || result.missionID !== input.data.missionID) return foreign()
      return { available: true, ...result }
    })
  })

  // The same answer from the authoritative full snapshot at the owned Location,
  // for an application-authored native prompt's admission (the coordinator message):
  // project damage the index has not seen yet still refuses it.
  app.get<{ Params: { id: string; missionID: string } }>("/api/workspaces/:id/missions/:missionID/admission", async (request, reply) => {
    const params = MissionReadParamsSchema.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: "Invalid mission read request" })
    return readMissionPlugin(request, reply, deps, async ({ rpc, call, projectID, foreign }): Promise<MissionReadResponse<MissionMap>> => {
      const read = missionReadFromSnapshot(await rpc.snapshot({}, call) as MissionSnapshot, params.data.missionID)
      if (read.projectID !== projectID) return foreign()
      return { available: true, ...read }
    })
  })

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/missions", async (request, reply) => {
    const lifetime = requestAdmission(request, reply)
    let creation: Awaited<ReturnType<typeof prepareMissionCreation>> | undefined
    try {
      lifetime.signal.throwIfAborted()
      creation = await prepareMissionCreation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence,
        workspaceID: request.params.id, request: request.body, signal: lifetime.signal, wait: lifetime.wait })
      return await creation.execute()
    } catch (error) {
      // Hold codes keep their own meaning: a creation-uncertain retry may follow
      // an earlier dispatched attempt with the same request identity.
      if (error instanceof MissionCreationHoldError) {
        return reply.code(error.code === "creation-capacity" ? 503 : 409).send({ error: error.message, code: error.code })
      }
      const deleting = error instanceof Error && "code" in error && error.code === "worktree-deleting"
      // Only failures before the native create was attempted prove no effect and
      // carry a no-effect code; later failures stay codeless and uncertain.
      if (!creation?.dispatched) {
        if (error instanceof MissionCreationPreparationError) {
          return reply.code(error.status).send({ error: error.message, ...(error.message.startsWith("compare-models-") ? { code: error.message }
            : error.status === 503 ? { code: "creation-unavailable" } : {}) })
        }
        if (deleting) return reply.code(409).send({ error: "Worktree deletion is in progress", code: "creation-worktree-deleting" })
        return reply.code(503).send({ error: "Mission creation unavailable", code: "creation-unavailable" })
      }
      if (deleting) return reply.code(409).send({ error: "Worktree deletion is in progress" })
      return mutationError(reply, error)
    } finally { lifetime.dispose() }
  })

  app.patch<{ Params: { id: string; missionID: string } }>("/api/workspaces/:id/missions/:missionID", async (request, reply) => {
    const parsed = UpdateSchema.safeParse(request.body)
    const params = z.object({ id: z.string().trim().min(1).max(200), missionID: z.string().trim().min(1).max(100) }).safeParse(request.params)
    if (!parsed.success || !params.success) return reply.code(400).send({ error: "Invalid mission update request" })
    return mutate(request, reply, deps, params.data.id, async (rpc, options) => {
      const result = await rpc.update({
        missionID: params.data.missionID, requestID: parsed.data.requestId, objective: parsed.data.objective,
        ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }), expectedRevision: parsed.data.expectedRevision,
      }, options) as { mission: MissionMap }
      return { mission: result.mission }
    })
  })

  app.post<{ Params: { id: string; missionID: string } }>("/api/workspaces/:id/missions/:missionID/control", async (request, reply) => {
    const parsed = z.object({ action: z.enum(["start", "pause", "stop"]), expectedRevision: z.number().int().positive(), requestId: RequestID,
      graceful: z.literal(true).optional() }).strict().refine(value => !value.graceful || value.action === "pause").safeParse(request.body)
    const params = z.object({ id: z.string().trim().min(1).max(200), missionID: z.string().trim().min(1).max(100) }).safeParse(request.params)
    if (!parsed.success || !params.success) return reply.code(400).send({ error: "Invalid mission control request" })
    return mutate(request, reply, deps, params.data.id, async (rpc, options) => await rpc.lifecycle({
      missionID: params.data.missionID, requestID: parsed.data.requestId, action: parsed.data.action, expectedRevision: parsed.data.expectedRevision,
      ...(parsed.data.graceful ? { graceful: true } : {}),
    }, options) as { mission: MissionMap })
  })

  app.delete<{ Params: { id: string; missionID: string } }>("/api/workspaces/:id/missions/:missionID", async (request, reply) => {
    const parsed = DeleteSchema.safeParse(request.body)
    const params = z.object({ id: z.string().trim().min(1).max(200), missionID: z.string().trim().min(1).max(100) }).safeParse(request.params)
    if (!parsed.success || !params.success) return reply.code(400).send({ error: "Invalid mission deletion request" })
    return mutate(request, reply, deps, params.data.id, async (rpc, options) => await rpc.delete({
      missionID: params.data.missionID, requestID: parsed.data.requestId, expectedRevision: parsed.data.expectedRevision,
      ...(parsed.data.deleteManagedSessions === undefined ? {} : { deleteManagedSessions: parsed.data.deleteManagedSessions }),
    }, options) as { deleted: true })
  })

  app.post<{ Params: { id: string; missionID: string } }>("/api/workspaces/:id/missions/:missionID/recover", async (request, reply) => {
    const parsed = z.object({ expectedRevision: z.number().int().positive(), target: z.enum(["coordinator", "report"]), taskKey: z.string().min(1).max(100).optional() }).strict().safeParse(request.body)
    const params = z.object({ id: z.string().trim().min(1).max(200), missionID: z.string().trim().min(1).max(100) }).safeParse(request.params)
    if (!parsed.success || !params.success) return reply.code(400).send({ error: "Invalid mission recovery request" })
    return mutate(request, reply, deps, params.data.id, async (rpc, options) =>
      await rpc.recover({ missionID: params.data.missionID, ...parsed.data }, options))
  })
}

const missionRpc = (client: OpenCodeClient) => client.rpc(CODENOMAD_MISSIONS_RPC)

interface MissionPluginRead {
  rpc: ReturnType<typeof missionRpc>
  call: { location: { directory: string }; headers?: Record<string, string> }
  projectID: string
  /** A response naming another project: logged, answered 502 plugin-unavailable. */
  foreign(): MissionListUnavailableResponse
  /** Display activity of these maps' actors, fenced by this read's view and connection. */
  observe(read: MissionActivityInput): Promise<MissionActivityProjection>
}

/** The read routes' shared path to the owned Location's active plugin. */
async function readMissionPlugin<T>(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, deps: MissionRouteDeps,
  read: (plugin: MissionPluginRead) => Promise<T>): Promise<T | MissionListUnavailableResponse> {
  const lifetime = requestAdmission(request, reply)
  const parsed = MissionParamsSchema.safeParse(request.params)
  if (!parsed.success || !deps.workspaceManager.get(parsed.data.id)) {
    lifetime.dispose()
    reply.code(404)
    return unavailable("workspace-unavailable")
  }
  const workspaceID = parsed.data.id
  const ownedLocation = deps.workspaceManager.getServiceLocation(workspaceID)
  if (!ownedLocation) { lifetime.dispose(); return unavailable("workspace-unavailable") }
  // Without its bridge this backend never provisions the plugin: reconnecting or
  // reloading OpenCode cannot help, so say so before reading the inventory.
  if (deps.missionsHost && !deps.missionsHost()) { lifetime.dispose(); return unavailable("host-unavailable") }
  const workspace = deps.workspaceManager.get(workspaceID)
  const displayCapture = captureDisplayIdentities(deps.worktreeDeletionFence, deps.workspaceManager, workspaceID, [ownedLocation.directory])
  const location = { directory: ownedLocation.directory }
  const options = locationRequestOptions(ownedLocation)

  try {
    const connection = await lifetime.wait(deps.workspaceManager.getSharedServiceConnection(workspaceID))
    if (!connection) return unavailable("workspace-unavailable")
    connection.assertCurrent()
    const client = connection.client
    const resolved = await client.location.get({ location }, options)
    const inventory = await client.plugin.list({ location }, options)
    const plugin = inventory.data.find((entry) => entry.id === CODENOMAD_MISSIONS_RPC_ID)
    // Local V2 plugins currently advertise `server` but do not set `features.rpc`
    // after registration. The reviewed typed call is the RPC capability check.
    if (plugin?.state.status === "failed") return unavailable("plugin-failed")
    if (!plugin || plugin.state.status !== "active") return unavailable("plugin-unavailable")
    return await read({
      rpc: missionRpc(client), call: { location, ...options }, projectID: resolved.project.id,
      foreign: () => {
        request.log.error({ workspaceId: workspaceID }, "Mission RPC returned a foreign project snapshot")
        reply.code(502)
        return unavailable("plugin-unavailable")
      },
      observe: async snapshot => {
        const displayCurrent = await lifetime.wait(displayCapture)
        const deletionCurrent = await lifetime.wait(captureDisplayIdentities(deps.worktreeDeletionFence, deps.workspaceManager, workspaceID, [
          ownedLocation.directory, ...snapshot.missions.flatMap(mission => mission.actors.map(actor => actor.location.directory)),
        ]))
        return projectMissionActivity({
          client, snapshot, workspaceID,
          ownsLocation: deps.workspaceManager.ownsLocation.bind(deps.workspaceManager),
          isCurrent: () => {
            if (!displayCurrent?.() || !deletionCurrent?.() || lifetime.signal.aborted
              || deps.workspaceManager.get(workspaceID) !== workspace
              || !sameLocation(deps.workspaceManager.getServiceLocation(workspaceID) ?? { directory: "" }, ownedLocation)) return false
            try { connection.assertCurrent(); return true } catch { return false }
          },
        })
      },
    })
  } catch (error) {
    request.log.warn({ err: error, workspaceId: workspaceID }, "Mission plugin snapshot is unavailable")
    return unavailable(isRpcFailure(error) ? "plugin-unavailable" : "workspace-unavailable")
  } finally { lifetime.dispose() }
}

async function mutate(request: FastifyRequest, reply: FastifyReply, deps: MissionRouteDeps, workspaceID: string,
  call: Parameters<Awaited<ReturnType<typeof prepareMissionMapMutation>>["run"]>[0]) {
  const lifetime = requestAdmission(request, reply)
  try {
    const prepared = await prepareMissionMapMutation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence,
      workspaceID, signal: lifetime.signal, wait: lifetime.wait })
    return await prepared.run(call)
  } catch (error) {
    if (error instanceof MissionMapMutationError) return reply.code(error.status).send({ error: error.message })
    return mutationError(reply, error)
  } finally { lifetime.dispose() }
}

function mutationError(reply: import("fastify").FastifyReply, error: unknown) {
  const rejection = readMissionMutationError(error)
  if (rejection) return reply.code(rejection.status).send({ error: rejection.message, code: rejection.code })
  reply.code(503).send({ error: "Mission plugin unavailable" })
}

function unavailable(reason: MissionUnavailableReason): MissionListUnavailableResponse {
  return { available: false, reason, missions: [] }
}

/** One mission's read projected from a full snapshot: its map (stamped with the
 * project flags), its cleanups and the project flags. */
function missionReadFromSnapshot(snapshot: MissionSnapshot, missionID: string): MissionRead<MissionMap> {
  const mission = snapshot.missions.find(value => value.id === missionID)
  return { version: snapshot.version, projectID: snapshot.projectID, generatedAt: snapshot.generatedAt, ...(mission ? { mission } : {}),
    cleanups: (snapshot.cleanups ?? []).filter(cleanup => cleanup.missionID === missionID),
    ...(snapshot.cleanupUnavailable ? { cleanupUnavailable: true } : {}), ...(snapshot.controlUnavailable ? { controlUnavailable: true } : {}),
    ...(snapshot.notificationUnavailable ? { notificationUnavailable: true } : {}) }
}

/** An older plugin build, during a reload, registered no such method. */
function isMissingMethod(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { type?: unknown }).type === "rpc.method_not_found")
}

function isRpcFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const type = "type" in error ? (error as { type?: unknown }).type : undefined
  return typeof type === "string" && type.startsWith("rpc.")
}
