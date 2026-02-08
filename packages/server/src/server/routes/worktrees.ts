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
import type { WorktreeListResponse, WorktreeMap } from "../../api-types"
import { ensureCodenomadGitExclude, readWorktreeMap, writeWorktreeMap } from "../../workspaces/worktree-map"

interface RouteDeps {
  workspaceManager: WorkspaceManager
}

const WorktreeMapSchema = z.object({
  version: z.literal(1),
  defaultWorktreeSlug: z.string().min(1).default("root"),
  parentSessionWorktreeSlug: z.record(z.string(), z.string()).default({}),
})

const WorktreeCreateSchema = z.object({
  slug: z.string().trim().min(1),
  branch: z.string().trim().min(1).optional(),
})

export function registerWorktreeRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/worktrees", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404)
      return { error: "Workspace not found" }
    }

    const { repoRoot, isGitRepo } = await resolveRepoRoot(workspace.path, request.log)
    const worktrees = await listWorktrees({ repoRoot, workspaceFolder: workspace.path, logger: request.log })
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

      reply.code(201)
      return created
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
      const worktrees = await listWorktrees({ repoRoot, workspaceFolder: workspace.path, logger: request.log })
      const match = worktrees.find((wt) => wt.slug === slug)
      if (!match || match.kind === "root") {
        reply.code(404)
        return { error: "Worktree not found" }
      }

      await removeWorktree({ workspaceFolder: workspace.path, directory: match.directory, force, logger: request.log })

      // Best-effort: prune any mappings that point at the deleted worktree.
      const current = await readWorktreeMap(workspace.path, request.log)
      let changed = false
      const nextMapping: Record<string, string> = { ...(current.parentSessionWorktreeSlug ?? {}) }
      for (const [sessionId, mapped] of Object.entries(nextMapping)) {
        if (mapped === slug) {
          delete nextMapping[sessionId]
          changed = true
        }
      }
      const nextDefault = current.defaultWorktreeSlug === slug ? "root" : current.defaultWorktreeSlug
      if (nextDefault !== current.defaultWorktreeSlug) {
        changed = true
      }
      if (changed) {
        await writeWorktreeMap(
          workspace.path,
          {
            version: 1,
            defaultWorktreeSlug: nextDefault,
            parentSessionWorktreeSlug: nextMapping,
          },
          request.log,
        )
      }

      reply.code(204)
    } catch (error) {
      return handleError(error, reply)
    }
  },
  )

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/worktrees/map", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404)
      return { error: "Workspace not found" }
    }
    return await readWorktreeMap(workspace.path, request.log)
  })

  app.put<{ Params: { id: string } }>("/api/workspaces/:id/worktrees/map", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404)
      return { error: "Workspace not found" }
    }

    try {
      const parsed = WorktreeMapSchema.parse(request.body ?? {}) as WorktreeMap
      if (!isValidWorktreeSlug(parsed.defaultWorktreeSlug)) {
        reply.code(400)
        return { error: "Invalid defaultWorktreeSlug" }
      }
      for (const slug of Object.values(parsed.parentSessionWorktreeSlug ?? {})) {
        if (!isValidWorktreeSlug(slug)) {
          reply.code(400)
          return { error: "Invalid worktree slug in mapping" }
        }
      }
      await writeWorktreeMap(workspace.path, parsed, request.log)
      reply.code(204)
    } catch (error) {
      return handleError(error, reply)
    }
  })
}

function handleError(error: unknown, reply: FastifyReply) {
  reply.code(400)
  return { error: error instanceof Error ? error.message : "Unable to fulfill request" }
}
