import { createSignal } from "solid-js"
import {
  MessageUpdateEvent,
  MessageRemovedEvent,
  MessagePartUpdatedEvent,
  MessagePartRemovedEvent,
  MessagePartDeltaEvent,
} from "../types/message"
import type {
  LocationRef,
  PermissionAsked,
  PermissionReplied,
  QuestionAsked,
  QuestionRejected,
  QuestionReplied,
  SessionCompactionEnded,
  SessionCreated,
  SessionDeleted,
  SessionExecutionFailed,
  SessionIdle,
  SessionRevertCleared,
  SessionRevertCommitted,
  SessionRevertStaged,
  SessionStatus2,
  TuiToastShow,
} from "@opencode-ai/client"
import { serverEvents } from "./server-events"
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

export interface NativeSessionEvent {
  type: string
  data?: {
    sessionID?: string
    location?: LocationRef
    [key: string]: unknown
  }
  location?: { directory?: string }
}

interface ServerInstanceDisposedEvent {
  type: "server.instance.disposed"
  properties: {
    directory: string
  }
}

export interface WorktreeReadyEvent {
  type: "worktree.ready"
  directory?: string
  properties: {
    name: string
    branch?: string
  }
}

export interface EventSessionDeleted {
  type: "session.deleted"
  data?: { sessionID?: string }
  properties?: { info?: { id?: string }; id?: string; sessionID?: string }
}

type SSEEvent =
  | MessageUpdateEvent
  | MessageRemovedEvent
  | MessagePartUpdatedEvent
  | MessagePartRemovedEvent
  | MessagePartDeltaEvent
  | SessionCreated
  | SessionDeleted
  | SessionCompactionEnded
  | SessionExecutionFailed
  | SessionIdle
  | SessionRevertStaged
  | SessionRevertCleared
  | SessionRevertCommitted
  | SessionStatus2
  | PermissionAsked
  | PermissionReplied
  | QuestionAsked
  | QuestionReplied
  | QuestionRejected
  | TuiToastShow
  | ServerInstanceDisposedEvent
  | WorktreeReadyEvent
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

  seedStatusIfMissing(instanceId: string, status: ConnectionStatus) {
    setConnectionStatus((prev) => seedConnectionStatusIfMissing(prev, instanceId, status))
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
      case "session.created":
        this.onSessionUpdate?.(instanceId, event as SessionCreated)
        break
      case "session.revert.staged":
      case "session.revert.cleared":
      case "session.revert.committed":
        this.onSessionUpdate?.(instanceId, event as SessionRevertStaged | SessionRevertCleared | SessionRevertCommitted)
        break
      case "session.deleted":
        this.onSessionDeleted?.(instanceId, event as SessionDeleted)
        break
      case "session.compaction.ended":
        this.onSessionCompacted?.(instanceId, event as SessionCompactionEnded)
        break
      case "session.execution.failed":
        this.onSessionError?.(instanceId, event as SessionExecutionFailed)
        break
      case "tui.toast.show":
        this.onTuiToast?.(instanceId, event as TuiToastShow)
        break
      case "session.idle":
        this.onSessionIdle?.(instanceId, event as SessionIdle)
        break
      case "session.status":
        this.onSessionStatus?.(instanceId, event as SessionStatus2)
        break
      case "permission.asked":
        this.onPermissionUpdated?.(instanceId, event as PermissionAsked)
        break
      case "permission.replied":
        this.onPermissionReplied?.(instanceId, event as PermissionReplied)
        break
      case "question.asked":
        this.onQuestionAsked?.(instanceId, event as QuestionAsked)
        break
      case "question.replied":
      case "question.rejected":
        this.onQuestionAnswered?.(instanceId, event as QuestionReplied | QuestionRejected)
        break
      case "server.instance.disposed":
        this.onInstanceDisposed?.(instanceId, event as ServerInstanceDisposedEvent)
        break
      case "worktree.ready":
        try {
          const result = this.onWorktreeReady?.(instanceId, event as WorktreeReadyEvent)
          void result?.catch((error) => {
            log.warn("Failed to handle worktree ready event", { instanceId, error })
          })
        } catch (error) {
          log.warn("Failed to handle worktree ready event", { instanceId, error })
        }
        break
      default:
        if (event.type.startsWith("session.")) {
          this.onNativeSessionEvent?.(instanceId, event as NativeSessionEvent)
        } else {
          log.warn("Unknown SSE event type", { type: event.type })
        }
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
  onSessionUpdate?: (instanceId: string, event: SessionCreated | SessionRevertStaged | SessionRevertCleared | SessionRevertCommitted) => void
  onSessionDeleted?: (instanceId: string, event: EventSessionDeleted) => void
  onSessionCompacted?: (instanceId: string, event: SessionCompactionEnded) => void
  onSessionError?: (instanceId: string, event: SessionExecutionFailed) => void
  onTuiToast?: (instanceId: string, event: TuiToastShow) => void
  onSessionIdle?: (instanceId: string, event: SessionIdle) => void
  onSessionStatus?: (instanceId: string, event: SessionStatus2) => void
  onPermissionUpdated?: (instanceId: string, event: PermissionAsked) => void
  onPermissionReplied?: (instanceId: string, event: PermissionReplied) => void
  onQuestionAsked?: (instanceId: string, event: QuestionAsked) => void
  onQuestionAnswered?: (instanceId: string, event: QuestionReplied | QuestionRejected) => void
  onNativeSessionEvent?: (instanceId: string, event: NativeSessionEvent) => void
  onLspUpdated?: (instanceId: string, event: { type: string }) => void | Promise<void>
  onInstanceDisposed?: (instanceId: string, event: ServerInstanceDisposedEvent) => void
  onWorktreeReady?: (instanceId: string, event: WorktreeReadyEvent) => void | Promise<void>
  onConnectionLost?: (instanceId: string, reason: string) => void | Promise<void>

  getStatus(instanceId: string): ConnectionStatus | null {
    return deriveDisplayConnectionStatus(connectionStatus().get(instanceId) ?? null, transportStatus())
  }

  getStatuses() {
    return connectionStatus()
  }
}

export const sseManager = new SSEManager()
