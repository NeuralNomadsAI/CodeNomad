import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import type { EventBus } from "../events/bus"
import type { SettingsService } from "../settings/service"
import type { WorkspaceManager } from "../workspaces/manager"
import { MemoryContextSchema, MemoryOperationSchema, type MemoryContext, type MemoryOperation, type MemoryResult, type MemorySettings } from "./api"
import { lockMemoryRepository } from "./lock"
import { MemoryError, type MemoryEntry } from "./model"
import { resolveMemoryProjectIdentity, type MemoryProjectTarget } from "./project-identity"
import { decideMemorySave, memoryForAgent, reviewMemoryEntry } from "./rules"
import type { MemoryNamespace, MemoryStore } from "./store"
import type { MemoryTitles } from "../workspaces/session-memory-context"

const memoryRevision = (entry: MemoryEntry): string => createHash("sha256").update(JSON.stringify([
  entry.id, entry.title, entry.type, entry.text, entry.createdAt, entry.updatedAt, entry.sessionId,
])).digest("hex")
const versioned = (entry: MemoryEntry) => ({ id: entry.id, title: entry.title, type: entry.type, text: entry.text,
  createdAt: entry.createdAt, updatedAt: entry.updatedAt, sessionId: entry.sessionId, revision: memoryRevision(entry) })
const reviewed = (entry: MemoryEntry) => {
  const result = reviewMemoryEntry(entry)
  return { ...versioned(entry), flagged: result.flagged, ...(result.flagged ? { warning: "suspected_injection" as const } : {}) }
}

export class MemoryService {
  constructor(private readonly store: MemoryStore,
    private readonly settings: Pick<SettingsService, "getRawConfigOwner" | "mergePatchOwner">,
    private readonly manager: Pick<WorkspaceManager, "get" | "list" | "getSharedServiceClient" | "getServiceDirectoryForPath" | "getServiceWslDistro">,
    private readonly events: Pick<EventBus, "publish">,
    private readonly projectIdentity = resolveMemoryProjectIdentity) {}

  getSettings(): MemorySettings {
    try {
      const value = this.settings.getRawConfigOwner("server").memoryEnabled
      if (value !== undefined && typeof value !== "boolean") throw new Error("Invalid preference")
      return { enabled: value === true }
    } catch { throw new MemoryError("unreadable", "Memory preference is unavailable") }
  }

  /** All HTTP config writers share the repository lock with memory mutations. */
  async withSettingsLock<T>(action: () => T | Promise<T>): Promise<T> {
    try { await mkdir(this.store.configBaseDir, { recursive: true, mode: 0o700 }) }
    catch { throw new MemoryError("unreadable", "Memory configuration is unavailable") }
    const release = await lockMemoryRepository(this.store.directory)
    try {
      this.settings.getRawConfigOwner("server")
      return await action()
    } finally { await release() }
  }

  async setEnabled(enabled: boolean): Promise<MemorySettings> {
    return this.withSettingsLock(() => {
      this.settings.mergePatchOwner("config", "server", { memoryEnabled: enabled })
      this.invalidate()
      return this.getSettings()
    })
  }

  private async uiTarget(context?: MemoryContext): Promise<MemoryProjectTarget> {
    const parsed = MemoryContextSchema.safeParse(context)
    if (!parsed.success) throw new MemoryError("invalid", "An authorized project context is required")
    const workspace = this.manager.get(parsed.data.workspaceId)
    if (!workspace) throw new MemoryError("invalid", "Project is unavailable")
    const directory = await this.manager.getServiceDirectoryForPath(workspace.id, parsed.data.directory ?? workspace.path)
    if (!directory || !this.manager.get(workspace.id)) throw new MemoryError("invalid", "Project location is not owned")
    return { directory, distro: this.manager.getServiceWslDistro(workspace.id) }
  }

  private async sessionTarget(sessionID: string): Promise<MemoryProjectTarget> {
    if (!sessionID || sessionID.length > 200) throw new MemoryError("invalid", "Invalid session")
    const client = await this.manager.getSharedServiceClient()
    const { location } = await client.session.get({ sessionID }, { signal: AbortSignal.timeout(15_000) })
    if (!location || "workspaceID" in location) throw new MemoryError("invalid", "Session location is not owned")
    // One verified workspace establishes this backend's claim; unrelated inventories may be cold.
    try {
      return await Promise.any(this.manager.list().map(async workspace => {
        const directory = await this.manager.getServiceDirectoryForPath(workspace.id, location.directory)
        if (!directory || !this.manager.get(workspace.id)) throw new Error("Not an owner")
        return { directory, distro: this.manager.getServiceWslDistro(workspace.id) }
      }))
    } catch { throw new MemoryError("invalid", "Session location is not owned") }
  }

  async probe(sessionID: string): Promise<void> { await this.sessionTarget(sessionID) }

  async sessionTitles(sessionID: string): Promise<MemoryTitles | null> {
    const target = await this.sessionTarget(sessionID)
    if (!this.getSettings().enabled) return null
    const scopes: MemoryTitles = {}
    let projectId: string | undefined
    await Promise.all((["global", "project"] as const).map(async scope => {
      try {
        const namespace: MemoryNamespace = scope === "global" ? { scope }
          : { scope, projectId: (await this.projectIdentity(target)).id }
        if (namespace.scope === "project") projectId = namespace.projectId
        scopes[scope] = (await this.store.list(namespace)).map(({ title, type }) => ({ title, type }))
      } catch { /* An unreadable scope stays absent, rather than looking empty. */ }
    }))
    // Revalidate ownership and the current preference after storage awaits.
    const current = await this.sessionTarget(sessionID)
    if (JSON.stringify(current) !== JSON.stringify(target)) throw new MemoryError("conflict", "Memory session moved")
    if (projectId !== undefined && (await this.projectIdentity(current)).id !== projectId)
      throw new MemoryError("conflict", "Memory project changed")
    if (JSON.stringify(await this.sessionTarget(sessionID)) !== JSON.stringify(target)) throw new MemoryError("conflict", "Memory session moved")
    return this.getSettings().enabled ? scopes : null
  }

  async executeAgent(sessionID: string, input: unknown): Promise<MemoryResult> {
    return this.execute(input, () => this.sessionTarget(sessionID), sessionID)
  }

  async executeUI(input: unknown, context?: MemoryContext): Promise<MemoryResult> {
    const operation = MemoryOperationSchema.safeParse(input)
    const cleanupTarget = context && operation.success && operation.data.action === "list" ? await this.uiTarget(context) : undefined
    const result = await this.execute(input, () => this.uiTarget(context))
    if (cleanupTarget) {
      if (JSON.stringify(await this.uiTarget(context)) !== JSON.stringify(cleanupTarget))
        throw new MemoryError("conflict", "Memory project changed")
      return { ...result, cleanupDirectory: cleanupTarget.directory }
    }
    return result
  }

  private async namespace(operation: MemoryOperation, target: () => Promise<MemoryProjectTarget>, agent: boolean): Promise<MemoryNamespace> {
    // Even global agent calls must have a current native owner.
    const authorized = agent || operation.scope === "project" ? await target() : undefined
    if (operation.scope === "global") return { scope: "global" }
    const projectId = (await this.projectIdentity(authorized!)).id
    if (JSON.stringify(await target()) !== JSON.stringify(authorized)) throw new MemoryError("conflict", "Memory project changed")
    return { scope: "project", projectId }
  }

  private async execute(input: unknown, target: () => Promise<MemoryProjectTarget>, sessionID?: string): Promise<MemoryResult> {
    const parsed = MemoryOperationSchema.safeParse(input)
    if (!parsed.success) throw new MemoryError("invalid", "Invalid memory operation")
    const operation = parsed.data, agent = sessionID !== undefined
    if (operation.action === "save" && (operation.id === undefined ? operation.revision !== undefined || !agent : !operation.revision))
      throw new MemoryError("invalid", "Editing memory requires its ID and revision")
    const namespace = await this.namespace(operation, target, agent)
    if (agent && !this.getSettings().enabled) throw new MemoryError("disabled", "Memory is disabled")
    const revalidate = async () => {
      const current = await this.namespace(operation, target, agent)
      if (JSON.stringify(current) !== JSON.stringify(namespace)) throw new MemoryError("conflict", "Memory project changed")
      if ((agent || operation.action === "save" || operation.action === "delete") && !this.getSettings().enabled)
        throw new MemoryError("disabled", "Memory is disabled")
    }
    if (operation.action === "list" || operation.action === "read") {
      // Capture before the read: a concurrent later write stays unread next visit.
      const observedAt = new Date().toISOString()
      const all = await this.store.listForUI(namespace)
      const entries = agent ? memoryForAgent(all) : all
      const cleanupWritable = !agent && operation.action === "list" && this.getSettings().enabled
        && entries.some(entry => !reviewMemoryEntry(entry).flagged) && await this.store.cleanupWritable(namespace)
      await revalidate()
      if (operation.action === "list") return { entries: agent
        ? entries.map(entry => { const { text: _text, ...header } = versioned(entry); return header })
        : entries.map(reviewed), ...(!agent ? { scopeKey: namespace.scope === "global" ? "global" : namespace.projectId, observedAt,
          cleanupWritable: this.getSettings().enabled && cleanupWritable } : {}) }
      const entry = entries.find(entry => entry.id === operation.query) ?? entries.find(entry => entry.title === operation.query)
      return { entry: entry ? agent ? versioned(entry) : reviewed(entry) : null }
    }
    const result = await this.store.mutate<MemoryResult>(namespace, async entries => {
      await revalidate()
      const existing = "id" in operation ? entries.find(entry => entry.id === operation.id) : undefined
      if (operation.id !== undefined && (!existing || memoryRevision(existing) !== operation.revision))
        throw new MemoryError("conflict", "Memory changed; read it again before retrying")
      if (agent && existing && reviewMemoryEntry(existing).flagged) throw new MemoryError("conflict", "Memory entry requires human review")
      if (operation.action === "delete") return { kind: "delete", id: operation.id, result: { deleted: true } }
      try {
        const mutation = decideMemorySave(namespace.scope, entries, operation.content, sessionID ?? existing!.sessionId, operation.id)
        if (mutation.kind !== "save") throw new MemoryError("invalid", "Invalid memory decision")
        return { ...mutation, result: { id: mutation.entry.id, revision: memoryRevision(mutation.entry), flagged: reviewMemoryEntry(mutation.entry).flagged } }
      } catch (error) {
        if (agent && error instanceof MemoryError && error.code === "full")
          throw new MemoryError("full", "Memory is full. Merge or delete entries before retrying.", memoryForAgent(entries).map(entry => entry.title))
        throw error
      }
    })
    this.invalidate()
    await revalidate()
    return result
  }

  private invalidate(): void {
    // A hint only: every consumer re-reads its own authorized scope.
    try { this.events.publish({ type: "memory.changed" }) } catch { /* The committed result remains authoritative. */ }
  }
}
