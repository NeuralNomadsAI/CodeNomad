import { createSignal } from "solid-js"
import {
  MessageUpdateEvent,
  MessageRemovedEvent,
  MessagePartUpdatedEvent,
  MessagePartRemovedEvent,
  MessagePartDeltaEvent,
} from "../types/message"
import type {
  EventLspUpdated,

  EventSessionCompacted,
  EventSessionError,
  EventSessionIdle,
  EventSessionUpdated,
  EventSessionStatus,
} from "@opencode-ai/sdk"
import type {
  EventPermissionV2Asked,
  EventPermissionV2Replied,
  EventQuestionV2Asked,
  EventQuestionV2Rejected,
  EventQuestionV2Replied,
} from "@opencode-ai/sdk/v2"
import type { LegacyPermissionAskedEvent, LegacyPermissionRepliedEvent } from "../types/permission"
import { serverEvents } from "./server-events"
import type { WorkspaceEventTransportStatus } from "./event-transport"
import type {
  BackgroundProcess,
  InstanceStreamEvent,
  WorkspaceEventPayload,
} from "../../../server/src/api-types"
import { getLogger } from "./logger"
import { deriveDisplayConnectionStatus, type ConnectionStatus } from "./connection-status"

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

interface ServerInstanceDisposedEvent {
  type: "server.instance.disposed"
  properties: {
    directory: string
  }
}

type EventSessionCreated = Omit<EventSessionUpdated, "type"> & { type: "session.created" }

type SSEEvent =
  | MessageUpdateEvent
  | MessageRemovedEvent
  | MessagePartUpdatedEvent
  | MessagePartRemovedEvent
  | MessagePartDeltaEvent
  | EventSessionCreated
  | EventSessionUpdated
  | EventSessionCompacted
  | EventSessionError
  | EventSessionIdle
  | EventSessionStatus
  | EventPermissionV2Asked
  | EventPermissionV2Replied
  | LegacyPermissionAskedEvent
  | LegacyPermissionRepliedEvent
  | { type: "question.asked"; properties?: any }
  | { type: "question.replied" | "question.rejected"; properties?: any }
  | EventQuestionV2Asked
  | EventQuestionV2Replied
  | EventQuestionV2Rejected
  | EventLspUpdated
  | TuiToastEvent
  | BackgroundProcessUpdatedEvent
  | BackgroundProcessRemovedEvent
  | ServerInstanceDisposedEvent
  | { type: string; properties?: Record<string, unknown> }

const [connectionStatus, setConnectionStatus] = createSignal<Map<string, ConnectionStatus>>(new Map())
const [transportStatus, setTransportStatus] = createSignal<WorkspaceEventTransportStatus>("connecting")

class SSEManager {
  constructor() {
    log.info("sseManager initialized: listening for SSE disconnect and reconnect")

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

    serverEvents.onTransportStatus((status) => {
      log.info("SSE transport status changed", { status })
      setTransportStatus(status)
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
      case "message.part.delta":
        this.onMessagePartDelta?.(instanceId, event as MessagePartDeltaEvent)
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
      case "session.created":
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
      case "permission.asked":
      case "permission.updated":
        this.onPermissionUpdated?.(instanceId, event as any)
        break
      case "permission.replied":
        this.onPermissionReplied?.(instanceId, event as any)
        break
      case "permission.v2.asked":
        this.onPermissionUpdated?.(instanceId, event as EventPermissionV2Asked)
        break
      case "permission.v2.replied":
        this.onPermissionReplied?.(instanceId, event as EventPermissionV2Replied)
        break
      case "question.asked":
        this.onQuestionAsked?.(instanceId, event as any)
        break
      case "question.replied":
      case "question.rejected":
        this.onQuestionAnswered?.(instanceId, event as any)
        break
      case "question.v2.asked":
        this.onQuestionAsked?.(instanceId, event as EventQuestionV2Asked)
        break
      case "question.v2.replied":
      case "question.v2.rejected":
        this.onQuestionAnswered?.(instanceId, event as EventQuestionV2Replied | EventQuestionV2Rejected)
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
      case "server.instance.disposed":
        this.onInstanceDisposed?.(instanceId, event as ServerInstanceDisposedEvent)
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
  onMessagePartDelta?: (instanceId: string, event: MessagePartDeltaEvent) => void
  onMessagePartRemoved?: (instanceId: string, event: MessagePartRemovedEvent) => void
  onSessionUpdate?: (instanceId: string, event: EventSessionUpdated) => void
  onSessionCompacted?: (instanceId: string, event: EventSessionCompacted) => void
  onSessionError?: (instanceId: string, event: EventSessionError) => void
  onTuiToast?: (instanceId: string, event: TuiToastEvent) => void
  onSessionIdle?: (instanceId: string, event: EventSessionIdle) => void
  onSessionStatus?: (instanceId: string, event: EventSessionStatus) => void
  onPermissionUpdated?: (instanceId: string, event: EventPermissionV2Asked | LegacyPermissionAskedEvent) => void
  onPermissionReplied?: (instanceId: string, event: EventPermissionV2Replied | LegacyPermissionRepliedEvent) => void
  onQuestionAsked?: (instanceId: string, event: EventQuestionV2Asked | { type: "question.asked"; properties?: any }) => void
  onQuestionAnswered?: (instanceId: string, event: EventQuestionV2Replied | EventQuestionV2Rejected | { type: "question.replied" | "question.rejected"; properties?: any }) => void
  onLspUpdated?: (instanceId: string, event: EventLspUpdated) => void
  onBackgroundProcessUpdated?: (instanceId: string, event: BackgroundProcessUpdatedEvent) => void
  onBackgroundProcessRemoved?: (instanceId: string, event: BackgroundProcessRemovedEvent) => void
  onInstanceDisposed?: (instanceId: string, event: ServerInstanceDisposedEvent) => void
  onConnectionLost?: (instanceId: string, reason: string) => void | Promise<void>

  getStatus(instanceId: string): ConnectionStatus | null {
    return deriveDisplayConnectionStatus(connectionStatus().get(instanceId) ?? null, transportStatus())
  }

  getStatuses() {
    return connectionStatus()
  }
}

export const sseManager = new SSEManager()
