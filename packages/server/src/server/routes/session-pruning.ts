import type { FastifyInstance } from "fastify"
import { messageTargetSchema, PRUNING_RPC_ID, prunePreviewSchema, pruneRequestSchema, pruneResultSchema } from "../../opencode/session-pruning/contract"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

interface RouteDeps {
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceClient" | "ownsLocation" | "getWorktreeIdentityForPath">
  worktreeDeletionFence: WorktreeDeletionFence
}

export function registerSessionPruningRoutes(app: FastifyInstance, deps: RouteDeps): void {
  for (const method of ["preview", "prune"] as const) {
    app.post<{ Params: { id: string } }>(`/api/workspaces/:id/session-pruning/${method}`, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const input = (method === "prune" ? pruneRequestSchema : messageTargetSchema).safeParse(request.body)
      if (!input.success) return reply.code(400).send({ error: "Invalid pruning request" })
      const client = await deps.workspaceManager.getSharedServiceClient()
      const session = await client.session.get({ sessionID: input.data.sessionID })
      if (!await deps.workspaceManager.ownsLocation(request.params.id, session.location)) {
        return reply.code(403).send({ error: "Session does not belong to workspace" })
      }
      const identity = await deps.workspaceManager.getWorktreeIdentityForPath(request.params.id, session.location.directory)
      if (!identity) return reply.code(403).send({ error: "Session does not belong to workspace" })
      const release = deps.worktreeDeletionFence.enter([identity])
      if (!release) return reply.code(409).send({ error: "Worktree deletion is in progress" })
      try {
        // Narrow broker only: callers cannot choose RPC ID, method, location,
        // database filename, SQL, or replacement content. Generic RPC stays blocked.
        const result = await client.rpc.call({
          rpcID: PRUNING_RPC_ID, method, input: input.data, location: { directory: session.location.directory },
        }, { signal: AbortSignal.timeout(15_000) })
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
      } finally { release() }
    })
  }
}
