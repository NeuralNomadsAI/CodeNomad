import type { Logger } from "../logger"
import type { ClientConnectionManager, ClientConnectionRef } from "../clients/connection-manager"
import type { PluginChannelManager } from "./channel"

interface VoiceModeManagerOptions {
  connections: ClientConnectionManager
  channel: PluginChannelManager
  logger: Logger
}

export class VoiceModeManager {
  private readonly enabledConnectionsByInstance = new Map<string, Set<string>>()
  private readonly aggregateByInstance = new Map<string, boolean>()

  constructor(private readonly options: VoiceModeManagerOptions) {
    this.options.connections.subscribe((event) => {
      if (event.type !== "disconnected") return
      this.clearConnection(event.connection)
    })
  }

  setEnabled(instanceId: string, connection: ClientConnectionRef, enabled: boolean): void {
    if (enabled && !this.options.connections.isConnected(connection)) {
      this.options.logger.debug(
        { instanceId, clientId: connection.clientId, connectionId: connection.connectionId },
        "Ignoring voice mode enable for disconnected client connection",
      )
      return
    }

    const key = getConnectionKey(connection)
    const current = this.enabledConnectionsByInstance.get(instanceId) ?? new Set<string>()

    if (enabled) {
      current.add(key)
      this.enabledConnectionsByInstance.set(instanceId, current)
    } else if (current.delete(key)) {
      if (current.size === 0) {
        this.enabledConnectionsByInstance.delete(instanceId)
      } else {
        this.enabledConnectionsByInstance.set(instanceId, current)
      }
    }

    this.options.logger.debug({ instanceId, clientId: connection.clientId, connectionId: connection.connectionId, enabled }, "Voice mode updated for client connection")
    this.publishIfChanged(instanceId)
  }

  syncInstance(instanceId: string): void {
    this.options.channel.send(instanceId, buildVoiceModeEvent(this.isEnabled(instanceId)))
  }

  isEnabled(instanceId: string): boolean {
    return this.aggregateByInstance.get(instanceId) === true
  }

  private clearConnection(connection: ClientConnectionRef): void {
    const key = getConnectionKey(connection)
    for (const [instanceId, enabledConnections] of Array.from(this.enabledConnectionsByInstance.entries())) {
      if (!enabledConnections.delete(key)) continue
      if (enabledConnections.size === 0) {
        this.enabledConnectionsByInstance.delete(instanceId)
      }
      this.publishIfChanged(instanceId)
    }
  }

  private publishIfChanged(instanceId: string): void {
    const enabled = (this.enabledConnectionsByInstance.get(instanceId)?.size ?? 0) > 0
    const previous = this.aggregateByInstance.get(instanceId) === true
    if (enabled === previous) return

    if (enabled) {
      this.aggregateByInstance.set(instanceId, true)
    } else {
      this.aggregateByInstance.delete(instanceId)
    }

    this.options.logger.debug({ instanceId, enabled }, "Broadcasting aggregate voice mode")
    this.options.channel.send(instanceId, buildVoiceModeEvent(enabled))
  }
}

function buildVoiceModeEvent(enabled: boolean) {
  return {
    type: "codenomad.voiceMode",
    properties: {
      enabled,
      formatVersion: "v1",
    },
  }
}

function getConnectionKey(connection: ClientConnectionRef): string {
  return `${connection.clientId}:${connection.connectionId}`
}
