import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import { backgroundShellIds, ownedShellDirectory } from "../../opencode/background-shells"
import { locationRequestOptions } from "../../opencode/compatibility/location"

type Dependencies = Pick<WorkspaceManager, "get" | "ownsDirectory" | "getSharedServiceConnection" | "getServicePathForPath">
const querySchema = z.object({ directory: z.string().min(1) }).strict()

export function registerBackgroundShellRoutes(app: FastifyInstance, manager: Dependencies) {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/background-shells", async (request, reply) => {
    reply.header("cache-control", "no-store")
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid shell location" })
    const id = request.params.id
    if (!manager.get(id)) return reply.code(404).send({ error: "Workspace not found" })
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.once("close", abort)
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
      if (!await manager.ownsDirectory(id, parsed.data.directory)) return reply.code(403).send({ error: "Shell location does not belong to workspace" })
      const directory = await manager.getServicePathForPath(id, parsed.data.directory)
      if (!directory) return reply.code(403).send({ error: "Shell location does not belong to workspace" })
      const connection = await manager.getSharedServiceConnection(id)
      if (!connection) return reply.code(503).send({ error: "OpenCode is unavailable" })
      const [ids, shells] = await Promise.all([
        backgroundShellIds(connection, signal),
        connection.client.shell.list({ location: { directory } }, { ...locationRequestOptions({ directory }), signal }),
      ])
      const candidates = shells.data.filter(shell => ids.has(shell.id))
      const ownership = await Promise.all(candidates.map(shell => ownedShellDirectory(shell, connection.client,
        path => manager.ownsDirectory(id, path), signal)))
      connection.assertCurrent()
      signal.throwIfAborted()
      return { data: candidates.filter((_, index) => ownership[index]) }
    } catch (error) {
      request.log.warn({ err: error }, "Background shell inventory failed")
      return reply.code(502).send({ error: "Background shell inventory is unavailable" })
    } finally { reply.raw.removeListener("close", abort) }
  })
}
