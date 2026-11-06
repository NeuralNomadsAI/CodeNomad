import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { instanceKey, isBackendId, LOCAL_BACKEND_ID, parseInstanceKey } from "./backend-identity"
import type { BackendId } from "./backend-transport"
import type { WorkspaceEventTransportStatus } from "./event-transport"
import { getLogger } from "./logger"
import type { ServerEvents } from "./server-events"

export type BackendEventPayload = WorkspaceEventPayload & { backendId?: BackendId }

/** Rewrite only CodeNomad envelope identities; native locations, paths and generations stay intact. */
export function scopeBackendEvent(backendId: BackendId, event: WorkspaceEventPayload): BackendEventPayload {
  if (backendId === LOCAL_BACKEND_ID) return event
  const scoped: BackendEventPayload = { ...event, backendId }
  if ("instanceId" in scoped) scoped.instanceId = instanceKey(backendId, scoped.instanceId)
  if ("workspaceId" in scoped) scoped.workspaceId = instanceKey(backendId, scoped.workspaceId)
  if ("workspace" in scoped) scoped.workspace = { ...scoped.workspace, id: instanceKey(backendId, scoped.workspace.id) }
  if ("entry" in scoped) scoped.entry = { ...scoped.entry, workspaceId: instanceKey(backendId, scoped.entry.workspaceId) }
  return scoped
}

const log = getLogger("sse")

/** Synchronous fan-in; subscribing never starts or restarts a source. */
export class BackendEvents {
  private sources = new Map<BackendId, () => void>()
  private handlers = new Map<WorkspaceEventType | "*", Set<(event: BackendEventPayload) => void>>()
  private opens = new Set<(backendId: BackendId) => void>()
  private statuses = new Set<(status: WorkspaceEventTransportStatus, backendId: BackendId) => void>()
  private removals = new Set<(backendId: BackendId) => void>()

  /** Reads the current target at delivery, so a switched view never observes another backend's lifecycle. */
  forInstance(instanceId: () => string | undefined) {
    const matches = (backendId: BackendId) => backendId === parseInstanceKey(instanceId() ?? "").backendId
    return {
      on: (type: WorkspaceEventType | "*", handler: (event: BackendEventPayload) => void) =>
        this.on(type, event => { if (matches(event.backendId ?? LOCAL_BACKEND_ID)) handler(event) }),
      onOpen: (handler: (backendId: BackendId) => void) =>
        this.onOpen(backendId => { if (matches(backendId)) handler(backendId) }),
      onTransportStatus: (handler: (status: WorkspaceEventTransportStatus, backendId: BackendId) => void) =>
        this.onTransportStatus((status, backendId) => { if (matches(backendId)) handler(status, backendId) }),
    }
  }

  attach(backendId: BackendId, source: Pick<ServerEvents, "on" | "onOpen" | "onTransportStatus" | "onDispose">): () => void {
    if (!isBackendId(backendId)) throw new TypeError(`Invalid backend id: ${backendId}`)
    if (this.sources.has(backendId)) throw new Error(`Events already attached for backend ${backendId}`)
    const off = [
      source.on("*", event => {
        const scoped = scopeBackendEvent(backendId, event)
        this.notify(this.handlers.get("*"), handler => handler(scoped))
        this.notify(this.handlers.get(event.type), handler => handler(scoped))
      }),
      source.onOpen(() => this.notify(this.opens, handler => handler(backendId))),
      source.onTransportStatus(status => this.notify(this.statuses, handler => handler(status, backendId))),
    ]
    const detach = () => {
      if (this.sources.get(backendId) !== detach) return
      this.sources.delete(backendId)
      off.forEach(unsubscribe => unsubscribe())
      this.notify(this.statuses, handler => handler("disconnected", backendId))
      this.notify(this.removals, handler => handler(backendId))
    }
    this.sources.set(backendId, detach)
    off.push(source.onDispose(detach))
    return detach
  }

  onDetach(handler: (backendId: BackendId) => void): () => void {
    this.removals.add(handler)
    return () => { this.removals.delete(handler) }
  }

  private notify<T>(handlers: Set<T> | undefined, invoke: (handler: T) => void) {
    handlers?.forEach(handler => {
      try { invoke(handler) } catch (error) { log.error("Backend event subscriber failed", { error }) }
    })
  }

  on(type: WorkspaceEventType | "*", handler: (event: BackendEventPayload) => void): () => void {
    let bucket = this.handlers.get(type)
    if (!bucket) this.handlers.set(type, bucket = new Set())
    bucket.add(handler)
    return () => { bucket.delete(handler) }
  }

  onOpen(handler: (backendId: BackendId) => void): () => void {
    this.opens.add(handler)
    return () => { this.opens.delete(handler) }
  }

  onTransportStatus(handler: (status: WorkspaceEventTransportStatus, backendId: BackendId) => void): () => void {
    this.statuses.add(handler)
    return () => { this.statuses.delete(handler) }
  }
}
