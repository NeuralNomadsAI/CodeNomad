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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function waitFor(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for event")), 2000)
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

function locationlessManager(
  events: OpenCodeEvent[],
  sessionLocations: Record<string, string | Error>,
  workspaces = [{ id: "a", path: "/repo-a" }],
) {
  let sessionGets = 0
  const manager = {
    list: () => workspaces,
    ownsDirectory: async (workspaceId: string, directory: string) => (
      workspaces.some((workspace) => workspace.id === workspaceId && workspace.path === directory)
    ),
    getSharedServiceClient: async () => ({
      session: { get: async ({ sessionID }: { sessionID: string }) => {
        sessionGets++
        const location = sessionLocations[sessionID]
        if (location instanceof Error) throw location
        if (!location) throw new Error("Session not found")
        return { id: sessionID, location: { directory: location } }
      } },
    }),
    subscribeToSharedService: async (signal?: AbortSignal) => (async function* () {
      yield* events
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
    })(),
  } as unknown as WorkspaceManager
  return { manager, sessionGets: () => sessionGets }
}

describe("InstanceEventBridge", () => {
  it("does not publish connected until the stream confirms with its first event", async () => {
    const gate = deferred<void>()
    const manager = {
      list: () => [{ id: "a", path: "/repo-a" }],
      ownsDirectory: async () => true,
      subscribeToSharedService: async (signal?: AbortSignal) => (async function* () {
        await gate.promise
        yield { type: "permission.asked", location: { directory: "/repo-a" }, data: { id: "p1" } } as OpenCodeEvent
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
      })(),
    } as unknown as WorkspaceManager
    const bus = new EventBus()
    const statuses: string[] = []
    bus.on("instance.eventStatus", (event) => statuses.push(event.status))
    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })
    try {
      bus.publish({ type: "workspace.started", workspace: manager.list()[0] as any })
      await waitFor(() => statuses.includes("connecting"))
      assert.equal(statuses.includes("connected"), false)
      gate.resolve()
      await waitFor(() => statuses.includes("connected"))
    } finally {
      bridge.shutdown()
    }
  })

  it("clears routing caches before reconnecting", async () => {
    let subscriptions = 0
    let ownershipChecks = 0
    const event = { type: "permission.asked", location: { directory: "/repo-a" }, data: { id: "p1" } } as OpenCodeEvent
    const manager = {
      list: () => [{ id: "a", path: "/repo-a" }],
      ownsDirectory: async () => ++ownershipChecks === 1,
      subscribeToSharedService: async (signal?: AbortSignal) => {
        subscriptions += 1
        const current = subscriptions
        return (async function* () {
          yield event
          if (current > 1) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
        })()
      },
    } as unknown as WorkspaceManager
    const bus = new EventBus()
    const received: unknown[] = []
    bus.on("instance.event", (value) => received.push(value))
    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })
    try {
      bus.publish({ type: "workspace.started", workspace: manager.list()[0] as any })
      await waitFor(() => subscriptions === 2 && ownershipChecks === 2)
      assert.equal(received.length, 1)
    } finally {
      bridge.shutdown()
    }
  })
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

  it("routes known locationless session events and invalidates the cache after deletion", async () => {
    const events = [
      { type: "session.text.delta", data: { sessionID: "known", delta: "one" } },
      { type: "session.status", data: { sessionID: "known", status: { type: "busy" } } },
      { type: "session.deleted", data: { sessionID: "known" } },
      { type: "session.status", data: { sessionID: "known", status: { type: "idle" } } },
    ] as OpenCodeEvent[]
    const { manager, sessionGets } = locationlessManager(events, { known: "/repo-a" })
    const bus = new EventBus()
    const received: any[] = []
    bus.on("instance.event", (event) => received.push(event))
    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })

    try {
      bus.publish({ type: "workspace.started", workspace: manager.list()[0] as any })
      await waitFor(() => received.length === 4)
      assert.deepEqual(received.map((event) => event.instanceId), ["a", "a", "a", "a"])
      assert.equal(sessionGets(), 2)
    } finally {
      bridge.shutdown()
    }
  })

  it("drops an unknown locationless session event", async () => {
    const events = [{ type: "session.status", data: { sessionID: "unknown", status: { type: "idle" } } }] as OpenCodeEvent[]
    const { manager, sessionGets } = locationlessManager(events, { unknown: new Error("not found") })
    const bus = new EventBus()
    const received: any[] = []
    bus.on("instance.event", (event) => received.push(event))
    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })

    try {
      bus.publish({ type: "workspace.started", workspace: manager.list()[0] as any })
      await waitFor(() => sessionGets() === 1)
      assert.deepEqual(received, [])
    } finally {
      bridge.shutdown()
    }
  })

  it("routes locationless PTY events by cwd without broadcasting ownership", async () => {
    const events = [
      { type: "pty.created", data: { info: { id: "pty-1", title: "dev", command: "npm", args: [], cwd: "/repo-b", status: "running", pid: 42 } } },
      { type: "pty.exited", data: { id: "pty-1", exitCode: 0 } },
      { type: "pty.deleted", data: { id: "pty-1" } },
    ] as OpenCodeEvent[]
    const workspaces = [{ id: "a", path: "/repo-a" }, { id: "b", path: "/repo-b" }]
    const { manager } = locationlessManager(events, {}, workspaces)
    const bus = new EventBus()
    const received: any[] = []
    bus.on("instance.event", (event) => received.push(event))
    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })

    try {
      bus.publish({ type: "workspace.started", workspace: manager.list()[0] as any })
      await waitFor(() => received.length === 3)
      assert.deepEqual(received.map((event) => event.instanceId), ["b", "b", "b"])
      assert.deepEqual(received.map((event) => event.event.type), ["pty.created", "pty.exited", "pty.deleted"])
    } finally {
      bridge.shutdown()
    }
  })

  it("broadcasts an unresolvable locationless deletion", async () => {
    const events = [{ type: "session.deleted", data: { sessionID: "deleted" } }] as OpenCodeEvent[]
    const workspaces = [{ id: "a", path: "/repo-a" }, { id: "b", path: "/repo-b" }]
    const { manager, sessionGets } = locationlessManager(events, { deleted: new Error("not found") }, workspaces)
    const bus = new EventBus()
    const received: any[] = []
    bus.on("instance.event", (event) => received.push(event))
    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })

    try {
      bus.publish({ type: "workspace.started", workspace: manager.list()[0] as any })
      await waitFor(() => received.length === 2)
      assert.equal(sessionGets(), 1)
      assert.deepEqual(received.map((event) => event.instanceId), ["a", "b"])
      assert.deepEqual(received.map((event) => event.event.properties.id), ["deleted", "deleted"])
    } finally {
      bridge.shutdown()
    }
  })

  it("keeps locationless session and permission events scoped to their owning workspace", async () => {
    const events = [
      { type: "session.status", data: { sessionID: "foreign", status: { type: "idle" } } },
      { type: "permission.asked", data: { id: "permission", sessionID: "foreign" } },
    ] as OpenCodeEvent[]
    const workspaces = [{ id: "a", path: "/repo-a" }, { id: "b", path: "/repo-b" }]
    const { manager } = locationlessManager(events, { foreign: "/repo-b" }, workspaces)
    const bus = new EventBus()
    const received: any[] = []
    bus.on("instance.event", (event) => received.push(event))
    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })

    try {
      bus.publish({ type: "workspace.started", workspace: manager.list()[0] as any })
      await waitFor(() => received.length === 2)
      assert.deepEqual(received.map((event) => event.instanceId), ["b", "b"])
    } finally {
      bridge.shutdown()
    }
  })

  it("routes locationless form.created through data.form.sessionID", async () => {
    const events = [{
      type: "form.created",
      data: { form: { id: "form", sessionID: "owned", title: "Question", fields: [] } },
    }] as unknown as OpenCodeEvent[]
    const workspaces = [{ id: "a", path: "/repo-a" }, { id: "b", path: "/repo-b" }]
    const { manager, sessionGets } = locationlessManager(events, { owned: "/repo-b" }, workspaces)
    const bus = new EventBus()
    const received: any[] = []
    bus.on("instance.event", (event) => received.push(event))
    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })
    try {
      bus.publish({ type: "workspace.started", workspace: manager.list()[0] as any })
      await waitFor(() => received.length === 1)
      assert.equal(sessionGets(), 1)
      assert.equal(received[0].instanceId, "b")
      assert.equal(received[0].event.properties.form.sessionID, "owned")
    } finally {
      bridge.shutdown()
    }
  })

  it("broadcasts safe global locationless service events", async () => {
    const events = [
      { type: "agent.updated", data: {} },
      { type: "catalog.updated", data: {} },
      { type: "command.updated", data: {} },
      { type: "config.updated", data: {} },
      { type: "integration.connection.updated", data: { integrationID: "test" } },
      { type: "integration.updated", data: {} },
      { type: "mcp.resources.changed", data: { server: "test" } },
      { type: "mcp.status.changed", data: { server: "test" } },
      { type: "models-dev.refreshed", data: {} },
      { type: "installation.updated", data: { version: "1.2.3" } },
      { type: "installation.update-available", data: { version: "1.2.4" } },
    ] as OpenCodeEvent[]
    const workspaces = [{ id: "a", path: "/repo-a" }, { id: "b", path: "/repo-b" }]
    const { manager, sessionGets } = locationlessManager(events, {}, workspaces)
    const bus = new EventBus()
    const received: any[] = []
    bus.on("instance.event", (event) => received.push(event))
    const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })
    try {
      bus.publish({ type: "workspace.started", workspace: manager.list()[0] as any })
      await waitFor(() => received.length === events.length * workspaces.length)
      assert.equal(sessionGets(), 0)
      assert.deepEqual(received.map((event) => event.event.type), events.flatMap((event) => [event.type, event.type]))
      assert.deepEqual(received.map((event) => event.instanceId), events.flatMap(() => ["a", "b"]))
    } finally {
      bridge.shutdown()
    }
  })
})
