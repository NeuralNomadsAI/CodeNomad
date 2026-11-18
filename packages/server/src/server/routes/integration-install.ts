import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { IntegrationInstallError, type IntegrationInstaller, type IntegrationInstallErrorCode } from "../../opencode/integrations/install"

const Query = z.object({ directory: z.string().min(1).max(32_768).refine(value => value.trim() === value && !/\p{Cc}/u.test(value)) }).strict()
const Params = z.object({ id: z.string().min(1).max(512), integrationId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) }).strict()
// The client names a scope only: never a spec, path or option.
const Body = z.object({ scope: z.enum(["global", "project"]) }).strict()
const statuses: Record<IntegrationInstallErrorCode, number> = {
  invalid: 400, "not-found": 404, forbidden: 403, "global-only": 422, refused: 422,
  duplicate: 409, ambiguous: 409, stale: 409, unavailable: 503, timeout: 503, uncertain: 503,
}

/** `POST /api/workspaces/:id/integrations/:integrationId/install?directory=` (dev-docs/OPENCODE_INTEGRATIONS.md). */
export function registerIntegrationInstallRoutes(app: FastifyInstance, deps: { installer: Pick<IntegrationInstaller, "install"> }): void {
  app.post<{ Params: { id: string; integrationId: string } }>("/api/workspaces/:id/integrations/:integrationId/install", async (request, reply) => {
    reply.header("cache-control", "no-store")
    const params = Params.safeParse(request.params), query = Query.safeParse(request.query), body = Body.safeParse(request.body)
    if (!params.success || !query.success || !body.success) return reply.code(400).send({ error: "Invalid integration install request", code: "invalid" })
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.once("close", abort)
    try {
      return await deps.installer.install(params.data.id, params.data.integrationId, query.data, body.data.scope, controller.signal)
    } catch (error) {
      // Native and document errors can carry paths and specs: only the fixed code is logged or returned.
      const code = error instanceof IntegrationInstallError ? error.code : "unavailable"
      request.log.warn({ code }, "Integration install refused")
      return reply.code(statuses[code]).send({ error: `Integration install ${code}`, code })
    } finally { reply.raw.removeListener("close", abort) }
  })
}
