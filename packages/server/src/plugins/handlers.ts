import type { EventBus } from "../events/bus"
import type { WorkspaceManager } from "../workspaces/manager"
import type { Logger } from "../logger"
import type { PluginOutboundEvent } from "./channel"

export interface PluginInboundEvent {
  type: string
  properties?: Record<string, unknown>
}

interface HandlerDeps {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
}

export function handlePluginEvent(workspaceId: string, event: PluginInboundEvent, deps: HandlerDeps) {
  switch (event.type) {
    case "codenomad.pong":
      deps.logger.debug({ workspaceId, properties: event.properties }, "Plugin pong received")
      return

    default:
      deps.logger.debug({ workspaceId, eventType: event.type }, "Unhandled plugin event")
  }
}

export function buildPingEvent(): PluginOutboundEvent {

  return {
    type: "codenomad.ping",
    properties: {
      ts: Date.now(),
    },
  }
}
