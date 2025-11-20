import { createSignal } from "solid-js"
import {
  MessageUpdateEvent,
  MessageRemovedEvent,
  MessagePartUpdatedEvent,
  MessagePartRemovedEvent,
} from "../types/message"
import type {
  EventLspUpdated,
  EventPermissionReplied,
  EventPermissionUpdated,
  EventSessionCompacted,
  EventSessionError,
  EventSessionIdle,
  EventSessionUpdated,
} from "@opencode-ai/sdk"
import { CODENOMAD_API_BASE } from "./api-client"

interface SSEConnection {
  instanceId: string
  proxyPath: string
  eventSource: EventSource
  status: "connecting" | "connected" | "disconnected" | "error"
  reconnectAttempts: number
  reconnectTimer?: ReturnType<typeof setTimeout>
}

interface TuiToastEvent {
  type: "tui.toast.show"
  properties: {
    title?: string
    message: string
    variant: "info" | "success" | "warning" | "error"
    duration?: number
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
  | EventPermissionUpdated
  | EventPermissionReplied
  | EventLspUpdated
  | TuiToastEvent
  | { type: string; properties?: Record<string, unknown> } // Fallback for unknown event types

const [connectionStatus, setConnectionStatus] = createSignal<
  Map<string, "connecting" | "connected" | "disconnected" | "error">
>(new Map())

class SSEManager {
  private connections = new Map<string, SSEConnection>()
  private static readonly MAX_RECONNECT_DELAY_MS = 5000

  connect(instanceId: string, proxyPath: string, reconnectAttempts = 0): void {
    const existing = this.connections.get(instanceId)
    if (existing) {
      this.clearReconnectTimer(existing)
      existing.eventSource.close()
    }

    const url = buildInstanceEventsUrl(proxyPath)
    const eventSource = new EventSource(url)

    const connection: SSEConnection = {
      instanceId,
      proxyPath,
      eventSource,
      status: "connecting",
      reconnectAttempts,
    }

    this.connections.set(instanceId, connection)
    this.updateConnectionStatus(instanceId, "connecting")

    eventSource.onopen = () => {
      connection.status = "connected"
      connection.reconnectAttempts = 0
      this.updateConnectionStatus(instanceId, "connected")
      console.log(`[SSE] Connected to instance ${instanceId}`)
    }

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        this.handleEvent(instanceId, data)
      } catch (error) {
        console.error("[SSE] Failed to parse event:", error)
      }
    }

    eventSource.onerror = () => {
      connection.status = "error"
      this.updateConnectionStatus(instanceId, "error")
      console.error(`[SSE] Connection error for instance ${instanceId}`)
      this.handleConnectionError(instanceId, "Connection to instance lost")
    }
  }

  disconnect(instanceId: string): void {
    const connection = this.connections.get(instanceId)
    if (connection) {
      this.clearReconnectTimer(connection)
      connection.eventSource.close()
      this.connections.delete(instanceId)
      this.updateConnectionStatus(instanceId, "disconnected")
      console.log(`[SSE] Disconnected from instance ${instanceId}`)
    }
  }

  private handleEvent(instanceId: string, event: SSEEvent): void {
    console.log("[SSE] Received event:", event.type, event)

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
      case "permission.updated":
        this.onPermissionUpdated?.(instanceId, event as EventPermissionUpdated)
        break
      case "permission.replied":
        this.onPermissionReplied?.(instanceId, event as EventPermissionReplied)
        break
      case "lsp.updated":
        this.onLspUpdated?.(instanceId, event as EventLspUpdated)
        break
      default:
        console.warn("[SSE] Unknown event type:", event.type)
    }
  }

  private handleConnectionError(instanceId: string, reason: string): void {
    const connection = this.connections.get(instanceId)
    if (!connection) return

    connection.eventSource.close()

    const nextAttempt = connection.reconnectAttempts + 1
    const delay = Math.min(nextAttempt * 1000, SSEManager.MAX_RECONNECT_DELAY_MS)

    connection.reconnectAttempts = nextAttempt
    connection.status = "connecting"
    this.updateConnectionStatus(instanceId, "connecting")

    console.warn(`[SSE] Attempting reconnect ${nextAttempt} for instance ${instanceId}`)

    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = undefined
      this.connect(instanceId, connection.proxyPath, nextAttempt)
    }, delay)
  }

  private clearReconnectTimer(connection: SSEConnection): void {
    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer)
      connection.reconnectTimer = undefined
    }
  }

  private updateConnectionStatus(instanceId: string, status: SSEConnection["status"]): void {
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
  onPermissionUpdated?: (instanceId: string, event: EventPermissionUpdated) => void
  onPermissionReplied?: (instanceId: string, event: EventPermissionReplied) => void
  onLspUpdated?: (instanceId: string, event: EventLspUpdated) => void
  onConnectionLost?: (instanceId: string, reason: string) => void | Promise<void>

  getStatus(instanceId: string): "connecting" | "connected" | "disconnected" | "error" | null {
    return connectionStatus().get(instanceId) ?? null
  }

  getStatuses() {
    return connectionStatus()
  }
}

function buildInstanceEventsUrl(proxyPath: string): string {
  const normalized = normalizeProxyPath(proxyPath)
  const base = stripTrailingSlashes(CODENOMAD_API_BASE)
  return `${base}${normalized}/event`
}

function normalizeProxyPath(proxyPath: string): string {
  const withLeading = proxyPath.startsWith("/") ? proxyPath : `/${proxyPath}`
  return withLeading.replace(/\/+/g, "/").replace(/\/+$/, "")
}

function stripTrailingSlashes(input: string): string {
  return input.replace(/\/+$/, "")
}

export const sseManager = new SSEManager()
