import { createSignal } from "solid-js"
import {
  MessageUpdateEvent,
  MessageRemovedEvent,
  MessagePartUpdatedEvent,
  MessagePartRemovedEvent,
} from "../types/message"
import type {
  EventLspUpdated,

  EventSessionCompacted,
  EventSessionError,
  EventSessionIdle,
  EventSessionUpdated,
  EventSessionStatus,
} from "@opencode-ai/sdk"
import { serverEvents } from "./server-events"
import type {
  BackgroundProcess,
  InstanceStreamEvent,
  InstanceStreamStatus,
  WorkspaceEventPayload,
} from "../../../server/src/api-types"
import { getLogger } from "./logger"

const log = getLogger("sse")

type InstanceEventPayload = Extract<WorkspaceEventPayload, { type: "instance.event" }>
type InstanceStatusPayload = Extract<WorkspaceEventPayload, { type: "instance.eventStatus" }>

interface TuiToastEvent {
  type: "tui.toast.show"
  properties: {
    title?: string
    message: string
    variant: "info" | "success" | "warning" | "error"
    duration?: number
  }
}

interface BackgroundProcessUpdatedEvent {
  type: "background.process.updated"
  properties: {
    process: BackgroundProcess
  }
}

interface BackgroundProcessRemovedEvent {
  type: "background.process.removed"
  properties: {
    processId: string
  }
}

type SSEEvent =
  | MessageUpdateEvent
  | MessageRemovedEvent
  | MessagePartUpdatedEvent
  | MessagePartRemovedEvent
  | EventSessionUpdated
  | EventSessionCompacted
  | EventSessionError
  | EventSessionIdle
  | { type: "permission.updated" | "permission.asked"; properties?: any }
  | { type: "permission.replied"; properties?: any }
  | EventLspUpdated
  | TuiToastEvent
  | BackgroundProcessUpdatedEvent
  | BackgroundProcessRemovedEvent
  | { type: string; properties?: Record<string, unknown> }

type ConnectionStatus = InstanceStreamStatus

const [connectionStatus, setConnectionStatus] = createSignal<Map<string, ConnectionStatus>>(new Map())

class SSEManager {
  constructor() {
    serverEvents.on("instance.eventStatus", (event) => {
      const payload = event as InstanceStatusPayload
      this.updateConnectionStatus(payload.instanceId, payload.status)
      if (payload.status === "disconnected") {
        if (payload.reason === "workspace stopped") {
          return
        }
        const reason = payload.reason ?? "Instance disconnected"
        void this.onConnectionLost?.(payload.instanceId, reason)
      }
    })

    serverEvents.on("instance.event", (event) => {
      const payload = event as InstanceEventPayload
      this.updateConnectionStatus(payload.instanceId, "connected")
      this.handleEvent(payload.instanceId, payload.event as SSEEvent)
    })
  }

  seedStatus(instanceId: string, status: ConnectionStatus) {
    this.updateConnectionStatus(instanceId, status)
  }

  private handleEvent(instanceId: string, event: SSEEvent | InstanceStreamEvent): void {
    if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") {
      log.warn("Dropping malformed event", event)
      return
    }

    log.info("Received event", { type: event.type, event })

    switch (event.type) {
      case "message.updated":
        this.onMessageUpdate?.(instanceId, event as MessageUpdateEvent)
        break
      case "message.part.updated":
        this.onMessagePartUpdated?.(instanceId, event as MessagePartUpdatedEvent)
        break
      case "message.removed":
        this.onMessageRemoved?.(instanceId, event as MessageRemovedEvent)
        break
      case "message.part.removed":
        this.onMessagePartRemoved?.(instanceId, event as MessagePartRemovedEvent)
        break
      case "session.updated":
        this.onSessionUpdate?.(instanceId, event as EventSessionUpdated)
        break
      case "session.compacted":
        this.onSessionCompacted?.(instanceId, event as EventSessionCompacted)
        break
      case "session.error":
        this.onSessionError?.(instanceId, event as EventSessionError)
        break
      case "tui.toast.show":
        this.onTuiToast?.(instanceId, event as TuiToastEvent)
        break
      case "session.idle":
        this.onSessionIdle?.(instanceId, event as EventSessionIdle)
        break
      case "session.status":
        this.onSessionStatus?.(instanceId, event as EventSessionStatus)
        break
      case "permission.updated":
      case "permission.asked":
        this.onPermissionUpdated?.(instanceId, event as any)
        break
      case "permission.replied":
        this.onPermissionReplied?.(instanceId, event as any)
        break
      case "lsp.updated":
        this.onLspUpdated?.(instanceId, event as EventLspUpdated)
        break
      case "background.process.updated":
        this.onBackgroundProcessUpdated?.(instanceId, event as BackgroundProcessUpdatedEvent)
        break
      case "background.process.removed":
        this.onBackgroundProcessRemoved?.(instanceId, event as BackgroundProcessRemovedEvent)
        break
      default:
        log.warn("Unknown SSE event type", { type: event.type })
    }
  }

  private updateConnectionStatus(instanceId: string, status: ConnectionStatus): void {
    setConnectionStatus((prev) => {
      const next = new Map(prev)
      next.set(instanceId, status)
      return next
    })
  }

  onMessageUpdate?: (instanceId: string, event: MessageUpdateEvent) => void
  onMessageRemoved?: (instanceId: string, event: MessageRemovedEvent) => void
  onMessagePartUpdated?: (instanceId: string, event: MessagePartUpdatedEvent) => void
  onMessagePartRemoved?: (instanceId: string, event: MessagePartRemovedEvent) => void
  onSessionUpdate?: (instanceId: string, event: EventSessionUpdated) => void
  onSessionCompacted?: (instanceId: string, event: EventSessionCompacted) => void
  onSessionError?: (instanceId: string, event: EventSessionError) => void
  onTuiToast?: (instanceId: string, event: TuiToastEvent) => void
  onSessionIdle?: (instanceId: string, event: EventSessionIdle) => void
  onSessionStatus?: (instanceId: string, event: EventSessionStatus) => void
  onPermissionUpdated?: (instanceId: string, event: any) => void
  onPermissionReplied?: (instanceId: string, event: any) => void
  onLspUpdated?: (instanceId: string, event: EventLspUpdated) => void
  onBackgroundProcessUpdated?: (instanceId: string, event: BackgroundProcessUpdatedEvent) => void
  onBackgroundProcessRemoved?: (instanceId: string, event: BackgroundProcessRemovedEvent) => void
  onConnectionLost?: (instanceId: string, reason: string) => void | Promise<void>

  getStatus(instanceId: string): ConnectionStatus | null {
    return connectionStatus().get(instanceId) ?? null
  }

  getStatuses() {
    return connectionStatus()
  }
}

export const sseManager = new SSEManager()
