import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { getClientIdentity } from "./client-identity"
import { getLogger } from "./logger"
import { debugInfo, debugWarn } from "../stores/debug-log"

const RETRY_BASE_DELAY = 1000
const RETRY_MAX_DELAY = 10000
const log = getLogger("sse")

function logSse(message: string, context?: Record<string, unknown>) {
  if (context) {
    log.info(message, context)
    return
  }
  log.info(message)
}

class ServerEvents {
  private handlers = new Map<WorkspaceEventType | "*", Set<(event: WorkspaceEventPayload) => void>>()
  private openHandlers = new Set<() => void>()
  private disconnectHandlers = new Set<() => void>()
  private source: EventSource | null = null
  private retryDelay = RETRY_BASE_DELAY
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _connected = false

  get connected(): boolean {
    return this._connected
  }

  constructor() {
    this.connect()
  }

  private connect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.source) {
      this.source.close()
    }
    logSse("Connecting to backend events stream")
    this.source = serverApi.connectEvents(
      (event) => this.dispatch(event),
      () => this.scheduleReconnect(),
      (payload) => {
        void serverApi
          .sendClientConnectionPong({
            ...getClientIdentity(),
            pingTs: payload.ts,
          })
          .catch(() => {
            debugWarn("sse", "Pong failed (connection already closed)")
          })
      },
    )
    this.source.onopen = () => {
      logSse("Events stream connected")
      this.retryDelay = RETRY_BASE_DELAY
      this._connected = true
      this.openHandlers.forEach((handler) => handler())
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) {
      return
    }
    const source = this.source
    this.source = null
    this._connected = false
    this.disconnectHandlers.forEach((handler) => handler())
    logSse("Events stream disconnected, scheduling reconnect", { delayMs: this.retryDelay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_DELAY)
      this.connect()
    }, this.retryDelay)
    source?.close()
  }

  private dispatch(event: WorkspaceEventPayload) {
    logSse(`event ${event.type}`)
    this.handlers.get("*")?.forEach((handler) => handler(event))
    this.handlers.get(event.type)?.forEach((handler) => handler(event))
  }

  on(type: WorkspaceEventType | "*", handler: (event: WorkspaceEventPayload) => void): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    const bucket = this.handlers.get(type)!
    bucket.add(handler)
    return () => bucket.delete(handler)
  }

  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler)
    return () => this.openHandlers.delete(handler)
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler)
    return () => this.disconnectHandlers.delete(handler)
  }

  resetRetry() {
    debugInfo("sse", "Reset retry delay and reconnect")
    this.retryDelay = RETRY_BASE_DELAY
    if (!this.source && this.reconnectTimer === null) {
      this.connect()
    }
  }
}

export const serverEvents = new ServerEvents()
