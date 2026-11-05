import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { EventBus } from "./bus"
import type { WorkspaceEventPayload } from "../api-types"

describe("event bus instance status replay", () => {
  it("purges only the terminated occurrence before notifying stop/error subscribers", () => {
    const bus = new EventBus()
    const publish = (instanceId: string, serverId: string, generation = 1) => bus.publish({
      type: "instance.eventStatus", instanceId, source: { serverId, generation }, generation, status: "connected",
    })
    const replay = () => {
      const frames: WorkspaceEventPayload[] = []
      const off = bus.onEvent(frame => frames.push(frame)); off()
      return frames
    }
    publish("local", "local-shared")
    publish("sibling", "B")
    bus.publish({ type: "instance.eventStatus", instanceId: "offline", source: { serverId: "A", generation: 1 }, generation: 1, status: "error", gap: "transport" })
    for (const type of ["workspace.stopped", "workspace.error"] as const) {
      publish("closed", "A")
      publish("closed", "B")
      const check = () => assert.deepEqual(replay().map(frame => "instanceId" in frame && frame.instanceId), ["local", "sibling", "offline"])
      bus.once(type, check)
      if (type === "workspace.stopped") bus.publish({ type, workspaceId: "closed", reason: "deleted" })
      else bus.publish({ type, workspace: { id: "closed" } as Extract<WorkspaceEventPayload, { type: "workspace.error" }>["workspace"] })
      check()
    }
    publish("closed", "A", 2)
    publish("closed", "A", 1)
    const fresh = replay().find(frame => "instanceId" in frame && frame.instanceId === "closed")
    assert.equal(fresh?.type === "instance.eventStatus" && fresh.source?.generation, 2)
    assert.equal(bus.listenerCount("instance.eventStatus"), 0)
  })

  it("replays the latest instance status to a late subscriber", () => {
    const bus = new EventBus()
    bus.publish({ type: "instance.eventStatus", instanceId: "workspace-1", status: "connecting", generation: 1 })
    bus.publish({ type: "instance.eventStatus", instanceId: "workspace-1", status: "connected", generation: 1 })

    const received: WorkspaceEventPayload[] = []
    bus.onEvent((event) => received.push(event))

    assert.deepEqual(received, [
      { type: "instance.eventStatus", instanceId: "workspace-1", status: "connected", generation: 1 },
    ])
  })

  it("delivers terminal disconnects live without replaying stopped workspaces", () => {
    const bus = new EventBus()
    bus.publish({ type: "instance.eventStatus", instanceId: "workspace-1", status: "connected", generation: 1 })
    const live: WorkspaceEventPayload[] = []
    bus.onEvent((event) => live.push(event))
    live.length = 0

    bus.publish({
      type: "instance.eventStatus",
      instanceId: "workspace-1",
      status: "disconnected",
      generation: 1,
      reason: "workspace stopped",
    })

    assert.deepEqual(live, [{
      type: "instance.eventStatus",
      instanceId: "workspace-1",
      status: "disconnected",
      generation: 1,
      reason: "workspace stopped",
    }])
    const replayed: WorkspaceEventPayload[] = []
    bus.onEvent((event) => replayed.push(event))
    assert.deepEqual(replayed, [])
  })
})
