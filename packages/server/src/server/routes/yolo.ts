import { FastifyInstance } from "fastify"
import type { AutoAcceptManager } from "../../permissions/auto-accept-manager"
import { acquireGitRepositoryLock } from "../../workspaces/git-repository-lock"
import { resolveRepoRoot } from "../../workspaces/git-worktrees"
import type { WorkspaceManager } from "../../workspaces/manager"
import { acquireWorkspaceMutation } from "../workspace-mutation-gate"

interface RouteDeps {
  yoloManager: AutoAcceptManager
  workspaceManager: WorkspaceManager
}

export function registerYoloRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/yolo/sessions/:sessionId",
    async (request) => {
      const { id, sessionId } = request.params
      await deps.yoloManager.hydrateInstance(id)
      return { enabled: deps.yoloManager.isEnabled(id, sessionId) }
    },
  )

  app.post<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/yolo/sessions/:sessionId/toggle",
    async (request, reply) => {
      const { id, sessionId } = request.params
      const workspace = deps.workspaceManager.get(id)
      if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
      const releaseMutation = await acquireWorkspaceMutation(id)
      let releaseRepository: (() => Promise<void>) | undefined
      try {
        if ((await resolveRepoRoot(workspace.path, request.log)).isGitRepo) {
          releaseRepository = await acquireGitRepositoryLock(workspace.path)
        }
        return { enabled: await deps.yoloManager.toggle(id, sessionId) }
      } finally {
        try {
          await releaseRepository?.()
        } finally {
          releaseMutation()
        }
      }
    },
  )
}
