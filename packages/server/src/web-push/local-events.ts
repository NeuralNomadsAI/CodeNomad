import type { WorkspaceEventPayload, WorktreeListResponse } from "../api-types"
import type { EventBus } from "../events/bus"
import type { WorkspaceManager } from "../workspaces/manager"

export interface LocalPushEvent {
  key: string
  category: "needsInput" | "sessionDone"
  instanceId: string
  sessionId: string
}

type Manager = Pick<WorkspaceManager, "get" | "list" | "getExistingSharedServiceConnection"
  | "ownsLocation" | "getServiceLocation"> & {
    getEventWorktrees: (instanceId: string) => Promise<Pick<WorktreeListResponse, "worktrees">>
  }
type Pending = { instanceId: string; sessionId: string; category: LocalPushEvent["category"]; key: string; abort: AbortController }
const MAX_PENDING = 32
const MAX_SEEN = 2048

// Match the renderer's directory identity, including case-sensitive WSL paths.
function normalize(directory: string): string {
  const trimmed = directory.trim()
  const comparable = trimmed.replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  const wsl = comparable.match(/^\/\/(wsl(?:\.localhost|\$)?)[/]([^/]+)(.*)$/i)
  if (wsl) return `//${wsl[1]!.toLowerCase()}/${wsl[2]!.toLowerCase()}${wsl[3]}`
  return /^[A-Za-z]:\//.test(comparable) || comparable.startsWith("//") || trimmed.includes("\\")
    ? comparable.toLowerCase() : comparable
}

/** Qualify shared live events without opening another native stream. */
export function attachLocalPushEvents({ eventBus, workspaceManager: manager, interested, emit }: {
  eventBus: EventBus
  workspaceManager: Manager
  interested: (instanceId: string) => boolean
  emit: (event: LocalPushEvent) => void
}): () => void {
  const pending = new Set<Pending>()
  const seen = new Set<string>()
  let disposed = false
  const remember = (key: string) => {
    seen.add(key)
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!)
  }
  const cancel = (matches: (item: Pending) => boolean) => {
    for (const item of pending) if (matches(item)) item.abort.abort()
  }

  async function lists(instanceId: string, directory: string): Promise<boolean> {
    const workspace = manager.get(instanceId)
    if (!workspace) return false
    const target = normalize(directory)
    if ([workspace.path, manager.getServiceLocation(instanceId)?.directory].some(value => value && normalize(value) === target)) return true
    const inventory = await manager.getEventWorktrees(instanceId)
    return inventory.worktrees.some(worktree => [worktree.directory, worktree.serviceDirectory]
      .some(value => value && normalize(value) === target))
  }

  async function qualify(item: Pending) {
    const { instanceId, sessionId, category, abort } = item
    if (!interested(instanceId)) return
    const workspace = manager.get(instanceId)
    const connection = manager.getExistingSharedServiceConnection(instanceId)
    if (!workspace || !connection) return
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])
    const current = () => {
      signal.throwIfAborted()
      connection.assertCurrent()
      if (disposed || !interested(instanceId) || manager.get(instanceId) !== workspace
        || manager.getExistingSharedServiceConnection(instanceId) !== connection) throw new Error("Push event authority changed")
    }
    current()
    const session = await connection.client.session.get({ sessionID: sessionId }, { signal })
    current()
    if (session.id !== sessionId || session.parentID != null || !session.location?.directory) return
    if (!await manager.ownsLocation(instanceId, session.location, connection.client, { signal, purpose: "event", strict: true })) return
    current()
    if (!await lists(instanceId, session.location.directory)) {
      if (category !== "needsInput") return
      // A nested repository request stays with its owning folder unless another
      // open project's list owns it (the same request is routed to that project).
      const others = manager.list().filter(other => other.id !== instanceId)
      if (others.length > 256) return
      for (const other of others) {
        current()
        if (await lists(other.id, session.location.directory)) return
      }
    }
    current()
    if (category === "sessionDone") {
      const active = await connection.client.session.active({ signal })
      current()
      if (!active || typeof active !== "object" || Array.isArray(active)
        || Object.prototype.hasOwnProperty.call(active, sessionId)) return
    }
    current()
    if (seen.has(item.key)) return
    remember(item.key)
    emit({ key: item.key, category, instanceId, sessionId })
  }

  const onEvent = (payload: Extract<WorkspaceEventPayload, { type: "instance.event" }>) => {
    const { instanceId, event } = payload
    const data = event.data as { sessionID?: string; id?: string; requestID?: string; reason?: string; form?: { id?: string; sessionID?: string } }
    const sessionId = event.type === "form.created" ? data.form?.sessionID : data.sessionID
    if (typeof sessionId !== "string" || !sessionId || sessionId === "global" || sessionId.length > 512) return
    const sameSession = (item: Pending) => item.instanceId === instanceId && item.sessionId === sessionId
    if (event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted") {
      const key = JSON.stringify([instanceId, sessionId, "done", event.id])
      if (seen.has(key) || [...pending].some(item => item.key === key)) return
    }
    if (event.type.startsWith("session.") && (
      event.type === "session.execution.started" || event.type === "session.step.started" || event.type === "session.step.streamed"
      || event.type.startsWith("session.text.") || event.type.startsWith("session.reasoning.") || event.type.startsWith("session.tool.")
      || event.type.startsWith("session.compaction.") || event.type.startsWith("session.execution.")
      || event.type === "session.moved" || event.type === "session.deleted"
    )) cancel(item => sameSession(item) && (item.category === "sessionDone" || event.type === "session.deleted" || event.type === "session.moved"))
    if (event.type === "permission.replied") {
      if (typeof data.requestID !== "string" || data.requestID.length > 512) return
      const key = JSON.stringify([instanceId, sessionId, "permission", data.requestID])
      remember(key)
      cancel(item => item.key === key)
      return
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      if (typeof data.id !== "string" || data.id.length > 512) return
      const key = JSON.stringify([instanceId, sessionId, "form", data.id])
      remember(key)
      cancel(item => item.key === key)
      return
    }
    const category = event.type === "permission.asked" || event.type === "form.created" ? "needsInput"
      : event.type === "session.execution.succeeded"
        || (event.type === "session.execution.interrupted" && data.reason === "inactivity") ? "sessionDone" : undefined
    if (!category) return
    const kind = event.type === "permission.asked" ? "permission" : event.type === "form.created" ? "form" : "done"
    const identity = kind === "permission" ? data.id : kind === "form" ? data.form?.id : event.id
    if (typeof identity !== "string" || !identity || identity.length > 512) return
    const key = JSON.stringify([instanceId, sessionId, kind, identity])
    if (disposed || !interested(instanceId) || seen.has(key) || [...pending].some(item => item.key === key) || pending.size >= MAX_PENDING) return
    const item: Pending = { instanceId, sessionId, category, key, abort: new AbortController() }
    pending.add(item)
    // Unavailable metadata, ownership or active state abandons this hint.
    void qualify(item).catch(() => {}).finally(() => pending.delete(item))
  }
  const onStatus = (event: Extract<WorkspaceEventPayload, { type: "instance.eventStatus" }>) => {
    cancel(item => item.instanceId === event.instanceId)
  }
  // A project opening, closing or changing its worktrees changes request placement.
  const onTopology = () => cancel(() => true)
  const topologyEvents = ["workspace.created", "workspace.started", "workspace.stopped", "workspace.error", "workspace.worktreesChanged"] as const
  eventBus.on("instance.event", onEvent)
  eventBus.on("instance.eventStatus", onStatus)
  for (const type of topologyEvents) eventBus.on(type, onTopology)
  return () => {
    disposed = true
    cancel(() => true)
    seen.clear()
    eventBus.off("instance.event", onEvent)
    eventBus.off("instance.eventStatus", onStatus)
    for (const type of topologyEvents) eventBus.off(type, onTopology)
  }
}
