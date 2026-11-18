import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { ForgeWorkItems } from "../../forge/work-items"

/** Editor-only discovery under the same physical-directory authority as branch choices. */
export function registerRepositorySourceRoute(app: FastifyInstance, deps: { workspaceManager: WorkspaceManager;
  worktreeDeletionFence: WorktreeDeletionFence; forge: Pick<ForgeWorkItems, "openRepository"> }) {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/repository-source", async (request, reply) => {
    const parsed = z.object({ directory: z.string().min(1).max(4096) }).strict().safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid repository directory" })
    const { directory } = parsed.data, id = request.params.id, workspace = deps.workspaceManager.get(id)
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
    const owned = await deps.workspaceManager.getServiceDirectoryForPath(id, directory)
    const host = owned && await deps.workspaceManager.getHostPathForServicePath(id, owned)
    const identity = host && await deps.workspaceManager.getWorktreeIdentityForPath(id, host)
    if (!host || !identity) return reply.code(403).send({ error: "Foreign repository directory" })
    const release = deps.worktreeDeletionFence.enter([identity])
    if (!release) return reply.code(409).send({ error: "Worktree deletion pending" })
    const controller = new AbortController(), closed = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.on("close", closed)
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
      const connection = await deps.forge.openRepository(host, true, signal)
      signal.throwIfAborted()
      if (deps.workspaceManager.get(id) !== workspace || await deps.workspaceManager.getServiceDirectoryForPath(id, directory) !== owned
        || await deps.workspaceManager.getWorktreeIdentityForPath(id, host) !== identity) return reply.code(409).send({ error: "Repository directory changed" })
      return connection.status === "ok" ? { status: "ok", repository: { provider: connection.repository.provider,
        host: connection.repository.host, repository: connection.repository.path } } : connection
    } catch { return reply.code(503).send({ error: "Repository discovery unavailable" }) }
    finally { reply.raw.off("close", closed); release() }
  })
}
