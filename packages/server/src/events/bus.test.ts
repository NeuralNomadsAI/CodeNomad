import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { EventBus } from "./bus"
import type { WorkspaceEventPayload } from "../api-types"

describe("event bus instance status replay", () => {
  it("replays the latest instance status to a late subscriber", () => {
    const bus = new EventBus()
    bus.publish({ type: "instance.eventStatus", instanceId: "workspace-1", status: "connecting" })
    bus.publish({ type: "instance.eventStatus", instanceId: "workspace-1", status: "connected" })

    const received: WorkspaceEventPayload[] = []
    bus.onEvent((event) => received.push(event))

    assert.deepEqual(received, [
      { type: "instance.eventStatus", instanceId: "workspace-1", status: "connected" },
    ])
  })

  it("delivers terminal disconnects live without replaying stopped workspaces", () => {
    const bus = new EventBus()
    bus.publish({ type: "instance.eventStatus", instanceId: "workspace-1", status: "connected" })
    const live: WorkspaceEventPayload[] = []
    bus.onEvent((event) => live.push(event))
    live.length = 0

    bus.publish({
      type: "instance.eventStatus",
      instanceId: "workspace-1",
      status: "disconnected",
      reason: "workspace stopped",
    })

    assert.deepEqual(live, [{
      type: "instance.eventStatus",
      instanceId: "workspace-1",
      status: "disconnected",
      reason: "workspace stopped",
    }])
    const replayed: WorkspaceEventPayload[] = []
    bus.onEvent((event) => replayed.push(event))
    assert.deepEqual(replayed, [])
  })
})

describe("event bus sequence replay", () => {
  it("bounds replay and preserves replay-to-live publish order", () => {
    const bus = new EventBus(undefined, 2)
    for (const sequence of [1, 2, 3]) {
      bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence } } as never)
    }

    const received: Array<{ id?: number; sequence: number }> = []
    bus.onEvent((event, id) => {
      const sequence = (event as never as { entry: { sequence: number } }).entry.sequence
      received.push({ id, sequence })
      if (sequence === 2) {
        bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence: 4 } } as never)
      }
    }, 1)

    assert.deepEqual(received, [
      { id: 2, sequence: 2 },
      { id: 3, sequence: 3 },
      { id: 4, sequence: 4 },
    ])
  })

  it("signals overflow before live delivery instead of replaying a partial window", () => {
    const bus = new EventBus(undefined, 2)
    for (const sequence of [1, 2, 3]) {
      bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence } } as never)
    }

    const received: string[] = []
    bus.onEvent(
      (event, id) => received.push(`${id}:${(event as never as { entry: { sequence: number } }).entry.sequence}`),
      0,
      (gap) => {
        received.push(`reset:${gap.requestedId}:${gap.earliestAvailableId}:${gap.latestEventId}`)
        bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence: 4 } } as never)
      },
    )

    assert.deepEqual(received, ["reset:0:2:3", "4:4"])
  })
})
