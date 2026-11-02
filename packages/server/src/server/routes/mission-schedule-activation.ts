import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { requiresMissionCalendar } from "../../missions/launch-policy"
import type { NativeScheduleSettingsActivation } from "../../opencode/native-schedule-settings-activation"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { requestAdmission } from "../request-admission"
import { MissionMapMutationError, prepareMissionMapMutation, type MissionMapMutationManager } from "./mission-map-mutation"
import { missionScheduleActivationJournal } from "./mission-schedule-activation-journal"

const params = z.object({ id: z.string().min(1).max(200), missionID: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/) }).strict()
const identity = z.object({ requestID: z.string().min(1).max(128), expectedDocumentRevision: z.number().int().nonnegative().safe() }).strict()
type Deps = { workspaceManager: MissionMapMutationManager; worktreeDeletionFence?: WorktreeDeletionFence;
  scheduleSettingsActivation?: Pick<NativeScheduleSettingsActivation, "prepare" | "apply"> }

/** Authenticated preparation only. The calendar owner performs Play/arming after
 * its own complete capability, admission and fresh effective-setting checks. */
export function registerMissionScheduleActivation(app: FastifyInstance, deps: Deps) {
  for (const method of ["GET", "POST"] as const) app.route({ method,
    url: "/api/workspaces/:id/missions/:missionID/schedule-settings",
    handler: async (request, reply) => {
      const selected = params.safeParse(request.params)
      const raw = method === "POST" ? request.body : request.query
      const input = identity.safeParse(method === "GET" && raw && typeof raw === "object"
        ? { ...raw, expectedDocumentRevision: Number((raw as Record<string, unknown>).expectedDocumentRevision) } : raw)
      if (!selected.success || !input.success) return reply.code(400).send({ error: "Invalid Mission activation request" })
      const lifetime = requestAdmission(request, reply)
      try {
        const owned = await prepareMissionMapMutation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence,
          workspaceID: selected.data.id, signal: lifetime.signal, wait: lifetime.wait })
        return await owned.run(async (rpc, options) => {
          const guarded = { documentActivation: async (...args: Parameters<typeof rpc.documentActivation>) => {
            await owned.refresh()
            return rpc.documentActivation(...args)
          } }
          const adapter = missionScheduleActivationJournal(guarded, options, { missionID: selected.data.missionID,
            requestID: input.data.requestID, expectedRevision: input.data.expectedDocumentRevision }, owned.current)
          const before = await adapter.read()
          if (method === "GET") return { document: before }
          if (!deps.scheduleSettingsActivation || before.state !== "paused" || !requiresMissionCalendar(before.launch))
            return reply.code(409).send({ error: "Mission schedule preparation unavailable", code: "schedule-activation-unavailable" })
          const previous = before.scheduleActivation
          const same = previous?.requestID === input.data.requestID && previous.expectedRevision === input.data.expectedDocumentRevision
          if (!same && (before.revision !== input.data.expectedDocumentRevision
            || previous && (previous.state !== "failed" || previous.targets.some(target => target.attempted))))
            return reply.code(409).send({ error: "Original Mission activation remains unresolved", code: "schedule-activation-conflict" })
          try {
            const plan = same ? { authority: previous!.authority, targets: previous!.targets }
              : await deps.scheduleSettingsActivation.prepare(selected.data.id, options.location)
            owned.current()
            const intent = { authority: plan.authority, targets: plan.targets.map(target => ({ ...target,
              attempted: "attempted" in target ? Boolean(target.attempted) : false,
              acknowledged: "acknowledged" in target ? Boolean(target.acknowledged) : false })) }
            await deps.scheduleSettingsActivation.apply(selected.data.id, options.location, intent, adapter.journal)
            return { document: await adapter.read() }
          } catch (error) {
            const code = error instanceof PluginControlsError ? `configuration-${error.kind}` : "configuration-unconfirmed"
            // This records metadata only. Attempt markers and successful writes
            // survive failure; an uncertain target is never rolled back/replayed.
            await adapter.failed(code).catch(() => undefined)
            throw error
          }
        })
      } catch (error) {
        const status = error instanceof MissionMapMutationError ? error.status : error instanceof PluginControlsError
          ? error.kind === "forbidden" ? 403 : error.kind === "invalid" ? 400 : error.kind === "conflict" ? 409 : 503 : 503
        return reply.code(status).send({ error: "Mission schedule configuration remains unconfirmed", code: "schedule-activation-pending" })
      } finally { lifetime.dispose() }
    },
  })
}
