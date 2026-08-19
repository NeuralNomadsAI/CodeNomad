import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { WorkspaceManager } from "../../workspaces/manager"
import {
  resolveRepoRoot,
  listWorktrees,
  isValidWorktreeSlug,
  createManagedWorktree,
  removeWorktree,
} from "../../workspaces/git-worktrees"
import type {
  WorktreeListResponse,
  WorktreeSessionMoveRequest,
  WorktreeSessionMoveResponse,
} from "../../api-types"
import { ensureCodenomadGitExclude } from "../../workspaces/worktree-map"
import { invalidateWorktreeDirectoryCache } from "../../workspaces/worktree-directory"
import {
  moveProjectSessionFamily,
  ProjectSessionError,
  removeProjectWorktree,
} from "../../workspaces/project-session-families"

interface RouteDeps {
  workspaceManager: WorkspaceManager
}

const WorktreeCreateSchema = z.object({
  slug: z.string().trim().min(1),
  branch: z.string().trim().min(1).optional(),
})

const WorktreeSessionMoveSchema = z.object({
  worktreeSlug: z.string().trim().min(1),
})

export function registerWorktreeRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/worktrees", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404)
      return { error: "Workspace not found" }
    }

    const { repoRoot, isGitRepo } = await resolveRepoRoot(workspace.path, request.log)
    const listed = await listWorktrees({ repoRoot, workspaceFolder: workspace.path, logger: request.log })
    const worktrees = await Promise.all(listed.map(async (worktree) => ({
      ...worktree,
      serviceDirectory: await deps.workspaceManager.getServiceDirectoryForPath(workspace.id, worktree.directory),
    })))
    const response: WorktreeListResponse = { worktrees, isGitRepo }
    return response
  })

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/worktrees", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404)
      return { error: "Workspace not found" }
    }

    try {
      const body = WorktreeCreateSchema.parse(request.body ?? {})
      const slug = body.slug
      if (!isValidWorktreeSlug(slug) || slug === "root") {
        reply.code(400)
        return { error: "Invalid worktree slug" }
      }
      if (body.branch) {
        if (!isValidWorktreeSlug(body.branch) || body.branch === "root") {
          reply.code(400)
          return { error: "Invalid worktree branch" }
        }
        if (body.branch !== slug) {
          reply.code(400)
          return { error: "Branch must match slug" }
        }
      }

      const { repoRoot, isGitRepo } = await resolveRepoRoot(workspace.path, request.log)
      if (!isGitRepo) {
        reply.code(400)
        return { error: "Workspace is not a Git repository" }
      }

      await ensureCodenomadGitExclude(workspace.path, request.log).catch(() => undefined)

      const created = await createManagedWorktree({
        repoRoot,
        workspaceFolder: workspace.path,
        slug,
        logger: request.log,
      })
      invalidateWorktreeDirectoryCache(workspace.id)

      reply.code(201)
      return created
    } catch (error) {
      return handleError(error, reply)
    }
  })

  app.post<{
    Params: { id: string; sessionId: string }
    Body: WorktreeSessionMoveRequest
  }>("/api/workspaces/:id/sessions/:sessionId/worktree", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404)
      return { error: "Workspace not found" }
    }

    try {
      const { worktreeSlug } = WorktreeSessionMoveSchema.parse(request.body ?? {})
      const { repoRoot, isGitRepo } = await resolveRepoRoot(workspace.path, request.log)
      if (!isGitRepo) throw new ProjectSessionError("Workspace is not a Git repository", 409)
      const worktrees = await strictWorktrees({
        repoRoot,
        workspaceFolder: workspace.path,
        logger: request.log,
        failClosed: true,
      })
      const target = worktrees.find((worktree) => worktree.slug === worktreeSlug)
      if (!target) throw new ProjectSessionError("Worktree not found", 404)
      const projectDirectory = deps.workspaceManager.getServiceDirectory(workspace.id)
      const targetDirectory = await deps.workspaceManager.getServiceDirectoryForPath(workspace.id, target.directory)
      if (!projectDirectory || !targetDirectory) throw new ProjectSessionError("Unable to resolve OpenCode worktree paths", 409)
      const moved = await moveProjectSessionFamily({
        client: await deps.workspaceManager.getSharedServiceClient(),
        projectDirectory,
        sessionId: request.params.sessionId,
        targetDirectory,
        validateTarget: async () => {
          const refreshed = await strictWorktrees({
            repoRoot,
            workspaceFolder: workspace.path,
            logger: request.log,
            failClosed: true,
          })
          return refreshed.some((worktree) => worktree.slug === worktreeSlug
            && worktree.registeredDirectory === target.registeredDirectory
            && worktree.head === target.head)
        },
      })
      const response: WorktreeSessionMoveResponse = { ...moved, worktreeSlug }
      return response
    } catch (error) {
      return handleError(error, reply)
    }
  })

  app.delete<{ Params: { id: string; slug: string }; Querystring: { force?: string } }>(
    "/api/workspaces/:id/worktrees/:slug",
    async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404)
      return { error: "Workspace not found" }
    }

    const slug = (request.params.slug ?? "").trim()
    if (!isValidWorktreeSlug(slug) || slug === "root") {
      reply.code(400)
      return { error: "Invalid worktree slug" }
    }

    const { repoRoot, isGitRepo } = await resolveRepoRoot(workspace.path, request.log)
    if (!isGitRepo) {
      reply.code(400)
      return { error: "Workspace is not a Git repository" }
    }

    const force = (request.query?.force ?? "").toString().toLowerCase() === "true"

    try {
      const worktrees = await strictWorktrees({
        repoRoot,
        workspaceFolder: workspace.path,
        logger: request.log,
        failClosed: true,
      })
      const match = worktrees.find((wt) => wt.slug === slug)
      if (!match || match.kind === "root") {
        reply.code(404)
        return { error: "Worktree not found" }
      }
      let releaseDeletion: () => void
      try {
        releaseDeletion = await deps.workspaceManager.reserveWorktreeDeletion(match.registeredDirectory ?? match.directory)
      } catch (error) {
        throw new ProjectSessionError(error instanceof Error ? error.message : "Unable to reserve worktree deletion", 409)
      }
      try {
        const client = await deps.workspaceManager.getSharedServiceClient()
        const projectDirectory = deps.workspaceManager.getServiceDirectory(workspace.id)
        const targetHostDirectory = match.registeredDirectory ?? match.directory
        const rootHostDirectory = worktrees.find((worktree) => worktree.kind === "root")!.directory
        const [targetDirectory, rootDirectory] = await Promise.all([
          deps.workspaceManager.getServiceDirectoryForPath(workspace.id, targetHostDirectory),
          deps.workspaceManager.getServiceDirectoryForPath(workspace.id, rootHostDirectory),
        ])
        if (!projectDirectory || !targetDirectory || !rootDirectory) {
          throw new ProjectSessionError("Unable to resolve OpenCode worktree paths", 409)
        }
        const isTargetRegistered = async () => {
          const refreshed = await strictWorktrees({
            repoRoot,
            workspaceFolder: workspace.path,
            logger: request.log,
            failClosed: true,
          })
          return refreshed.some((worktree) => worktree.slug === slug
            && worktree.kind === "worktree"
            && worktree.registeredDirectory === match.registeredDirectory
            && worktree.head === match.head)
        }
        await removeProjectWorktree({
          client,
          projectDirectory,
          targetDirectory,
          rootDirectory,
          remove: async () => {
            if (!await isTargetRegistered()) {
              throw new ProjectSessionError("Worktree changed before deletion", 409)
            }
            try {
              await removeWorktree({
                workspaceFolder: workspace.path,
                directory: targetHostDirectory,
                force,
                logger: request.log,
              })
            } catch (error) {
              throw new ProjectSessionError(error instanceof Error ? error.message : "Unable to remove worktree", 409)
            }
          },
          isTargetRegistered,
        })
        invalidateWorktreeDirectoryCache(workspace.id)
      } finally {
        releaseDeletion()
      }

      reply.code(204)
    } catch (error) {
      return handleError(error, reply)
    }
  },
  )
}

function strictWorktrees(params: Parameters<typeof listWorktrees>[0]) {
  return listWorktrees(params).catch((error) => {
    throw new ProjectSessionError(error instanceof Error ? error.message : "Unable to read Git worktree inventory", 502)
  })
}

function handleError(error: unknown, reply: FastifyReply) {
  reply.code(error instanceof ProjectSessionError ? error.statusCode : 400)
  return { error: error instanceof Error ? error.message : "Unable to fulfill request" }
}
