import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { OpenCode } from "@opencode/client"
import type { WorkspaceEventPayload } from "../api-types"
import { EventBus } from "../events/bus"
import { attachLocalPushEvents, type LocalPushEvent } from "./local-events"

async function fixture(t: test.TestContext) {
  const bus = new EventBus()
  const output: LocalPushEvent[] = []
  const requests: string[] = []
  const inventoryReads: string[] = []
  let interested = true
  let parentID: string | undefined, directory = "/repo", active = false, unavailable = false, metadataUnavailable = false
  let hold: Promise<void> | undefined, holdMetadata: Promise<void> | undefined
  const server = createServer(async (req, res) => {
    requests.push(req.url!)
    if (req.url === "/api/session/active") {
      await hold
      if (unavailable) { res.writeHead(503).end(); return }
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ data: active ? { root: { type: "running" } } : {} }))
      return
    }
    await holdMetadata
    if (metadataUnavailable) { res.writeHead(503).end(); return }
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ data: { id: "root", parentID, projectID: "project", location: { directory },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 } } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as { port: number }
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${address.port}` })
  let currentConnection = true
  const connection = { client, assertCurrent() { assert.ok(currentConnection) } }
  const workspace = { id: "one", path: "/repo" }
  const nested = { id: "nested", path: "/repo/nested" }
  let open = true, nestedOpen = false, owned = true, worktreeDirectory = ""
  const manager = {
    get: (id: string) => open ? id === "nested" ? nested : workspace : undefined,
    list: () => nestedOpen ? [workspace, nested] : [workspace],
    getExistingSharedServiceConnection: () => connection,
    ownsLocation: async () => owned,
    getServiceLocation: (id: string) => ({ directory: id === "nested" ? "/repo/nested" : "/repo" }),
    getWorktrees: async () => { assert.fail("notification qualification must never discover worktrees") },
    getEventWorktrees: async (id: string) => {
      inventoryReads.push(id)
      return { worktrees: worktreeDirectory ? [{ directory: "/host/worktree", serviceDirectory: worktreeDirectory }] : [] }
    },
  }
  const dispose = attachLocalPushEvents({ eventBus: bus,
    workspaceManager: manager as unknown as Parameters<typeof attachLocalPushEvents>[0]["workspaceManager"],
    interested: () => interested, emit: event => output.push(event) })
  t.after(() => { dispose(); server.closeAllConnections(); server.close() })
  const publish = (type: string, data: Record<string, unknown> = {}, id = type) => bus.publish({
    type: "instance.event", instanceId: "one",
    event: { type, id, created: 1, data: { sessionID: "root", ...data }, location: { directory } },
  } as WorkspaceEventPayload)
  const settle = () => new Promise(resolve => setTimeout(resolve, 60))
  return { bus, output, requests, inventoryReads, publish, settle, dispose,
    setInterest: (value: boolean) => { interested = value },
    setParent: (value?: string) => { parentID = value },
    setDirectory: (value: string) => { directory = value },
    setActive: (value: boolean) => { active = value },
    setUnavailable: () => { unavailable = true },
    setMetadataUnavailable: () => { metadataUnavailable = true },
    setOwned: (value: boolean) => { owned = value },
    setNestedOpen: () => { nestedOpen = true },
    setWorktree: (value: string) => { worktreeDirectory = value },
    closeWorkspace: () => { open = false },
    revokeConnection: () => { currentConnection = false },
    holdActive: () => { let release!: () => void; hold = new Promise<void>(resolve => { release = resolve }); return release },
    holdMetadata: () => { let release!: () => void; holdMetadata = new Promise<void>(resolve => { release = resolve }); return release },
  }
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail("event qualification did not settle")
}

test("root completion requires authoritative inactivity and uses stable dedupe keys", async t => {
  const f = await fixture(t)
  f.publish("session.execution.succeeded")
  f.publish("session.execution.succeeded")
  await until(() => f.output.length === 1)
  assert.equal(f.output[0].category, "sessionDone")
  assert.equal(f.output[0].sessionId, "root")
  f.publish("session.execution.succeeded")
  await f.settle()
  assert.equal(f.output.length, 1)
  f.publish("session.execution.succeeded", {}, "second-run")
  await until(() => f.output.length === 2)
  assert.notEqual(f.output[0].key, f.output[1].key)
  assert.ok(f.requests.includes("/api/session/active"))
  assert.ok(f.requests.includes("/api/session/root"))
})

test("only success and inactivity interruptions notify; busy and unavailable never complete", async t => {
  const f = await fixture(t)
  for (const type of ["session.execution.failed", "session.compaction.failed"]) f.publish(type)
  for (const reason of ["user", "shutdown"]) f.publish("session.execution.interrupted", { reason }, reason)
  await f.settle()
  assert.equal(f.requests.length, 0)
  f.setActive(true)
  f.publish("session.execution.succeeded")
  await f.settle()
  assert.equal(f.output.length, 0)
  f.setActive(false)
  f.publish("session.execution.interrupted", { reason: "inactivity" }, "inactivity")
  await until(() => f.output.length === 1)
  f.setUnavailable()
  f.publish("session.execution.succeeded", {}, "unavailable")
  await f.settle()
  assert.equal(f.output.length, 1)
})

test("permission and form attention only notify hydrated roots, deduplicated by request", async t => {
  const f = await fixture(t)
  f.setParent("parent")
  f.publish("permission.asked", { id: "child-request" })
  await f.settle()
  assert.equal(f.output.length, 0)
  f.setParent()
  f.publish("permission.asked", { id: "request" }, "delivery-one")
  await until(() => f.output.length === 1)
  f.publish("permission.asked", { id: "request" }, "delivery-two")
  await f.settle()
  assert.equal(f.output.length, 1)
  f.publish("form.created", { form: { id: "form", sessionID: "root" } })
  await until(() => f.output.length === 2)
  assert.deepEqual(f.output.map(e => e.category), ["needsInput", "needsInput"])
})

test("nested requests fall back to owning project unless another open project lists them", async t => {
  const f = await fixture(t)
  f.setDirectory("/repo/nested")
  f.publish("session.execution.succeeded")
  await f.settle()
  assert.equal(f.output.length, 0)
  f.publish("permission.asked", { id: "nested" })
  await until(() => f.output.length === 1)
  f.setNestedOpen()
  f.publish("permission.asked", { id: "nested-two" }, "two")
  await f.settle()
  assert.equal(f.output.length, 1)
  f.setOwned(false)
  f.publish("permission.asked", { id: "foreign" }, "foreign")
  await f.settle()
  assert.equal(f.output.length, 1)
})

test("registered worktree service directories qualify completion with renderer path identity", async t => {
  const f = await fixture(t)
  f.setWorktree("C:\\Repo\\Worktree")
  f.setDirectory("c:/repo/worktree/")
  f.publish("session.execution.succeeded")
  await until(() => f.output.length === 1)
  assert.deepEqual(f.inventoryReads, ["one"])
  f.setWorktree("//wsl.localhost/Ubuntu/Repo")
  f.setDirectory("//WSL.LOCALHOST/ubuntu/repo")
  f.publish("session.execution.succeeded", {}, "case-sensitive-wsl")
  await f.settle()
  assert.equal(f.output.length, 1)
})

test("new activity fences an older terminal check", async t => {
  const f = await fixture(t)
  const release = f.holdActive()
  f.publish("session.execution.succeeded")
  await until(() => f.requests.includes("/api/session/active"))
  f.publish("session.execution.started")
  release()
  await f.settle()
  assert.equal(f.output.length, 0)
})

test("workspace, connection, stream and disposal authority fence outstanding reads", async t => {
  for (const revoke of ["closeWorkspace", "revokeConnection", "dispose", "disconnect", "topology"] as const) {
    const f = await fixture(t)
    const release = f.holdActive()
    f.publish("session.execution.succeeded")
    await until(() => f.requests.includes("/api/session/active"))
    if (revoke === "disconnect") f.bus.publish({ type: "instance.eventStatus", instanceId: "one", status: "disconnected", generation: 1 })
    else if (revoke === "topology") f.bus.publish({ type: "workspace.worktreesChanged", workspaceId: "one" })
    else f[revoke]()
    release()
    await f.settle()
    assert.equal(f.output.length, 0, revoke)
  }
})

test("settled requests cannot notify from late metadata or replayed request events", async t => {
  const f = await fixture(t)
  const release = f.holdMetadata()
  f.publish("permission.asked", { id: "permission" })
  f.publish("form.created", { form: { id: "form", sessionID: "root" } })
  await until(() => f.requests.length === 2)
  f.publish("permission.replied", { requestID: "permission" })
  f.publish("form.cancelled", { id: "form" })
  release()
  await f.settle()
  f.publish("permission.asked", { id: "permission" }, "replay")
  f.publish("form.created", { form: { id: "form", sessionID: "root" } }, "replay")
  await f.settle()
  assert.equal(f.output.length, 0)
  assert.equal(f.requests.length, 2)
})

test("missing metadata and sessionless global forms never invent a root", async t => {
  const f = await fixture(t)
  f.setMetadataUnavailable()
  f.publish("permission.asked", { id: "missing" })
  f.publish("form.created", { form: { id: "global", sessionID: "global" } })
  await until(() => f.requests.length === 1)
  await f.settle()
  assert.equal(f.output.length, 0)
})

test("a request storm has bounded native demand and disposal removes listeners", async t => {
  const f = await fixture(t)
  const release = f.holdMetadata()
  for (let i = 0; i < 100; i++) f.publish("permission.asked", { id: `permission-${i}` }, `event-${i}`)
  await until(() => f.requests.length === 32)
  f.dispose()
  release()
  await f.settle()
  assert.equal(f.requests.length, 32)
  assert.equal(f.output.length, 0)
  assert.equal(f.bus.listenerCount("instance.event"), 0)
})

test("uninterested projects perform no native IO or worktree inventory reads", async t => {
  const f = await fixture(t)
  f.setInterest(false)
  f.setDirectory("/registered/worktree")
  f.publish("session.execution.succeeded")
  f.publish("permission.asked", { id: "uninterested" })
  f.publish("form.created", { form: { id: "uninterested-form", sessionID: "root" } })
  await f.settle()
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.inventoryReads, [])
  assert.deepEqual(f.output, [])
  f.setInterest(true)
  f.setDirectory("/repo")
  f.publish("session.execution.succeeded")
  await until(() => f.output.length === 1)
})

test("interest withdrawn during metadata read prevents subsequent native IO", async t => {
  const f = await fixture(t)
  const release = f.holdMetadata()
  f.publish("session.execution.succeeded")
  await until(() => f.requests.length === 1)
  f.setInterest(false)
  release()
  await f.settle()
  assert.deepEqual(f.requests, ["/api/session/root"])
  assert.deepEqual(f.inventoryReads, [])
  assert.deepEqual(f.output, [])
})
