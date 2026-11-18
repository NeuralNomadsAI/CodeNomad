import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { MemoryContextSchema, MemoryOperationSchema, type MemoryApiError } from "../../memory/api"
import { MemoryError } from "../../memory/model"
import type { MemoryService } from "../../memory/service"

export function memoryErrorReply(reply: FastifyReply, error: unknown) {
  const code = error instanceof MemoryError ? error.code : (error as { code?: string })?.code === "git_required" ? "git_unavailable" : "unreadable"
  const payload: MemoryApiError = { code, error: code === "full" ? "Memory is full. Merge or delete entries before retrying." : `Memory operation failed: ${code}`,
    ...(error instanceof MemoryError && error.titles ? { titles: error.titles } : {}) }
  return reply.code({ disabled: 403, full: 409, conflict: 409, invalid: 400, unreadable: 503, malformed: 422, git_unavailable: 503 }[code]).send(payload)
}

export function registerMemoryRoutes(app: FastifyInstance, memory: MemoryService): void {
  app.get("/api/memory/settings", async (_request, reply) => {
    try { return memory.getSettings() } catch (error) { return memoryErrorReply(reply, error) }
  })
  app.put("/api/memory/settings", async (request, reply) => {
    const body = z.object({ enabled: z.boolean() }).strict().safeParse(request.body)
    if (!body.success) return memoryErrorReply(reply, new MemoryError("invalid", "Invalid memory preference"))
    try { return await memory.setEnabled(body.data.enabled) } catch (error) { return memoryErrorReply(reply, error) }
  })
  app.post("/api/memory", { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const body = z.object({ operation: MemoryOperationSchema, context: MemoryContextSchema.optional() }).strict().safeParse(request.body)
    if (!body.success) return memoryErrorReply(reply, new MemoryError("invalid", "Invalid memory request"))
    try { return await memory.executeUI(body.data.operation, body.data.context) } catch (error) { return memoryErrorReply(reply, error) }
  })
}
