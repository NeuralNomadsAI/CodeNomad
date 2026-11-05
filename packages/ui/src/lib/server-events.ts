import { batch as solidBatch } from "solid-js"
import type { InstanceEventSource, WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
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
const log = getLogger("sse")
type InstanceStatus = Extract<WorkspaceEventPayload, { type: "instance.eventStatus" }>
export interface InstanceEventContext {
  source?: InstanceEventSource
  liveGeneration?: number
  current: () => boolean
}
const positiveGeneration = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
function contradictoryBoundary(previous: InstanceStatus | undefined, event: InstanceStatus): boolean {
  return Boolean(previous?.source?.serverId === event.source?.serverId && previous?.source?.generation === event.source?.generation
    && positiveGeneration(previous?.liveGeneration) && previous.liveGeneration === event.liveGeneration
    && (previous.status !== event.status || previous.source?.connectionGeneration !== event.source?.connectionGeneration))
}

function logSse(message: string, context?: Record<string, unknown>) {
  if (context) {
    log.info(message, context)
    return
  }
  log.info(message)
}

export class ServerEvents {
  private bindingReader: (instanceId: string) => string | undefined = () => undefined
  private sourceGenerations = new Map<string, number>()
  private liveStatuses = new Map<string, InstanceStatus>()
  // ponytail: retired IDs live for this transport; prune proven retired attempts if occurrence churn grows.
  private retiredInstances = new Set<string>()
  private deferredStatuses = new Map<string, Extract<WorkspaceEventPayload, { type: "instance.eventStatus" }>>()
  private handlers = new Map<WorkspaceEventType | "*", Set<(event: WorkspaceEventPayload) => void>>()
  private openHandlers = new Set<() => void>()
  private statusHandlers = new Set<(status: WorkspaceEventTransportStatus) => void>()
  private participationHandlers = new Set<(grant: { token: string; current: () => boolean } | undefined) => void>()
  private participation?: { token: string; current: () => boolean }
  private connection: WorkspaceEventConnection | null = null
  private connectGeneration = 0
  private retryDelay = RETRY_BASE_DELAY
  private retryTimer: ReturnType<typeof setTimeout> | null = null
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
    this.participation = undefined
    this.notify(this.participationHandlers, undefined, "participation")
    this.sourceGenerations.clear()
    this.liveStatuses = new Map()
    this.retiredInstances.clear()
    this.deferredStatuses.clear()
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
          this.dispatchBatch(events)
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
        onParticipation: (payload) => {
          if (generation !== this.connectGeneration || !payload || typeof payload !== "object"
            || Object.keys(payload).length !== 1 || !("token" in payload) || typeof payload.token !== "string" || !/^[a-f0-9]{64}$/.test(payload.token)) return
          const current = this.captureTransportAuthority()
          const grant = { token: payload.token, current: () => this.participation === grant && generation === this.connectGeneration && current() }
          this.participation = grant
          this.notify(this.participationHandlers, this.participation, "participation")
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
    if (event.type === "instance.eventStatus" && event.source && event.source.serverId !== "local-shared"
      && this.bindingReader(event.instanceId) === undefined) {
      const key = JSON.stringify([event.instanceId, event.source.serverId])
      const previous = this.deferredStatuses.get(key)
      if (previous?.source && previous.source.generation > event.source.generation) return
      if (!this.validCorrelation(event)) return
      if (previous?.source?.generation === event.source.generation && (previous?.liveGeneration ?? 0) > event.liveGeneration!) return
      if (contradictoryBoundary(previous, event)) return
      if (this.deferredStatuses.size >= 1024 && !this.deferredStatuses.has(key)) this.deferredStatuses.delete(this.deferredStatuses.keys().next().value!)
      this.deferredStatuses.set(key, event)
      return
    }
    if (!this.acceptSource(event)) return
    this.notify(this.handlers.get("*"), event, event.type)
    this.notify(this.handlers.get(event.type), event, event.type)
  }

  setBindingReader(reader: (instanceId: string) => string | undefined): void { this.bindingReader = reader }

  syncInstanceBinding(instanceId: string): void {
    const key = JSON.stringify([instanceId, this.bindingReader(instanceId) ?? "local-shared"])
    const status = this.deferredStatuses.get(key)
    if (!status) return
    this.deferredStatuses.delete(key)
    this.dispatch(status)
  }

  private acceptSource(event: WorkspaceEventPayload): boolean {
    if (event.type !== "instance.event" && event.type !== "instance.eventStatus") return true
    const binding = this.bindingReader(event.instanceId) ?? "local-shared"
    const source = event.source
    if (!source) return binding === "local-shared"
    if (source.serverId !== binding || !Number.isSafeInteger(source.generation) || source.generation < 1) return false
    if (!this.validCorrelation(event)) return false
    const generation = this.sourceGenerations.get(source.serverId)
    if (generation !== undefined && source.generation < generation) return false
    if (event.type === "instance.eventStatus") {
      const previous = this.liveStatuses.get(event.instanceId)
      if (binding !== "local-shared" && this.retiredInstances.has(event.instanceId) && previous?.source?.serverId === source.serverId
        && (event.liveGeneration ?? 0) <= (previous.liveGeneration ?? 0)) return false
      if (previous?.source?.serverId === source.serverId && previous.source.generation === source.generation
        && positiveGeneration(previous.liveGeneration) && positiveGeneration(event.liveGeneration)) {
        if ((previous.liveGeneration ?? 0) > (event.liveGeneration ?? 0)) return false
        if (previous.liveGeneration === event.liveGeneration) {
          if (previous.status !== event.status || previous.source.connectionGeneration !== source.connectionGeneration) return false
          this.sourceGenerations.set(source.serverId, source.generation)
          return true
        }
      }
      this.sourceGenerations.set(source.serverId, source.generation)
      this.retiredInstances.delete(event.instanceId)
      this.liveStatuses.set(event.instanceId, event)
      return true
    }
    // A status is the authoritative handshake, never an arbitrary business frame.
    const status = this.liveStatuses.get(event.instanceId)
    return generation === source.generation && (binding === "local-shared"
      || status?.source?.connectionGeneration === source.connectionGeneration)
  }

  private validCorrelation(event: Extract<WorkspaceEventPayload, { type: "instance.event" | "instance.eventStatus" }>): boolean {
    if (event.source?.serverId === "local-shared") return true
    return positiveGeneration(event.liveGeneration) && ((event.type === "instance.eventStatus" && event.status !== "connected" && event.source?.connectionGeneration === undefined)
      || positiveGeneration(event.source?.connectionGeneration))
  }

  /** Capture the accepted source at dispatch, independently of late workspace metadata. */
  captureEventContext(event: Extract<WorkspaceEventPayload, { type: "instance.event" | "instance.eventStatus" }>): InstanceEventContext {
    const statuses = this.liveStatuses, status = statuses.get(event.instanceId), lifetime = this.connectGeneration
    const source = event.source && { ...event.source }, liveGeneration = event.liveGeneration
    return { source, liveGeneration, current: () => Boolean(status && !this.retiredInstances.has(event.instanceId)
      && this.liveStatuses === statuses && lifetime === this.connectGeneration
      && this.liveStatuses.get(event.instanceId) === status && status.status === "connected"
      && source?.serverId === status.source?.serverId && source?.generation === status.source?.generation
      && source?.connectionGeneration === status.source?.connectionGeneration && liveGeneration === status.liveGeneration) }
  }

  captureTransportAuthority(): () => boolean {
    const statuses = this.liveStatuses, lifetime = this.connectGeneration
    return () => this.liveStatuses === statuses && this.connectGeneration === lifetime
  }

  retireInstance(instanceId: string): void {
    const source = this.liveStatuses.get(instanceId)?.source
    if (source && source.serverId !== "local-shared") this.retiredInstances.add(instanceId)
  }

  private notify<T>(handlers: Set<(value: T) => void> | undefined, value: T, kind: string): void {
    handlers?.forEach((handler) => {
      try {
        handler(value)
      } catch {
        // A feature failure must not discard another feature's native event or
        // interrupt the connection lifecycle. Do not replay failed handlers.
        log.error("Backend event subscriber failed", { kind, category: "event-subscriber-failed" })
      }
    })
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
    if (status !== "connected") this.liveStatuses = new Map()
    if (status !== "connected") {
      this.participation = undefined
      this.notify(this.participationHandlers, undefined, "participation")
    }
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

  onParticipation(handler: (grant: { token: string; current: () => boolean } | undefined) => void) {
    this.participationHandlers.add(handler)
    handler(this.participation)
    return () => this.participationHandlers.delete(handler)
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
