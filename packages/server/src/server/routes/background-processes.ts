import { FastifyInstance } from "fastify"
import { z } from "zod"
import type { BackgroundProcessManager } from "../../background-processes/manager"

interface RouteDeps {
  backgroundProcessManager: BackgroundProcessManager
}

const StartSchema = z.object({
  title: z.string().trim().min(1),
  command: z.string().trim().min(1),
})

const OutputQuerySchema = z.object({
  method: z.enum(["full", "tail", "head", "grep"]).optional(),
  mode: z.enum(["full", "tail", "head", "grep"]).optional(),
  pattern: z.string().optional(),
  lines: z.coerce.number().int().positive().max(2000).optional(),
  maxBytes: z.coerce.number().int().positive().optional(),
})

export function registerBackgroundProcessRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get<{ Params: { id: string } }>("/workspaces/:id/plugin/background-processes", async (request) => {
    const processes = await deps.backgroundProcessManager.list(request.params.id)
    return { processes }
  })

  app.post<{ Params: { id: string } }>("/workspaces/:id/plugin/background-processes", async (request, reply) => {
    const payload = StartSchema.parse(request.body ?? {})
    const process = await deps.backgroundProcessManager.start(request.params.id, payload.title, payload.command)
    reply.code(201)
    return process
  })

  app.post<{ Params: { id: string; processId: string } }>(
    "/workspaces/:id/plugin/background-processes/:processId/stop",
    async (request, reply) => {
      const process = await deps.backgroundProcessManager.stop(request.params.id, request.params.processId)
      if (!process) {
        reply.code(404)
        return { error: "Process not found" }
      }
      return process
    },
  )

  app.post<{ Params: { id: string; processId: string } }>(
    "/workspaces/:id/plugin/background-processes/:processId/terminate",
    async (request, reply) => {
      await deps.backgroundProcessManager.terminate(request.params.id, request.params.processId)
      reply.code(204)
      return undefined
    },
  )

  app.get<{ Params: { id: string; processId: string } }>(
    "/workspaces/:id/plugin/background-processes/:processId/output",
    async (request, reply) => {
      const query = OutputQuerySchema.parse(request.query ?? {})
      const method = query.method ?? query.mode
      if (method === "grep" && !query.pattern) {
        reply.code(400)
        return { error: "Pattern is required for grep output" }
      }
      try {
        return await deps.backgroundProcessManager.readOutput(request.params.id, request.params.processId, {
          method,
          pattern: query.pattern,
          lines: query.lines,
          maxBytes: query.maxBytes,
        })
      } catch (error) {
        reply.code(400)
        return { error: error instanceof Error ? error.message : "Invalid output request" }
      }
    },
  )

  app.get<{ Params: { id: string; processId: string } }>(
    "/workspaces/:id/plugin/background-processes/:processId/stream",
    async (request, reply) => {
      await deps.backgroundProcessManager.streamOutput(request.params.id, request.params.processId, reply)
    },
  )
}
