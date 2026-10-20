import type { WorkspaceManager } from "../workspaces/manager"
import { PluginControlsError } from "./plugin-controls"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { SettingsService } from "../settings/service"
import { ServiceUsageCache } from "./service-usage-cache"

type Manager = Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "getServiceWslDistro" | "getServicePathStyle">
export type UsageQuery = { from: number; to: number; timezone: string; restorePeriod?: boolean }

// Deliberately service-wide, as authorized for the Usage Preferences surface.
// Native project IDs can span independent clones and are not physical Git-family
// authority. Never present this opaque aggregate as workspace/directory-scoped.
export class ServiceUsage {
  private readonly cache?: ServiceUsageCache
  private readonly identities = new WeakMap<ServiceConnection, { promise: Promise<string>; value?: string }>()
  private readonly connections = new WeakMap<ServiceConnection, string>()
  private readonly closing = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly admissions = new Map<string, number>()
  private sequence = 0
  private retiredThrough = 0
  async close() {
    this.closing.abort()
    await Promise.allSettled([...this.pending])
  }
  constructor(private readonly manager: Manager, settings?: Pick<SettingsService, "getOwner" | "mergePatchOwner">) {
    if (settings) this.cache = new ServiceUsageCache(settings)
  }
  private async context(workspaceId: string) {
    if (this.closing.signal.aborted) throw new PluginControlsError("Stats service closed", "unavailable")
    const record = this.manager.get(workspaceId)
    if (!record) throw new PluginControlsError("Workspace not found", "not-found")
    const connection = await this.manager.getSharedServiceConnection(workspaceId)
    if (!connection) throw new PluginControlsError("OpenCode connection unavailable", "unavailable")
    connection.assertCurrent()
    const current = () => {
      if (this.closing.signal.aborted) throw new PluginControlsError("Stats service closed", "unavailable")
      connection.assertCurrent()
      if (this.manager.get(workspaceId) !== record) throw new PluginControlsError("Workspace connection changed", "forbidden")
    }
    return { record, connection, current }
  }
  private ownerKey(workspaceId: string, connection: ServiceConnection, folder: string) {
    const auth = connection.endpoint.auth
    return createHash("sha256").update(JSON.stringify([this.manager.getServicePathStyle(workspaceId),
      this.manager.getServiceWslDistro(workspaceId)?.toLowerCase() ?? `host:${process.platform}`, folder,
      auth ? [auth.type, auth.username, auth.password] : connection.endpoint.url])).digest("hex")
  }
  private connectionKey(connection: ServiceConnection) {
    let key = this.connections.get(connection)
    if (!key) this.connections.set(connection, key = randomUUID())
    return key
  }
  async owner(workspaceId: string) {
    const { connection, record, current } = await this.context(workspaceId)
    current()
    return { owner: this.ownerKey(workspaceId, connection, record.path), identity: this.knownIdentity(connection, record.path), connection: this.connectionKey(connection) }
  }
  private knownIdentity(connection: ServiceConnection, folder: string) {
    const value = this.identities.get(connection)?.value
    return value ? createHash("sha256").update(JSON.stringify([value, folder])).digest("hex") : undefined
  }
  private async identity(workspaceId: string, connection: ServiceConnection, folder: string) {
    let identity = this.identities.get(connection)
    if (!identity) {
      const style = this.manager.getServicePathStyle(workspaceId)
      if (!style) throw new PluginControlsError("Workspace execution identity unavailable", "unavailable")
      const paths = style === "win32" ? path.win32 : path.posix
      const host = this.manager.getServiceWslDistro(workspaceId)?.toLowerCase() ?? `host:${process.platform}`
      const signal = AbortSignal.any([this.closing.signal, AbortSignal.timeout(10_000)])
      signal.throwIfAborted()
      let cancel!: () => void
      const aborted = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason)
        signal.addEventListener("abort", cancel, { once: true })
      })
      const lookup = Promise.race([Promise.resolve().then(() => connection.client.config.get(undefined, { signal })), aborted]).then(entries => {
        connection.assertCurrent()
        const root = entries.find(value => value.type === "directory")?.path
        if (!root || !paths.isAbsolute(root) || root.includes("\0")) throw new Error("Missing native discovery identity")
        const normalized = paths.normalize(root)
        // Same authenticated-channel scoping as permission receipts. Only a digest
        // survives; never store/expose credentials, transient workspace IDs or PIDs.
        const auth = connection.endpoint.auth
        return createHash("sha256").update(JSON.stringify([host, style === "win32" ? normalized.toLowerCase() : normalized,
          auth ? [auth.type, auth.username, auth.password] : connection.endpoint.url])).digest("hex")
      }).finally(() => signal.removeEventListener("abort", cancel))
      identity = { promise: lookup }
      this.identities.set(connection, identity)
      const captured = identity
      void lookup.then(value => { captured.value = value }, () => this.identities.delete(connection))
    }
    // Keep different opened Locations separate even though each result explicitly aggregates the service.
    return createHash("sha256").update(JSON.stringify([await identity.promise, folder])).digest("hex")
  }
  async cached(workspaceId: string, timezone: string, days?: number) {
    const { connection, record, current } = await this.context(workspaceId)
    const identity = this.cache ? await this.identity(workspaceId, connection, record.path) : ""
    current()
    const owner = this.ownerKey(workspaceId, connection, record.path)
    const saved = this.cache?.get(identity, timezone, days, owner) ?? { days: days ?? 30, snapshot: undefined }
    const source = this.connectionKey(connection)
    return { ...saved, owner, identity, connection: source, snapshot: saved.snapshot ? { ...saved.snapshot, owner, identity, connection: source } : undefined }
  }
  async read(workspaceId: string, query: UsageQuery) {
    // Backend receipt order, assigned before any asynchronous connection lookup.
    // The latest authorized admission wins across windows, never client clocks.
    const order = ++this.sequence
    const { connection, record, current } = await this.context(workspaceId)
    current()
    const owner = this.cache ? this.ownerKey(workspaceId, connection, record.path) : undefined
    let from = query.from
    try { if (owner && query.restorePeriod) from = query.to - this.cache!.period(owner, query.timezone) * 86_400_000 }
    catch { /* Optional saved period is not a prerequisite for aggregation. */ }
    if (from < 0) throw new PluginControlsError("Restored Stats range starts before the supported epoch", "invalid")
    const native = connection.client.session.stats({ from, to: query.to, timezone: query.timezone, tools: "none" })
    const key = JSON.stringify([owner, query.timezone]), days = (query.to - from) / 86_400_000
    const latest = () => order > this.retiredThrough && this.admissions.get(key) === order
    if (order > this.retiredThrough && order > (this.admissions.get(key) ?? 0)) {
      this.admissions.delete(key); this.admissions.set(key, order)
      if (this.admissions.size > 64) {
        const oldest = this.admissions.entries().next().value!
        this.retiredThrough = Math.max(this.retiredThrough, oldest[1]); this.admissions.delete(oldest[0])
      }
      try { if (owner) this.cache?.select(owner, query.timezone, days) }
      catch { /* SettingsService logs optional display-state persistence failures. */ }
    }
    const stats = await native
    current()
    const snapshot = { scope: "service" as const, stats, owner, identity: this.knownIdentity(connection, record.path), connection: this.connectionKey(connection) }
    if (this.cache && latest() && this.pending.size < 32) {
      // Native totals return independently. Discovery has its existing bounded
      // deadline, shutdown cancellation and late connection/admission fences.
      const save = this.identity(workspaceId, connection, record.path).then(identity => {
        current()
        if (latest()) this.cache?.set(identity, query.timezone, days, snapshot)
      }).catch(() => {}).finally(() => this.pending.delete(save))
      this.pending.add(save)
    }
    return snapshot
  }
}
