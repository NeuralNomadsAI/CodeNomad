import { EventEmitter } from "events"
import { WorkspaceEventPayload } from "../api-types"
import { Logger } from "../logger"

export interface EventReplayGap {
  requestedId: number
  earliestAvailableId: number
  latestEventId: number
}

export class EventBus extends EventEmitter {
  private readonly instanceStatuses = new Map<string, Extract<WorkspaceEventPayload, { type: "instance.eventStatus" }>>()
  private readonly replay: Array<{ id: number; event: WorkspaceEventPayload }> = []
  private nextEventId = 0

  constructor(private readonly logger?: Logger, private readonly replayLimit = 1_000) {
    super()
  }

  get latestEventId(): number {
    return this.nextEventId
  }

  publish(event: WorkspaceEventPayload): boolean {
    const sequenced = { id: ++this.nextEventId, event }
    this.replay.push(sequenced)
    if (this.replay.length > this.replayLimit) this.replay.shift()
    if (event.type === "instance.eventStatus") {
      const terminal = event.status === "disconnected"
        && (event.reason === "workspace stopped" || event.reason === "workspace error")
      if (terminal) {
        this.instanceStatuses.delete(event.instanceId)
      } else {
        this.instanceStatuses.set(event.instanceId, event)
      }
    }
    if (event.type !== "instance.event" && event.type !== "instance.eventStatus") {
      this.logger?.debug({ type: event.type }, "Publishing workspace event")
      if (this.logger?.isLevelEnabled("trace")) {
        this.logger.trace({ event }, "Workspace event payload")
      }
    }
    return super.emit(event.type, event, sequenced.id)
  }

  onEvent(
    listener: (event: WorkspaceEventPayload, id?: number) => void,
    afterId?: number,
    onReplayGap?: (gap: EventReplayGap) => void,
  ) {
    const replayBoundary = this.nextEventId
    const replaySnapshot = this.replay.filter((entry) => entry.id <= replayBoundary)
    const earliestAvailableId = replaySnapshot[0]?.id ?? replayBoundary + 1
    const replayGap = afterId !== undefined
      && (afterId < earliestAvailableId - 1 || afterId > replayBoundary)
    const pendingLive: Array<{ id: number; event: WorkspaceEventPayload }> = []
    let replaying = true
    const handler = (event: WorkspaceEventPayload, id: number) => {
      if (replaying) pendingLive.push({ event, id })
      else listener(event, id)
    }
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
    this.on("yolo.stateChanged", handler)
    this.on("yolo.autoAccepted", handler)
    if (afterId === undefined) {
      for (const status of this.instanceStatuses.values()) listener(status)
    } else if (replayGap) {
      onReplayGap?.({ requestedId: afterId, earliestAvailableId, latestEventId: replayBoundary })
    } else {
      for (const entry of replaySnapshot) {
        if (entry.id > afterId) listener(entry.event, entry.id)
      }
    }
    for (let index = 0; index < pendingLive.length; index += 1) {
      const entry = pendingLive[index]!
      listener(entry.event, entry.id)
    }
    replaying = false
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
      this.off("yolo.stateChanged", handler)
      this.off("yolo.autoAccepted", handler)
    }
  }
}
