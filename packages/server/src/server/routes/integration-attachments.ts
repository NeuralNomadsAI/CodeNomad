import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { IntegrationAttachmentError, type IntegrationAttachments } from "../../opencode/integrations/attachments"
import { integrationRpcSchemas } from "../../opencode/integrations/contract"

const Query = z.object({ directory: z.string().min(1).max(32_768).refine(value => value.trim() === value && !/\p{Cc}/u.test(value)) }).strict()
const Params = z.object({ id: z.string().min(1).max(512), integrationId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) }).strict()
const statuses = { invalid: 400, "not-found": 404, forbidden: 403, inactive: 409, unsupported: 409, "non-conforming": 502, unavailable: 503 } as const

export function registerIntegrationAttachmentRoutes(app: FastifyInstance, deps: { attachments: Pick<IntegrationAttachments, "hosts" | "attach" | "detach" | "installHost"> }): void {
  for (const action of ["hosts", "attach", "detach", "install-host"] as const) {
    app.route<{ Params: { id: string; integrationId: string } }>({
      method: action === "hosts" ? "GET" : "POST",
      url: `/api/workspaces/:id/integrations/:integrationId/${action}`,
      handler: async (request, reply) => {
        reply.header("cache-control", "no-store")
        const params = Params.safeParse(request.params), query = Query.safeParse(request.query)
        const body = (action === "attach" ? integrationRpcSchemas["attachHost.input"]
          : action === "detach" ? integrationRpcSchemas["detachHost.input"] : integrationRpcSchemas["hosts.input"]).safeParse(action === "install-host" ? request.body : request.body ?? {})
        if (!params.success || !query.success || !body.success) return reply.code(400).send({ error: "Invalid integration attachment request", code: "invalid" })
        const controller = new AbortController()
        const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
        reply.raw.once("close", abort)
        try {
          const { id, integrationId } = params.data
          if (action === "install-host") return await deps.attachments.installHost(id, integrationId, query.data, controller.signal)
          if (action === "hosts") return await deps.attachments.hosts(id, integrationId, query.data, controller.signal)
          if (action === "attach") return await deps.attachments.attach(id, integrationId, query.data,
            integrationRpcSchemas["attachHost.input"].parse(body.data), controller.signal)
          return await deps.attachments.detach(id, integrationId, query.data,
            integrationRpcSchemas["detachHost.input"].parse(body.data), controller.signal)
        } catch (error) {
          // Native exceptions can contain RPC inputs, paths and credentials: never echo or log them.
          const code = error instanceof IntegrationAttachmentError ? error.code : "unavailable"
          request.log.warn({ code }, "Integration attachment request refused")
          return reply.code(statuses[code]).send({ error: `Integration attachment ${code}`, code })
        } finally { reply.raw.removeListener("close", abort) }
      },
    })
  }
}
