import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import { readLocationRef } from "../../opencode/compatibility/location"
import { createNativeCodexUsage } from "../../usage/native-codex"
import { getProviderUsage, resolveUsageProvider } from "../../usage/service"

const UsageParamsSchema = z.object({ providerId: z.string().trim().min(1) })
const UsageQuerySchema = z.object({
  instanceId: z.string().trim().min(1).max(256), sessionId: z.string().trim().min(1).max(256),
  modelId: z.string().trim().max(256).optional(),
}).strict()

export interface UsageRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "ownsLocation">
}

export function registerUsageRoutes(app: FastifyInstance, deps: UsageRouteDeps) {
  const nativeCodexUsage = createNativeCodexUsage()
  app.get<{ Params: { providerId: string }; Querystring: z.infer<typeof UsageQuerySchema> }>(
    "/api/usage/:providerId",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const params = UsageParamsSchema.safeParse(request.params)
      const query = UsageQuerySchema.safeParse(request.query ?? {})
      if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid usage request" })
      const { instanceId, sessionId, modelId } = query.data
      const manager = deps.workspaceManager
      const workspace = manager.get(instanceId)
      if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      const signal = controller.signal
      try {
        return await boundedRead(async () => {
          const connection = await manager.getSharedServiceConnection(instanceId)
          signal.throwIfAborted()
          if (!connection) return reply.code(503).send({ error: "Provider usage unavailable" })
          connection.assertCurrent()
          signal.throwIfAborted()
          const session = await connection.client.session.get({ sessionID: sessionId }, { signal })
          const location = readLocationRef(session.location)
          const owned = location.workspaceID === undefined && await manager.ownsLocation(instanceId, location, connection.client)
          signal.throwIfAborted()
          if (!owned) {
            return reply.code(403).send({ error: "Session does not belong to workspace" })
          }
          signal.throwIfAborted()
          connection.assertCurrent()
          const provider = resolveUsageProvider(params.data.providerId)
          const native = !provider || provider.id === "codex"
            ? await nativeCodexUsage(connection, { instanceId, sessionId, directory: location.directory,
              providerId: params.data.providerId, modelId }, signal)
            : null
          const usage = native ?? await getProviderUsage(params.data.providerId, { modelId })
          // Session movement, workspace eviction and reconnect fence publication too.
          const current = await connection.client.session.get({ sessionID: sessionId }, { signal })
          const currentLocation = readLocationRef(current.location)
          connection.assertCurrent()
          signal.throwIfAborted()
          const stillOwned = manager.get(instanceId) === workspace && currentLocation.directory === location.directory
            && currentLocation.workspaceID === undefined && await manager.ownsLocation(instanceId, currentLocation, connection.client)
          signal.throwIfAborted()
          if (!stillOwned) {
            return reply.code(403).send({ error: "Session does not belong to workspace" })
          }
          signal.throwIfAborted()
          connection.assertCurrent()
          return usage
        }, signal)
      } catch (error) {
        // Do not serialize/log SDK errors: credential exports and request bodies
        // are server-only, and arbitrary upstream errors can contain secrets.
        const missing = error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError"
        return reply.code(missing ? 404 : 503).send({ error: missing ? "Session not found" : "Provider usage unavailable" })
      } finally {
        clearTimeout(timeout)
      }
    },
  )
}

async function boundedRead<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Provider usage timed out"))
    signal.addEventListener("abort", abort, { once: true })
  })
  try { return await Promise.race([operation(), aborted]) }
  finally { signal.removeEventListener("abort", abort) }
}
