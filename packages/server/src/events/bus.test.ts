import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { EventBus, type EventReplayGap } from "./bus"
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
    const bus = new EventBus(undefined, 2, Infinity, "test")
    for (const sequence of [1, 2, 3]) {
      bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence } } as never)
    }

    const received: Array<{ cursor?: string; sequence: number }> = []
    bus.onEvent((event, cursor) => {
      const sequence = (event as never as { entry: { sequence: number } }).entry.sequence
      received.push({ cursor, sequence })
      if (sequence === 2) {
        bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence: 4 } } as never)
      }
    }, "test:1")

    assert.deepEqual(received, [
      { cursor: "test:2", sequence: 2 },
      { cursor: "test:3", sequence: 3 },
      { cursor: "test:4", sequence: 4 },
    ])
  })

  it("signals overflow before live delivery instead of replaying a partial window", () => {
    const bus = new EventBus(undefined, 2, Infinity, "test")
    for (const sequence of [1, 2, 3]) {
      bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence } } as never)
    }

    const received: string[] = []
    bus.onEvent(
      (event, cursor) => received.push(`${cursor}:${(event as never as { entry: { sequence: number } }).entry.sequence}`),
      "test:0",
      (gap) => {
        received.push(`reset:${gap.requestedCursor}:${gap.earliestAvailableCursor}:${gap.latestCursor}`)
        bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence: 4 } } as never)
      },
    )

    assert.deepEqual(received, ["reset:test:0:test:2:test:3", "test:4:4"])
  })

  it("rejects a cursor from a previous server epoch", () => {
    const previous = new EventBus(undefined, 1, Infinity, "old")
    previous.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: {} } as never)
    const bus = new EventBus(undefined, 1, Infinity, "new")
    let gap: unknown

    bus.onEvent(() => undefined, previous.latestCursor, (value) => {
      gap = value
    })

    assert.deepEqual(gap, {
      requestedCursor: "old:1",
      earliestAvailableCursor: "new:1",
      latestCursor: "new:0",
    })
  })

  it("delivers re-entrant publications to every listener in id order", () => {
    const bus = new EventBus(undefined, 10, Infinity, "test")
    const received: string[] = []
    bus.onEvent((event) => {
      if ((event as any).entry.sequence === 1) {
        bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence: 2 } } as never)
      }
    }, bus.latestCursor)
    bus.onEvent((event, cursor) => {
      received.push(`${cursor}:${(event as any).entry.sequence}`)
    }, bus.latestCursor)

    bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence: 1 } } as never)

    assert.deepEqual(received, ["test:1:1", "test:2:2"])
  })

  it("does not replay a queued re-entrant event twice to a new subscriber", () => {
    const bus = new EventBus(undefined, 10, Infinity, "test")
    const received: string[] = []
    bus.onEvent((event) => {
      if ((event as any).entry.sequence !== 1) return
      bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence: 2 } } as never)
      bus.onEvent((replayed, cursor) => {
        received.push(`${cursor}:${(replayed as any).entry.sequence}`)
      }, "test:0")
    }, bus.latestCursor)

    bus.publish({ type: "workspace.log", workspaceId: "workspace-1", entry: { sequence: 1 } } as never)

    assert.deepEqual(received, ["test:1:1", "test:2:2"])
  })

  it("bounds replay by serialized bytes", () => {
    const bus = new EventBus(undefined, 100, 250, "test")
    for (const sequence of [1, 2]) {
      bus.publish({
        type: "workspace.log",
        workspaceId: "workspace-1",
        entry: { sequence, message: "x".repeat(120) },
      } as never)
    }
    let gap: EventReplayGap | undefined

    bus.onEvent(() => undefined, "test:0", (value) => {
      gap = value
    })

    assert.equal(gap?.latestCursor, "test:2")
    assert.notEqual(gap?.earliestAvailableCursor, "test:1")
  })
})
