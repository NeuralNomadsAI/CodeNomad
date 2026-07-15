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
