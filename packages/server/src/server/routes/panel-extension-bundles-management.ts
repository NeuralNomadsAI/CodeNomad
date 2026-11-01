import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { BundlesTransport } from "../../panel-extensions/bundles-transport"
import { bundlesMountInputSchema, bundlesManageInputSchema, bundlesControlInputSchema } from "../../panel-extensions/bundles-contract"
import { BundlesStalePlanError } from "../../panel-extensions/bundles-lifecycle"

const id = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{1,39}$/) }).strict()

/** Parent-only HTTP adapter. Author selectors and confirmation display data never enter this surface. */
export function registerPanelExtensionBundlesManagementRoutes(app: FastifyInstance, deps: { transport: BundlesTransport; routeBudgetMs?: number }): void {
  for (const method of ["mount", "manage", "control"] as const) {
    app.post(`/api/panel-extensions/:id/bundles/${method}`, { bodyLimit: 4096 }, async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const abandoned = new AbortController()
      const close = () => { if (!reply.raw.writableFinished) abandoned.abort() }
      reply.raw.once("close", close)
      const signal = AbortSignal.any([abandoned.signal, AbortSignal.timeout(deps.routeBudgetMs ?? 19_000)])
      try {
        const extension = id.parse(request.params).id
        const work = (): Promise<unknown> => {
          switch (method) {
            case "mount": return deps.transport.mount(request, extension, bundlesMountInputSchema.parse(request.body), signal)
            case "manage": return deps.transport.manage(request, extension, bundlesManageInputSchema.parse(request.body), signal)
            case "control": return deps.transport.control(request, extension, bundlesControlInputSchema.parse(request.body), signal)
          }
        }
        return await new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener("abort", abort, { once: true })
          Promise.resolve().then(() => { signal.throwIfAborted(); return work() }).then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort))
        })
      } catch (error) {
        return reply.code(error instanceof z.ZodError ? 400 : error instanceof BundlesStalePlanError ? 409 : 503)
          .send({ error: "Panel extension request unavailable" })
      } finally { reply.raw.off("close", close) }
    })
  }
}
