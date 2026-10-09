import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { TemporaryWorkspaceError, TemporaryWorkspaces } from "../../workspaces/temporary-workspaces"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  worktreeDeletionFence: WorktreeDeletionFence
}

export function registerTemporaryWorkspaceRoutes(app: FastifyInstance, deps: RouteDeps) {
  const registry = deps.workspaceManager.temporaryFolders
  const temporary = registry
    ? new TemporaryWorkspaces({ registry, workspaceManager: deps.workspaceManager, deletionFence: deps.worktreeDeletionFence })
    : undefined

  const fail = (request: FastifyRequest, reply: FastifyReply, error: unknown, message: string) => {
    request.log.error({ err: error }, message)
    const status = error instanceof TemporaryWorkspaceError ? error.statusCode : 500
    return reply.code(status).send({ error: error instanceof Error ? error.message : message })
  }
  const unavailable = (reply: FastifyReply) => reply.code(503).send({ error: "Temporary workspaces are unavailable" })

  // Only the folder is created here; the client opens it like any other folder.
  app.post("/api/workspaces/temporary", async (request, reply) => {
    if (!temporary) return unavailable(reply)
    try {
      reply.code(201)
      return { path: await temporary.createFolder() }
    } catch (error) {
      return fail(request, reply, error, "Unable to create a temporary folder")
    }
  })

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/keep", async (request, reply) => {
    if (!temporary) return unavailable(reply)
    try {
      await temporary.keep(request.params.id)
      return reply.code(204).send()
    } catch (error) {
      return fail(request, reply, error, "Unable to keep the temporary workspace")
    }
  })

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/discard", async (request, reply) => {
    if (!temporary) return unavailable(reply)
    try {
      await temporary.discard(request.params.id)
      return reply.code(204).send()
    } catch (error) {
      return fail(request, reply, error, "Unable to discard the temporary workspace")
    }
  })
}
