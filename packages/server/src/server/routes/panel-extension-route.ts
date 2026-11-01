import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { PanelExtensionStore } from "../../panel-extensions/store"
import type { PanelExtensionPermission } from "../../panel-extensions/contract"
import { PanelExtensionError } from "../../panel-extensions/archive"

const authority = { instanceId: z.string().min(1).max(256), digest: z.string().regex(/^[a-f0-9]{64}$/) }
const idSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{1,39}$/) }).strict()
const ROUTE_BUDGET_MS = 19_000

export class PanelRouteRefused extends Error { constructor(readonly status: number) { super("refused") } }
export interface PanelRouteContext {
  id: string
  signal: AbortSignal
  prompts: boolean
  fence(key: string, check: () => Promise<void>): void
  pin(connection: { assertCurrent(): void }): void
}

/** Settle at cancellation even when an adapter ignores its signal; discard late outcomes. */
function settle<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    work().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/** The shared API 4 envelope: exact consent, cancellation and final authority fences. */
export function createPanelExtensionRoute(app: FastifyInstance, deps: { store: PanelExtensionStore; routeBudgetMs?: number }) {
  return <T extends z.ZodRawShape>(method: string, permission: PanelExtensionPermission | null, shape: T, bodyLimit: number,
    run: (input: z.infer<z.ZodObject<T & typeof authority>>, context: PanelRouteContext) => Promise<unknown>) => {
    const schema = z.object({ ...authority, ...shape }).strict()
    app.post(`/api/panel-extensions/:id/${method}`, { bodyLimit }, async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const abandoned = new AbortController()
      reply.raw.once("close", () => { if (!reply.raw.writableFinished) abandoned.abort(new Error("Request abandoned")) })
      const signal = AbortSignal.any([abandoned.signal, AbortSignal.timeout(deps.routeBudgetMs ?? ROUTE_BUDGET_MS)])
      try {
        const { id } = idSchema.parse(request.params)
        const input = schema.parse(request.body) as z.infer<z.ZodObject<T & typeof authority>> & { instanceId: string; digest: string }
        return await settle(signal, async () => {
          const entry = permission ? await deps.store.authorize(id, input.digest, permission) : undefined
          const prompts = Boolean(entry && (entry.manifest.permissions as readonly string[]).includes("session.images.prompts"))
          const fences = new Map<string, () => Promise<void>>(), pinned = new Set<{ assertCurrent(): void }>()
          const result = await run(input, { id, signal, prompts, fence: (key, check) => { if (!fences.has(key)) fences.set(key, check) },
            pin: connection => { pinned.add(connection) } })
          for (const check of fences.values()) { signal.throwIfAborted(); await check() }
          if (permission) await deps.store.authorize(id, input.digest, permission)
          signal.throwIfAborted()
          for (const connection of pinned) connection.assertCurrent()
          return result
        })
      } catch (error) {
        const code = error instanceof PanelRouteRefused ? error.status : error instanceof z.ZodError ? 400 : error instanceof PanelExtensionError
          ? { missing: 404, disabled: 403, conflict: 409, invalid: 400, limit: 413, unavailable: 503 }[error.code] : 503
        return reply.code(code).send({ error: "Panel extension request unavailable" })
      }
    })
  }
}
