import { createSignal } from "solid-js"
import type {
  PermissionAsked,
  PermissionReplied,
  SessionCompactionEnded,
  SessionCreated,
  SessionDeleted,
  SessionExecutionFailed,
  SessionRevertCleared,
  SessionRevertCommitted,
  SessionRevertStaged,
  TuiToastShow,
  V2Event,
} from "@opencode/client"
import { backendEvents as serverEvents } from "./server-events"
import { parseInstanceKey, LOCAL_BACKEND_ID } from "./backend-identity"
import type { WorkspaceEventTransportStatus } from "./event-transport"
import type { InstanceStreamEvent, WorkspaceEventPayload } from "../../../server/src/api-types"
import { getLogger } from "./logger"
import {
  deriveDisplayConnectionStatus,
  seedConnectionStatusIfMissing,
  type ConnectionStatus,
} from "./connection-status"

const log = getLogger("sse")

type InstanceEventPayload = Extract<WorkspaceEventPayload, { type: "instance.event" }>
type InstanceStatusPayload = Extract<WorkspaceEventPayload, { type: "instance.eventStatus" }>

export type NativeSessionEvent = V2Event

export interface WorktreeReadyEvent {
  type: "worktree.ready"
  location?: { directory: string }
  data?: {
    name?: string
    branch?: string
  }
}

export interface EventSessionDeleted {
  type: "session.deleted"
  data?: { sessionID?: string }
}

type SSEEvent =
  | SessionCreated
  | SessionDeleted
  | SessionCompactionEnded
  | SessionExecutionFailed
  | SessionRevertStaged
  | SessionRevertCleared
  | SessionRevertCommitted
  | PermissionAsked
  | PermissionReplied
  | TuiToastShow
  | WorktreeReadyEvent
  | V2Event

export class SSEManager {
  private readonly connection = createSignal<Map<string, ConnectionStatus>>(new Map())
  private readonly transport = createSignal<WorkspaceEventTransportStatus>("connecting")
  private readonly callbacks: SSEManager
  private readonly cleanup: (() => void)[] = []
  private disposed = false
  readonly signal?: AbortSignal

  constructor(readonly backendId = LOCAL_BACKEND_ID, callbacks?: SSEManager) {
    this.callbacks = callbacks ?? this
    this.signal = serverEvents.signal(backendId)
    const removed = () => {
      const owned = managers.get(backendId) === this
      if (owned) managers.delete(backendId)
      this.dispose()
      if (owned) setManagerRevision(value => value + 1)
    }
    this.signal?.addEventListener("abort", removed, { once: true })
    this.cleanup.push(() => this.signal?.removeEventListener("abort", removed))
    log.info("sseManager initialized: listening for SSE disconnect and reconnect")

    this.cleanup.push(serverEvents.on("instance.eventStatus", (event) => {
      if (this.disposed || this.signal?.aborted) return
      if ((event.backendId ?? LOCAL_BACKEND_ID) !== this.backendId) return
      const payload = event as InstanceStatusPayload
      this.updateConnectionStatus(payload.instanceId, payload.status)
      if (this.disposed) return
      if (payload.status === "disconnected") {
        if (payload.reason === "workspace stopped") {
          return
        }
        const reason = payload.reason ?? "Instance disconnected"
        void this.callbacks.onConnectionLost?.(payload.instanceId, reason)
      }
    }))

    this.cleanup.push(serverEvents.on("instance.event", (event) => {
      if (this.disposed || this.signal?.aborted) return
      if ((event.backendId ?? LOCAL_BACKEND_ID) !== this.backendId) return
      const payload = event as InstanceEventPayload
      this.updateConnectionStatus(payload.instanceId, "connected")
      if (this.disposed) return
      this.handleEvent(payload.instanceId, payload.event as SSEEvent)
    }))

    this.cleanup.push(serverEvents.onTransportStatus((status, backendId) => {
      if (this.disposed || this.signal?.aborted) return
      if (backendId !== this.backendId) return
      log.info("SSE transport status changed", { status })
      this.seedTransportStatus(status)
    }))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cleanup.splice(0).forEach(off => off())
    this.transport[1]("disconnected")
    this.connection[1](new Map())
  }

  seedTransportStatus(status: WorkspaceEventTransportStatus): void {
    if (!this.disposed) this.transport[1](status)
  }

  seedStatus(instanceId: string, status: ConnectionStatus) {
    getSseManager(parseInstanceKey(instanceId).backendId).updateConnectionStatus(instanceId, status)
  }

  seedStatusIfMissing(instanceId: string, status: ConnectionStatus) {
    getSseManager(parseInstanceKey(instanceId).backendId).connection[1]((prev) => seedConnectionStatusIfMissing(prev, instanceId, status))
  }

  private handleEvent(instanceId: string, event: SSEEvent | InstanceStreamEvent): void {
    if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") {
      log.warn("Dropping malformed event", event)
      return
    }

    log.info("Received event", { type: event.type, event })
    this.callbacks.onInvalidation?.(instanceId, event as V2Event)
    if (this.disposed || this.signal?.aborted) return

    switch (event.type) {
      case "session.created":
        this.callbacks.onSessionUpdate?.(instanceId, event as SessionCreated)
        break
      case "session.revert.staged":
      case "session.revert.cleared":
      case "session.revert.committed":
        this.callbacks.onSessionUpdate?.(instanceId, event as SessionRevertStaged | SessionRevertCleared | SessionRevertCommitted)
        break
      case "session.deleted":
        this.callbacks.onSessionDeleted?.(instanceId, event as SessionDeleted)
        break
      case "session.compaction.ended":
        this.callbacks.onSessionCompacted?.(instanceId, event as SessionCompactionEnded)
        break
      case "session.execution.failed":
        this.callbacks.onSessionError?.(instanceId, event as SessionExecutionFailed)
        break
      case "tui.toast.show":
        this.callbacks.onTuiToast?.(instanceId, event as TuiToastShow)
        break
      case "permission.asked":
        this.callbacks.onPermissionUpdated?.(instanceId, event as PermissionAsked)
        break
      case "permission.replied":
        this.callbacks.onPermissionReplied?.(instanceId, event as PermissionReplied)
        break
      case "worktree.ready":
        try {
          const result = this.callbacks.onWorktreeReady?.(instanceId, event as WorktreeReadyEvent)
          void result?.catch((error) => {
            log.warn("Failed to handle worktree ready event", { instanceId, error })
          })
        } catch (error) {
          log.warn("Failed to handle worktree ready event", { instanceId, error })
        }
        break
      case "worktree.updated":
        void this.callbacks.onWorktreeUpdated?.(instanceId)?.catch(error => log.warn("Failed to refresh native worktrees", error))
        break
      default:
        this.callbacks.onNativeSessionEvent?.(instanceId, event as NativeSessionEvent)
    }
  }

  private updateConnectionStatus(instanceId: string, status: ConnectionStatus): void {
    this.connection[1]((prev) => {
      if (prev.get(instanceId) === status) return prev
      const next = new Map(prev)
      next.set(instanceId, status)
      return next
    })
  }

  onSessionUpdate?: (instanceId: string, event: SessionCreated | SessionRevertStaged | SessionRevertCleared | SessionRevertCommitted) => void
  onSessionDeleted?: (instanceId: string, event: EventSessionDeleted) => void
  onWorktreeUpdated?: (instanceId: string) => Promise<void>
  onSessionCompacted?: (instanceId: string, event: SessionCompactionEnded) => void
  onSessionError?: (instanceId: string, event: SessionExecutionFailed) => void
  onTuiToast?: (instanceId: string, event: TuiToastShow) => void
  onPermissionUpdated?: (instanceId: string, event: PermissionAsked) => void
  onPermissionReplied?: (instanceId: string, event: PermissionReplied) => void
  onNativeSessionEvent?: (instanceId: string, event: NativeSessionEvent) => void
  onInvalidation?: (instanceId: string, event: V2Event) => void
  onWorktreeReady?: (instanceId: string, event: WorktreeReadyEvent) => void | Promise<void>
  onConnectionLost?: (instanceId: string, reason: string) => void | Promise<void>

  getStatus(instanceId: string): ConnectionStatus | null {
    managerRevision()
    const manager = managers.get(parseInstanceKey(instanceId).backendId)
    if (!manager) return null
    return deriveDisplayConnectionStatus(manager.connection[0]().get(instanceId) ?? null, manager.transport[0]())
  }

  getStatuses() {
    managerRevision()
    if (this !== sseManager) return this.connection[0]()
    return new Map([...managers.values()].flatMap(manager => [...manager.connection[0]()]))
  }
}

export const sseManager = new SSEManager()
const managers = new Map<string, SSEManager>([[LOCAL_BACKEND_ID, sseManager]])
const [managerRevision, setManagerRevision] = createSignal(0)

/** Each backend owns connection state; the ordinary store hooks receive globally scoped instance keys. */
export function getSseManager(backendId: string): SSEManager {
  let manager = managers.get(backendId)
  if (manager && manager.signal !== serverEvents.signal(backendId)) {
    managers.delete(backendId)
    manager.dispose()
    manager = managers.get(backendId)
  }
  if (!manager) {
    managers.set(backendId, manager = new SSEManager(backendId, sseManager))
    setManagerRevision(value => value + 1)
  }
  return manager
}

// Create the backend owner before dispatching its first typed event or transport status.
serverEvents.on("*", event => { getSseManager(event.backendId ?? LOCAL_BACKEND_ID) })
serverEvents.onTransportStatus((status, backendId) => { if (serverEvents.signal(backendId)) getSseManager(backendId).seedTransportStatus(status) })
serverEvents.onDetach((backendId, signal) => {
  const manager = managers.get(backendId)
  if (manager?.signal !== signal) return
  managers.delete(backendId)
  manager?.dispose()
  setManagerRevision(value => value + 1)
})
