import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import type { OpenCodeClient } from "@opencode/client"
import { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import { WorkspaceCapabilityError } from "../opencode/servers/capabilities"
import type { SettingsService } from "../settings/service"
import type { WorkspaceManager } from "../workspaces/manager"
import { registerYoloRoutes } from "../server/routes/yolo"
import { AutoAcceptManager } from "./auto-accept-manager"
import { createOpencodeYoloPersistence } from "./opencode-yolo-metadata"

test("Yolo routes, persistence and automatic events refuse A/B before colliding local state or native calls", async () => {
  const effects: string[] = []
  const logger = { warn() {}, error() {}, debug() {}, info() {}, trace() {}, isLevelEnabled: () => false } as unknown as Logger
  const bus = new EventBus(logger)
  const workspaceManager = {
    requireWorkspaceCapability(id: string, capability: string) {
      assert.equal(capability, "yolo")
      if (id !== "local") throw new WorkspaceCapabilityError("yolo", { code: "deferred" })
      return new AbortController().signal
    },
    get: () => ({ path: "/same" }),
    getServiceDirectory: () => "/same",
    ownsDirectory: async () => true,
  } as unknown as WorkspaceManager
  let enabled = true
  const settings = {
    getOwner: () => { effects.push("state.read"); return { sessions: { same: { yoloEnabled: enabled } } } },
    mergePatchOwner: (_kind: string, _owner: string, patch: { sessions: { same: { yoloEnabled: boolean } } }) => {
      effects.push("state.write")
      enabled = patch.sessions.same.yoloEnabled
    },
  } as unknown as SettingsService
  const session = { id: "same", location: { directory: "/same" } }
  const client = { session: {
    list: async () => { effects.push("native.list"); return { data: [session], cursor: {} } },
    get: async () => { effects.push("native.get"); return session },
  } } as unknown as OpenCodeClient
  const persistence = createOpencodeYoloPersistence(workspaceManager, settings, async () => {
    effects.push("acquire")
    return client
  })
  const manager = new AutoAcceptManager({ eventBus: bus, logger, persistence, replier: async ({ instanceId }) => { effects.push(`reply.${instanceId}`) } })
  manager.start()
  const app = Fastify()
  registerYoloRoutes(app, { yoloManager: manager })
  try {
    for (const id of ["A", "B"]) {
      for (const [method, suffix] of [["GET", ""], ["POST", "/toggle"]] as const) {
        const response = await app.inject({ method, url: `/workspaces/${id}/yolo/sessions/same${suffix}` })
        assert.equal(response.statusCode, 403)
        assert.deepEqual(response.json(), { error: "explicit_capability_unavailable", code: "explicit_capability_unavailable", capability: "yolo", reason: { code: "deferred" } })
      }
      await assert.rejects(persistence.loadSessions(id), WorkspaceCapabilityError)
      await assert.rejects(persistence.loadSession!(id, "same"), WorkspaceCapabilityError)
      assert.throws(() => persistence.persist(id, "same", true), WorkspaceCapabilityError)
      assert.throws(() => manager.toggle(id, "same"), WorkspaceCapabilityError)
      bus.publish({ type: "workspace.started", workspace: { id } } as never)
      for (const event of [
        { type: "session.created", data: { sessionID: "same" } },
        { type: "permission.asked", data: { id: "same-permission", sessionID: "same" } },
      ]) {
        bus.publish({ type: "instance.event", instanceId: id, event } as never)
        manager.handleInstanceEvent(id, event)
      }
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(effects.length, 0)
    assert.equal((await app.inject("/workspaces/local/yolo/sessions/same")).json().enabled, true)
    bus.publish({ type: "instance.event", instanceId: "local", event: {
      type: "permission.asked", data: { id: "same-permission", sessionID: "same" },
    } } as never)
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(effects.includes("reply.local"))
    assert.equal((await app.inject({ method: "POST", url: "/workspaces/local/yolo/sessions/same/toggle" })).json().enabled, false)
  } finally {
    manager.stop()
    await app.close()
  }
})
