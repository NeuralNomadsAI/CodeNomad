import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { test } from "node:test"
import pino from "pino"
import type { WorkspaceEventPayload } from "../api-types"
import { explicitContractFixture } from "../opencode/compatibility/contract-fixture"
import { OpenCodeServerConnections } from "../opencode/servers/connections"
import { OpenCodeServerCredentials } from "../opencode/servers/credentials"
import { OpenCodeServerRegistry } from "../opencode/servers/registry"
import { InstanceEventBridge } from "../workspaces/instance-events"
import { WorkspaceManager } from "../workspaces/manager"
import { EventBus } from "./bus"

async function until(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check()) {
    assert.ok(Date.now() < end, "lifecycle condition timed out")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test("actual project lifecycle bounds status replay by live occurrences, including late routing and last detach", async t => {
  const streams = new Set<ServerResponse>()
  let lateRead: ServerResponse | undefined
  const send = (res: ServerResponse, event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  const upstream = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture")
    const directory = url.searchParams.get("location[directory]")
    if (url.pathname === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      streams.add(res)
      res.on("close", () => streams.delete(res))
      send(res, { type: "server.connected", id: "same", created: 1, data: {} })
      return
    }
    res.setHeader("content-type", "application/json")
    if (url.pathname === "/api/session/late") { lateRead = res; return }
    res.end(JSON.stringify(url.pathname === "/openapi.json" ? explicitContractFixture()
      : url.pathname === "/api/location" ? { directory, project: { id: "same", directory, canonical: directory } }
      : url.pathname === "/api/fs/list" ? { location: { directory }, data: [] }
      : { version: "99.0.0" }))
  })
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening")
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  let profiles = [{ kind: "explicit" as const, id: "A", label: "A", origin }]
  const registry = new OpenCodeServerRegistry(() => profiles, next => { profiles = next as typeof profiles })
  const credentials = new OpenCodeServerCredentials({ profileKey: "fixture", configIdentity: "memory" }, registry)
  await credentials.set("A", JSON.stringify({ username: "fixture", password: "synthetic" }))
  const forbidden = (): never => { throw new Error("Host operation forbidden") }
  const connections = new OpenCodeServerConnections({ registry, credentials, local: { acquire: forbidden, existing: forbidden, invalidate: forbidden } })
  const bus = new EventBus()
  const live: WorkspaceEventPayload[] = []
  const off = bus.onEvent(frame => live.push(frame))
  t.after(off)
  const manager = new WorkspaceManager({ rootDir: "D:/unused-fixture", eventBus: bus, logger: pino({ level: "silent" }),
    binaryResolver: { resolveDefault: forbidden } as never,
    settings: { getOpenCodeServerConnections: () => connections, getOwner: forbidden, readEnvironmentForAdmission: forbidden,
      disposeOpenCodeServers: () => connections.dispose() } as never,
    sharedService: { endpoint: forbidden, client: forbidden, headers: forbidden, validateLocation: forbidden, subscribe: forbidden, shutdown: async () => {} },
    wslHostDirectoryResolver: forbidden, wslServiceDirectoryResolver: forbidden,
  })
  const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger: pino({ level: "silent" }) })
  t.after(async () => {
    bridge.shutdown(); await manager.shutdown()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  })
  const replay = () => {
    const frames: WorkspaceEventPayload[] = []
    const off = bus.onEvent(frame => frames.push(frame)); off()
    return frames.filter(frame => frame.type === "instance.eventStatus")
  }
  const listeners = () => ["workspace.started", "workspace.stopped", "workspace.error"].map(type => bus.listenerCount(type))
  const baseline = listeners()
  const open = async () => {
    const { workspace } = await manager.create("/same", undefined, { serverId: "A" })
    await until(() => replay().some(frame => frame.instanceId === workspace.id && frame.status === "connected"))
    return workspace
  }
  await connections.connect("A")
  assert.deepEqual(replay(), [], "Connect without a project has no occurrence status")
  const sibling = await open()
  for (let cycle = 0; cycle < 20; cycle++) {
    const workspace = await open()
    if (cycle === 0) {
      for (const stream of streams) send(stream, { type: "session.text.delta", id: "late-event", created: 1, data: { sessionID: "late", delta: "fixture" } })
      await until(() => Boolean(lateRead))
    }
    await manager.delete(workspace.id)
    if (cycle === 0) {
      lateRead!.end(JSON.stringify({ data: { id: "late", location: { directory: "/same" } } }))
      await until(() => live.some(frame => frame.type === "instance.event" && frame.instanceId === sibling.id && frame.event.type === "session.text.delta"))
      const stopped = live.findIndex(frame => frame.type === "workspace.stopped" && frame.workspaceId === workspace.id)
      assert.ok(stopped >= 0)
      assert.equal(live.slice(stopped + 1).some(frame => frame.type === "instance.eventStatus" && frame.instanceId === workspace.id && frame.reason !== "workspace stopped"), false,
        "late routing cannot reinsert a stopped occurrence status")
    }
    assert.deepEqual(replay().map(frame => frame.instanceId), [sibling.id])
  }
  connections.disconnect("A")
  assert.deepEqual(replay().map(frame => [frame.instanceId, frame.status, frame.gap]), [[sibling.id, "disconnected", "revoked"]])
  await manager.delete(sibling.id)
  assert.deepEqual(replay(), [])
  let generation = 0
  for (let cycle = 0; cycle < 20; cycle++) {
    await connections.connect("A")
    const workspace = await open()
    assert.ok(replay()[0].source!.generation > generation)
    generation = replay()[0].source!.generation
    if (cycle % 2) connections.disconnect("A")
    await manager.delete(workspace.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(replay(), [])
    assert.equal(connections.activeExplicitTargets, 0)
    assert.deepEqual(manager.list(), [])
    assert.deepEqual(listeners(), baseline, "retired sources release lifecycle callbacks")
  }
  off()
  assert.equal(bus.listenerCount("instance.eventStatus"), 0, "temporary replay subscribers release callbacks")
})
