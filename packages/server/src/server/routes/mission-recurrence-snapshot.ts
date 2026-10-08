import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { z } from "zod"
import type { MissionRecurrenceSnapshot } from "../../api-types"
import { sameLocation, locationRequestOptions } from "../../opencode/compatibility/location"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { requestAdmission } from "../request-admission"
import { recurrenceIDSchema, recurrenceMessageID, RECURRENCE_HISTORY_LIMIT, RECURRENCE_SCHEDULE_LIMIT } from "../../missions/recurrence-contract"
import { dailyClockSchema } from "../../missions/recurrence-clock"
import { recurrenceReadInput, recurrenceReadPage } from "../../missions/recurrence-reader-contract"
import { recurrenceControlRequestSchema, recurrenceNativeControlSchema } from "../../missions/recurrence-control-contract"

const counter = z.number().int().nonnegative().safe()
const timestamp = counter.max(Date.parse("9999-12-28T00:00:00Z"))
const id = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/)
const reference = z.object({ passageID: recurrenceIDSchema, messageID: recurrenceIDSchema, dueAt: timestamp, settledAt: timestamp,
  status: z.enum(["completed", "failed", "stopped", "rejected-before-effect"]),
  missionID: id.optional(), conversationID: id.optional(), artifactMessageIDs: z.array(id).max(8).optional(),
}).strict().refine(value => value.messageID === recurrenceMessageID(value.passageID) && value.settledAt >= value.dueAt && (value.status === "rejected-before-effect"
  ? value.missionID === undefined && value.conversationID === undefined && value.artifactMessageIDs === undefined
  : value.missionID !== undefined && value.conversationID !== undefined && value.artifactMessageIDs !== undefined))
const schedule = z.object({ id: recurrenceIDSchema, revision: counter, scheduleRevision: counter,
  state: z.enum(["running", "paused", "interrupted", "unavailable", "stopped"]), clock: dailyClockSchema,
  epoch: counter.nullable().optional(),
  controlCapability: z.object({ version: z.literal(1), actions: z.array(z.enum(["play", "pause", "stop"])).max(3)
    .refine(actions => new Set(actions).size === actions.length) }).strict().optional(),
  nativeControl: recurrenceNativeControlSchema.optional(), controlRetry: recurrenceControlRequestSchema.optional(), controlsComplete: z.boolean().optional(),
  pendingPassageID: recurrenceIDSchema.nullable(), pendingStatus: z.enum(["unknown", "admitted"]).nullable(),
  pendingAdmission: z.object({ missionID: id, conversationID: id }).strict().nullable(),
  settledCount: counter, latestResult: reference.nullable(), history: z.array(reference).max(RECURRENCE_HISTORY_LIMIT),
}).strict().refine(value => value.history.length === Math.min(value.settledCount, RECURRENCE_HISTORY_LIMIT)
  && (!value.controlCapability || value.epoch !== undefined && value.epoch !== null)
  && (!value.controlRetry || value.controlRetry.scheduleID === value.id && value.controlRetry.expectedEpoch + 1 === value.epoch
    && value.controlRetry.action !== "play" && (!value.nativeControl || value.nativeControl.requestID === value.controlRetry.requestID
      && value.nativeControl.action === value.controlRetry.action))
  && (value.controlsComplete !== true || !value.nativeControl?.pending.length)
  && value.scheduleRevision <= value.revision
  && Boolean(value.pendingPassageID) === Boolean(value.pendingStatus)
  && (value.pendingStatus === "admitted") === Boolean(value.pendingAdmission)
  && JSON.stringify(value.latestResult) === JSON.stringify(value.history.at(-1) ?? null)
  && new Set(value.history.map(item => item.passageID)).size === value.history.length
  && !value.history.some(item => item.passageID === value.pendingPassageID))
const snapshotSchema = z.object({ version: z.literal(1), projectID: id, projectCanonical: z.string().min(1).max(4096),
  location: z.object({ directory: z.string().min(1).max(4096), workspaceID: z.string().optional() }).strict(),
  schedules: z.array(schedule).max(RECURRENCE_SCHEDULE_LIMIT),
}).strict()
const pageSchema = recurrenceReadPage.extend({ projectCanonical: z.string().min(1).max(4096),
  location: z.object({ directory: z.string().min(1).max(4096), workspaceID: z.string().optional() }).strict() })
const pageQuery = z.object({ section: z.coerce.number().int().nonnegative().optional(), page: z.coerce.number().int().nonnegative().optional(),
  revision: z.coerce.number().int().positive().optional() }).strict()

export function registerMissionRecurrenceSnapshot(app: FastifyInstance, deps: {
  workspaceManager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection" | "ownsLocation">
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
    const current = deps.worktreeDeletionFence?.captureDisplay([owned.directory])
    try {
      const connection = await lifetime.wait(manager.getSharedServiceConnection(parsed.data))
      if (!connection) return reply.code(503).send({ error: "Mission service unavailable" })
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
    } catch (error) {
      request.log.warn({ err: error, workspaceId: parsed.data }, "Mission recurrence snapshot unavailable")
      return reply.code(503).send({ error: "Mission recurrence unavailable" })
    } finally { lifetime.dispose() }
  }
  app.get("/api/workspaces/:id/missions/recurrence", read)
  app.get("/api/workspaces/:id/missions/recurrence/:scheduleID/passages/:passageID", read)
}
