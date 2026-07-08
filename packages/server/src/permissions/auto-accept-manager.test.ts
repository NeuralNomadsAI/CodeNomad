import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { EventBus } from "../events/bus"
import { AutoAcceptManager, type PermissionReplier, type AutoAcceptReply } from "./auto-accept-manager"
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
  bus.publish({ type: "instance.event", instanceId, event: { ...event } as InstanceStreamEvent })
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
