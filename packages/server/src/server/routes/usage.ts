import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { ProviderUsageResponse } from "../../api-types"
import { readLocationRef } from "../../opencode/compatibility/location"
import { createNativeCodexUsage } from "../../usage/native-codex"
import { claudeCodeAuthEntry, claudeCodeCredential, type ClaudeCodeHost } from "../../usage/claude-credential"
import { readUsageCredentials } from "../../usage/native-credentials"
import { readUsageProviderSettings } from "../../usage/native-settings"
import { pluginUsageRpcId, readPluginProviderUsage, unavailable as pluginUsageUnavailable } from "../../usage/plugin-usage"
import { getProviderUsage, resolveUsageProvider } from "../../usage/service"
import { requestAdmission } from "../request-admission"
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
      // A plugin RPC runs plugin code: stop it once the client has gone.
      const pluginPhase = !resolvedProvider && !isOpenCodeFreeModel(params.data.providerId, modelId)
        && pluginUsageRpcId(params.data.providerId) !== null
      const admission = pluginPhase ? requestAdmission(request, reply) : null
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
          const assertCurrentWorkspace = (sig: AbortSignal): boolean => {
            sig.throwIfAborted()
            connection.assertCurrent()
            return manager.get(instanceId) === workspace
          }
          const verifyOwned = async (sig: AbortSignal): Promise<boolean> => {
            const current = await connection.client.session.get({ sessionID: sessionId }, { signal: sig })
            const currentLocation = readLocationRef(current.location)
            connection.assertCurrent()
            sig.throwIfAborted()
            const stillOwned = manager.get(instanceId) === workspace && currentLocation.directory === location.directory
              && currentLocation.workspaceID === undefined && await manager.ownsLocation(instanceId, currentLocation, connection.client)
            sig.throwIfAborted()
            if (!stillOwned || manager.get(instanceId) !== workspace) return false
            connection.assertCurrent()
            return true
          }
          const free = isOpenCodeFreeModel(params.data.providerId, modelId)
          const provider = free ? null : resolveUsageProvider(params.data.providerId)
          let plugin: ProviderUsageResponse | null = null
          if (pluginPhase) {
            // Plugin code receives the Location: confirm the session did not move during the ownership check.
            // Client disconnect aborts only this phase: the Codex fallback shares one upstream read across clients.
            const rpcSignal = AbortSignal.any([signal, admission!.signal])
            const rpcQuotaSignal = AbortSignal.any([quotaSignal, admission!.signal])
            let confirmed = false
            try {
              const current = readLocationRef((await admission!.wait(
                connection.client.session.get({ sessionID: sessionId }, { signal: rpcQuotaSignal }), rpcQuotaSignal)).location)
              if (current.directory !== location.directory || current.workspaceID !== undefined || !assertCurrentWorkspace(rpcSignal)) {
                return reply.code(403).send({ error: "Session does not belong to workspace" })
              }
              confirmed = true
            } catch (error) {
              rpcSignal.throwIfAborted()
              if (!quotaSignal.aborted) throw error
            }
            // The quota deadline also bounds the re-read; past it, publish an unavailable quota without dispatching.
            plugin = confirmed ? await readPluginProviderUsage(connection, {
              providerId: params.data.providerId, location, modelId,
            }, rpcSignal, rpcQuotaSignal) : pluginUsageUnavailable(params.data.providerId, modelId)
            admission!.dispose()
            if (!plugin && (!await verifyOwned(signal) || !assertCurrentWorkspace(signal))) {
              return reply.code(403).send({ error: "Session does not belong to workspace" })
            }
          }
          const native = free ? await freeUsage.read(connection, params.data.providerId, modelId, signal, quotaSignal)
            : !plugin && (!provider || provider.id === "codex")
            ? await nativeCodexUsage(connection, { instanceId, sessionId, directory: location.directory,
              providerId: params.data.providerId, modelId }, signal)
            : null
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
            if (!await verifyOwned(signal) || !assertCurrentWorkspace(signal)) {
              return reply.code(403).send({ error: "Session does not belong to workspace" })
            }
            return usage
          }
          if (provider?.id === "opencode-console") consoleTimeout = publicationSignal => publish({
            requestedProviderId: params.data.providerId, providerId: provider.id, providerName: provider.name, modelId,
            supported: true, configured: true, ok: false, windows: {}, fetchedAt: Date.now(),
            unavailableReason: "opencode-console-network-error",
          }, publicationSignal)
          const usage = native ?? plugin ?? await getProviderUsage(params.data.providerId, { modelId, auth,
            context: { ...settings?.context, signal: provider ? quotaSignal : signal } })
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
        admission?.dispose()
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
