import type { Logger } from "../logger"

const STALE_CONNECTION_TIMEOUT_MS = 45000
const STALE_SWEEP_INTERVAL_MS = 5000

export interface ClientConnectionRef {
  clientId: string
  connectionId: string
}

export interface ClientConnectionRecord extends ClientConnectionRef {
  key: string
  lastSeenAt: number
}

interface RegisteredConnection extends ClientConnectionRecord {
  close: () => void
}

export class ClientConnectionManager {
  private readonly connections = new Map<string, RegisteredConnection>()
  private readonly sweepTimer: NodeJS.Timeout

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
      lastSeenAt: now,
      close: input.close,
    }
    this.connections.set(key, connection)
    this.logger.debug({ clientId: input.clientId, connectionId: input.connectionId }, "Client connected")
    return () => this.disconnect(key, "closed", true, connection)
  }

  pong(input: ClientConnectionRef): boolean {
    const key = getConnectionKey(input)
    const connection = this.connections.get(key)
    if (!connection) {
      this.logger.debug({ clientId: input.clientId, connectionId: input.connectionId }, "Ignoring pong for unknown client connection")
      return false
    }

    connection.lastSeenAt = Date.now()
    return true
  }

  private sweepStaleConnections(): void {
    const cutoff = Date.now() - STALE_CONNECTION_TIMEOUT_MS
    for (const connection of Array.from(this.connections.values())) {
      if (connection.lastSeenAt > cutoff) continue
      this.logger.debug({ clientId: connection.clientId, connectionId: connection.connectionId }, "Client connection timed out")
      this.disconnect(connection.key, "timeout")
    }
  }

  private disconnect(key: string, reason: string, invokeClose = true, expected?: RegisteredConnection): void {
    const connection = this.connections.get(key)
    if (!connection || (expected && connection !== expected)) return
    this.connections.delete(key)
    this.logger.debug({ clientId: connection.clientId, connectionId: connection.connectionId, reason }, "Client disconnected")

    if (invokeClose) {
      try {
        connection.close()
      } catch (error) {
        this.logger.warn({ err: error, clientId: connection.clientId, connectionId: connection.connectionId }, "Failed to close stale client connection")
      }
    }
  }
}

function getConnectionKey(input: ClientConnectionRef): string {
  return JSON.stringify([input.clientId, input.connectionId])
}
