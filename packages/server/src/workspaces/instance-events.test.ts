import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeEvent } from "@opencode-ai/client"
import { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import { InstanceEventBridge } from "./instance-events"
import type { WorkspaceManager } from "./manager"

const logger = {
  debug() {},
  warn() {},
} as unknown as Logger

function waitFor(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for event")), 1000)
    const poll = () => {
      if (check()) {
        clearTimeout(timeout)
        resolve()
      } else {
        setTimeout(poll, 0)
      }
    }
    poll()
  })
}

describe("InstanceEventBridge", () => {
  it("routes root and owned worktree events to the logical workspace and caches ownership", async () => {
    const events = [
      { id: "1", created: 1, type: "permission.asked", location: { directory: "/repo-a" }, data: { id: "p1" } },
      {
        id: "2",
        created: 2,
        type: "session.created",
        durable: { aggregateID: "session-1", seq: 1, version: 1 },
        location: { directory: "/repo-a" },
        data: {
          sessionID: "session-1",
          projectID: "project-1",
          location: { directory: "/repo-a" },
          slug: "session",
          version: "1",
        },
      },
      { id: "3", created: 3, type: "permission.asked", location: { directory: "/other" }, data: { id: "p2" } },
      { id: "4", created: 4, type: "server.connected", data: {} },
      {
        id: "5",
        created: 5,
        type: "session.text.delta",
        location: { directory: "/repo-a/.worktrees/feature" },
        data: { sessionID: "session-2", assistantMessageID: "message-1", ordinal: 0, delta: "hello" },
      },
      {
        id: "6",
        created: 6,
        type: "session.text.delta",
        location: { directory: "/repo-a/.worktrees/feature" },
        data: { sessionID: "session-2", assistantMessageID: "message-1", ordinal: 1, delta: " again" },
      },
    ] as OpenCodeEvent[]
    const ownerLookups = new Map<string, number>()
    const manager = {
      list: () => [
        { id: "a", path: "/repo-a" },
        { id: "b", path: "/repo-b" },
      ],
      ownsDirectory: async (workspaceId: string, directory: string) => {
        ownerLookups.set(directory, (ownerLookups.get(directory) ?? 0) + 1)
        await Promise.resolve()
        return workspaceId === "a" && (directory === "/repo-a" || directory === "/repo-a/.worktrees/feature")
      },
      subscribeToSharedService: async (signal?: AbortSignal) => (async function* () {
        yield* events
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
      })(),
    } as unknown as WorkspaceManager
    const bus = new EventBus()
    const received: any[] = []
    bus.on("instance.event", (event) => received.push(event))

    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })
    try {
      bus.publish({ type: "workspace.started", workspace: manager.list()[0] as any })
      await waitFor(() => received.length === 4)
      assert.equal(received[0].instanceId, "a")
      assert.deepEqual(received[0].event.location, { directory: "/repo-a" })
      assert.deepEqual(received[0].event.data, { id: "p1" })
      assert.deepEqual(received[0].event.properties, { id: "p1" })
      assert.equal(received[1].event.data.sessionID, "session-1")
      assert.equal(received[1].event.properties.info.id, "session-1")
      assert.equal(received[2].instanceId, "a")
      assert.deepEqual(received[2].event.properties, {
        sessionID: "session-2",
        assistantMessageID: "message-1",
        ordinal: 0,
        delta: "hello",
      })
      assert.equal(received[3].instanceId, "a")
      assert.equal(received[3].event.properties.delta, " again")
      assert.equal(ownerLookups.get("/repo-a/.worktrees/feature"), 2)
    } finally {
      bridge.shutdown()
    }
  })

  it("fans an event out to every logical workspace for the same directory", async () => {
    const manager = {
      list: () => [{ id: "first", path: "/repo" }, { id: "second", path: "/repo" }],
      ownsDirectory: async (_workspaceId: string, directory: string) => directory === "/repo",
      subscribeToSharedService: async (signal?: AbortSignal) => (async function* () {
        yield { id: "1", created: 1, type: "permission.asked", location: { directory: "/repo" }, data: { id: "p1" } } as OpenCodeEvent
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
      })(),
    } as unknown as WorkspaceManager
    const bus = new EventBus()
    const received: string[] = []
    bus.on("instance.event", (event) => received.push(event.instanceId))

    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })
    try {
      bus.publish({ type: "workspace.started", workspace: manager.list()[0] as any })
      await waitFor(() => received.length === 2)
      assert.deepEqual(received, ["first", "second"])
    } finally {
      bridge.shutdown()
    }
  })
})
