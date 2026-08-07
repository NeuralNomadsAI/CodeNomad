import { batch as solidBatch } from "solid-js"
import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { getClientIdentity } from "./client-identity"
import {
  connectWorkspaceEvents,
  type WorkspaceEventConnection,
  type WorkspaceEventTransportStatus,
} from "./event-transport"
import { getLogger } from "./logger"
import { retryWithBackoff, isRetryableError } from "./retry-utils"

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
  private statusHandlers = new Set<(status: WorkspaceEventTransportStatus) => void>()
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
      this.emitTransportStatus("disconnected")
      this.connection.disconnect()
      this.connection = null
    }

    logSse("Connecting to backend events stream")

    try {
      const connection = await connectWorkspaceEvents({
        onBatch: (events) => {
          if (generation === this.connectGeneration) this.dispatchBatch(events)
        },
        onError: () => {
          if (generation !== this.connectGeneration) {
            return
          }
          this.scheduleReconnect()
        },
        onStatus: (status) => {
          if (generation !== this.connectGeneration) {
            return
          }
          this.emitTransportStatus(status)
        },
        onOpen: () => {
          if (generation !== this.connectGeneration) {
            return
          }
          logSse("Events stream connected")
          this.retryDelay = RETRY_BASE_DELAY
          this.openHandlers.forEach((handler) => handler())
        },
        onPing: (payload) => {
          if (generation !== this.connectGeneration) {
            return
          }
          const identity = getClientIdentity()
          const pongPayload = { ...identity, pingTs: payload.ts }

          void retryWithBackoff(
            (signal) => serverApi.sendClientConnectionPong(pongPayload, signal),
            {
              maxAttempts: 3,
              initialDelayMs: 100,
              maxDelayMs: 2000,
              timeoutMs: 10000,
              shouldRetry: (error) => isRetryableError(error),
            },
          ).catch((error) => {
            log.warn("Failed to send client connection pong after retries", error)
          })
        },
      })

      if (generation !== this.connectGeneration) {
        connection.disconnect()
        return
      }

      this.connection = connection
    } catch (error) {
      if (generation !== this.connectGeneration) {
        return
      }

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

    this.connectGeneration += 1

    if (this.connection) {
      this.connection.disconnect()
      this.connection = null
    }

    this.emitTransportStatus("disconnected")

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

  private emitTransportStatus(status: WorkspaceEventTransportStatus) {
    this.statusHandlers.forEach((handler) => handler(status))
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

  onTransportStatus(handler: (status: WorkspaceEventTransportStatus) => void): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  restart(reason = "manual restart"): void {
    this.retryDelay = RETRY_BASE_DELAY
    this.clearReconnectTimer()

    if (this.connection) {
      this.emitTransportStatus("disconnected")
      this.connection.disconnect()
      this.connection = null
    }

    logSse("Restarting backend events stream", { reason })
    void this.connect()
  }
}

export const serverEvents = new ServerEvents()
