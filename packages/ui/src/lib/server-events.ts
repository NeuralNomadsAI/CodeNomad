import { batch as solidBatch } from "solid-js"
import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { connectWorkspaceEvents, type WorkspaceEventConnection } from "./event-transport"
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
  private openHandlers = new Set<() => void>()
  private connection: WorkspaceEventConnection | null = null
  private connectGeneration = 0
  private retryDelay = RETRY_BASE_DELAY
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    void this.connect()
  }

  private async connect() {
    const generation = ++this.connectGeneration
    this.clearReconnectTimer()

    if (this.connection) {
      this.connection.disconnect()
      this.connection = null
    }

    logSse("Connecting to backend events stream")

    try {
      const connection = await connectWorkspaceEvents({
        onBatch: (events) => this.dispatchBatch(events),
        onError: () => {
          if (generation !== this.connectGeneration) {
            return
          }
          this.scheduleReconnect()
        },
        onOpen: () => {
          if (generation !== this.connectGeneration) {
            return
          }
          logSse("Events stream connected")
          this.retryDelay = RETRY_BASE_DELAY
          this.openHandlers.forEach((handler) => handler())
        },
      })

      if (generation !== this.connectGeneration) {
        connection.disconnect()
        return
      }

      this.connection = connection
    } catch (error) {
      logSse("Events stream failed to connect, scheduling reconnect", {
        error: error instanceof Error ? error.message : String(error),
      })
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.retryTimer) {
      return
    }

    if (this.connection) {
      this.connection.disconnect()
      this.connection = null
    }

    logSse("Events stream disconnected, scheduling reconnect", { delayMs: this.retryDelay })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_DELAY)
      void this.connect()
    }, this.retryDelay)
  }

  private clearReconnectTimer() {
    if (!this.retryTimer) {
      return
    }

    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private dispatch(event: WorkspaceEventPayload) {
    this.handlers.get("*")?.forEach((handler) => handler(event))
    this.handlers.get(event.type)?.forEach((handler) => handler(event))
  }

  private dispatchBatch(events: WorkspaceEventPayload[]) {
    if (events.length === 0) {
      return
    }

    logSse("event batch", { size: events.length })

    solidBatch(() => {
      for (const event of events) {
        this.dispatch(event)
      }
    })
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
}

export const serverEvents = new ServerEvents()
