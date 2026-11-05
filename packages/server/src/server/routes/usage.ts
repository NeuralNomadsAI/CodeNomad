import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import { readLocationRef } from "../../opencode/compatibility/location"
import { createNativeCodexUsage } from "../../usage/native-codex"
import { claudeCodeAuthEntry, claudeCodeCredential, type ClaudeCodeHost } from "../../usage/claude-credential"
import { readUsageCredentials } from "../../usage/native-credentials"
import { getProviderUsage, resolveUsageProvider } from "../../usage/service"
import { estimateOpenCodeFreeUsage, isOpenCodeFreeModel, openCodeFreeWindow } from "../../usage/opencode-free-estimate"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { WorkspaceCapabilityError } from "../../opencode/servers/capabilities"
import { readJson } from "../../opencode/servers/remote-workspace"
import type { ProviderUsageResponse } from "../../api-types"

const UsageParamsSchema = z.object({ providerId: z.string().trim().min(1) })
const UsageQuerySchema = z.object({
  instanceId: z.string().trim().min(1).max(256), sessionId: z.string().trim().min(1).max(256),
  modelId: z.string().trim().max(256).optional(),
}).strict()

export interface UsageRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "ownsLocation"
    | "getSessionEnvironment" | "getServiceWslDistro" | "getHostPathForServicePath" | "requireWorkspaceCapability">
    & Partial<Pick<WorkspaceManager, "isExplicitWorkspace">>
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
  app.get<{ Params: { providerId: string }; Querystring: z.infer<typeof UsageQuerySchema> }>(
    "/api/usage/:providerId",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const params = UsageParamsSchema.safeParse(request.params)
      const query = UsageQuerySchema.safeParse(request.query ?? {})
      if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid usage request" })
      const { instanceId, sessionId, modelId } = query.data
      const manager = deps.workspaceManager
      try { manager.requireWorkspaceCapability(instanceId, "providerUsage") }
      catch (error) {
        if (error instanceof WorkspaceCapabilityError) return reply.code(403).send({ error: error.code, code: error.code, capability: error.capability, reason: error.reason })
        throw error
      }
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
          const free = isOpenCodeFreeModel(params.data.providerId, modelId)
          // prototype-1236: an explicit server publishes only its own quotas; its credentials are never read.
          if (manager.isExplicitWorkspace?.(instanceId)) {
            const usage = free ? await openCodeFreeUsage(connection, params.data.providerId, modelId, signal)
              : await publishedServerUsage(connection, params.data.providerId, location.directory, modelId, signal)
            const current = await connection.client.session.get({ sessionID: sessionId }, { signal })
            connection.assertCurrent()
            signal.throwIfAborted()
            // Explicit descriptors are fresh snapshots; their frozen binding is the occurrence identity.
            if (manager.get(instanceId)?.binding !== workspace.binding || readLocationRef(current.location).directory !== location.directory
              || !await manager.ownsLocation(instanceId, readLocationRef(current.location), connection.client)) {
              return reply.code(403).send({ error: "Session does not belong to workspace" })
            }
            return usage
          }
          const provider = free ? null : resolveUsageProvider(params.data.providerId)
          const native = free ? await openCodeFreeUsage(connection, params.data.providerId, modelId, signal)
            : !provider || provider.id === "codex"
            ? await nativeCodexUsage(connection, { instanceId, sessionId, directory: location.directory,
              providerId: params.data.providerId, modelId }, signal)
            : null
          const auth = !native && provider ? await readUsageCredentials(connection, signal) : {}
          signal.throwIfAborted()
          if (provider?.id === "opencode-go") {
            // Go quota follows the session provider's own login (a Go key or the
            // Console sign-in), and only for the Go provider: pay-as-you-go Zen
            // sessions keep the env-cookie behaviour and never send Console
            // credentials to the Go usage endpoint.
            const integrationID = await connection.client.provider.get({ providerID: params.data.providerId, location: { directory: location.directory } }, { signal })
              .then(info => info.location.directory === location.directory && info.data.id === params.data.providerId
                && (info.data.id === "opencode-go" || info.data.canonical === "opencode-go")
                ? info.data.integrationID ?? info.data.id : undefined, () => undefined)
            for (const alias of ["opencode-go", "opencode"]) if (alias !== integrationID) delete auth[alias]
            signal.throwIfAborted()
          }
          if (provider?.id === "claude-code") {
            // Every provider ID resolving to the Claude Code reader (`claude-code`,
            // `claude-agent`) gets the host login, replacing any native entry.
            auth["claude-code"] = claudeCodeAuthEntry(await claudeCodeCredential(await claudeCodeHost(manager, instanceId, signal), signal))
            signal.throwIfAborted()
          }
          const usage = native ?? await getProviderUsage(params.data.providerId, { modelId, auth })
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

// prototype-1236: OpenCode Go meters the server publishes for its Console workspace; nothing else is supported.
async function publishedServerUsage(connection: ServiceConnection, providerId: string, directory: string, modelId: string | undefined, signal: AbortSignal): Promise<ProviderUsageResponse> {
  const base = { requestedProviderId: providerId, providerId: null, providerName: providerId, ...(modelId ? { modelId } : {}), windows: {}, fetchedAt: Date.now() }
  const provider = resolveUsageProvider(providerId)
  if (provider?.id !== "opencode-go") return { ...base, supported: false, configured: false, ok: false }
  const named = { ...base, providerId: provider.id, providerName: provider.name }
  const limits = await readJson(connection, "/api/experimental/usage/limits", {}, directory, signal).catch(() => undefined)
  if (!limits) return { ...named, supported: true, configured: true, ok: false }
  const go = limits.data?.go
  if (!go) return { ...named, supported: true, configured: false, ok: false }
  const windows: ProviderUsageResponse["windows"] = {}
  for (const [label, seconds, meter] of [["5h", 18_000, go.rolling], ["weekly", 604_800, go.weekly], ["monthly", 2_592_000, go.monthly]] as const) {
    if (!meter || typeof meter.percent !== "number") continue
    const used = meter.limited ? 100 : Math.max(0, Math.min(100, meter.percent))
    windows[label] = { usedPercent: used, remainingPercent: 100 - used, windowSeconds: seconds, resetAt: Number.isFinite(meter.resetsAt) ? meter.resetsAt : null }
  }
  return { ...named, supported: true, configured: true, ok: Object.keys(windows).length > 0, windows }
}

async function openCodeFreeUsage(connection: ServiceConnection, providerId: string, modelId: string | undefined, signal: AbortSignal) {
  const now = Date.now(), { from, to } = openCodeFreeWindow(now)
  const stats = to === from ? { models: [] } : await connection.client.session.stats({ from, to, timezone: "UTC", tools: "none" }, { signal })
  return estimateOpenCodeFreeUsage(stats, providerId, modelId, now)
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
