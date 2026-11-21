import { batch as solidBatch, untrack } from "solid-js"
import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { serverApi, type ServerApi } from "./api-client"
import { getClientIdentity } from "./client-identity"
import {
  connectWorkspaceEvents,
  type WorkspaceEventConnection,
  type WorkspaceEventTransportStatus,
} from "./event-transport"
import { getLogger } from "./logger"
import { retryWithBackoff, isRetryableError } from "./retry-utils"
import { createStreamStalenessWatchdog } from "./stream-staleness"
import { authRecovery, type AuthRecovery } from "./auth-recovery"
import { backendEvents } from "./backend-events"
export { backendEvents } from "./backend-events"

const RETRY_BASE_DELAY = 1000
const RETRY_MAX_DELAY = 10000
const FRAME_FALLBACK_MS = 32
const log = getLogger("sse")

function isStreamingDelta(event: WorkspaceEventPayload): boolean {
  if (event.type !== "instance.event") return false
  const type = event.event?.type
  return type === "session.text.delta" || type === "session.reasoning.delta"
}

function logSse(message: string, context?: Record<string, unknown>) {
  if (context) {
    log.info(message, context)
    return
  }
  log.info(message)
}

export interface ServerEventsOptions {
  api: Pick<ServerApi, "connectEvents" | "sendClientConnectionPong">
  auth: Pick<AuthRecovery, "check" | "onRestored">
}

/** One backend's events stream; it connects only once `start()` is called. */
export class ServerEvents {
  private readonly api: ServerEventsOptions["api"]
  private readonly auth: ServerEventsOptions["auth"]
  private started = false
  private disposed = false
  private cleanup: (() => void)[] = []
  private disposeHandlers = new Set<() => void>()
  private lifetime = new AbortController()
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
  private connectionValidator?: (signal: AbortSignal) => Promise<boolean>
  private validation?: AbortController
  private watchdog = createStreamStalenessWatchdog({
    onStale: () => this.restart("stream stale"),
  })

  constructor(options: ServerEventsOptions) {
    this.api = options.api
    this.auth = options.auth
  }

  /** Remote admission installs this before start; every connection precedes domain resyncs. */
  setConnectionValidator(validate: (signal: AbortSignal) => Promise<boolean>): void {
    if (this.started || this.disposed) throw new Error("Connection validation must precede start")
    this.connectionValidator = validate
  }

  /** Capture synchronously on open, before deferring connection-owned work. */
  connectionGuard(): () => boolean {
    const generation = this.connectGeneration
    return () => !this.disposed && generation === this.connectGeneration
  }

  start(): Promise<void> | undefined {
    if (this.started || this.disposed) return
    this.started = true
    this.cleanup.push(this.auth.onRestored(() => this.restart("authentication restored")))
    if (typeof window !== "undefined") {
      const rendererWindow = window
      // Minimal renderer globals (tests, embedded previews) may define window
      // without event APIs; the probes are enhancements, never requirements.
      const online = () => this.probeStale("network online")
      window.addEventListener?.("online", online)
      this.cleanup.push(() => rendererWindow.removeEventListener?.("online", online))
      if (typeof document !== "undefined") {
        const rendererDocument = document
        const visible = () => {
          this.flushPendingBatch()
          if (rendererDocument.visibilityState === "visible") {
            this.probeStale("visibility restored")
          }
        }
        document.addEventListener?.("visibilitychange", visible)
        this.cleanup.push(() => rendererDocument.removeEventListener?.("visibilitychange", visible))
      }
      return this.connect()
    }
  }

  private async connect() {
    if (this.disposed) return
    const generation = ++this.connectGeneration
    this.clearReconnectTimer()

    if (this.connection) {
      const connection = this.connection
      this.connection = null
      connection.disconnect()
      this.emitTransportStatus("disconnected")
      if (this.disposed || generation !== this.connectGeneration) return
      this.watchdog.setConnected(false)
    }

    logSse("Connecting to backend events stream")
    let opening: (() => void)[] = []

    try {
      if (this.connectionValidator) {
        this.validation?.abort()
        const validation = this.validation = new AbortController()
        if (!await this.connectionValidator(AbortSignal.any([this.lifetime.signal, validation.signal]))) return
      }
      if (this.disposed || generation !== this.connectGeneration) return
      const connection = await connectWorkspaceEvents({
        onEvent: (event) => {
          if (generation !== this.connectGeneration) return
          this.watchdog.activity()
          this.admitEvent(event)
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
          if (status === "connected") opening = [...this.openHandlers]
          this.emitTransportStatus(status, generation)
        },
        onOpen: () => {
          if (generation !== this.connectGeneration) {
            return
          }
          this.watchdog.activity()
          logSse("Events stream connected")
          this.retryDelay = RETRY_BASE_DELAY
          this.notify(this.openHandlers, undefined, "open", generation, opening)
        },
        onPing: (payload) => {
          if (generation !== this.connectGeneration) {
            return
          }
          this.watchdog.activity()
          const identity = getClientIdentity()
          const pongPayload = { ...identity, pingTs: payload.ts }

          void retryWithBackoff(
            (signal) => this.api.sendClientConnectionPong(pongPayload, signal),
            {
              maxAttempts: 3,
              initialDelayMs: 100,
              maxDelayMs: 2000,
              timeoutMs: 10000,
              signal: this.lifetime.signal,
              shouldRetry: (error) => isRetryableError(error),
            },
          ).catch((error) => {
            if (!this.lifetime.signal.aborted) log.warn("Failed to send client connection pong after retries", error)
          })
        },
      }, this.api)

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
    if (this.disposed) return
    const previousGeneration = this.connectGeneration
    // EventSource hides HTTP status. Probe our own auth endpoint so a server
    // restart is recoverable even when the user has not made another API call.
    void this.auth.check(this.lifetime.signal)
    if (this.disposed || previousGeneration !== this.connectGeneration) return
    if (this.retryTimer) {
      return
    }

    this.flushPendingBatch()
    if (this.disposed || previousGeneration !== this.connectGeneration) return
    const generation = ++this.connectGeneration

    this.validation?.abort()

    if (this.connection) {
      const connection = this.connection
      this.connection = null
      connection.disconnect()
    }
    if (this.disposed || generation !== this.connectGeneration) return

    this.watchdog.setConnected(false)
    this.emitTransportStatus("disconnected")
    if (this.disposed || generation !== this.connectGeneration) return

    logSse("Events stream disconnected, scheduling reconnect", { delayMs: this.retryDelay })
    this.retryTimer = setTimeout(() => {
      if (this.disposed || generation !== this.connectGeneration) return
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

  private dispatch(event: WorkspaceEventPayload, wildcardRecipients?: ((event: WorkspaceEventPayload) => void)[]) {
    const generation = this.connectGeneration
    this.notify(this.handlers.get("*"), event, event.type, generation, wildcardRecipients)
    this.notify(this.handlers.get(event.type), event, event.type, generation)
  }

  private notify<T>(handlers: Set<(value: T) => void> | undefined, value: T, kind: string, generation = this.connectGeneration,
    recipients = [...handlers ?? []]): void {
    for (const handler of recipients) {
      if (generation !== this.connectGeneration || this.disposed && kind !== "dispose") break
      if (!handlers?.has(handler)) continue
      try {
        handler(value)
      } catch (error) {
        // A feature failure must not discard another feature's native event or
        // interrupt the connection lifecycle. Do not replay failed handlers.
        log.error("Backend event subscriber failed", { kind, error })
      }
    }
  }

  private admitEvent(event: WorkspaceEventPayload): void {
    if (this.disposed) return
    this.pendingBatch.push(event)
    if (!isStreamingDelta(event) || (typeof document === "undefined" && typeof requestAnimationFrame !== "function")) {
      this.flushPendingBatch()
      return
    }
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

  /** Delivers buffered deltas before a consumer reads the transcript or its live state. */
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
    const generation = this.connectGeneration
    solidBatch(() => untrack(() => {
      // A replacement attachment cannot observe the rest of an older batch.
      const wildcardRecipients = [...this.handlers.get("*") ?? []]
      const parent = this.batchEndCallbacks
      const callbacks = parent ?? new Set<() => void>()
      this.batchEndCallbacks = callbacks
      try {
        for (const event of events) {
          if (this.disposed || generation !== this.connectGeneration) break
          this.dispatch(event, wildcardRecipients)
        }
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

  private emitTransportStatus(status: WorkspaceEventTransportStatus, generation = this.connectGeneration) {
    // Deliver already accepted events before reconnect observers read authority.
    this.flushPendingBatch()
    this.notify(this.statusHandlers, status, "transport-status", generation)
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
    if (this.disposed) return
    const previousGeneration = this.connectGeneration
    this.flushPendingBatch()
    if (this.disposed || previousGeneration !== this.connectGeneration) return
    const generation = ++this.connectGeneration
    this.validation?.abort()
    this.retryDelay = RETRY_BASE_DELAY
    this.clearReconnectTimer()
    this.watchdog.setConnected(false)

    if (this.connection) {
      const connection = this.connection
      this.connection = null
      connection.disconnect()
      this.emitTransportStatus("disconnected")
    }
    if (this.disposed || generation !== this.connectGeneration) return

    logSse("Restarting backend events stream", { reason })
    void this.connect()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.connectGeneration++
    this.cancelBatchWake?.()
    this.cancelBatchWake = undefined
    this.pendingBatch = []
    this.validation?.abort()
    this.clearReconnectTimer()
    this.connection?.disconnect()
    this.connection = null
    this.watchdog.dispose()
    this.lifetime.abort()
    this.cleanup.forEach(cleanup => cleanup())
    this.cleanup = []
    this.notify(this.disposeHandlers, undefined, "dispose")
    this.disposeHandlers.clear()
    this.handlers.clear()
    this.openHandlers.clear()
    this.statusHandlers.clear()
  }

  onDispose(handler: () => void): () => void {
    if (this.disposed) { handler(); return () => {} }
    this.disposeHandlers.add(handler)
    return () => { this.disposeHandlers.delete(handler) }
  }
}

export const serverEvents = new ServerEvents({ api: serverApi, auth: authRecovery })
backendEvents.attach("local", serverEvents)
serverEvents.start()
