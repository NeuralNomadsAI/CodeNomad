import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { EventBus } from "../events/bus"
import { AutoAcceptManager, type AutoAcceptPersistence, type PermissionReplier, type AutoAcceptReply } from "./auto-accept-manager"
import type { InstanceStreamEvent } from "../api-types"
import type { Logger } from "../logger"

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
  isLevelEnabled() {
    return false
  },
  child() {
    return noopLogger
  },
} as unknown as Logger

function publishInstanceEvent(bus: EventBus, instanceId: string, event: Record<string, unknown>, streamId?: string) {
  bus.publish({ type: "instance.event", instanceId, streamId, event: { ...event } as InstanceStreamEvent })
}

/** Publish a `session.*` event using the real OpenCode shape (`properties.info`). */
function publishSession(
  bus: EventBus,
  instanceId: string,
  eventType: "session.updated" | "session.created" | "session.deleted",
  info: Record<string, unknown>,
) {
  publishInstanceEvent(bus, instanceId, { type: eventType, properties: { info: { ...info } } })
}

describe("AutoAcceptManager session tree", () => {
  it("ingests session.updated to build the parent chain", () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "master", parentID: null })
    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "master" })

    assert.equal(manager.isEnabled("inst", "master"), false)
    manager.toggle("inst", "child")
    assert.equal(manager.isEnabled("inst", "child"), true)
    assert.equal(manager.isEnabled("inst", "master"), true)

    manager.stop()
  })

  it("treats a session with revert as a fork root", () => {
    const bus = new EventBus(noopLogger)
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier() })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "master", parentID: null })
    publishSession(bus, "inst", "session.updated", {
      id: "fork",
      parentID: "master",
      revert: { messageID: "m", partID: "p" },
    })

    manager.toggle("inst", "fork")
    assert.equal(manager.isEnabled("inst", "fork"), true)
    assert.equal(manager.isEnabled("inst", "master"), false)

    manager.stop()
  })

  it("session.deleted removes the tree entry but keeps the toggle", () => {
    const bus = new EventBus(noopLogger)
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier() })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "master", parentID: null })
    manager.toggle("inst", "master")
    publishSession(bus, "inst", "session.deleted", { id: "master" })

    // toggle is independent of the tree (survives deletion)
    assert.equal(manager.isEnabled("inst", "master"), true)

    manager.stop()
  })
})

describe("AutoAcceptManager persistence", () => {
  it("hydrates a persisted family root before processing queued permissions", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        await gate
        return [
          { id: "root", parentId: null, yoloEnabled: true },
          { id: "child", parentId: "root", yoloEnabled: false },
        ]
      },
      async persist() {},
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier, persistence })
    manager.start()
    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "root" })
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "permission", sessionID: "child" },
    })
    await flushMicrotasks()
    assert.equal(replier.calls.length, 0)
    release()
    await manager.hydrateInstance("inst")
    await flushMicrotasks()
    assert.equal(manager.isEnabled("inst", "child"), true)
    assert.equal(replier.calls.length, 1)
    manager.stop()
  })

  it("persists before enabling memory and emitting feedback", async () => {
    const bus = new EventBus(noopLogger)
    const changes: Record<string, unknown>[] = []
    bus.on("yolo.stateChanged", (event) => changes.push(event))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const writes: unknown[][] = []
    const persistence: AutoAcceptPersistence = {
      async loadSessions() { return [{ id: "root", parentId: null, yoloEnabled: false }] },
      async persist(...args) { writes.push(args.slice(0, 4)); await gate },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    const toggle = manager.toggle("inst", "root")
    await flushMicrotasks()
    assert.deepEqual(writes, [["inst", "root", true, undefined]])
    assert.equal(manager.isEnabled("inst", "root"), false)
    assert.equal(changes.length, 0)
    release()
    assert.equal(await toggle, true)
    assert.equal(manager.isEnabled("inst", "root"), true)
    assert.equal(changes.length, 1)
  })

  it("serializes concurrent toggles", async () => {
    const bus = new EventBus(noopLogger)
    const writes: boolean[] = []
    const persistence: AutoAcceptPersistence = {
      async loadSessions() { return [{ id: "root", parentId: null, yoloEnabled: false }] },
      async persist(_instanceId, _rootSessionId, enabled) { writes.push(enabled) },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    assert.deepEqual(await Promise.all([manager.toggle("inst", "root"), manager.toggle("inst", "root")]), [true, false])
    assert.deepEqual(writes, [true, false])
    assert.equal(manager.isEnabled("inst", "root"), false)
  })

  it("keeps queued permissions until a failed hydration can retry", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    let attempts = 0
    const signals: AbortSignal[] = []
    const persistence: AutoAcceptPersistence = {
      async loadSessions(_instanceId, signal) {
        signals.push(signal)
        if (++attempts === 1) throw new Error("temporary failure")
        return [{ id: "root", parentId: null, yoloEnabled: true }]
      },
      async persist() {},
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier, persistence })
    manager.start()
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "permission", sessionID: "root" },
    })
    await flushMicrotasks()
    assert.equal(replier.calls.length, 0)
    assert.equal(signals[0]?.aborted, true)
    await manager.hydrateInstance("inst")
    await flushMicrotasks()
    assert.notEqual(signals[1], signals[0])
    assert.equal(replier.calls.length, 1)
    manager.stop()
  })

  it("releases generation controllers after arbitrary hydration failures", async () => {
    const bus = new EventBus(noopLogger)
    const signals: AbortSignal[] = []
    const persistence: AutoAcceptPersistence = {
      async loadSessions(instanceId, signal) {
        signals.push(signal)
        throw new Error(`unknown workspace: ${instanceId}`)
      },
      async persist() {},
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })

    await assert.rejects(manager.hydrateInstance("invalid-a"), /unknown workspace/)
    await assert.rejects(manager.hydrateInstance("invalid-b"), /unknown workspace/)

    assert.equal(signals.every((signal) => signal.aborted), true)
    assert.equal(
      (manager as unknown as { generationControllers: Map<string, AbortController> }).generationControllers.size,
      0,
    )
  })

  it("deduplicates one bounded hydration retry run and fails closed at the bounded event queue", { timeout: 2_000 }, async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    let loads = 0
    let failLoads = true
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        loads += 1
        if (failLoads) throw new Error("temporary hydration outage")
        return [{ id: "root", parentId: null, yoloEnabled: true }]
      },
      async persist() {},
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier, persistence })
    manager.start()
    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "current", status: "connecting" })

    for (let index = 0; index < 700; index += 1) {
      publishSession(bus, "inst", "session.updated", { id: `session-${index}`, parentID: null })
    }
    for (let index = 0; index < 100; index += 1) {
      publishSession(bus, "inst", "session.updated", { id: "same-session", parentID: null, title: String(index) })
    }
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "open", sessionID: "root" },
    })
    publishInstanceEvent(bus, "inst", {
      type: "permission.updated",
      properties: { id: "open", sessionID: "root", detail: "latest" },
    })
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "closed", sessionID: "root" },
    })
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.replied",
      properties: { id: "closed" },
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    assert.equal(loads, 4, "all queued events must share the initial load and three retries")
    const queued = (manager as unknown as {
      queuedEvents: Map<string, Map<string, unknown>>
    }).queuedEvents.get("inst")
    assert.equal(queued?.size, 512)
    assert.equal(queued?.has("session:same-session"), true)
    assert.equal(queued?.has("permission:open"), false)
    assert.equal(queued?.has("permission:closed"), false)

    publishSession(bus, "inst", "session.updated", { id: "after-exhaustion", parentID: null })
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    assert.equal(loads, 4, "new events must not start one load each after retry exhaustion")

    failLoads = false
    await manager.hydrateInstance("inst")
    await flushMicrotasks()

    assert.equal(loads, 6, "overflow must force a second authoritative load before replay")
    assert.deepEqual(replier.calls, [])
    assert.equal((manager as unknown as { queuedEvents: Map<string, unknown> }).queuedEvents.has("inst"), false)
    manager.stop()
  })

  it("replays deduplicated session topology before queued permissions", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        await gate
        return [
          { id: "enabled", parentId: null, yoloEnabled: true },
          { id: "disabled", parentId: null, yoloEnabled: false },
        ]
      },
      async persist() {},
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier, persistence })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "enabled" })
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "permission", sessionID: "child" },
    })
    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "disabled" })

    const hydration = manager.hydrateInstance("inst")
    release()
    await hydration
    await flushMicrotasks()

    assert.deepEqual(replier.calls, [])
    assert.equal(manager.isEnabled("inst", "child"), false)
    manager.stop()
  })

  it("keeps permissions queued until microtask-delayed topology replay is authoritative", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        return [
          { id: "enabled", parentId: null, yoloEnabled: true },
          { id: "disabled", parentId: null, yoloEnabled: false },
          { id: "child", parentId: "enabled", yoloEnabled: false },
        ]
      },
      async persist() {},
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier, persistence })
    let permissionScheduled = false
    bus.on("yolo.stateChanged", () => {
      if (permissionScheduled) return
      permissionScheduled = true
      queueMicrotask(() => publishInstanceEvent(bus, "inst", {
        type: "permission.v2.asked",
        properties: { id: "permission", sessionID: "child" },
      }))
    })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "disabled" })
    await manager.hydrateInstance("inst")
    await flushMicrotasks()

    assert.deepEqual(replier.calls, [])
    assert.equal(manager.isEnabled("inst", "child"), false)
    manager.stop()
  })

  it("drops permission auto-accept and rehydrates when the 513th queued event reaches the cap", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    let release!: () => void
    let loads = 0
    const gate = new Promise<void>((resolve) => { release = resolve })
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        const load = ++loads
        if (load === 1) await gate
        return [
          { id: "enabled", parentId: null, yoloEnabled: true },
          { id: "disabled", parentId: null, yoloEnabled: false },
          { id: "child", parentId: load === 1 ? "enabled" : "disabled", yoloEnabled: false },
        ]
      },
      async persist() {},
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier, persistence })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "disabled" })
    for (let index = 0; index < 511; index += 1) {
      publishSession(bus, "inst", "session.updated", { id: `filler-${index}`, parentID: null })
    }
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "permission", sessionID: "child" },
    })

    const queued = (manager as unknown as {
      queuedEvents: Map<string, Map<string, unknown>>
    }).queuedEvents.get("inst")
    assert.equal(queued?.size, 512)
    assert.equal(queued?.has("session:child"), true)
    assert.equal(queued?.has("permission:permission"), false)

    const hydration = manager.hydrateInstance("inst")
    release()
    await hydration
    await flushMicrotasks()

    assert.equal(loads, 2)
    assert.deepEqual(replier.calls, [])
    assert.equal(manager.isEnabled("inst", "child"), false)
    manager.stop()
  })

  it("does not re-enable memory when a persisted toggle finishes after cleanup", async () => {
    const bus = new EventBus(noopLogger)
    const changes: Record<string, unknown>[] = []
    bus.on("yolo.stateChanged", (event) => changes.push(event))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let writes = 0
    let staleSignal: AbortSignal | undefined
    const persistence: AutoAcceptPersistence = {
      async loadSessions() { return [{ id: "root", parentId: null, yoloEnabled: false }] },
      async persist(_instanceId, _rootSessionId, _enabled, _workspaceId, signal) {
        staleSignal = signal
        await gate
        if (signal.aborted) throw signal.reason
        writes += 1
      },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    const toggle = manager.toggle("inst", "root")
    const queued = manager.toggle("inst", "root")
    await flushMicrotasks()
    manager.clearInstance("inst")
    assert.equal(staleSignal?.aborted, true)
    release()
    assert.equal(await toggle, false)
    assert.equal(await queued, false)
    assert.equal(writes, 0)
    assert.equal(manager.isEnabled("inst", "root"), false)
    assert.equal(changes.length, 0)
  })

  it("reports a committed toggle after runtime rotation and hydrates the durable value", async () => {
    const bus = new EventBus(noopLogger)
    const changes: Array<{ enabled?: boolean }> = []
    let durableEnabled = false
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        return [{ id: "root", parentId: null, yoloEnabled: durableEnabled }]
      },
      async persist(_instanceId, _rootSessionId, enabled) {
        durableEnabled = enabled
        bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "new", status: "connecting" })
      },
    }
    bus.on("yolo.stateChanged", (event) => changes.push(event))
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "old", status: "connecting" })
    await manager.hydrateInstance("inst")

    assert.equal(await manager.toggle("inst", "root"), true)
    await manager.hydrateInstance("inst")

    assert.equal(durableEnabled, true)
    assert.equal(manager.isEnabled("inst", "root"), true)
    assert.deepEqual(changes.map((event) => event.enabled), [true])
    manager.stop()
  })

  it("rebinds the requested toggle when rotation drops the first persistence attempt", async () => {
    const bus = new EventBus(noopLogger)
    const changes: Array<{ enabled?: boolean }> = []
    const writes: Array<{ enabled: boolean; signal: AbortSignal }> = []
    let durableEnabled = false
    let loads = 0
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        loads += 1
        return [{ id: "root", parentId: null, yoloEnabled: durableEnabled }]
      },
      async persist(_instanceId, _rootSessionId, enabled, _workspaceId, signal) {
        writes.push({ enabled, signal })
        if (writes.length === 1) {
          bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "replacement", status: "connecting" })
          return
        }
        durableEnabled = enabled
      },
    }
    bus.on("yolo.stateChanged", (event) => changes.push(event))
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "old", status: "connecting" })
    await manager.hydrateInstance("inst")

    assert.equal(await manager.toggle("inst", "root"), true)

    assert.equal(loads, 2)
    assert.deepEqual(writes.map(({ enabled }) => enabled), [true, true])
    assert.equal(writes[0]?.signal.aborted, true)
    assert.equal(writes[1]?.signal.aborted, false)
    assert.equal(durableEnabled, true)
    assert.equal(manager.isEnabled("inst", "root"), true)
    assert.deepEqual(changes.map(({ enabled }) => enabled), [true])
    manager.stop()
  })

  it("publishes the authoritative disabled state when rotation aborts persistence after commit", async () => {
    const bus = new EventBus(noopLogger)
    const changes: Array<{ sessionId?: string; enabled?: boolean }> = []
    let durableEnabled = true
    let loads = 0
    let persistSignal: AbortSignal | undefined
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        loads += 1
        return [
          { id: "root", parentId: null, yoloEnabled: durableEnabled },
          ...(loads === 1 ? [] : [{ id: "unrelated", parentId: null, yoloEnabled: true }]),
        ]
      },
      async persist(_instanceId, _rootSessionId, enabled, _workspaceId, signal) {
        durableEnabled = enabled
        persistSignal = signal
        bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "replacement", status: "connecting" })
        throw signal.reason
      },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "old", status: "connecting" })
    await manager.hydrateInstance("inst")
    bus.on("yolo.stateChanged", (event) => changes.push(event))

    assert.equal(await manager.toggle("inst", "root"), false)

    assert.equal(persistSignal?.aborted, true)
    assert.equal(loads, 2)
    assert.equal(manager.isEnabled("inst", "root"), false)
    assert.equal(manager.isEnabled("inst", "unrelated"), true)
    assert.deepEqual(changes.map(({ sessionId, enabled }) => [sessionId, enabled]), [
      ["unrelated", true],
      ["root", false],
    ])
    manager.stop()
  })

  it("rebinds a toggle behind replacement hydration when runtime rotation interrupts initial hydration", async () => {
    const bus = new EventBus(noopLogger)
    const changes: Array<{ enabled?: boolean }> = []
    const writes: boolean[] = []
    let releaseOld!: () => void
    let releaseReplacement!: () => void
    let loads = 0
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve })
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        await (++loads === 1 ? oldGate : replacementGate)
        return [{ id: "root", parentId: null, yoloEnabled: false }]
      },
      async persist(_instanceId, _rootSessionId, enabled) { writes.push(enabled) },
    }
    bus.on("yolo.stateChanged", (event) => changes.push(event))
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "old", status: "connecting" })
    const oldHydration = manager.hydrateInstance("inst")
    const toggle = manager.toggle("inst", "root")

    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "replacement", status: "connecting" })
    releaseOld()
    await oldHydration
    await flushMicrotasks()

    assert.equal(loads, 2)
    assert.deepEqual(writes, [], "stale authority must not persist before replacement hydration")
    assert.equal(changes.length, 0, "stale authority must not publish replacement state")
    assert.equal(manager.isEnabled("inst", "root"), false)

    releaseReplacement()
    assert.equal(await toggle, true)
    assert.deepEqual(writes, [true])
    assert.equal(manager.isEnabled("inst", "root"), true)
    assert.deepEqual(changes.map((event) => event.enabled), [true])
    manager.stop()
  })

  it("moves persisted Yolo state when late ancestry changes the family root", async () => {
    const bus = new EventBus(noopLogger)
    const writes: unknown[][] = []
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        return [
          { id: "parent", parentId: null, workspaceId: "workspace", yoloEnabled: false },
          { id: "child", parentId: null, workspaceId: "workspace", yoloEnabled: true },
        ]
      },
      async persist(...args) { writes.push(args.slice(0, 4)) },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    await manager.hydrateInstance("inst")
    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "parent", workspaceID: "workspace" })
    await flushMicrotasks()
    assert.equal(manager.isEnabled("inst", "parent"), true)
    assert.deepEqual(writes, [
      ["inst", "parent", true, "workspace"],
      ["inst", "child", false, "workspace"],
    ])
    manager.stop()
  })

  it("re-resolves the authoritative root when topology advances during migration rebind", async () => {
    const bus = new EventBus(noopLogger)
    const changes: Array<{ sessionId?: string; enabled?: boolean }> = []
    const durableEnabled = new Map<string, boolean>([["grandparent", false], ["parent", false], ["child", true]])
    const writes: Array<{ rootSessionId: string; enabled: boolean; signal: AbortSignal }> = []
    let rotated = false
    let releaseStale!: () => void
    let markStaleStarted!: () => void
    let markMigrated!: () => void
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve })
    const staleStarted = new Promise<void>((resolve) => { markStaleStarted = resolve })
    const migrated = new Promise<void>((resolve) => { markMigrated = resolve })
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        return [
          { id: "grandparent", parentId: null, workspaceId: "workspace", yoloEnabled: durableEnabled.get("grandparent") ?? false },
          { id: "parent", parentId: null, workspaceId: "workspace", yoloEnabled: durableEnabled.get("parent") ?? false },
          {
            id: "child",
            parentId: rotated ? "grandparent" : null,
            workspaceId: "workspace",
            yoloEnabled: durableEnabled.get("child") ?? false,
          },
        ]
      },
      async persist(_instanceId, rootSessionId, enabled, _workspaceId, signal) {
        writes.push({ rootSessionId, enabled, signal })
        if (!rotated) {
          rotated = true
          bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "replacement", status: "connecting" })
          markStaleStarted()
          await staleGate
          return
        }
        durableEnabled.set(rootSessionId, enabled)
        if (rootSessionId === "child" && !enabled) markMigrated()
      },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "old", status: "connecting" })
    await manager.hydrateInstance("inst")
    bus.on("yolo.stateChanged", (event) => changes.push(event))

    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "parent", workspaceID: "workspace" })
    await staleStarted

    assert.equal(writes[0]?.signal.aborted, true)
    assert.equal(manager.isEnabled("inst", "parent"), false)
    assert.equal(changes.length, 0, "stale migration must not publish replacement state")

    releaseStale()
    await migrated
    await flushMicrotasks()

    assert.deepEqual(writes.map(({ rootSessionId, enabled }) => [rootSessionId, enabled]), [
      ["parent", true],
      ["grandparent", true],
      ["child", false],
    ])
    assert.notEqual(writes[1]?.signal, writes[0]?.signal)
    assert.equal(writes[1]?.signal.aborted, false)
    assert.equal(durableEnabled.get("grandparent"), true)
    assert.equal(durableEnabled.get("parent"), false)
    assert.equal(durableEnabled.get("child"), false)
    assert.equal(manager.isEnabled("inst", "grandparent"), true)
    assert.equal(manager.isEnabled("inst", "parent"), false)
    assert.deepEqual(changes.map(({ sessionId, enabled }) => [sessionId, enabled]), [
      ["grandparent", true],
    ])
    manager.stop()
  })

  it("automatically retries replacement hydration for the same current generation", { timeout: 1_000 }, async () => {
    const bus = new EventBus(noopLogger)
    const changes: Array<{ sessionId?: string; enabled?: boolean }> = []
    const durableEnabled = new Map<string, boolean>([["parent", false], ["child", true]])
    const writes: Array<{ rootSessionId: string; enabled: boolean; signal: AbortSignal }> = []
    const loadSignals: AbortSignal[] = []
    let loads = 0
    let releaseFailedHydration!: () => void
    let markFailedHydrationStarted!: () => void
    let markMigrated!: () => void
    const failedHydrationGate = new Promise<void>((resolve) => { releaseFailedHydration = resolve })
    const failedHydrationStarted = new Promise<void>((resolve) => { markFailedHydrationStarted = resolve })
    const migrated = new Promise<void>((resolve) => { markMigrated = resolve })
    const persistence: AutoAcceptPersistence = {
      async loadSessions(_instanceId, signal) {
        loadSignals.push(signal)
        loads += 1
        if (loads === 2) {
          markFailedHydrationStarted()
          await failedHydrationGate
          throw new Error("temporary hydration failure")
        }
        return [
          { id: "parent", parentId: null, workspaceId: "workspace", yoloEnabled: durableEnabled.get("parent") ?? false },
          {
            id: "child",
            parentId: loads === 1 ? null : "parent",
            workspaceId: "workspace",
            yoloEnabled: durableEnabled.get("child") ?? false,
          },
        ]
      },
      async persist(_instanceId, rootSessionId, enabled, _workspaceId, signal) {
        writes.push({ rootSessionId, enabled, signal })
        if (writes.length === 1) {
          bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "replacement", status: "connecting" })
          return
        }
        durableEnabled.set(rootSessionId, enabled)
        if (rootSessionId === "child" && !enabled) markMigrated()
      },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "old", status: "connecting" })
    await manager.hydrateInstance("inst")
    bus.on("yolo.stateChanged", (event) => changes.push(event))

    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "parent", workspaceID: "workspace" })
    await markFailedHydrationStarted
    releaseFailedHydration()
    await flushMicrotasks()

    assert.equal(loads, 2)
    assert.equal(manager.isEnabled("inst", "parent"), false)
    assert.equal(changes.length, 0)

    await migrated
    await flushMicrotasks()

    assert.equal(loads, 3)
    assert.equal(loadSignals[1]?.aborted, true)
    assert.notEqual(loadSignals[2], loadSignals[1])
    assert.equal(loadSignals[2]?.aborted, false)
    assert.deepEqual(writes.map(({ rootSessionId, enabled }) => [rootSessionId, enabled]), [
      ["parent", true],
      ["parent", true],
      ["child", false],
    ])
    assert.equal(writes[0]?.signal.aborted, true)
    assert.notEqual(writes[1]?.signal, writes[0]?.signal)
    assert.equal(durableEnabled.get("parent"), true)
    assert.equal(durableEnabled.get("child"), false)
    assert.equal(manager.isEnabled("inst", "parent"), true)
    assert.deepEqual(changes.map(({ sessionId, enabled }) => [sessionId, enabled]), [["parent", true]])
    manager.stop()
  })

  it("retries a current-generation rebound migration after a transient persistence outage", { timeout: 1_000 }, async () => {
    const bus = new EventBus(noopLogger)
    const changes: Array<{ sessionId?: string; enabled?: boolean }> = []
    const durableEnabled = new Map<string, boolean>([["parent", false], ["child", true]])
    const writes: Array<{ rootSessionId: string; enabled: boolean; signal: AbortSignal }> = []
    let loads = 0
    let outageInjected = false
    let markMigrated!: () => void
    const migrated = new Promise<void>((resolve) => { markMigrated = resolve })
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        loads += 1
        return [
          { id: "parent", parentId: null, workspaceId: "workspace", yoloEnabled: durableEnabled.get("parent") ?? false },
          {
            id: "child",
            parentId: loads === 1 ? null : "parent",
            workspaceId: "workspace",
            yoloEnabled: durableEnabled.get("child") ?? false,
          },
        ]
      },
      async persist(_instanceId, rootSessionId, enabled, _workspaceId, signal) {
        writes.push({ rootSessionId, enabled, signal })
        if (writes.length === 1) {
          bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "replacement", status: "connecting" })
          return
        }
        if (!outageInjected) {
          outageInjected = true
          throw new Error("temporary persistence outage")
        }
        durableEnabled.set(rootSessionId, enabled)
        if (rootSessionId === "child" && !enabled) markMigrated()
      },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "old", status: "connecting" })
    await manager.hydrateInstance("inst")
    bus.on("yolo.stateChanged", (event) => changes.push(event))

    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "parent", workspaceID: "workspace" })
    await migrated
    await flushMicrotasks()

    assert.equal(loads, 3, "recovery must not require manual hydration")
    assert.deepEqual(writes.map(({ rootSessionId, enabled }) => [rootSessionId, enabled]), [
      ["parent", true],
      ["parent", true],
      ["parent", true],
      ["child", false],
    ])
    assert.equal(writes[0]?.signal.aborted, true)
    assert.equal(writes[1]?.signal.aborted, true)
    assert.notEqual(writes[2]?.signal, writes[1]?.signal)
    assert.equal(writes[2]?.signal.aborted, false)
    assert.equal(writes[3]?.signal, writes[2]?.signal)
    assert.equal(durableEnabled.get("parent"), true)
    assert.equal(durableEnabled.get("child"), false)
    assert.equal(manager.isEnabled("inst", "parent"), true)
    assert.equal(manager.isEnabled("inst", "child"), true)
    assert.deepEqual(changes.map(({ sessionId, enabled }) => [sessionId, enabled]), [["parent", true]])
    manager.stop()
  })

  it("does not let a repaired migration override a newer successful disable", { timeout: 1_000 }, async () => {
    const bus = new EventBus(noopLogger)
    const durableEnabled = new Map<string, boolean>([["parent", false], ["child", true]])
    const writes: Array<{ rootSessionId: string; enabled: boolean }> = []
    let loads = 0
    let childClearAttempts = 0
    let markChildClearFailed!: () => void
    let markChildCleared!: () => void
    const childClearFailed = new Promise<void>((resolve) => { markChildClearFailed = resolve })
    const childCleared = new Promise<void>((resolve) => { markChildCleared = resolve })
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        loads += 1
        return [
          { id: "parent", parentId: null, workspaceId: "workspace", yoloEnabled: durableEnabled.get("parent") ?? false },
          {
            id: "child",
            parentId: loads === 1 ? null : "parent",
            workspaceId: "workspace",
            yoloEnabled: durableEnabled.get("child") ?? false,
          },
        ]
      },
      async persist(_instanceId, rootSessionId, enabled) {
        writes.push({ rootSessionId, enabled })
        durableEnabled.set(rootSessionId, enabled)
        if (writes.length === 1) {
          bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "replacement", status: "connecting" })
          return
        }
        if (rootSessionId === "child" && !enabled && ++childClearAttempts === 1) {
          durableEnabled.set(rootSessionId, true)
          markChildClearFailed()
          throw new Error("temporary child clear failure")
        }
        if (rootSessionId === "child" && !enabled) markChildCleared()
      },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "old", status: "connecting" })
    await manager.hydrateInstance("inst")

    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "parent", workspaceID: "workspace" })
    await childClearFailed
    await childCleared

    assert.equal(await manager.toggle("inst", "parent"), false)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    const disableIndex = writes.findIndex(({ rootSessionId, enabled }) => rootSessionId === "parent" && !enabled)
    assert.notEqual(disableIndex, -1)
    assert.equal(
      writes.slice(disableIndex + 1).some(({ rootSessionId, enabled }) => rootSessionId === "parent" && enabled),
      false,
    )
    assert.equal(durableEnabled.get("parent"), false)
    assert.equal(durableEnabled.get("child"), false)
    assert.equal(manager.isEnabled("inst", "parent"), false)
    manager.stop()
  })

  it("self-heals a partial migration after retry exhaustion and process restart", { timeout: 1_000 }, async () => {
    const bus = new EventBus(noopLogger)
    const durableEnabled = new Map<string, boolean>([
      ["parent", false],
      ["child", true],
      ["unrelated", false],
      ["isolated-fork", true],
    ])
    let loads = 0
    let childClearAttempts = 0
    let markRetryBudgetExhausted!: () => void
    const retryBudgetExhausted = new Promise<void>((resolve) => { markRetryBudgetExhausted = resolve })
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        loads += 1
        return [
          { id: "parent", parentId: null, workspaceId: "workspace", yoloEnabled: durableEnabled.get("parent") ?? false },
          {
            id: "child",
            parentId: loads === 1 ? null : "parent",
            workspaceId: "workspace",
            yoloEnabled: durableEnabled.get("child") ?? false,
          },
          { id: "unrelated", parentId: null, workspaceId: "workspace", yoloEnabled: false },
          {
            id: "isolated-fork",
            parentId: "unrelated",
            revert: { snapshot: "fork" },
            workspaceId: "workspace",
            yoloEnabled: durableEnabled.get("isolated-fork") ?? false,
          },
        ]
      },
      async persist(_instanceId, rootSessionId, enabled) {
        durableEnabled.set(rootSessionId, enabled)
        if (rootSessionId === "parent" && enabled && loads === 1) {
          bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "replacement", status: "connecting" })
          return
        }
        if (rootSessionId === "child" && !enabled) {
          childClearAttempts += 1
          if (childClearAttempts <= 4) {
            durableEnabled.set(rootSessionId, true)
            if (childClearAttempts === 4) markRetryBudgetExhausted()
            throw new Error("child clear unavailable")
          }
        }
      },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "old", status: "connecting" })
    await manager.hydrateInstance("inst")

    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "parent", workspaceID: "workspace" })
    await retryBudgetExhausted
    await flushMicrotasks()
    assert.equal(durableEnabled.get("parent"), true)
    assert.equal(durableEnabled.get("child"), true)

    manager.stop()

    const restartedBus = new EventBus(noopLogger)
    const restartedManager = new AutoAcceptManager({
      eventBus: restartedBus,
      logger: noopLogger,
      replier: makeRecordingReplier(),
      persistence,
    })
    restartedManager.start()
    restartedBus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "after-restart", status: "connecting" })
    await restartedManager.hydrateInstance("inst")

    assert.equal(childClearAttempts, 5)
    assert.equal(durableEnabled.get("parent"), true)
    assert.equal(durableEnabled.get("child"), false)
    assert.equal(restartedManager.isEnabled("inst", "parent"), true)
    assert.equal(restartedManager.isEnabled("inst", "unrelated"), false)
    assert.equal(restartedManager.isEnabled("inst", "isolated-fork"), true)
    assert.equal(durableEnabled.get("isolated-fork"), true)
    restartedManager.stop()
  })

  it("does not re-enable a family when ancestry repeatedly changes during a disable", async () => {
    const bus = new EventBus(noopLogger)
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
    const writes: unknown[][] = []
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        return [
          { id: "grandparent", parentId: null, workspaceId: "workspace", yoloEnabled: false },
          { id: "parent", parentId: null, workspaceId: "workspace", yoloEnabled: false },
          { id: "child", parentId: null, workspaceId: "workspace", yoloEnabled: true },
        ]
      },
      async persist(...args) {
        writes.push(args)
        if (writes.length === 1) await firstGate
        if (writes.length === 2) await secondGate
      },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    await manager.hydrateInstance("inst")
    const toggle = manager.toggle("inst", "child")
    await flushMicrotasks()
    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "parent", workspaceID: "workspace" })
    releaseFirst()
    await flushMicrotasks()
    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "grandparent", workspaceID: "workspace" })
    releaseSecond()
    assert.equal(await toggle, false)
    await flushMicrotasks()
    assert.equal(manager.isEnabled("inst", "grandparent"), false)
    assert.equal(writes.some(([, , enabled]) => enabled === true), false, JSON.stringify(writes))
    manager.stop()
  })

  it("allows a queued toggle to continue after an earlier persistence failure", async () => {
    const bus = new EventBus(noopLogger)
    let attempts = 0
    const persistence: AutoAcceptPersistence = {
      async loadSessions() { return [{ id: "root", parentId: null, yoloEnabled: false }] },
      async persist() { if (++attempts === 1) throw new Error("write failed") },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    const first = manager.toggle("inst", "root")
    const second = manager.toggle("inst", "root")
    await assert.rejects(Promise.resolve(first), /write failed/)
    assert.equal(await second, true)
    assert.equal(manager.isEnabled("inst", "root"), true)
  })

  it("does not restore a late hydration after workspace cleanup", async () => {
    const bus = new EventBus(noopLogger)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const persistence: AutoAcceptPersistence = {
      async loadSessions() { await gate; return [{ id: "root", parentId: null, yoloEnabled: true }] },
      async persist() {},
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    const hydration = manager.hydrateInstance("inst")
    manager.clearInstance("inst")
    release()
    await hydration
    assert.equal(manager.isEnabled("inst", "root"), false)
  })
})

describe("AutoAcceptManager permission interception", () => {
  it("auto-replies to a v2 permission on an enabled family", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const accepted: Record<string, unknown>[] = []
    bus.on("yolo.autoAccepted", (e) => accepted.push(e))
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "master", parentID: null })
    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "master" })
    manager.toggle("inst", "child") // enable the whole family root

    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-1", sessionID: "child", action: "edit", resources: ["a.ts"] },
    })

    await flushMicrotasks()

    assert.equal(replier.calls.length, 1)
    const call = replier.calls[0]
    assert.equal(call.instanceId, "inst")
    assert.equal(call.permissionId, "perm-1")
    assert.equal(call.sessionId, "child")
    assert.equal(call.source, "v2")
    assert.equal(call.reply, "once")
    assert.equal(accepted.length, 1)
    assert.equal((accepted[0] as any).permissionId, "perm-1")

    manager.stop()
  })

  it("auto-replies to a legacy permission.asked event", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    manager.toggle("inst", "solo")

    publishInstanceEvent(bus, "inst", {
      type: "permission.asked",
      properties: { id: "perm-2", sessionID: "solo", type: "bash" },
    })

    await flushMicrotasks()

    assert.equal(replier.calls.length, 1)
    assert.equal(replier.calls[0].source, "legacy")
    assert.equal(replier.calls[0].permissionId, "perm-2")

    manager.stop()
  })

  it("does not reply when the family is disabled", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-3", sessionID: "solo" },
    })

    await flushMicrotasks()
    assert.equal(replier.calls.length, 0)

    manager.stop()
  })

  it("ignores permission events without an id or sessionID", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    manager.toggle("inst", "solo")

    publishInstanceEvent(bus, "inst", { type: "permission.v2.asked", properties: { sessionID: "solo" } })
    publishInstanceEvent(bus, "inst", { type: "permission.v2.asked", properties: { id: "x" } })
    await flushMicrotasks()

    assert.equal(replier.calls.length, 0)
    manager.stop()
  })

  it("deduplicates repeated emission of the same permission", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    manager.toggle("inst", "solo")

    for (let i = 0; i < 3; i++) {
      publishInstanceEvent(bus, "inst", {
        type: "permission.v2.asked",
        properties: { id: "perm-dup", sessionID: "solo" },
      })
    }
    await flushMicrotasks()

    assert.equal(replier.calls.length, 1)
    manager.stop()
  })

  it("clears in-flight tracking after the reply resolves so it can retry", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    manager.toggle("inst", "solo")

    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-retry", sessionID: "solo" },
    })
    await flushMicrotasks()
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-retry", sessionID: "solo" },
    })
    await flushMicrotasks()

    assert.equal(replier.calls.length, 2)
    manager.stop()
  })
})

describe("AutoAcceptManager state events", () => {
  it("publishes yolo.stateChanged with the new enabled value on toggle", () => {
    const bus = new EventBus(noopLogger)
    const changes: Record<string, unknown>[] = []
    bus.on("yolo.stateChanged", (e) => changes.push(e))
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier() })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "master", parentID: null })

    manager.toggle("inst", "master")
    manager.toggle("inst", "master")

    assert.equal(changes.length, 2)
    assert.equal((changes[0] as any).enabled, true)
    assert.equal((changes[1] as any).enabled, false)
    assert.equal((changes[0] as any).sessionId, "master")
    assert.equal((changes[0] as any).instanceId, "inst")

    manager.stop()
  })
})

describe("AutoAcceptManager lifecycle", () => {
  it("clearInstance drops tree and enabled state for the instance", () => {
    const bus = new EventBus(noopLogger)
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier() })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "master", parentID: null })
    manager.toggle("inst", "master")
    manager.clearInstance("inst")

    assert.equal(manager.isEnabled("inst", "master"), false)
    manager.stop()
  })

  it("clears state when the workspace stops", () => {
    const bus = new EventBus(noopLogger)
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier() })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "master", parentID: null })
    manager.toggle("inst", "master")
    bus.publish({ type: "workspace.stopped", workspaceId: "inst" })

    assert.equal(manager.isEnabled("inst", "master"), false)
    manager.stop()
  })

  it("stop() unsubscribes so no further events are processed", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()
    manager.stop()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    manager.toggle("inst", "solo")
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "p", sessionID: "solo" },
    })
    await flushMicrotasks()

    assert.equal(replier.calls.length, 0)
  })

  it("stop() fences late hydration and refuses new work until restarted", async () => {
    const bus = new EventBus(noopLogger)
    const changes: Record<string, unknown>[] = []
    const signals: AbortSignal[] = []
    let release!: () => void
    let loads = 0
    const gate = new Promise<void>((resolve) => { release = resolve })
    const persistence: AutoAcceptPersistence = {
      async loadSessions(_instanceId, signal) {
        loads += 1
        signals.push(signal)
        if (loads === 1) await gate
        return [{ id: "root", parentId: null, yoloEnabled: true }]
      },
      async persist() {},
    }
    bus.on("yolo.stateChanged", (event) => changes.push(event))
    const manager = new AutoAcceptManager({
      eventBus: bus,
      logger: noopLogger,
      replier: makeRecordingReplier(),
      persistence,
    })
    manager.start()

    const hydration = manager.hydrateInstance("inst")
    manager.stop()
    assert.equal(signals[0]?.aborted, true)
    release()
    await hydration
    await manager.hydrateInstance("inst")

    assert.equal(loads, 1, "stopped managers must not create new generation work")
    assert.equal(manager.isEnabled("inst", "root"), false)
    assert.equal(changes.length, 0)

    manager.start()
    await manager.hydrateInstance("inst")
    assert.equal(loads, 2)
    assert.equal(signals[1]?.aborted, false)
    assert.equal(manager.isEnabled("inst", "root"), true)
    manager.stop()
  })

  it("stop() ignores a reply that settles after cancellation", async () => {
    const bus = new EventBus(noopLogger)
    const accepted: Record<string, unknown>[] = []
    let signal: AbortSignal | undefined
    let release!: () => void
    const replier: PermissionReplier = (_reply, replySignal) => {
      signal = replySignal
      return new Promise<void>((resolve) => { release = resolve })
    }
    bus.on("yolo.autoAccepted", (event) => accepted.push(event))
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()
    publishSession(bus, "inst", "session.updated", { id: "root", parentID: null })
    manager.toggle("inst", "root")
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "permission", sessionID: "root" },
    })

    manager.stop()
    assert.equal(signal?.aborted, true)
    release()
    await flushMicrotasks()

    assert.equal(accepted.length, 0)
  })
})

describe("AutoAcceptManager runtime rotation", () => {
  it("clears runtime state and rehydrates persisted roots for the new stream", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    let loads = 0
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        loads += 1
        return loads === 1
          ? [
              { id: "old-root", parentId: null, yoloEnabled: true },
              { id: "old-child", parentId: "old-root", yoloEnabled: false },
              { id: "stale", parentId: null, yoloEnabled: false },
            ]
          : [{ id: "new-root", parentId: null, yoloEnabled: true }]
      },
      async persist() {},
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier, persistence })
    manager.start()
    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "old", status: "connecting" })
    await manager.hydrateInstance("inst")
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "stale-permission", sessionID: "stale" },
    }, "old")

    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "new", status: "connecting" })
    await manager.hydrateInstance("inst")
    await flushMicrotasks()

    assert.equal(loads, 2)
    assert.equal(manager.isEnabled("inst", "old-child"), false)
    assert.equal(manager.isEnabled("inst", "new-root"), true)
    assert.equal(replier.calls.length, 0, "stale pending permission must not drain into the new runtime")
    manager.stop()
  })

  it("ignores an old reply completion without disturbing the new in-flight reply", async () => {
    const bus = new EventBus(noopLogger)
    const completions: Array<() => void> = []
    const calls: AutoAcceptReply[] = []
    const accepted: Record<string, unknown>[] = []
    const signals: AbortSignal[] = []
    const replier: PermissionReplier = (reply, signal) => {
      calls.push(reply)
      signals.push(signal)
      return new Promise<void>((resolve) => completions.push(resolve))
    }
    bus.on("yolo.autoAccepted", (event) => accepted.push(event))
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "old", status: "connecting" })
    publishSession(bus, "inst", "session.updated", { id: "root", parentID: null })
    manager.toggle("inst", "root")
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "same-permission", sessionID: "root" },
    }, "old")

    bus.publish({ type: "instance.eventStatus", instanceId: "inst", streamId: "new", status: "connecting" })
    assert.equal(signals[0]?.aborted, true)
    publishSession(bus, "inst", "session.updated", { id: "root", parentID: null })
    manager.toggle("inst", "root")
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "same-permission", sessionID: "root" },
    }, "new")
    assert.equal(calls.length, 2)
    assert.equal(signals[1]?.aborted, false)

    completions[0]()
    await flushMicrotasks()
    assert.equal(accepted.length, 0)
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "same-permission", sessionID: "root" },
    }, "new")
    assert.equal(calls.length, 2, "old completion must not clear the new in-flight marker")

    completions[1]()
    await flushMicrotasks()
    assert.equal(accepted.length, 1)
    assert.equal(accepted[0].permissionId, "same-permission")
    manager.stop()
  })
})

describe("AutoAcceptManager pending permissions drain", () => {
  it("drains a pending permission that arrived before enable", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })

    // permission arrives while yolo is OFF
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-pending", sessionID: "solo" },
    })
    await flushMicrotasks()
    assert.equal(replier.calls.length, 0)

    // enabling yolo should drain the pending permission
    manager.toggle("inst", "solo")
    await flushMicrotasks()

    assert.equal(replier.calls.length, 1)
    assert.equal(replier.calls[0].permissionId, "perm-pending")

    manager.stop()
  })

  it("drains pending permissions for the same family only", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "root-a", parentID: null })
    publishSession(bus, "inst", "session.updated", { id: "root-b", parentID: null })

    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-a", sessionID: "root-a" },
    })
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-b", sessionID: "root-b" },
    })
    await flushMicrotasks()
    assert.equal(replier.calls.length, 0)

    manager.toggle("inst", "root-a")
    await flushMicrotasks()

    assert.equal(replier.calls.length, 1)
    assert.equal(replier.calls[0].permissionId, "perm-a")

    manager.stop()
  })

  it("does not re-drain already-auto-accepted permissions", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    manager.toggle("inst", "solo")

    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-1", sessionID: "solo" },
    })
    await flushMicrotasks()
    assert.equal(replier.calls.length, 1)

    // toggling off then on should not re-drain the already-replied permission
    manager.toggle("inst", "solo") // off
    manager.toggle("inst", "solo") // on — drain runs but pending set is empty
    await flushMicrotasks()

    assert.equal(replier.calls.length, 1)

    manager.stop()
  })

  it("re-drains pending when late session ancestry joins an enabled family", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    // master exists, yolo enabled on master
    publishSession(bus, "inst", "session.updated", { id: "master", parentID: null })
    manager.toggle("inst", "master")

    // child permission arrives BEFORE child's session ancestry is known.
    // At this point "child" is unknown to the tree, so it resolves as its
    // own root and the permission is NOT auto-accepted.
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-late", sessionID: "child" },
    })
    await flushMicrotasks()
    assert.equal(replier.calls.length, 0)

    // child session ancestry arrives — child.parentID = "master".
    // ingestSession → upsertSession → migrateEnabledRoots makes "child"
    // resolve to "master" (enabled). drainPending should fire and accept
    // the previously-pending permission.
    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "master" })
    await flushMicrotasks()

    assert.equal(replier.calls.length, 1)
    assert.equal(replier.calls[0].permissionId, "perm-late")
    assert.equal(replier.calls[0].sessionId, "child")

    manager.stop()
  })
})

describe("AutoAcceptManager permission replied cleanup", () => {
  it("removes a pending permission on permission.v2.replied", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })

    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-x", sessionID: "solo" },
    })
    await flushMicrotasks()

    // user manually replies → replied event cleans up pending
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.replied",
      properties: { id: "perm-x" },
    })

    // enabling yolo now should NOT drain the already-replied permission
    manager.toggle("inst", "solo")
    await flushMicrotasks()

    assert.equal(replier.calls.length, 0)
    manager.stop()
  })

  it("removes a pending permission on legacy permission.replied", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })

    publishInstanceEvent(bus, "inst", {
      type: "permission.asked",
      properties: { id: "perm-y", sessionID: "solo" },
    })
    await flushMicrotasks()

    publishInstanceEvent(bus, "inst", {
      type: "permission.replied",
      properties: { requestID: "perm-y" },
    })

    manager.toggle("inst", "solo")
    await flushMicrotasks()

    assert.equal(replier.calls.length, 0)
    manager.stop()
  })
})

describe("AutoAcceptManager clearInstance clears pending", () => {
  it("drops pending permissions on clearInstance", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })

    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-z", sessionID: "solo" },
    })
    await flushMicrotasks()

    manager.clearInstance("inst")

    // re-create session and enable — pending set should be empty
    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    manager.toggle("inst", "solo")
    await flushMicrotasks()

    assert.equal(replier.calls.length, 0)
    manager.stop()
  })
})

describe("AutoAcceptManager permission.updated source inference", () => {
  it("preserves the original v2 source when permission.updated arrives", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    // yolo is OFF — permission goes to pending with source "v2"
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-v2", sessionID: "solo" },
    })
    await flushMicrotasks()

    // enable yolo, then send permission.updated — should keep source "v2"
    manager.toggle("inst", "solo")
    publishInstanceEvent(bus, "inst", {
      type: "permission.updated",
      properties: { id: "perm-v2", sessionID: "solo" },
    })
    await flushMicrotasks()

    assert.equal(replier.calls.length, 1)
    assert.equal(replier.calls[0].source, "v2")

    manager.stop()
  })

  it("skips permission.updated for a permission not in pending", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    manager.toggle("inst", "solo")

    // permission.updated for a permission that was never asked (not in pending)
    publishInstanceEvent(bus, "inst", {
      type: "permission.updated",
      properties: { id: "perm-unknown", sessionID: "solo" },
    })
    await flushMicrotasks()

    assert.equal(replier.calls.length, 0)
    manager.stop()
  })
})

describe("AutoAcceptManager replier failure handling", () => {
  it("keeps permission pending and does not emit autoAccepted on failure", async () => {
    const bus = new EventBus(noopLogger)
    const autoAccepted: unknown[] = []
    bus.on("yolo.autoAccepted", (e) => autoAccepted.push(e))
    const failingReplier: PermissionReplier = async () => {
      throw new Error("connection refused")
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: failingReplier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    manager.toggle("inst", "solo")

    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-fail", sessionID: "solo" },
    })
    await flushMicrotasks()

    assert.equal(autoAccepted.length, 0)
    // permission should still be pending (enabling again would try again)
    manager.toggle("inst", "solo") // off
    manager.toggle("inst", "solo") // on — drain retries
    await flushMicrotasks()

    assert.equal(autoAccepted.length, 0)

    manager.stop()
  })

  it("stops retrying after MAX_REPLY_ATTEMPTS", async () => {
    const bus = new EventBus(noopLogger)
    let callCount = 0
    const failingReplier: PermissionReplier = async () => {
      callCount++
      throw new Error("timeout")
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: failingReplier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    manager.toggle("inst", "solo")

    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-stuck", sessionID: "solo" },
    })
    await flushMicrotasks()
    const attemptsAfterFirst = callCount

    // trigger drains via session events
    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    await flushMicrotasks()
    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    await flushMicrotasks()
    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    await flushMicrotasks()

    // should have attempted at most MAX_REPLY_ATTEMPTS times total
    assert.ok(callCount <= 3, `expected at most 3 attempts, got ${callCount}`)
    assert.equal(callCount, attemptsAfterFirst + 2) // 2 more retries (total 3), then stops

    manager.stop()
  })
})

describe("AutoAcceptManager workspace.error cleanup", () => {
  it("clears state when the workspace errors", () => {
    const bus = new EventBus(noopLogger)
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier() })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })
    manager.toggle("inst", "solo")
    assert.equal(manager.isEnabled("inst", "solo"), true)

    bus.publish({ type: "workspace.error", workspace: { id: "inst" } as any })

    assert.equal(manager.isEnabled("inst", "solo"), false)
    manager.stop()
  })
})

describe("AutoAcceptManager session.deleted clears pending", () => {
  it("removes pending permissions for a deleted session", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()

    publishSession(bus, "inst", "session.updated", { id: "solo", parentID: null })

    // permission arrives while yolo is OFF → goes to pending
    publishInstanceEvent(bus, "inst", {
      type: "permission.v2.asked",
      properties: { id: "perm-doomed", sessionID: "solo" },
    })
    await flushMicrotasks()

    // session deleted → pending should be cleared
    publishSession(bus, "inst", "session.deleted", { id: "solo" })

    // enabling yolo should not drain the deleted session's permission
    manager.toggle("inst", "solo")
    await flushMicrotasks()

    assert.equal(replier.calls.length, 0)
    manager.stop()
  })
})

function makeRecordingReplier() {
  const calls: AutoAcceptReply[] = []
  const replier: PermissionReplier = async (reply) => {
    calls.push(reply)
  }
  return Object.assign(replier, { calls }) as PermissionReplier & { calls: AutoAcceptReply[] }
}

function flushMicrotasks() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}
