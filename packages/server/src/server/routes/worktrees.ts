import type { FastifyInstance, FastifyReply } from "fastify"
import { z, ZodError } from "zod"
import type { WorktreeListResponse, WorktreeSessionMoveResponse } from "../../api-types"
import type { OpencodeYoloPersistence } from "../../permissions/opencode-yolo-metadata"
import { createInstanceClient } from "../../workspaces/instance-client"
import { acquireGitRepositoryLock, withGitRepositoryLock } from "../../workspaces/git-repository-lock"
import { createManagedWorktree, isValidWorktreeSlug, listWorktrees, resolveRepoRoot } from "../../workspaces/git-worktrees"
import { WorkspaceInUseError, type WorkspaceManager } from "../../workspaces/manager"
import { resolveNativeSessionScope } from "../../workspaces/native-session-scope"
import {
  deleteWorktreeTransaction,
  moveSessionFamily,
  WorktreeRollbackIncompleteError,
  WorktreeSessionBusyError,
} from "../../workspaces/worktree-transactions"
import { ensureCodenomadGitExclude, readWorktreeMap, writeWorktreeMap } from "../../workspaces/worktree-map"
import { acquireWorkspaceMutation } from "../workspace-mutation-gate"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  sessionMetadataPersistence: OpencodeYoloPersistence
}

const WorktreeCreateSchema = z.object({
  slug: z.string().trim().min(1),
  branch: z.string().trim().min(1).optional(),
})
const WorktreeSessionSchema = z.object({ worktreeSlug: z.string().trim().refine(isValidWorktreeSlug).nullable() })
const WorktreeSessionMoveSchema = z.object({ worktreeSlug: z.string().trim().refine(isValidWorktreeSlug) })

export function registerWorktreeRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.put<{ Params: { id: string; sessionId: string }; Body: unknown }>(
    "/api/workspaces/:id/worktrees/sessions/:sessionId",
    async (request, reply) => {
      const workspace = deps.workspaceManager.get(request.params.id)
      if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
      try {
        const body = WorktreeSessionSchema.parse(request.body)
        return await withGitRepositoryLock(workspace.path, async () => {
          if (body.worktreeSlug) {
            const { repoRoot } = await resolveRepoRoot(workspace.path, request.log)
            const exists = (await listWorktrees({ repoRoot, workspaceFolder: workspace.path, logger: request.log }))
              .some((worktree) => worktree.slug === body.worktreeSlug)
            if (!exists) return reply.code(404).send({ error: "Worktree not found" })
          }
          if (!await deps.sessionMetadataPersistence.hasProjectSession(workspace.id, request.params.sessionId)) {
            return reply.code(404).send({ error: "Session not found" })
          }
          const metadata = await deps.sessionMetadataPersistence.setWorktreeSlug(
            workspace.id,
            request.params.sessionId,
            body.worktreeSlug,
          )
          return { metadata }
        })
      } catch (error) {
        return handleError(error, reply)
      }
    },
  )

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/worktrees", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
    const { repoRoot, isGitRepo } = await resolveRepoRoot(workspace.path, request.log)
    const hostWorktrees = await listWorktrees({ repoRoot, workspaceFolder: workspace.path, logger: request.log })
    const worktrees = await Promise.all(hostWorktrees.map(async (worktree) => ({
      ...worktree,
      nativeDirectory: await deps.workspaceManager.resolveInstanceDirectory(workspace.id, worktree.directory),
    })))
    return { worktrees, isGitRepo } satisfies WorktreeListResponse
  })

  app.post<{ Params: { id: string }; Body: unknown }>("/api/workspaces/:id/worktrees", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
    try {
      const body = WorktreeCreateSchema.parse(request.body ?? {})
      if (!isValidWorktreeSlug(body.slug) || body.slug === "root" || (body.branch && body.branch !== body.slug)) {
        return reply.code(400).send({ error: "Invalid worktree slug" })
      }
      const created = await withGitRepositoryLock(workspace.path, async () => {
        const { repoRoot, isGitRepo } = await resolveRepoRoot(workspace.path, request.log)
        if (!isGitRepo) throw new Error("Workspace is not a Git repository")
        await ensureCodenomadGitExclude(workspace.path, request.log).catch(() => undefined)
        return createManagedWorktree({ repoRoot, workspaceFolder: workspace.path, slug: body.slug, logger: request.log })
      })
      return reply.code(201).send(created)
    } catch (error) {
      return handleError(error, reply)
    }
  })

  app.post<{ Params: { id: string; sessionId: string }; Body: unknown }>(
    "/api/workspaces/:id/worktrees/sessions/:sessionId/move",
    async (request, reply) => {
      const workspace = deps.workspaceManager.get(request.params.id)
      if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
      try {
        const body = WorktreeSessionMoveSchema.parse(request.body)
        return await withGitRepositoryLock<WorktreeSessionMoveResponse>(workspace.path, async () => {
          const { repoRoot, isGitRepo } = await resolveRepoRoot(workspace.path, request.log)
          if (!isGitRepo) throw new Error("Workspace is not a Git repository")
          const target = (await listWorktrees({ repoRoot, workspaceFolder: workspace.path, logger: request.log }))
            .find((worktree) => worktree.slug === body.worktreeSlug)
          if (!target) throw new Error("Worktree not found")
          const rootDirectory = await deps.workspaceManager.resolveInstanceDirectory(workspace.id)
          const client = createInstanceClient(deps.workspaceManager, workspace.id, { directory: rootDirectory })
          if (!client) throw new Error("Workspace instance is not ready")
          return moveSessionFamily({
            instanceId: workspace.id,
            client,
            rootDirectory,
            sessionId: request.params.sessionId,
            target: { ...target, nativeDirectory: await deps.workspaceManager.resolveInstanceDirectory(workspace.id, target.directory) },
            persistence: deps.sessionMetadataPersistence,
          })
        })
      } catch (error) {
        return handleError(error, reply)
      }
    },
  )

  app.post<{ Params: { id: string; sessionId: string } }>(
    "/api/workspaces/:id/worktrees/sessions/:sessionId/create-related",
    async (request, reply) => {
      const workspace = deps.workspaceManager.get(request.params.id)
      if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
      const releaseMutation = await acquireWorkspaceMutation(workspace.id)
      let releaseRepository: (() => Promise<void>) | undefined
      try {
        if ((await resolveRepoRoot(workspace.path, request.log)).isGitRepo) {
          releaseRepository = await acquireGitRepositoryLock(workspace.path)
        }
        const scope = await resolveNativeSessionScope(deps.workspaceManager, workspace.id, request.params.sessionId)
        const { data } = await scope.client.session.create(
          { directory: scope.directory, ...(scope.workspace ? { workspace: scope.workspace, workspaceID: scope.workspace } : {}) },
          { throwOnError: true },
        )
        if (!data) throw new Error("Failed to create session: No data returned")
        return data
      } catch (error) {
        return handleError(error, reply)
      } finally {
        try {
          await releaseRepository?.()
        } finally {
          releaseMutation()
        }
      }
    },
  )

  app.delete<{ Params: { id: string; slug: string }; Querystring: { force?: string } }>(
    "/api/workspaces/:id/worktrees/:slug",
    async (request, reply) => {
      const workspace = deps.workspaceManager.get(request.params.id)
      if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
      const slug = request.params.slug.trim()
      if (!isValidWorktreeSlug(slug) || slug === "root") return reply.code(400).send({ error: "Invalid worktree slug" })
      try {
        await withGitRepositoryLock(workspace.path, async () => {
          await deps.workspaceManager.withWorkspaceExclusive(workspace.path, workspace.id, async () => {
            const { repoRoot, isGitRepo } = await resolveRepoRoot(workspace.path, request.log)
            if (!isGitRepo) throw new Error("Workspace is not a Git repository")
            const target = (await listWorktrees({ repoRoot, workspaceFolder: workspace.path, logger: request.log }))
              .find((worktree) => worktree.slug === slug && worktree.kind !== "root")
            if (!target) throw new Error("Worktree not found")
            const rootDirectory = await deps.workspaceManager.resolveInstanceDirectory(workspace.id)
            const client = createInstanceClient(deps.workspaceManager, workspace.id, { directory: rootDirectory })
            if (!client) throw new Error("Workspace instance is not ready")
            await deleteWorktreeTransaction({
              instanceId: workspace.id,
              client,
              rootDirectory,
              workspaceFolder: workspace.path,
              target: { ...target, nativeDirectory: await deps.workspaceManager.resolveInstanceDirectory(workspace.id, target.directory) },
              force: request.query.force?.toLowerCase() === "true",
              persistence: deps.sessionMetadataPersistence,
              logger: request.log,
            })
            try {
              const current = await readWorktreeMap(workspace.path, request.log)
              await writeWorktreeMap(workspace.path, {
                version: 1,
                defaultWorktreeSlug: current.defaultWorktreeSlug === slug ? "root" : current.defaultWorktreeSlug,
                parentSessionWorktreeSlug: Object.fromEntries(
                  Object.entries(current.parentSessionWorktreeSlug).filter(([, mapped]) => mapped !== slug),
                ),
              }, request.log)
            } catch (error) {
              request.log.warn({ error, slug }, "Worktree deleted but legacy map cleanup failed")
            }
          })
        })
        return reply.code(204).send()
      } catch (error) {
        return handleError(error, reply)
      }
    },
  )

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/worktrees/map", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
    return readWorktreeMap(workspace.path, request.log)
  })

  app.delete<{ Params: { id: string; sessionId: string } }>(
    "/api/workspaces/:id/worktrees/map/sessions/:sessionId",
    async (request, reply) => {
      const workspace = deps.workspaceManager.get(request.params.id)
      if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
      try {
        return await withGitRepositoryLock(workspace.path, async () => {
          const current = await readWorktreeMap(workspace.path, request.log)
          const parentSessionWorktreeSlug = { ...current.parentSessionWorktreeSlug }
          delete parentSessionWorktreeSlug[request.params.sessionId]
          const next = { ...current, parentSessionWorktreeSlug }
          await writeWorktreeMap(workspace.path, next, request.log)
          return next
        })
      } catch (error) {
        return handleError(error, reply)
      }
    },
  )

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/worktrees/map/prune", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
    try {
      return await withGitRepositoryLock(workspace.path, async () => {
        const { repoRoot } = await resolveRepoRoot(workspace.path, request.log)
        const available = new Set((await listWorktrees({ repoRoot, workspaceFolder: workspace.path, logger: request.log }))
          .map((worktree) => worktree.slug))
        available.add("root")
        const current = await readWorktreeMap(workspace.path, request.log)
        const next = {
          version: 1 as const,
          defaultWorktreeSlug: available.has(current.defaultWorktreeSlug) ? current.defaultWorktreeSlug : "root",
          parentSessionWorktreeSlug: Object.fromEntries(
            Object.entries(current.parentSessionWorktreeSlug).filter(([, slug]) => available.has(slug)),
          ),
        }
        await writeWorktreeMap(workspace.path, next, request.log)
        return next
      })
    } catch (error) {
      return handleError(error, reply)
    }
  })
}

function handleError(error: unknown, reply: FastifyReply) {
  reply.code(classifyWorktreeError(error))
  return { error: error instanceof Error ? error.message : "Unable to fulfill request" }
}

export function classifyWorktreeError(error: unknown): 400 | 404 | 409 | 500 | 503 {
  if (error instanceof ZodError) return 400
  if (error instanceof WorktreeSessionBusyError) return 409
  if (error instanceof WorkspaceInUseError) return 409
  if (error instanceof WorktreeRollbackIncompleteError || error instanceof AggregateError) return 500
  if (error instanceof Error && /^(Session|Worktree) not found$/.test(error.message)) return 404
  if (error instanceof Error && error.message === "Workspace instance is not ready") return 503
  if (error instanceof Error && error.message === "Workspace is not a Git repository") return 400
  return 500
}
