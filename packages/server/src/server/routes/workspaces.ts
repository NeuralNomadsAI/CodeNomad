import { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import fs from "fs"
import path from "path"
import { WorkspaceManager } from "../../workspaces/manager"
import { FileSystemBrowser } from "../../filesystem/browser"
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
  worktree: z.string().optional(),
})

const WorkspaceFileContentQuerySchema = z.object({
  path: z.string(),
  worktree: z.string().optional(),
})

const WorkspaceFileContentBodySchema = z.object({
  contents: z.string(),
})

const WorkspaceUploadQuerySchema = z.object({
  path: z.string(),
  worktree: z.string().optional(),
})

const WorkspaceDownloadQuerySchema = z.object({
  path: z.string(),
  worktree: z.string().optional(),
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
  worktree: z.string().optional(),
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
    Querystring: { path?: string; worktree?: string }
  }>("/api/workspaces/:id/files", async (request, reply) => {
    try {
      const query = WorkspaceFilesQuerySchema.parse(request.query ?? {})
      return deps.workspaceManager.listFiles(request.params.id, query.path ?? ".", query.worktree)
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.get<{
    Params: { id: string }
    Querystring: { q?: string; limit?: string; type?: "all" | "file" | "directory"; refresh?: string; worktree?: string }
  }>("/api/workspaces/:id/files/search", async (request, reply) => {
    try {
      const query = WorkspaceFileSearchQuerySchema.parse(request.query ?? {})
      return deps.workspaceManager.searchFiles(request.params.id, query.q, {
        limit: query.limit,
        type: query.type,
        refresh: query.refresh,
      }, query.worktree)
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.get<{
    Params: { id: string }
    Querystring: { path?: string; worktree?: string }
  }>("/api/workspaces/:id/files/content", async (request, reply) => {
    try {
      const query = WorkspaceFileContentQuerySchema.parse(request.query ?? {})
      return deps.workspaceManager.readFile(request.params.id, query.path, query.worktree)
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
      deps.workspaceManager.writeFile(request.params.id, query.path, body.contents, query.worktree)
      reply.code(204)
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.delete<{
    Params: { id: string }
    Querystring: { path?: string; worktree?: string }
  }>("/api/workspaces/:id/files/content", async (request, reply) => {
    try {
      const query = WorkspaceFileContentQuerySchema.parse(request.query ?? {})
      deps.workspaceManager.deleteFile(request.params.id, query.path, query.worktree)
      reply.code(204)
    } catch (error) {
      return handleWorkspaceError(error, reply)
    }
  })

  app.post<{
    Params: { id: string }
    Querystring: { path?: string; worktree?: string }
  }>("/api/workspaces/:id/files/upload", async (request, reply) => {
    try {
      const query = WorkspaceUploadQuerySchema.parse(request.query ?? {})
      const data = await request.file({
        limits: {
          fileSize: 100 * 1024 * 1024, // 100MB
        },
      })
      if (!data?.file) {
        reply.code(400)
        return { error: "No file provided" }
      }
      const overwrite = request.headers["x-overwrite"] === "true"
      const result = await deps.workspaceManager.uploadFile(request.params.id, query.path, data.file, query.worktree, overwrite)
      reply.code(201)
      return result
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
    Params: { id: string }
    Querystring: { path?: string; worktree?: string }
  }>("/api/workspaces/:id/files/download", async (request, reply) => {
    try {
      const query = WorkspaceDownloadQuerySchema.parse(request.query ?? {})
      const resolvedPath = await deps.workspaceManager.resolveFilePath(request.params.id, query.path, query.worktree)
      const fileName = path.basename(resolvedPath)

      const stats = fs.statSync(resolvedPath)
      if (stats.isDirectory()) {
        reply.code(400)
        return { error: "Cannot download directory" }
      }
      if (stats.size > 100 * 1024 * 1024) {
        reply.code(413)
        return { error: "File too large (max 100MB)" }
      }

      const mimeType = getMimeType(fileName)
      reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`)
      reply.header("Content-Type", mimeType)
      reply.header("Accept-Ranges", "bytes")
      reply.header("ETag", `"${stats.mtimeMs}-${stats.size}"`)
      reply.header("Content-Length", stats.size)

      const range = request.headers.range
      if (range) {
        const rangeMatch = range.match(/^bytes=(\d+)-(\d*)$/)
        if (!rangeMatch) {
          reply.code(400)
          return { error: "Invalid Range header" }
        }
        const start = parseInt(rangeMatch[1], 10)
        const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : stats.size - 1
        const chunkSize = (end - start) + 1

        reply.code(206)
        reply.header("Content-Range", `bytes ${start}-${end}/${stats.size}`)
        reply.header("Content-Length", chunkSize)

        const stream = fs.createReadStream(resolvedPath, { start, end })
        return reply.send(stream)
      }

      const stream = fs.createReadStream(resolvedPath)
      return reply.send(stream)
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
    reply.code((error as any).statusCode)
    return { error: (error as any).message }
  }
  if (error instanceof Error && error.message === "Workspace not found") {
    reply.code(404)
    return { error: "Workspace not found" }
  }
  if (error instanceof Error && error.message.includes("Cannot delete directory")) {
    reply.code(400)
    return { error: "Folder deletion is not supported" }
  }
  if (error instanceof Error && error.message.includes("File already exists")) {
    reply.code(409)
    return { error: "File already exists" }
  }
  if (error instanceof Error && error.message.includes("outside of root")) {
    reply.code(403)
    return { error: "Access denied" }
  }
  reply.code(400)
  return { error: error instanceof Error ? error.message : "Unable to fulfill request" }
}

function getMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase()
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".xml": "application/xml",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".md": "text/markdown",
    ".txt": "text/plain",
  }
  return mimeTypes[ext] || "application/octet-stream"
}
