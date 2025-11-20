import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { cliApi } from "./api-client"

const RETRY_BASE_DELAY = 1000
const RETRY_MAX_DELAY = 10000
const SSE_PREFIX = "[SSE]"

function logSse(message: string, context?: Record<string, unknown>) {
  if (context) {
    console.log(`${SSE_PREFIX} ${message}`, context)
    return
  }
  console.log(`${SSE_PREFIX} ${message}`)
}

class CliEvents {
  private handlers = new Map<WorkspaceEventType | "*", Set<(event: WorkspaceEventPayload) => void>>()
  private source: EventSource | null = null
  private retryDelay = RETRY_BASE_DELAY

  constructor() {
    this.connect()
  }

  private connect() {
    if (this.source) {
      this.source.close()
    }
    logSse("Connecting to backend events stream")
    this.source = cliApi.connectEvents((event) => this.dispatch(event), () => this.scheduleReconnect())
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
    logSse("Events stream disconnected, scheduling reconnect", { delayMs: this.retryDelay })
    setTimeout(() => {
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_DELAY)
      this.connect()
    }, this.retryDelay)
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

export const cliEvents = new CliEvents()
