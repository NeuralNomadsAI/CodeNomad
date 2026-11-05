import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { WorkspaceCapabilityError } from "../../opencode/servers/capabilities"
import type { EventBus } from "../../events/bus"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { TemporaryWorkspaceError, TemporaryWorkspaces } from "../../workspaces/temporary-workspaces"
import { hostOnlyQuery } from "./host-only-query"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  worktreeDeletionFence: WorktreeDeletionFence
  eventBus: EventBus
}

const TargetSchema = z.object({ serverId: z.string().optional() }).strict()
const AbandonSchema = TargetSchema.extend({ path: z.string().min(1) })
const DiscardSchema = z.object({ onlyIfEmpty: z.boolean().optional() })

function requireLocalTarget({ serverId }: z.infer<typeof TargetSchema>) {
  if (serverId !== undefined && serverId !== "local-shared") {
    throw new WorkspaceCapabilityError("worktrees", { code: "deferred" })
  }
}

export function registerTemporaryWorkspaceRoutes(app: FastifyInstance, deps: RouteDeps) {
  const registry = deps.workspaceManager.temporaryFolders
  const temporary = registry
    ? new TemporaryWorkspaces({
        registry,
        workspaceManager: deps.workspaceManager,
        deletionFence: deps.worktreeDeletionFence,
        onChange: (folders) => deps.eventBus.publish({ type: "workspace.temporaryChanged", folders }),
      })
    : undefined

  // `error` carries a stable code the client localizes; `message` is diagnostic.
  const fail = (request: FastifyRequest, reply: FastifyReply, error: unknown, message: string) => {
    request.log.error({ err: error }, message)
    if (error instanceof WorkspaceCapabilityError) {
      return reply.code(403).send({ error: error.code, code: error.code, capability: error.capability, reason: error.reason })
    }
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid temporary workspace request" })
    if (error instanceof TemporaryWorkspaceError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message })
    }
    return reply.code(500).send({ error: error instanceof Error ? error.message : message })
  }
  const unavailable = (reply: FastifyReply) => reply.code(503).send({ error: "Temporary workspaces are unavailable" })

  app.get("/api/workspaces/temporary", async () => ({ folders: temporary?.list() ?? [] }))

  // Only the folder is created here; the client opens it like any other folder.
  app.post("/api/workspaces/temporary", { preHandler: hostOnlyQuery("worktrees") }, async (request, reply) => {
    if (!temporary) return unavailable(reply)
    try {
      requireLocalTarget(TargetSchema.parse(request.body ?? {}))
      reply.code(201)
      return { path: await temporary.createFolder() }
    } catch (error) {
      return fail(request, reply, error, "Unable to create a temporary folder")
    }
  })

  app.post("/api/workspaces/temporary/abandon", { preHandler: hostOnlyQuery("worktrees") }, async (request, reply) => {
    if (!temporary) return unavailable(reply)
    try {
      const body = AbandonSchema.parse(request.body ?? {})
      requireLocalTarget(body)
      await temporary.abandonFolder(body.path)
      return reply.code(204).send()
    } catch (error) {
      return fail(request, reply, error, "Unable to remove the unused temporary folder")
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
      await temporary.discard(request.params.id, DiscardSchema.parse(request.body ?? {}))
      return reply.code(204).send()
    } catch (error) {
      return fail(request, reply, error, "Unable to discard the temporary workspace")
    }
  })
}
