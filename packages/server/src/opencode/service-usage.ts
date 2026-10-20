import type { WorkspaceManager } from "../workspaces/manager"
import { PluginControlsError } from "./plugin-controls"
import { createHash } from "node:crypto"
import path from "node:path"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { SettingsService } from "../settings/service"
import { ServiceUsageCache } from "./service-usage-cache"

type Manager = Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "getServiceWslDistro" | "getServicePathStyle">
export type UsageQuery = { from: number; to: number; timezone: string }

// Deliberately service-wide, as authorized for the Usage Preferences surface.
// Native project IDs can span independent clones and are not physical Git-family
// authority. Never present this opaque aggregate as workspace/directory-scoped.
export class ServiceUsage {
  private readonly cache?: ServiceUsageCache
  private readonly identities = new WeakMap<ServiceConnection, Promise<string>>()
  constructor(private readonly manager: Manager, settings?: Pick<SettingsService, "getOwner" | "mergePatchOwner">) {
    if (settings) this.cache = new ServiceUsageCache(settings)
  }
  private async context(workspaceId: string) {
    const record = this.manager.get(workspaceId)
    if (!record) throw new PluginControlsError("Workspace not found", "not-found")
    const connection = await this.manager.getSharedServiceConnection(workspaceId)
    if (!connection) throw new PluginControlsError("OpenCode connection unavailable", "unavailable")
    connection.assertCurrent()
    const current = () => {
      connection.assertCurrent()
      if (this.manager.get(workspaceId) !== record) throw new PluginControlsError("Workspace connection changed", "forbidden")
    }
    return { record, connection, current }
  }
  private async identity(workspaceId: string, connection: ServiceConnection, folder: string) {
    let identity = this.identities.get(connection)
    if (!identity) {
      const style = this.manager.getServicePathStyle(workspaceId)
      if (!style) throw new PluginControlsError("Workspace execution identity unavailable", "unavailable")
      const paths = style === "win32" ? path.win32 : path.posix
      const host = this.manager.getServiceWslDistro(workspaceId)?.toLowerCase() ?? `host:${process.platform}`
      identity = connection.client.config.get(undefined, { signal: AbortSignal.timeout(10_000) }).then(entries => {
        connection.assertCurrent()
        const root = entries.find(value => value.type === "directory")?.path
        if (!root || !paths.isAbsolute(root) || root.includes("\0")) throw new Error("Missing native discovery identity")
        const normalized = paths.normalize(root)
        // Same authenticated-channel scoping as permission receipts. Only a digest
        // survives; never store/expose credentials, transient workspace IDs or PIDs.
        const auth = connection.endpoint.auth
        return createHash("sha256").update(JSON.stringify([host, style === "win32" ? normalized.toLowerCase() : normalized,
          auth ? [auth.type, auth.username, auth.password] : connection.endpoint.url])).digest("hex")
      })
      this.identities.set(connection, identity)
      void identity.catch(() => this.identities.delete(connection))
    }
    // Keep different opened Locations separate even though each result explicitly aggregates the service.
    return createHash("sha256").update(JSON.stringify([await identity, folder])).digest("hex")
  }
  async cached(workspaceId: string, timezone: string, days?: number) {
    const { connection, record, current } = await this.context(workspaceId)
    const identity = this.cache ? await this.identity(workspaceId, connection, record.path) : ""
    current()
    return this.cache?.get(identity, timezone, days) ?? { days: days ?? 30, snapshot: undefined }
  }
  async read(workspaceId: string, query: UsageQuery) {
    const { connection, record, current } = await this.context(workspaceId)
    let identity = ""
    try { if (this.cache) identity = await this.identity(workspaceId, connection, record.path) }
    catch { /* Optional display restoration must not add a requirement to native Stats. */ }
    current()
    const stats = await connection.client.session.stats({ from: query.from, to: query.to, timezone: query.timezone, tools: "none" })
    current()
    const snapshot = { scope: "service" as const, stats }
    if (identity) {
      try { this.cache?.set(identity, query.timezone, (query.to - query.from) / 86_400_000, snapshot) }
      catch { /* SettingsService logs persistence failures; keep the successful native display. */ }
    }
    return snapshot
  }
}
