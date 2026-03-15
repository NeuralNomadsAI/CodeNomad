import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { getLogger } from "./logger"

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
  private source: EventSource | null = null
  private retryDelay = RETRY_BASE_DELAY
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.connect()
  }

  private connect() {
    if (this.source) {
      this.source.close()
      this.source = null
    }
    // Cancel any pending reconnect when an explicit connect is initiated
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    logSse("Connecting to backend events stream")
    this.source = serverApi.connectEvents((event) => this.dispatch(event), () => this.scheduleReconnect())
    this.source.onerror = () => {
      // Close the broken source before scheduling reconnect to prevent duplicate sources
      if (this.source) {
        this.source.close()
        this.source = null
      }
      this.scheduleReconnect()
    }
    this.source.onopen = () => {
      logSse("Events stream connected")
      this.retryDelay = RETRY_BASE_DELAY
    }
  }

  private scheduleReconnect() {
    if (this.source) {
      this.source.close()
      this.source = null
    }
    // Guard against duplicate reconnect timers (rapid disconnect/onerror)
    if (this.reconnectTimer !== null) return
    const jitter = Math.random() * 500
    const delay = this.retryDelay + jitter
    logSse("Events stream disconnected, scheduling reconnect", { delayMs: delay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_DELAY)
      this.connect()
    }, delay)
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
}

export const serverEvents = new ServerEvents()
