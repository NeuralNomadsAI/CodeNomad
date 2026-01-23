import { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { WorkspaceManager } from "../../workspaces/manager"
import type { EraDetectionService } from "../../era/detection"
import type { WorkspaceDescriptor } from "../../api-types"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  eraDetection?: EraDetectionService
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

const WorkspaceFileSearchQuerySchema = z.object({
  q: z.string().trim().min(1, "Query is required"),
  limit: z.coerce.number().int().positive().max(200).optional(),
  type: z.enum(["all", "file", "directory"]).optional(),
  refresh: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
})

/**
 * Compare semantic versions. Returns true if v1 < v2.
 */
function isVersionOlder(v1: string | undefined, v2: string | undefined): boolean {
  if (!v1 || !v2) return false
  
  const parse = (v: string) => {
    const match = v.match(/^(\d+)\.(\d+)\.(\d+)/)
    if (!match) return null
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)] as const
  }
  
  const p1 = parse(v1)
  const p2 = parse(v2)
  if (!p1 || !p2) return false
  
  for (let i = 0; i < 3; i++) {
    if (p1[i] < p2[i]) return true
    if (p1[i] > p2[i]) return false
  }
  return false
}

/**
 * Enrich a workspace descriptor with version comparison info.
 */
function enrichWorkspaceWithVersionInfo(
  workspace: WorkspaceDescriptor,
  installedVersion: string | null
): WorkspaceDescriptor {
  if (!installedVersion) return workspace
  
  return {
    ...workspace,
    installedBinaryVersion: installedVersion,
    isVersionOutdated: isVersionOlder(workspace.binaryVersion, installedVersion),
  }
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: RouteDeps) {
  // Cache the installed version (refreshed on each request for now)
  const getInstalledVersion = () => {
    if (!deps.eraDetection) return null
    const binary = deps.eraDetection.detectBinary()
    return binary.version
  }

  app.get("/api/workspaces", async () => {
    const installedVersion = getInstalledVersion()
    return deps.workspaceManager.list().map(w => enrichWorkspaceWithVersionInfo(w, installedVersion))
  })

  app.post("/api/workspaces", async (request, reply) => {
    const body = WorkspaceCreateSchema.parse(request.body ?? {})
    const workspace = await deps.workspaceManager.create(body.path, body.name)
    reply.code(201)
    return workspace
  })

  app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404)
      return { error: "Workspace not found" }
    }
    const installedVersion = getInstalledVersion()
    return enrichWorkspaceWithVersionInfo(workspace, installedVersion)
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
}


function handleWorkspaceError(error: unknown, reply: FastifyReply) {
  if (error instanceof Error && error.message === "Workspace not found") {
    reply.code(404)
    return { error: "Workspace not found" }
  }
  reply.code(400)
  return { error: error instanceof Error ? error.message : "Unable to fulfill request" }
}
