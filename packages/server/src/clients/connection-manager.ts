import type { Logger } from "../logger"
import { createSseMonitor } from "./sse-monitor"

const STALE_CONNECTION_TIMEOUT_MS = 120000
const STALE_SWEEP_INTERVAL_MS = 10000

export interface ClientConnectionRef {
  clientId: string
  connectionId: string
}

export interface ClientConnectionRecord extends ClientConnectionRef {
  key: string
  connectedAt: number
  lastSeenAt: number
}

type ConnectionChangeEvent = {
  type: "connected" | "disconnected"
  connection: ClientConnectionRecord
  reason?: string
}

interface RegisteredConnection extends ClientConnectionRecord {
  close: () => void
}

export class ClientConnectionManager {
  private readonly connections = new Map<string, RegisteredConnection>()
  private readonly subscribers = new Set<(event: ConnectionChangeEvent) => void>()
  private readonly sweepTimer: NodeJS.Timeout
  private readonly monitor = createSseMonitor()

  constructor(private readonly logger: Logger) {
    this.sweepTimer = setInterval(() => this.sweepStaleConnections(), STALE_SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  shutdown(): void {
    clearInterval(this.sweepTimer)
    for (const connection of Array.from(this.connections.values())) {
      this.disconnect(connection.key, "shutdown", false)
    }
  }

  subscribe(listener: (event: ConnectionChangeEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  register(input: ClientConnectionRef & { close: () => void }): () => void {
    const key = getConnectionKey(input)
    const now = Date.now()
    const existing = this.connections.get(key)

    if (existing) {
      this.logger.debug({ clientId: input.clientId, connectionId: input.connectionId }, "Replacing existing client connection")
      this.disconnect(key, "replaced")
    }

    const connection: RegisteredConnection = {
      key,
      clientId: input.clientId,
      connectionId: input.connectionId,
      connectedAt: now,
      lastSeenAt: now,
      close: input.close,
    }
    this.connections.set(key, connection)
    this.logger.debug({ clientId: input.clientId, connectionId: input.connectionId }, "Client connected")
    this.monitor.logConnection(input.clientId, input.connectionId)
    this.notify({ type: "connected", connection })
    return () => this.disconnect(key, "closed")
  }

  pong(input: ClientConnectionRef): boolean {
    const key = getConnectionKey(input)
    const connection = this.connections.get(key)
    if (!connection) {
      this.logger.debug({ clientId: input.clientId, connectionId: input.connectionId }, "Ignoring pong for unknown client connection")
      this.monitor.logPongFailure(input.clientId, input.connectionId, "connection not found")
      return false
    }

    const latency = Date.now() - connection.lastSeenAt
    connection.lastSeenAt = Date.now()
    this.monitor.logPongSuccess(input.clientId, input.connectionId, latency)
    return true
  }

  isConnected(input: ClientConnectionRef): boolean {
    return this.connections.has(getConnectionKey(input))
  }

  private sweepStaleConnections(): void {
    const cutoff = Date.now() - STALE_CONNECTION_TIMEOUT_MS
    for (const connection of Array.from(this.connections.values())) {
      if (connection.lastSeenAt > cutoff) continue
      const age = Date.now() - connection.lastSeenAt
      this.logger.debug({ clientId: connection.clientId, connectionId: connection.connectionId }, "Client connection timed out")
      this.monitor.logStaleConnection(connection.clientId, connection.connectionId, age)
      this.disconnect(connection.key, "timeout")
    }
  }

  private disconnect(key: string, reason: string, invokeClose = true): void {
    const connection = this.connections.get(key)
    if (!connection) return
    this.connections.delete(key)
    this.logger.debug({ clientId: connection.clientId, connectionId: connection.connectionId, reason }, "Client disconnected")
    this.monitor.logDisconnection(connection.clientId, connection.connectionId, reason)

    if (invokeClose) {
      try {
        connection.close()
      } catch (error) {
        this.logger.warn({ err: error, clientId: connection.clientId, connectionId: connection.connectionId }, "Failed to close stale client connection")
      }
    }

    this.notify({ type: "disconnected", connection, reason })
  }

  private notify(event: ConnectionChangeEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event)
      } catch (error) {
        this.logger.warn({ err: error, eventType: event.type }, "Client connection subscriber failed")
      }
    }
  }
}

function getConnectionKey(input: ClientConnectionRef): string {
  return `${input.clientId}:${input.connectionId}`
}
