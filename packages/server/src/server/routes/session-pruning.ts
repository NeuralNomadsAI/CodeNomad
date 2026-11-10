import type { FastifyInstance } from "fastify"
import { messageTargetSchema, PRUNING_RPC_ID, prunePreviewSchema, pruneRequestSchema, pruneResultSchema } from "../../opencode/session-pruning/contract"
import { locationRequestOptions, readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import { registerSessionHistoryRoutes, type HistoryRouteDeps } from "./session-history"
import { registerSessionNavigationRoutes } from "./session-navigation"
import { assertOrdinaryMissionScheduleSession } from "../mission-schedule-input-guard"

export function registerSessionPruningRoutes(app: FastifyInstance, deps: HistoryRouteDeps): void {
  registerSessionHistoryRoutes(app, deps)
  registerSessionNavigationRoutes(app, deps)
  for (const method of ["preview", "prune"] as const) {
    app.post<{ Params: { id: string } }>(`/api/workspaces/:id/session-pruning/${method}`, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const input = (method === "prune" ? pruneRequestSchema : messageTargetSchema).safeParse(request.body)
      if (!input.success) return reply.code(400).send({ error: "Invalid pruning request" })
      const manager = deps.workspaceManager, id = request.params.id
      const workspace = manager.get(id), base = manager.getServiceLocation(id)
      if (base && deps.worktreeDeletionFence.isBlocked(base.directory)) return reply.code(409).send({ error: "Worktree deletion is in progress" })
      const fences = [deps.worktreeDeletionFence.captureDisplay(base ? [base.directory] : [])]
      const deadlineAt = Date.now() + 15_000
      const abandoned = new AbortController()
      const abort = () => { if (!reply.raw.writableEnded) abandoned.abort() }
      reply.raw.once("close", abort)
      const signal = AbortSignal.any([abandoned.signal, AbortSignal.timeout(15_000)])
      let release: (() => void) | undefined
      try {
        const connection = await manager.getSharedServiceConnection(id)
        if (!connection || !workspace || !base) throw new Error("Workspace unavailable")
        const client = connection.client
        const current = () => {
          signal.throwIfAborted(); connection.assertCurrent()
          if (manager.get(id) !== workspace || manager.getServiceLocation(id) !== base || fences.some(check => !check())) throw new Error("Pruning placement changed")
        }
        current()
        const session = await client.session.get({ sessionID: input.data.sessionID }, { signal })
        current()
        const location = readLocationRef(session.location)
        if (!await manager.ownsLocation(id, location, client, signal)) return reply.code(403).send({ error: "Session does not belong to workspace" })
        current()
        fences.push(deps.worktreeDeletionFence.captureDisplay([location.directory]))
        const identity = await manager.getWorktreeIdentityForPath(id, location.directory)
        current()
        if (!identity) return reply.code(403).send({ error: "Session does not belong to workspace" })
        fences.push(deps.worktreeDeletionFence.captureDisplay([identity]))
        release = deps.worktreeDeletionFence.enter([identity])
        if (!release) return reply.code(409).send({ error: "Worktree deletion is in progress" })
        await manager.desktopPluginsReady({ connection, location: { directory: location.directory }, signal, deadlineAt, assertCurrent: current })
        current()
        const revalidate = async () => {
          current()
          const latest = await client.session.get({ sessionID: input.data.sessionID }, { signal })
          current()
          if (!sameLocation(location, readLocationRef(latest.location)) || !await manager.ownsLocation(id, latest.location, client, signal)) throw new Error("Session moved")
          current()
          return latest
        }
        const latest = await revalidate()
        if (method === "prune") {
          await assertOrdinaryMissionScheduleSession(client, latest, { signal, current })
          await revalidate()
        }
        // Narrow broker only: callers cannot choose RPC ID, method, location,
        // database filename, SQL, or replacement content. Generic RPC stays blocked.
        current()
        const result = await client.rpc.call({
          rpcID: PRUNING_RPC_ID, method, input: input.data, location: { directory: location.directory },
        }, { ...locationRequestOptions(location), signal })
        await revalidate()
        current()
        const output = (method === "prune" ? pruneResultSchema : prunePreviewSchema).safeParse(result.output)
        if (!output.success) return { status: "blocked", reason: "unavailable" }
        if (output.data.status === "pruned" && (output.data.messageID !== input.data.messageID
          || !("indexes" in input.data) || !Array.isArray(input.data.indexes) || output.data.removedCount !== input.data.indexes.length)) {
          return { status: "blocked", reason: "unavailable" }
        }
        return output.data
      } catch {
        // Missing plugin, incompatible runtime, timeout: no legacy API fallback
        // and no local-only deletion presented as a successful database write.
        return { status: "blocked", reason: "unavailable" }
      } finally { release?.(); reply.raw.removeListener("close", abort) }
    })
  }
}
