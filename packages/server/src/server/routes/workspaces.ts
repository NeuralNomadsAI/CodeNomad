import { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { WorkspaceManager } from "../../workspaces/manager"
import { getWorktreeGitDiff, getWorktreeGitStatus } from "../../workspaces/git-status"
import { commitWorktreeChanges, isGitMutationError, stageWorktreePaths, unstageWorktreePaths } from "../../workspaces/git-mutations"
import { isGitAvailable, resolveRepoRoot } from "../../workspaces/git-worktrees"
import { resolveWorktreeDirectory } from "../../workspaces/worktree-directory"

interface RouteDeps {
  workspaceManager: WorkspaceManager
}

const WorkspaceCreateSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
})

const WorkspaceFilesQuerySchema = z.object({
  path: z.string().optional(),
})

const WorkspaceFileContentQuerySchema = z.object({
  path: z.string(),
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
      const workspace = await deps.workspaceManager.create(body.path, body.name)
      reply.code(201)
      return workspace
    } catch (error) {
      request.log.error({ err: error }, "Failed to create workspace")
      const message = error instanceof Error ? error.message : "Failed to create workspace"
      reply.code(400).type("text/plain").send(message)
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
    Querystring: { path?: string }
  }>("/api/workspaces/:id/files/content", async (request, reply) => {
    try {
      const query = WorkspaceFileContentQuerySchema.parse(request.query ?? {})
      return deps.workspaceManager.readFile(request.params.id, query.path)
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.put<{
    Params: { id: string }
    Querystring: { path?: string }
  }>("/api/workspaces/:id/files/content", async (request, reply) => {
    try {
      const query = WorkspaceFileContentQuerySchema.parse(request.query ?? {})
      const body = WorkspaceFileContentBodySchema.parse(request.body ?? {})
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

      await stageWorktreePaths({ workspaceFolder: directory, paths: body.paths })
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

      await unstageWorktreePaths({ workspaceFolder: directory, paths: body.paths })
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

      const result = await commitWorktreeChanges({ workspaceFolder: directory, message: body.message })
      return { ok: true as const, ...result }
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })
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
