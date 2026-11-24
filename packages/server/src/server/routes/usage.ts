import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { ProviderUsageResponse } from "../../api-types"
import { readLocationRef } from "../../opencode/compatibility/location"
import { createNativeCodexUsage } from "../../usage/native-codex"
import { claudeCodeAuthEntry, claudeCodeCredential, type ClaudeCodeHost } from "../../usage/claude-credential"
import { readUsageCredentials } from "../../usage/native-credentials"
import { readUsageProviderSettings } from "../../usage/native-settings"
import { readPluginProviderUsage } from "../../usage/plugin-usage"
import { getProviderUsage, resolveUsageProvider } from "../../usage/service"
import { isOpenCodeFreeModel } from "../../usage/opencode-free-estimate"
import type { OpenCodeFreeUsage } from "../../usage/opencode-free-usage"

const UsageParamsSchema = z.object({ providerId: z.string().trim().min(1) })
const UsageQuerySchema = z.object({
  instanceId: z.string().trim().min(1).max(256), sessionId: z.string().trim().min(1).max(256),
  modelId: z.string().trim().max(256).optional(),
}).strict()

export interface UsageRouteDeps {
  freeUsage: OpenCodeFreeUsage
  workspaceManager: Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "ownsLocation"
    | "getSessionEnvironment" | "getServiceWslDistro" | "getHostPathForServicePath">
}

// opencode-claude and OpenCode's Claude Agent run Claude Code inside the daemon,
// so its login lives on the daemon host (possibly a WSL distro) under that
// host's environment.
async function claudeCodeHost(manager: UsageRouteDeps["workspaceManager"], instanceId: string, signal: AbortSignal): Promise<ClaudeCodeHost> {
  const environment = await manager.getSessionEnvironment(instanceId, signal)
  const wsl = Boolean(manager.getServiceWslDistro(instanceId))
  return {
    environment,
    pathStyle: wsl || process.platform !== "win32" ? "posix" : "win32",
    keychain: !wsl && process.platform === "darwin",
    toHostPath: servicePath => manager.getHostPathForServicePath(instanceId, servicePath),
  }
}

export function registerUsageRoutes(app: FastifyInstance, deps: UsageRouteDeps) {
  const nativeCodexUsage = createNativeCodexUsage()
  const freeUsage = deps.freeUsage
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
      // Google, free-model Console and plugin RPC reads share an entry-time deadline,
      // leaving 3 seconds for publication revalidation.
      const resolvedProvider = resolveUsageProvider(params.data.providerId)
      const quotaController = !resolvedProvider || resolvedProvider.id === "google" ||
        isOpenCodeFreeModel(params.data.providerId, modelId) ? new AbortController() : null
      const quotaTimeout = quotaController ? setTimeout(() => quotaController.abort(), 12_000) : undefined
      const quotaSignal = quotaController ? AbortSignal.any([signal, quotaController.signal]) : signal
      let consoleTimeout: ((publicationSignal: AbortSignal) => Promise<unknown>) | undefined
      try {
        return await boundedRead(async () => {
          const connection = await manager.getSharedServiceConnection(instanceId)
          signal.throwIfAborted()
          if (!connection) return reply.code(503).send({ error: "Provider usage unavailable" })
          connection.assertCurrent()
          signal.throwIfAborted()
          const session = await connection.client.session.get({ sessionID: sessionId }, { signal })
          const location = readLocationRef(session.location)
          const owned = manager.get(instanceId) === workspace && location.workspaceID === undefined
            && await manager.ownsLocation(instanceId, location, connection.client)
          signal.throwIfAborted()
          if (!owned || manager.get(instanceId) !== workspace) {
            return reply.code(403).send({ error: "Session does not belong to workspace" })
          }
          signal.throwIfAborted()
          connection.assertCurrent()
          const free = isOpenCodeFreeModel(params.data.providerId, modelId)
          const provider = free ? null : resolveUsageProvider(params.data.providerId)
          const native = free ? await freeUsage.read(connection, params.data.providerId, modelId, signal, quotaSignal)
            : !provider || provider.id === "codex"
            ? await nativeCodexUsage(connection, { instanceId, sessionId, directory: location.directory,
              providerId: params.data.providerId, modelId }, signal)
            : null
          let plugin: ProviderUsageResponse | null = null
          if (!native && !provider) {
            signal.throwIfAborted()
            connection.assertCurrent()
            if (manager.get(instanceId) !== workspace) {
              return reply.code(403).send({ error: "Session does not belong to workspace" })
            }
            // Re-verify Location ownership and session placement after the alias probe
            // so a moved session or evicted workspace never dispatches a plugin RPC.
            const stillOwned = await manager.ownsLocation(instanceId, location, connection.client)
            signal.throwIfAborted()
            connection.assertCurrent()
            if (!stillOwned || manager.get(instanceId) !== workspace) {
              return reply.code(403).send({ error: "Session does not belong to workspace" })
            }
            const beforePlugin = await connection.client.session.get({ sessionID: sessionId }, { signal })
            const beforeLocation = readLocationRef(beforePlugin.location)
            signal.throwIfAborted()
            connection.assertCurrent()
            if (manager.get(instanceId) !== workspace || beforeLocation.directory !== location.directory
              || beforeLocation.workspaceID !== undefined) {
              return reply.code(403).send({ error: "Session does not belong to workspace" })
            }
            plugin = await readPluginProviderUsage(connection, {
              providerId: params.data.providerId, location, modelId,
            }, signal, quotaSignal)
          }
          const auth = !native && !plugin && provider ? await readUsageCredentials(connection, signal) : {}
          const settings = !native && !plugin && provider && provider.id !== "google" && provider.id !== "opencode-console"
            ? await readUsageProviderSettings(connection, params.data.providerId, location.directory, signal) : undefined
          signal.throwIfAborted()
          if (provider?.id === "opencode-go") {
            // Go quota follows the Go session provider's own native login.
            const info = settings?.provider
            const integrationID = info && (info.id === "opencode-go" || info.canonical === "opencode-go")
              ? info.integrationID ?? info.id : undefined
            for (const alias of ["opencode-go", "opencode"]) if (alias !== integrationID) delete auth[alias]
            signal.throwIfAborted()
          }
          if (provider?.id === "claude-code") {
            // Every provider ID resolving to the Claude Code reader (`claude-code`,
            // `claude-agent`) gets the host login, replacing any native entry.
            auth["claude-code"] = claudeCodeAuthEntry(await claudeCodeCredential(await claudeCodeHost(manager, instanceId, signal), signal))
            signal.throwIfAborted()
          }
          const publish = async (usage: ProviderUsageResponse, signal: AbortSignal) => {
            // Session movement, workspace eviction and reconnect fence publication too.
            // Check Location ownership first, then re-read the session last so neither
            // a move nor an eviction while ownsLocation awaits can publish stale quota.
            const stillOwned = await manager.ownsLocation(instanceId, location, connection.client)
            signal.throwIfAborted()
            const current = await connection.client.session.get({ sessionID: sessionId }, { signal })
            const currentLocation = readLocationRef(current.location)
            connection.assertCurrent()
            signal.throwIfAborted()
            if (!stillOwned || manager.get(instanceId) !== workspace || currentLocation.directory !== location.directory
              || currentLocation.workspaceID !== undefined) {
              return reply.code(403).send({ error: "Session does not belong to workspace" })
            }
            signal.throwIfAborted()
            connection.assertCurrent()
            return usage
          }
          if (provider?.id === "opencode-console") consoleTimeout = publicationSignal => publish({
            requestedProviderId: params.data.providerId, providerId: provider.id, providerName: provider.name, modelId,
            supported: true, configured: true, ok: false, windows: {}, fetchedAt: Date.now(),
            unavailableReason: "opencode-console-network-error",
          }, publicationSignal)
          const usage = native ?? plugin ?? await getProviderUsage(params.data.providerId, { modelId, auth,
            context: { ...settings?.context, signal: quotaSignal } })
          consoleTimeout = undefined
          return publish(usage, signal)
        }, signal)
      } catch (error) {
        if (consoleTimeout && (signal.aborted || error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
          // Only the caller's wait ended. Keep the shared read alive and give
          // publication its own bounded ownership revalidation before reporting it.
          const publicationSignal = AbortSignal.timeout(15_000)
          try { return await boundedRead(() => consoleTimeout!(publicationSignal), publicationSignal) }
          catch (publicationError) { error = publicationError }
        }
        // Do not serialize/log SDK errors: credential exports and request bodies
        // are server-only, and arbitrary upstream errors can contain secrets.
        const missing = error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError"
        return reply.code(missing ? 404 : 503).send({ error: missing ? "Session not found" : "Provider usage unavailable" })
      } finally {
        clearTimeout(quotaTimeout)
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
