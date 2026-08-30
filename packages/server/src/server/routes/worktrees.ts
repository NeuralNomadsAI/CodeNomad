import type { FastifyInstance, FastifyReply } from "fastify"
import { stat } from "node:fs/promises"
import path from "node:path"
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
import { invalidateWorktreeCache } from "../../workspaces/worktree-directory"
import {
  moveProjectSessionFamily,
  listCompleteProjectSessions,
  ProjectSessionError,
  removeProjectWorktree,
} from "../../workspaces/project-session-families"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  worktreeDeletionFence: WorktreeDeletionFence
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
      invalidateWorktreeCache(workspace.id)
      await refreshOpenCodeWorktrees(deps.workspaceManager, workspace.id, request.log)

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
      const projectLocation = deps.workspaceManager.getServiceLocation(workspace.id)
      const targetDirectory = await deps.workspaceManager.getServiceDirectoryForPath(workspace.id, target.directory)
      if (!projectLocation || !targetDirectory) throw new ProjectSessionError("Unable to resolve OpenCode worktree paths", 409)
      const moved = await moveProjectSessionFamily({
        client: await deps.workspaceManager.getSharedServiceClient(),
        projectLocation,
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
        runMutation: async (directories, operation) => {
          const identities = await Promise.all(directories.map((directory) => (
            deps.workspaceManager.getWorktreeIdentityForPath(workspace.id, directory)
          )))
          if (identities.some((identity) => !identity)) {
            throw new ProjectSessionError("Unable to identify session worktrees", 409)
          }
          const release = deps.worktreeDeletionFence.enter(identities as string[])
          if (!release) throw new ProjectSessionError("A session worktree is being removed", 409)
          try {
            return await operation()
          } finally {
            release()
          }
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
      const targetHostDirectory = match.registeredDirectory ?? match.directory
      const targetIdentity = await deps.workspaceManager.getWorktreeIdentityForPath(workspace.id, match.directory)
      const pathIdentity = await readPathIdentity(targetHostDirectory)
      if (!targetIdentity || !pathIdentity) throw new ProjectSessionError("Unable to identify worktree before deletion", 409)
      let releaseDeletion: () => void
      try {
        releaseDeletion = await deps.workspaceManager.reserveWorktreeDeletion(targetHostDirectory)
      } catch (error) {
        throw new ProjectSessionError(error instanceof Error ? error.message : "Unable to reserve worktree deletion", 409)
      }
      try {
        const client = await deps.workspaceManager.getSharedServiceClient()
        const projectLocation = deps.workspaceManager.getServiceLocation(workspace.id)
        const rootHostDirectory = worktrees.find((worktree) => worktree.kind === "root")!.directory
        const [targetDirectory, rootDirectory] = await Promise.all([
          deps.workspaceManager.getServiceDirectoryForPath(workspace.id, match.directory),
          deps.workspaceManager.getServiceDirectoryForPath(workspace.id, rootHostDirectory),
        ])
        if (!projectLocation || !targetDirectory || !rootDirectory) {
          throw new ProjectSessionError("Unable to resolve OpenCode worktree paths", 409)
        }
        const targetServiceRoot = resolveServiceWorktreeRoot(targetHostDirectory, match.directory, targetDirectory)
        const isTargetRegistered = async () => {
          const refreshed = await strictWorktrees({
            repoRoot,
            workspaceFolder: workspace.path,
            logger: request.log,
            failClosed: true,
          })
          const current = refreshed.find((worktree) => worktree.slug === slug && worktree.kind === "worktree")
          return Boolean(current
            && current.registeredDirectory === match.registeredDirectory
            && current.head === match.head
            && current.branch === match.branch
            && samePathIdentity(pathIdentity, await readPathIdentity(targetHostDirectory)))
        }
        await removeProjectWorktree({
          client,
          projectLocation,
          targetDirectory,
          rootDirectory,
          matchesTarget: async (directory) => servicePathContains(targetServiceRoot, directory),
          validateBeforeRemove: async (projectID) => {
            await assertNoOtherProjectSessions(client, projectID, targetServiceRoot)
          },
          runMutation: async (directories, operation) => {
            const identities = await Promise.all(directories.map(async (directory) => (
              await deps.workspaceManager.getWorktreeIdentityForPath(workspace.id, directory)
                ?? (servicePathContains(targetServiceRoot, directory) ? targetIdentity : undefined)
            )))
            if (identities.some((identity) => !identity)) {
              throw new ProjectSessionError("Unable to identify session worktrees", 409)
            }
            return deps.worktreeDeletionFence.run(targetIdentity, identities as string[], operation)
          },
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
        invalidateWorktreeCache(workspace.id)
        await refreshOpenCodeWorktrees(deps.workspaceManager, workspace.id, request.log)
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

type PathIdentity = { dev: number; ino: number; birthtimeMs: number }

async function readPathIdentity(directory: string): Promise<PathIdentity | undefined> {
  try {
    const value = await stat(directory)
    return { dev: value.dev, ino: value.ino, birthtimeMs: value.birthtimeMs }
  } catch {
    return undefined
  }
}

function samePathIdentity(left: PathIdentity, right: PathIdentity | undefined): boolean {
  return Boolean(right && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs)
}

function resolveServiceWorktreeRoot(hostRoot: string, hostWorkspace: string, serviceWorkspace: string): string {
  const relative = path.relative(hostRoot, hostWorkspace)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProjectSessionError("Workspace path is outside the registered worktree", 409)
  }
  const servicePath = /^[A-Za-z]:[\\/]|^(?:\\\\|\/\/)/.test(serviceWorkspace) ? path.win32 : path.posix
  return relative.split(/[\\/]/).filter(Boolean).reduce((directory) => servicePath.dirname(directory), serviceWorkspace)
}

function servicePathContains(root: string, candidate: string): boolean {
  const servicePath = /^[A-Za-z]:[\\/]|^(?:\\\\|\/\/)/.test(root) ? path.win32 : path.posix
  const relative = servicePath.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${servicePath.sep}`) && !servicePath.isAbsolute(relative))
}

async function assertNoOtherProjectSessions(
  client: Awaited<ReturnType<WorkspaceManager["getSharedServiceClient"]>>,
  currentProjectID: string,
  targetRoot: string,
): Promise<void> {
  for (const project of await client.project.list()) {
    if (project.id === currentProjectID) continue
    const blocker = (await listCompleteProjectSessions(client, project.id))
      .find((session) => servicePathContains(targetRoot, session.location.directory))
    if (blocker) {
      throw new ProjectSessionError(`Session from another project blocks deletion: ${blocker.id}`, 409)
    }
  }
}

async function refreshOpenCodeWorktrees(
  manager: WorkspaceManager,
  workspaceId: string,
  logger: FastifyInstance["log"],
): Promise<void> {
  const location = manager.getServiceLocation(workspaceId)
  if (!location) return
  try {
    const client = await manager.getSharedServiceClient()
    const signal = AbortSignal.timeout(5_000)
    const resolved = await client.location.get({
      location: { directory: location.directory, workspace: location.workspaceID },
    }, { signal })
    await client.worktree.refresh({ projectID: resolved.project.id }, { signal })
  } catch (error) {
    logger.warn({ err: error }, "Failed to refresh OpenCode worktrees")
  }
}

function handleError(error: unknown, reply: FastifyReply) {
  reply.code(error instanceof ProjectSessionError ? error.statusCode : 400)
  return { error: error instanceof Error ? error.message : "Unable to fulfill request" }
}
