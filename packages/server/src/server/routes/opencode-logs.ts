import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { readOpenCodeLogs } from "../../opencode/logs"

export function registerOpenCodeLogsRoutes(app: FastifyInstance, deps: {
  resolveBinary: () => string
  read?: typeof readOpenCodeLogs
}) {
  app.get("/api/opencode/logs", async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    if (!z.object({}).strict().safeParse(request.query).success) return reply.code(400).send({ error: "invalid_logs_request" })
    try {
      const binary = deps.resolveBinary()
      const result = await (deps.read ?? readOpenCodeLogs)(binary)
      if (binary !== deps.resolveBinary()) return reply.code(409).send({ error: "logs_source_changed" })
      return result
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT"
      return reply.code(missing ? 404 : 502).send({ error: missing ? "opencode_logs_missing" : "opencode_logs_failed" })
    }
  })
}
