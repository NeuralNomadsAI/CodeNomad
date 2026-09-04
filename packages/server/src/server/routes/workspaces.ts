import { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { WorkspaceManager } from "../../workspaces/manager"
import { getWorktreeGitDiff, getWorktreeGitStatus, invalidateWorktreeGitStatus } from "../../workspaces/git-status"
import { commitWorktreeChanges, isGitMutationError, stageWorktreePaths, unstageWorktreePaths } from "../../workspaces/git-mutations"
import { cloneGitRepository, isGitCloneError } from "../../workspaces/git-clone"
import { isGitAvailable, resolveRepoRoot } from "../../workspaces/git-worktrees"
import { resolveWorktreeDirectory } from "../../workspaces/worktree-directory"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  worktreeDeletionFence: WorktreeDeletionFence
}

const WorkspaceCreateSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  requestId: z.string().trim().min(1).max(128).optional(),
})

const WorkspaceCloneSchema = z.object({
  repositoryUrl: z.string().trim().min(1, "Repository URL is required"),
  destinationPath: z.string().trim().min(1, "Destination path is required"),
  cleanup: z.boolean().optional(),
})

const WorkspaceCreationReleaseSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
})

const WorkspaceFilesQuerySchema = z.object({
  path: z.string().optional(),
})

const WorkspaceFileContentQuerySchema = z.object({
  path: z.string(),
  encoding: z.enum(["utf-8", "base64"]).optional(),
  worktree: z.string().trim().optional(),
})

const WorkspaceFileContentBodySchema = z.object({
  contents: z.string(),
})

const WorktreeGitDiffQuerySchema = z.object({
  path: z.string().trim().min(1, "Path is required"),
  originalPath: z.string().trim().optional(),
  scope: z.enum(["staged", "unstaged"]),
})

const WorktreeGitPathsBodySchema = z.object({
  paths: z.array(z.string().trim().min(1, "Path is required")).min(1, "At least one path is required"),
})

const WorktreeGitCommitBodySchema = z.object({
  message: z.string().trim().min(1, "Commit message is required"),
})

const WorkspaceFileSearchQuerySchema = z.object({
  q: z.string().trim().min(1, "Query is required"),
  limit: z.coerce.number().int().positive().max(200).optional(),
  type: z.enum(["all", "file", "directory"]).optional(),
  refresh: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
})

export function registerWorkspaceRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/workspaces", async () => {
    return deps.workspaceManager.list()
  })

  app.post("/api/workspaces", async (request, reply) => {
    try {
      const body = WorkspaceCreateSchema.parse(request.body ?? {})
      const result = await deps.workspaceManager.create(body.path, body.name, {
        requestId: body.requestId,
      })
      reply.code(201)
      return result.created ? result.workspace : { ...result.workspace, reused: true as const }
    } catch (error) {
      request.log.error({ err: error }, "Failed to create workspace")
      const message = error instanceof Error ? error.message : "Failed to create workspace"
      reply.code(400).type("text/plain").send(message)
    }
  })

  app.post("/api/workspaces/clone", async (request, reply) => {
    try {
      const body = WorkspaceCloneSchema.parse(request.body ?? {})
      const result = await cloneGitRepository(body)
      reply.code(201)
      return result
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404)
      return { error: "Workspace not found" }
    }
    return workspace
  })

  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    await deps.workspaceManager.delete(request.params.id)
    reply.code(204)
  })

  app.post("/api/workspaces/creation/cancel", async (request, reply) => {
    const parsed = WorkspaceCreationReleaseSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400).type("text/plain").send("Invalid workspace creation request")
      return
    }
    await deps.workspaceManager.cancelCreationRequest(parsed.data.requestId)
    reply.code(204)
  })

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/creation/release", async (request, reply) => {
    const parsed = WorkspaceCreationReleaseSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400).type("text/plain").send("Invalid workspace creation request")
      return
    }
    const body = parsed.data
    if (!deps.workspaceManager.releaseCreationRequest(request.params.id, body.requestId)) {
      reply.code(404).type("text/plain").send("Workspace creation request not found")
      return
    }
    reply.code(204)
  })

  app.get<{
    Params: { id: string }
    Querystring: { path?: string }
  }>("/api/workspaces/:id/files", async (request, reply) => {
    try {
      const query = WorkspaceFilesQuerySchema.parse(request.query ?? {})
      return deps.workspaceManager.listFiles(request.params.id, query.path ?? ".")
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.get<{
    Params: { id: string }
    Querystring: { q?: string; limit?: string; type?: "all" | "file" | "directory"; refresh?: string }
  }>("/api/workspaces/:id/files/search", async (request, reply) => {
    try {
      const query = WorkspaceFileSearchQuerySchema.parse(request.query ?? {})
      return deps.workspaceManager.searchFiles(request.params.id, query.q, {
        limit: query.limit,
        type: query.type,
        refresh: query.refresh,
      })
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.get<{
    Params: { id: string }
    Querystring: { path?: string; encoding?: "utf-8" | "base64"; worktree?: string }
  }>("/api/workspaces/:id/files/content", async (request, reply) => {
    try {
      const query = WorkspaceFileContentQuerySchema.parse(request.query ?? {})
      if (query.worktree && query.worktree !== "root") {
        const directory = await resolveGitWorktreeDirectory(deps.workspaceManager, request.params.id, query.worktree, request.log, reply)
        if (!directory) return
        return deps.workspaceManager.readFileInDirectory(request.params.id, directory, query.path, { encoding: query.encoding })
      }
      return deps.workspaceManager.readFile(request.params.id, query.path, { encoding: query.encoding })
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.put<{
    Params: { id: string }
    Querystring: { path?: string; worktree?: string }
  }>("/api/workspaces/:id/files/content", async (request, reply) => {
    try {
      const query = WorkspaceFileContentQuerySchema.parse(request.query ?? {})
      const body = WorkspaceFileContentBodySchema.parse(request.body ?? {})
      if (query.worktree && query.worktree !== "root") {
        const directory = await resolveGitWorktreeDirectory(deps.workspaceManager, request.params.id, query.worktree, request.log, reply)
        if (!directory) return
        const mutation = await runWorktreeMutation(deps, request.params.id, directory, reply, () => {
          deps.workspaceManager.writeFileInDirectory(request.params.id, directory, query.path, body.contents)
        })
        if (!mutation) return
        reply.code(204)
        return
      }
      deps.workspaceManager.writeFile(request.params.id, query.path, body.contents)
      reply.code(204)
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.get<{
    Params: { id: string; slug: string }
  }>("/api/workspaces/:id/worktrees/:slug/git-status", async (request, reply) => {
    try {
      const directory = await resolveGitWorktreeDirectory(deps.workspaceManager, request.params.id, request.params.slug, request.log, reply)
      if (!directory) return

      return await getWorktreeGitStatus({ workspaceFolder: directory, logger: request.log })
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.get<{
    Params: { id: string; slug: string }
    Querystring: { path: string; originalPath?: string; scope: "staged" | "unstaged" }
  }>("/api/workspaces/:id/worktrees/:slug/git-diff", async (request, reply) => {
    try {
      const query = WorktreeGitDiffQuerySchema.parse(request.query ?? {})
      const directory = await resolveGitWorktreeDirectory(deps.workspaceManager, request.params.id, request.params.slug, request.log, reply)
      if (!directory) return

      return await getWorktreeGitDiff({
        workspaceFolder: directory,
        path: query.path,
        originalPath: query.originalPath,
        scope: query.scope,
      })
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.post<{
    Params: { id: string; slug: string }
    Body: { paths: string[] }
  }>("/api/workspaces/:id/worktrees/:slug/git-stage", async (request, reply) => {
    try {
      const body = WorktreeGitPathsBodySchema.parse(request.body ?? {})
      const directory = await resolveGitWorktreeDirectory(deps.workspaceManager, request.params.id, request.params.slug, request.log, reply)
      if (!directory) return

      const mutation = await runWorktreeMutation(deps, request.params.id, directory, reply, async () => {
        await stageWorktreePaths({ workspaceFolder: directory, paths: body.paths })
        await invalidateWorktreeGitStatus(directory)
      })
      if (!mutation) return
      return { ok: true as const }
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.post<{
    Params: { id: string; slug: string }
    Body: { paths: string[] }
  }>("/api/workspaces/:id/worktrees/:slug/git-unstage", async (request, reply) => {
    try {
      const body = WorktreeGitPathsBodySchema.parse(request.body ?? {})
      const directory = await resolveGitWorktreeDirectory(deps.workspaceManager, request.params.id, request.params.slug, request.log, reply)
      if (!directory) return

      const mutation = await runWorktreeMutation(deps, request.params.id, directory, reply, async () => {
        await unstageWorktreePaths({ workspaceFolder: directory, paths: body.paths })
        await invalidateWorktreeGitStatus(directory)
      })
      if (!mutation) return
      return { ok: true as const }
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.post<{
    Params: { id: string; slug: string }
    Body: { message: string }
  }>("/api/workspaces/:id/worktrees/:slug/git-commit", async (request, reply) => {
    try {
      const body = WorktreeGitCommitBodySchema.parse(request.body ?? {})
      const directory = await resolveGitWorktreeDirectory(deps.workspaceManager, request.params.id, request.params.slug, request.log, reply)
      if (!directory) return

      const mutation = await runWorktreeMutation(deps, request.params.id, directory, reply, async () => {
        const result = await commitWorktreeChanges({ workspaceFolder: directory, message: body.message })
        await invalidateWorktreeGitStatus(directory)
        return result
      })
      if (!mutation) return
      return { ok: true as const, ...mutation.value }
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })
}

async function runWorktreeMutation<T>(
  deps: RouteDeps,
  workspaceId: string,
  directory: string,
  reply: FastifyReply,
  operation: () => T | Promise<T>,
): Promise<{ value: T } | null> {
  const identity = await deps.workspaceManager.getWorktreeIdentityForPath(workspaceId, directory)
  if (!identity) {
    reply.code(403).send({ error: "Worktree does not belong to workspace" })
    return null
  }
  const release = deps.worktreeDeletionFence.enter([identity])
  if (!release) {
    reply.code(409).send({ error: "Worktree deletion is in progress" })
    return null
  }
  try {
    return { value: await operation() }
  } finally {
    release()
  }
}

async function resolveGitWorktreeDirectory(
  workspaceManager: WorkspaceManager,
  workspaceId: string,
  worktreeSlug: string,
  logger: { debug?: (obj: any, msg?: string) => void; warn?: (obj: any, msg?: string) => void },
  reply: FastifyReply,
): Promise<string | null> {
  const workspace = workspaceManager.get(workspaceId)
  if (!workspace) {
    reply.code(404)
    reply.send({ error: "Workspace not found" })
    return null
  }

  const gitAvailable = await isGitAvailable(workspace.path)
  if (!gitAvailable) {
    reply.code(503)
    reply.send({ error: "Git is not installed or not available in PATH" })
    return null
  }

  const { isGitRepo } = await resolveRepoRoot(workspace.path, logger)
  if (!isGitRepo) {
    reply.code(400)
    reply.send({ error: "Workspace is not a Git repository" })
    return null
  }

  const directory = await resolveWorktreeDirectory({
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    worktreeSlug,
    logger,
  })
  if (!directory) {
    reply.code(404)
    reply.send({ error: "Worktree not found" })
    return null
  }

  return directory
}


function handleWorkspaceError(error: unknown, reply: FastifyReply) {
  if (isGitCloneError(error)) {
    reply.code(error.statusCode)
    return { error: error.message }
  }
  if (isGitMutationError(error)) {
    reply.code(error.statusCode)
    return { error: error.message }
  }
  if (error instanceof Error && error.message === "Workspace not found") {
    reply.code(404)
    return { error: "Workspace not found" }
  }
  reply.code(400)
  return { error: error instanceof Error ? error.message : "Unable to fulfill request" }
}
