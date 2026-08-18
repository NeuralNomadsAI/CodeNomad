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

function publishInstanceEvent(bus: EventBus, instanceId: string, event: Record<string, unknown>) {
  const type = event.type === "permission.v2.asked"
    ? "permission.asked"
    : event.type === "permission.v2.replied"
      ? "permission.replied"
      : event.type
  const { properties, ...nativeEvent } = event
  const wrapped = properties as { info?: Record<string, unknown> } | undefined
  const data = event.data ?? (wrapped?.info
    ? { ...wrapped.info, sessionID: wrapped.info.sessionID ?? wrapped.info.id }
    : properties)
  bus.publish({ type: "instance.event", instanceId, event: { ...nativeEvent, type, data } as InstanceStreamEvent })
}

/** Publish session lifecycle events using the native V2 data envelope. */
function publishSession(
  bus: EventBus,
  instanceId: string,
  eventType: "session.updated" | "session.created" | "session.deleted",
  info: Record<string, unknown>,
) {
  publishInstanceEvent(bus, instanceId, {
    type: eventType === "session.updated" ? "session.created" : eventType,
    data: { ...info, sessionID: info.sessionID ?? info.id },
  })
}

describe("AutoAcceptManager session tree", () => {
  it("does not apply Yolo policy to a session unknown to that logical workspace", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()
    manager.toggle("wrong-owner", "session")
    publishInstanceEvent(bus, "wrong-owner", {
      type: "permission.asked",
      properties: { id: "permission", sessionID: "session" },
    })
    await flushMicrotasks()
    assert.equal(replier.calls.length, 0)

    publishSession(bus, "wrong-owner", "session.updated", { id: "session", parentID: null })
    await flushMicrotasks()
    assert.equal(replier.calls.length, 1)
    manager.stop()
  })

  it("does not auto-reply when API hydration rejects cross-workspace ownership", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const persistence: AutoAcceptPersistence = {
      async loadSessions() { return [{ id: "root", parentId: null, yoloEnabled: true }] },
      async loadSession() { return null },
      async persist() {},
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier, persistence })
    manager.start()
    await manager.hydrateInstance("inst")

    publishInstanceEvent(bus, "inst", {
      type: "permission.asked",
      properties: { id: "foreign-permission", sessionID: "foreign-session" },
    })
    await flushMicrotasks()

    assert.equal(replier.calls.length, 0)
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
      async loadSession() { return { id: "root", parentId: null, yoloEnabled: false } },
      async persist(...args) { writes.push(args); await gate },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    const toggle = manager.toggle("inst", "root")
    await flushMicrotasks()
    assert.deepEqual(writes, [["inst", "root", true]])
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
      async loadSession() { return { id: "root", parentId: null, yoloEnabled: false } },
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
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
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
    await manager.hydrateInstance("inst")
    await flushMicrotasks()
    assert.equal(replier.calls.length, 1)
    manager.stop()
  })

  it("rejects a persisted toggle when the native session belongs to another logical workspace", async () => {
    const bus = new EventBus(noopLogger)
    let writes = 0
    const persistence: AutoAcceptPersistence = {
      async loadSessions() { return [{ id: "foreign", parentId: null, yoloEnabled: false }] },
      async loadSession() { return null },
      async persist() { writes += 1 },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    await assert.rejects(Promise.resolve(manager.toggle("inst", "foreign")), /does not belong to workspace/)
    assert.equal(writes, 0)
    assert.equal(manager.isEnabled("inst", "foreign"), false)
  })

  it("does not re-enable memory when a persisted toggle finishes after cleanup", async () => {
    const bus = new EventBus(noopLogger)
    const changes: Record<string, unknown>[] = []
    bus.on("yolo.stateChanged", (event) => changes.push(event))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let writes = 0
    const persistence: AutoAcceptPersistence = {
      async loadSessions() { return [{ id: "root", parentId: null, yoloEnabled: false }] },
      async loadSession() { return { id: "root", parentId: null, yoloEnabled: false } },
      async persist() { writes += 1; await gate },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    const toggle = manager.toggle("inst", "root")
    const queued = manager.toggle("inst", "root")
    await flushMicrotasks()
    manager.clearInstance("inst")
    release()
    assert.equal(await toggle, false)
    assert.equal(await queued, false)
    assert.equal(writes, 1)
    assert.equal(manager.isEnabled("inst", "root"), false)
    assert.equal(changes.length, 0)
  })

  it("moves persisted Yolo state when late ancestry changes the family root", async () => {
    const bus = new EventBus(noopLogger)
    const writes: unknown[][] = []
    const persistence: AutoAcceptPersistence = {
      async loadSessions() {
        return [
          { id: "parent", parentId: null, yoloEnabled: false },
          { id: "child", parentId: null, yoloEnabled: true },
        ]
      },
      async persist(...args) { writes.push(args) },
    }
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier: makeRecordingReplier(), persistence })
    manager.start()
    await manager.hydrateInstance("inst")
    publishSession(bus, "inst", "session.updated", { id: "child", parentID: "parent", workspaceID: "workspace" })
    await flushMicrotasks()
    assert.equal(manager.isEnabled("inst", "parent"), true)
    assert.deepEqual(writes, [
      ["inst", "parent", true],
      ["inst", "child", false],
    ])
    manager.stop()
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
          { id: "grandparent", parentId: null, yoloEnabled: false },
          { id: "parent", parentId: null, yoloEnabled: false },
          { id: "child", parentId: null, yoloEnabled: true },
        ]
      },
      async loadSession() { return { id: "child", parentId: null, yoloEnabled: true } },
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
  it("replies once when duplicate logical workspaces receive the same native permission", async () => {
    const bus = new EventBus(noopLogger)
    const replier = makeRecordingReplier()
    const manager = new AutoAcceptManager({ eventBus: bus, logger: noopLogger, replier })
    manager.start()
    for (const instanceId of ["first", "second"]) {
      publishSession(bus, instanceId, "session.updated", { id: "session", parentID: null })
      manager.toggle(instanceId, "session")
      publishInstanceEvent(bus, instanceId, {
        type: "permission.asked",
        properties: { id: "permission", sessionID: "session" },
      })
    }
    await flushMicrotasks()

    assert.equal(replier.calls.length, 1)
    manager.stop()
  })

})

describe("AutoAcceptManager pending permissions drain", () => {
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
