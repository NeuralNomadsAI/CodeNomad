import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { MissionCreationReceipt } from "../../missions/creation-receipt"
import { readMissionMutationError } from "../../missions/rpc-errors"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { requestAdmission } from "../request-admission"
import { MissionCreationHoldError } from "./mission-creation-holds"
import { prepareMissionCreation, MissionCreationPreparationError } from "./mission-creation-pipeline"
import type { MissionRouteDeps } from "./missions"

interface CreationResult {
  digest: string
  pending: boolean
  receipt: { requestId: string; state: "unknown" | "rejected" | "created" }
  preparation?: Awaited<ReturnType<typeof prepareMissionCreation>>
  reading?: Promise<MissionCreationReceipt>
}

/** Bounded original HTTP outcomes; unknown entries stay reserved until proof arrives. */
export function registerMissionCreation(app: FastifyInstance, deps: MissionRouteDeps) {
  const results = new Map<string, CreationResult>()
  const key = (workspace: string, requestId: string) => JSON.stringify([workspace, requestId])
  const params = z.object({ id: z.string().min(1).max(200), requestId: z.string().min(1).max(128) })
  app.get<{ Params: { id: string; requestId: string } }>("/api/workspaces/:id/missions/creation/:requestId", async (request, reply) => {
    const parsed = params.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid creation receipt request" })
    const { id, requestId } = parsed.data
    if (!deps.workspaceManager.get(id)) return reply.code(404).send({ error: "Workspace unavailable" })
    const record = results.get(key(id, requestId))
    if (!record) return { requestId, state: "unknown" }
    if (record.pending) return { requestId, state: "unknown" }
    if (record.receipt.state === "rejected") return record.receipt
    if (!record.preparation) return { requestId, state: "unknown" }
    return record.reading ??= (async () => {
      try {
        const mission = await record.preparation!.readReceipt()
        if (mission) {
          record.receipt = { requestId, state: "created" }
          return { requestId, state: "created" as const, mission }
        }
      } catch { /* Unreadable evidence preserves the original request and physical hold. */ }
      return { requestId, state: "unknown" as const }
    })().finally(() => { record.reading = undefined })
  })
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/missions", async (request, reply) => {
    const lifetime = requestAdmission(request, reply)
    let creation: Awaited<ReturnType<typeof prepareMissionCreation>> | undefined, record: CreationResult | undefined
    try {
      const requestId = z.object({ requestId: z.string().trim().min(1).max(128) }).safeParse(request.body)
      if (!requestId.success) return reply.code(400).send({ error: "Invalid mission creation request" })
      const id = requestId.data.requestId, entryKey = key(request.params.id, id), digest = canonicalAuthority(request.body)
      const previous = results.get(entryKey)
      if (previous && previous.digest !== digest) throw new MissionCreationHoldError("creation-conflict")
      if (previous && (previous.pending || previous.receipt.state !== "rejected")) {
        throw new MissionCreationHoldError("creation-uncertain")
      }
      // Terminal entries are disposable readback evidence; unknown entries have no expiry.
      if (!previous && results.size >= 128) {
        const terminal = [...results].find(([, value]) => !value.pending && value.receipt.state !== "unknown")
        if (terminal) results.delete(terminal[0])
        else throw new MissionCreationHoldError("creation-capacity")
      }
      record = { digest, pending: true, receipt: { requestId: id, state: "unknown" } }
      results.set(entryKey, record)
      lifetime.signal.throwIfAborted()
      creation = await prepareMissionCreation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence,
        workspaceID: request.params.id, request: request.body, signal: lifetime.signal, wait: lifetime.wait,
        permissionModes: deps.permissionModes })
      record.preparation = creation
      const result = await creation.execute()
      record.receipt = { requestId: id, state: "created" }
      return result
    } catch (error) {
      if (record && (creation?.rejected || !creation?.dispatched
        && (!(error instanceof MissionCreationHoldError) || error.code === "creation-capacity"))) {
        // A failed native transport never certifies rejection. The pipeline only
        // propagates dispatched failures after a validated no-effect receipt.
        record.receipt = { requestId: record.receipt.requestId, state: "rejected" }
      }
      if (error instanceof MissionCreationHoldError)
        return reply.code(error.code === "creation-capacity" ? 503 : 409).send({ error: error.message, code: error.code })
      const deleting = error instanceof Error && "code" in error && error.code === "worktree-deleting"
      if (!creation?.dispatched) {
        if (error instanceof MissionCreationPreparationError)
          return reply.code(error.status).send({ error: error.message, ...(error.message.startsWith("compare-models-") ? { code: error.message }
            : error.status === 503 ? { code: "creation-unavailable" } : {}) })
        if (deleting) return reply.code(409).send({ error: "Worktree deletion is in progress", code: "creation-worktree-deleting" })
        return reply.code(503).send({ error: "Mission creation unavailable", code: "creation-unavailable" })
      }
      if (deleting) return reply.code(409).send({ error: "Worktree deletion is in progress" })
      const rejection = readMissionMutationError(error)
      return rejection ? reply.code(rejection.status).send({ error: rejection.message, code: rejection.code })
        : reply.code(503).send({ error: "Mission plugin unavailable" })
    } finally { if (record) record.pending = false; lifetime.dispose() }
  })
}
