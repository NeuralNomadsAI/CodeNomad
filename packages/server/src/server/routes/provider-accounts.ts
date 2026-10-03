import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { ProviderAccountsService } from "../../provider-accounts/service"

type Deps = {
  workspaceManager: Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "getServiceDirectoryForPath" | "ownsLocation" | "getWorktreeIdentityForPath">
  worktreeDeletionFence: WorktreeDeletionFence
  accounts: ProviderAccountsService
}
const paramsSchema = z.object({ id: z.string().min(1).max(256), integrationID: z.string().min(1).max(256) }).strict()
const readSchema = z.object({ directory: z.string().min(1).max(4096) }).strict()
const writeSchema = readSchema.extend({ enabled: z.boolean() }).strict()

export function registerProviderAccountsRoutes(app: FastifyInstance, deps: Deps) {
  for (const method of ["GET", "PUT"] as const) app.route({
    method, url: "/api/workspaces/:id/provider-accounts/:integrationID",
    handler: async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const params = paramsSchema.safeParse(request.params)
      const input = method === "GET" ? readSchema.safeParse(request.query) : writeSchema.safeParse(request.body)
      if (!params.success || !input.success) return reply.code(400).send({ error: "Invalid provider accounts request" })
      const { id, integrationID } = params.data
      const manager = deps.workspaceManager, workspace = manager.get(id)
      if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
      const controller = new AbortController()
      const close = () => controller.abort()
      reply.raw.once("close", close)
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
      let release: (() => void) | undefined
      try {
        const connection = await manager.getSharedServiceConnection(id)
        if (!connection) return reply.code(503).send({ error: "Provider accounts unavailable" })
        const directory = await manager.getServiceDirectoryForPath(id, input.data.directory)
        if (!directory || !await manager.ownsLocation(id, { directory }, connection.client, signal)) {
          return reply.code(403).send({ error: "Location does not belong to workspace" })
        }
        if (method === "PUT") {
          const identity = await manager.getWorktreeIdentityForPath(id, input.data.directory)
          if (!identity) return reply.code(403).send({ error: "Location does not belong to workspace" })
          release = deps.worktreeDeletionFence.enter([identity])
          if (!release) return reply.code(409).send({ error: "Worktree deletion in progress" })
        }
        const snapshot = await deps.accounts.snapshot(connection, directory, integrationID, signal)
        if (manager.get(id) !== workspace || !await manager.ownsLocation(id, { directory }, connection.client, signal)) {
          return reply.code(403).send({ error: "Location does not belong to workspace" })
        }
        signal.throwIfAborted(); connection.assertCurrent()
        if (method === "PUT") {
          if (integrationID !== "openai" || ((input.data as z.infer<typeof writeSchema>).enabled && !snapshot.supported)) {
            return reply.code(409).send({ error: "Automatic account selection unavailable" })
          }
          const enabled = (input.data as z.infer<typeof writeSchema>).enabled
          deps.accounts.setEnabled(enabled)
          return { ...snapshot, enabled }
        }
        return snapshot
      } catch {
        // Credential exports are server-only. No raw errors or request details.
        return reply.code(503).send({ error: "Provider accounts unavailable" })
      } finally { release?.(); reply.raw.off("close", close) }
    },
  })
}
