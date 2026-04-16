import { EventEmitter } from "events"
import { WorkspaceEventPayload } from "../api-types"
import { Logger } from "../logger"

export class EventBus extends EventEmitter {
  constructor(private readonly logger?: Logger) {
    super()
  }

  publish(event: WorkspaceEventPayload): boolean {
    if (event.type !== "instance.event" && event.type !== "instance.eventStatus") {
      this.logger?.debug({ type: event.type }, "Publishing workspace event")
      if (this.logger?.isLevelEnabled("trace")) {
        this.logger.trace({ event }, "Workspace event payload")
      }
    }
    return super.emit(event.type, event)
  }

  onEvent(listener: (event: WorkspaceEventPayload) => void) {
    const handler = (event: WorkspaceEventPayload) => listener(event)
    this.on("workspace.created", handler)
    this.on("workspace.started", handler)
    this.on("workspace.error", handler)
    this.on("workspace.stopped", handler)
    this.on("workspace.log", handler)
    this.on("sidecar.updated", handler)
    this.on("sidecar.removed", handler)
    this.on("storage.configChanged", handler)
    this.on("storage.stateChanged", handler)
    this.on("instance.dataChanged", handler)
    this.on("instance.event", handler)
    this.on("instance.eventStatus", handler)
    return () => {
      this.off("workspace.created", handler)
      this.off("workspace.started", handler)
      this.off("workspace.error", handler)
      this.off("workspace.stopped", handler)
      this.off("workspace.log", handler)
      this.off("sidecar.updated", handler)
      this.off("sidecar.removed", handler)
      this.off("storage.configChanged", handler)
      this.off("storage.stateChanged", handler)
      this.off("instance.dataChanged", handler)
      this.off("instance.event", handler)
      this.off("instance.eventStatus", handler)
    }
  }
}
