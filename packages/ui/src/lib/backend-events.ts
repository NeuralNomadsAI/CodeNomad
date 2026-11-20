import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { instanceKey, isBackendId, LOCAL_BACKEND_ID, parseInstanceKey } from "./backend-identity"
import type { BackendId } from "./backend-transport"
import type { WorkspaceEventTransportStatus } from "./event-transport"
import { getLogger } from "./logger"
import type { ServerEvents } from "./server-events"
import { createStore } from "solid-js/store"

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
const detachedSignal = AbortSignal.abort()

/** Synchronous fan-in; subscribing never starts or restarts a source. */
export class BackendEvents {
  private sources = new Map<BackendId, { detach: () => void; controller: AbortController }>()
  private readonly attachments = createStore<Record<string, AbortSignal | undefined>>({})
  private handlers = new Map<WorkspaceEventType | "*", Set<(event: BackendEventPayload) => void>>()
  private opens = new Set<(backendId: BackendId) => void>()
  private statuses = new Set<(status: WorkspaceEventTransportStatus, backendId: BackendId) => void>()
  private removals = new Set<(backendId: BackendId, signal: AbortSignal) => void>()

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
    const controller = new AbortController()
    const active = () => this.sources.get(backendId)?.controller === controller && !controller.signal.aborted
    const off = [
      source.on("*", event => {
        const scoped = scopeBackendEvent(backendId, event)
        this.notify(this.handlers.get("*"), handler => handler(scoped), active)
        this.notify(this.handlers.get(event.type), handler => handler(scoped), active)
      }),
      source.onOpen(() => this.notify(this.opens, handler => handler(backendId), active)),
      source.onTransportStatus(status => this.notify(this.statuses, handler => handler(status, backendId), active)),
    ]
    const detach = () => {
      if (!active()) return
      this.sources.delete(backendId)
      controller.abort()
      // Revocation is irreversible even when a mounted consumer or unsubscribe fails.
      try { if (!this.sources.has(backendId)) this.attachments[1](backendId, undefined) }
      catch (error) { log.error("Backend attachment subscriber failed", { error }) }
      for (const unsubscribe of off) {
        try { unsubscribe() } catch (error) { log.error("Backend unsubscribe failed", { error }) }
      }
      const removed = () => !this.sources.has(backendId)
      this.notify(this.statuses, handler => handler("disconnected", backendId), removed)
      this.notify(this.removals, handler => handler(backendId, controller.signal), () => true)
    }
    this.sources.set(backendId, { detach, controller })
    off.push(source.onDispose(detach))
    if (active()) this.attachments[1](backendId, controller.signal)
    return detach
  }

  /** Capture once when admitting backend-owned work; never reacquire after an await. */
  signal(backendId: BackendId): AbortSignal | undefined {
    this.attachments[0][backendId]
    return this.sources.get(backendId)?.controller.signal
  }

  signalForInstance(instanceId: string): AbortSignal {
    return this.signal(parseInstanceKey(instanceId).backendId) ?? detachedSignal
  }

  onDetach(handler: (backendId: BackendId, signal: AbortSignal) => void): () => void {
    this.removals.add(handler)
    return () => { this.removals.delete(handler) }
  }

  private notify<T>(handlers: Set<T> | undefined, invoke: (handler: T) => void, active: () => boolean) {
    for (const handler of [...handlers ?? []]) {
      if (!active()) break
      if (!handlers?.has(handler)) continue
      try { invoke(handler) } catch (error) { log.error("Backend event subscriber failed", { error }) }
    }
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

/** The fan-in is passive; importing an authority never starts a transport. */
export const backendEvents = new BackendEvents()
