import { batch as solidBatch, untrack } from "solid-js"
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
import { createStreamStalenessWatchdog } from "./stream-staleness"
import { authRecovery } from "./auth-recovery"

const RETRY_BASE_DELAY = 1000
const RETRY_MAX_DELAY = 10000
const FRAME_FALLBACK_MS = 32
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
  private pendingBatch: WorkspaceEventPayload[] = []
  private cancelBatchWake: (() => void) | undefined
  private batchEndCallbacks: Set<() => void> | undefined
  private watchdog = createStreamStalenessWatchdog({
    onStale: () => this.restart("stream stale"),
  })

  constructor() {
    authRecovery.onRestored(() => this.restart("authentication restored"))
    if (typeof window !== "undefined") {
      // Minimal renderer globals (tests, embedded previews) may define window
      // without event APIs; the probes are enhancements, never requirements.
      window.addEventListener?.("online", () => this.probeStale("network online"))
      if (typeof document !== "undefined") {
        document.addEventListener?.("visibilitychange", () => {
          this.flushPendingBatch()
          if (document.visibilityState === "visible") {
            this.probeStale("visibility restored")
          }
        })
      }
      void this.connect()
    }
  }

  private async connect() {
    const generation = ++this.connectGeneration
    this.clearReconnectTimer()

    if (this.connection) {
      this.emitTransportStatus("disconnected")
      this.connection.disconnect()
      this.connection = null
      this.watchdog.setConnected(false)
    }

    logSse("Connecting to backend events stream")

    try {
      const connection = await connectWorkspaceEvents({
        onBatch: (events) => {
          if (generation !== this.connectGeneration) return
          this.watchdog.activity()
          this.queueBatch(events)
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
          this.watchdog.activity()
          logSse("Events stream connected")
          this.retryDelay = RETRY_BASE_DELAY
          this.notify(this.openHandlers, undefined, "open")
        },
        onPing: (payload) => {
          if (generation !== this.connectGeneration) {
            return
          }
          this.watchdog.activity()
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
      this.watchdog.setConnected(true)
    } catch (error) {
      if (generation !== this.connectGeneration) {
        return
      }

      logSse("Events stream failed to connect, scheduling reconnect", {
        error: error instanceof Error ? error.message : String(error),
      })
      this.watchdog.setConnected(false)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    // EventSource hides HTTP status. Probe our own auth endpoint so a server
    // restart is recoverable even when the user has not made another API call.
    void authRecovery.check()
    if (this.retryTimer) {
      return
    }

    this.connectGeneration += 1

    if (this.connection) {
      this.connection.disconnect()
      this.connection = null
    }

    this.watchdog.setConnected(false)
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
    this.notify(this.handlers.get("*"), event, event.type)
    this.notify(this.handlers.get(event.type), event, event.type)
  }

  private notify<T>(handlers: Set<(value: T) => void> | undefined, value: T, kind: string): void {
    handlers?.forEach((handler) => {
      try {
        handler(value)
      } catch (error) {
        // A feature failure must not discard another feature's native event or
        // interrupt the connection lifecycle. Do not replay failed handlers.
        log.error("Backend event subscriber failed", { kind, error })
      }
    })
  }

  private queueBatch(events: WorkspaceEventPayload[]): void {
    if (!events.length) return
    if (typeof document === "undefined" && typeof requestAnimationFrame !== "function") {
      this.dispatchBatch(events)
      return
    }
    for (const event of events) this.pendingBatch.push(event)
    if (this.cancelBatchWake) return

    const wake = () => {
      if (this.cancelBatchWake === cancel) this.flushPendingBatch()
    }
    const frame = typeof requestAnimationFrame === "function" && !(typeof document !== "undefined" && document.hidden)
      ? requestAnimationFrame(wake)
      : undefined
    // A hidden or suspended compositor may not deliver a frame.
    const fallback = setTimeout(wake, FRAME_FALLBACK_MS)
    const cancel = () => {
      if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
      clearTimeout(fallback)
    }
    this.cancelBatchWake = cancel
  }

  /** Delivers accepted events before a synchronous consumer changes their view. */
  flushPendingBatch(): void {
    this.cancelBatchWake?.()
    this.cancelBatchWake = undefined
    const events = this.pendingBatch
    if (!events.length) return
    this.pendingBatch = []
    try {
      this.dispatchBatch(events)
    } catch (error) {
      // The reactive flush runs outside the EventSource handler's error boundary.
      log.error("Failed to dispatch event", error)
    }
  }

  private dispatchBatch(events: WorkspaceEventPayload[]) {
    if (events.length === 0) {
      return
    }

    logSse("event batch", { size: events.length })
    solidBatch(() => untrack(() => {
      const parent = this.batchEndCallbacks
      const callbacks = parent ?? new Set<() => void>()
      this.batchEndCallbacks = callbacks
      try {
        for (const event of events) this.dispatch(event)
      } finally {
        this.batchEndCallbacks = parent
      }
      if (!parent) this.notify(callbacks, undefined, "batch-end")
    }))
  }

  /** Coalesces a subscriber's publication inside this batch's Solid update. */
  deferUntilBatchEnd(callback: () => void): boolean {
    if (!this.batchEndCallbacks) return false
    this.batchEndCallbacks.add(callback)
    return true
  }

  private emitTransportStatus(status: WorkspaceEventTransportStatus) {
    // Deliver already accepted events before reconnect observers read authority.
    this.flushPendingBatch()
    this.notify(this.statusHandlers, status, "transport-status")
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

  probeStale(reason: string): void {
    // Elapsed-time probe, not the interval's episode flag: the resume/online
    // probe is the fast path and must reconnect as soon as the same threshold
    // has elapsed, without waiting for the interval backstop to tick first.
    if (!this.connection || !this.watchdog.probe()) {
      return
    }

    logSse("Probing stale events stream", { reason })
    this.restart(reason)
  }

  restart(reason = "manual restart"): void {
    this.retryDelay = RETRY_BASE_DELAY
    this.clearReconnectTimer()
    this.watchdog.setConnected(false)

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
