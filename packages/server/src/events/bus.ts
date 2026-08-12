import { EventEmitter } from "events"
import { randomUUID } from "node:crypto"
import { WorkspaceEventPayload } from "../api-types"
import { Logger } from "../logger"

export interface EventReplayGap {
  requestedCursor: string
  earliestAvailableCursor: string
  latestCursor: string
}

const DEFAULT_REPLAY_BYTE_LIMIT = 8 * 1024 * 1024

export class EventBus extends EventEmitter {
  private readonly instanceStatuses = new Map<string, Extract<WorkspaceEventPayload, { type: "instance.eventStatus" }>>()
  private readonly replay: Array<{ id: number; event: WorkspaceEventPayload; bytes: number }> = []
  private readonly deliveryQueue: Array<{ id: number; event: WorkspaceEventPayload }> = []
  private replayBytes = 0
  private nextEventId = 0
  private latestDeliveredEventId = 0
  private currentDeliveryId: number | undefined
  private dispatching = false

  constructor(
    private readonly logger?: Logger,
    private readonly replayLimit = 1_000,
    private readonly replayByteLimit = DEFAULT_REPLAY_BYTE_LIMIT,
    private readonly epoch: string = randomUUID(),
  ) {
    super()
  }

  get latestCursor(): string {
    return this.cursor(this.currentDeliveryId ?? this.latestDeliveredEventId)
  }

  publish(event: WorkspaceEventPayload): boolean {
    const sequenced = {
      id: ++this.nextEventId,
      event,
      bytes: Buffer.byteLength(JSON.stringify(event)) + this.epoch.length + 16,
    }
    this.replay.push(sequenced)
    this.replayBytes += sequenced.bytes
    while (this.replay.length > this.replayLimit || this.replayBytes > this.replayByteLimit) {
      this.replayBytes -= this.replay.shift()!.bytes
    }
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
    const hadListeners = this.listenerCount(event.type) > 0
    this.deliveryQueue.push(sequenced)
    if (this.dispatching) return hadListeners

    let delivered = false
    this.dispatching = true
    try {
      while (this.deliveryQueue.length > 0) {
        const next = this.deliveryQueue.shift()!
        this.currentDeliveryId = next.id
        delivered = super.emit(next.event.type, next.event, this.cursor(next.id)) || delivered
        this.latestDeliveredEventId = next.id
        this.currentDeliveryId = undefined
      }
    } finally {
      this.currentDeliveryId = undefined
      this.dispatching = false
    }
    return delivered
  }

  onEvent(
    listener: (event: WorkspaceEventPayload, cursor?: string) => void,
    afterCursor?: string,
    onReplayGap?: (gap: EventReplayGap) => void,
  ) {
    const replayBoundary = this.currentDeliveryId ?? this.latestDeliveredEventId
    const replaySnapshot = this.replay.filter((entry) => entry.id <= replayBoundary)
    const earliestAvailableId = replaySnapshot[0]?.id ?? replayBoundary + 1
    const afterId = afterCursor === undefined ? undefined : this.parseCursor(afterCursor)
    const replayGap = afterCursor !== undefined
      && (afterId === undefined || afterId < earliestAvailableId - 1 || afterId > replayBoundary)
    const pendingLive: Array<{ id: number; event: WorkspaceEventPayload }> = []
    let replaying = true
    const handler = (event: WorkspaceEventPayload, cursor: string) => {
      const id = this.parseCursor(cursor)
      if (id === undefined) return
      if (replaying) pendingLive.push({ event, id })
      else listener(event, cursor)
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
    if (afterCursor === undefined) {
      for (const status of this.instanceStatuses.values()) listener(status)
    } else if (replayGap) {
      onReplayGap?.({
        requestedCursor: afterCursor,
        earliestAvailableCursor: this.cursor(earliestAvailableId),
        latestCursor: this.cursor(replayBoundary),
      })
    } else {
      for (const entry of replaySnapshot) {
        if (entry.id > afterId!) listener(entry.event, this.cursor(entry.id))
      }
    }
    for (let index = 0; index < pendingLive.length; index += 1) {
      const entry = pendingLive[index]!
      listener(entry.event, this.cursor(entry.id))
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

  private cursor(id: number): string {
    return `${this.epoch}:${id}`
  }

  private parseCursor(cursor: string): number | undefined {
    const prefix = `${this.epoch}:`
    if (!cursor.startsWith(prefix)) return undefined
    const sequence = cursor.slice(prefix.length)
    if (!/^\d+$/.test(sequence)) return undefined
    const id = Number(sequence)
    return Number.isSafeInteger(id) ? id : undefined
  }
}
