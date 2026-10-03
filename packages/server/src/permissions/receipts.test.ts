import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import type { Logger } from "../logger"
import type { WorkspaceManager } from "../workspaces/manager"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { nativeEventConnections } from "../workspaces/opencode-service"
import type { InstanceStreamEvent, PermissionReceipt } from "../api-types"
import { EventBus } from "../events/bus"
import { PermissionReceiptStore, permissionSnapshot } from "./receipt-store"
import { PermissionReceipts } from "./receipts"
import { createOpencodePermissionReplier } from "./opencode-replier"
import { AutoAcceptManager } from "./auto-accept-manager"
import { registerPermissionReceiptRoutes } from "../server/routes/permission-receipts"
import { registerInstanceProxyRoutes } from "../server/http-server"
import { WorktreeDeletionFence } from "../workspaces/worktree-session-evacuation"

const logger = { error() {}, warn() {}, debug() {}, trace() {}, isLevelEnabled: () => false } as unknown as Logger
const pending = (id = "p", source = true) => ({ id, sessionID: "s", action: "shell", resources: ["git status"],
  message: "Inspect repository", metadata: { secret: "never-persist", diff: "FULL DIFF" },
  ...(source ? { source: { type: "tool", messageID: "m", id: "call" } } : {}) })

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-receipts-"))
  const bus = new EventBus()
  const state = { owned: true, current: true, replies: 0, failure: false, directory: "/native/config", distro: undefined as string | undefined }
  const workspace = { id: "w", path: "/project" }
  const connection = {
    endpoint: { url: "http://127.0.0.1:4096", auth: { type: "basic", username: "opencode", password: "fixture-only" } },
    client: {
      debug: { location: { list: async () => [{ directory: "/project" }] } },
      config: { get: async () => [{ type: "directory", path: state.directory }] },
      session: { get: async () => ({ id: "s", location: { directory: "/project" } }) },
      permission: {
        get: async ({ requestID }: { requestID: string }) => pending(requestID),
        request: { list: async () => ({ data: [pending()] }) },
        reply: async () => { state.replies++; if (state.failure) throw new Error("transport failed") },
      },
    },
    assertCurrent: () => { if (!state.current) throw new Error("stale connection") },
  } as unknown as ServiceConnection
  const manager = {
    get: () => workspace,
    getSharedServiceConnection: async () => connection,
    getServiceWslDistro: () => state.distro,
    getServicePathStyle: () => "posix",
    ownsLocation: async () => state.owned,
  } as unknown as WorkspaceManager
  const store = new PermissionReceiptStore(root)
  const receipts = new PermissionReceipts(store, manager, bus, logger)
  const emit = (type: string, data: unknown) => {
    const event = { type, data, created: 123 } as InstanceStreamEvent
    nativeEventConnections.set(event, connection)
    return bus.publish({ type: "instance.event", instanceId: "w", event })
  }
  const changed: unknown[] = []
  bus.on("permission.receiptsChanged", event => changed.push(event))
  receipts.start()
  return { root, bus, state, connection, manager, store, receipts, emit, changed,
    close: async () => { await receipts.stop(); await rm(root, { recursive: true, force: true }) } }
}

test("all decisions persist across reload, SSE-before-HTTP upgrades only the exact request", async () => {
  const f = await fixture()
  try {
    for (const decision of ["once", "always", "reject"] as const) {
      const confirm = await f.receipts.prepare("w", f.connection, "s", decision, decision, "codenomad", "Because I chose it")
      f.emit("permission.replied", { sessionID: "s", requestID: decision, reply: decision })
      await f.receipts.stop()
      await confirm()
      f.receipts.start()
      f.emit("permission.replied", { sessionID: "s", requestID: decision, reply: decision })
    }
    f.emit("permission.asked", pending("cascade"))
    f.emit("permission.replied", { sessionID: "s", requestID: "cascade", reply: "reject" })
    await f.receipts.stop()
    const reloaded = new PermissionReceipts(new PermissionReceiptStore(f.root), f.manager, f.bus, logger)
    const rows = (await reloaded.list("w", "s", { messageId: "m" })).receipts
    assert.equal(rows.length, 4)
    for (const decision of ["once", "always", "reject"]) {
      const receipt = rows.find(row => row.requestId === decision)!
      assert.equal(receipt.decision, decision)
      assert.equal(receipt.origin, "codenomad")
      assert.equal(receipt.reason, "Because I chose it")
      assert.equal(receipt.resolvedAt, 123)
      assert.deepEqual(receipt.source, { messageId: "m", callId: "call" })
      assert.deepEqual(receipt.resources, ["git status"])
      assert.equal(receipt.requestMessage, "Inspect repository")
      assert.ok(!JSON.stringify(receipt).includes("never-persist"))
    }
    assert.equal(rows.find(row => row.requestId === "cascade")?.origin, "native")
    assert.equal(rows.find(row => row.requestId === "cascade")?.reason, undefined)
    assert.ok(f.changed.length >= 7)
  } finally { await f.close() }
})

test("initial connection and reconnect recover every loaded owned Location, including descendants", async () => {
  const f = await fixture()
  const directories = ["/project", "/project/packages/app", "/project-worktree", "/project-worktree/packages/app"]
  const requested: string[] = []
  let generation = 1
  Object.assign(f.manager, {
    ownsLocation: async (_id: string, location: { directory: string }, _client: unknown, _signal: unknown, purpose?: string) => {
      if (purpose) assert.equal(purpose, "event")
      return directories.includes(location.directory)
    },
  })
  Object.assign(f.connection.client.debug.location, { list: async () => [...directories, "/foreign", "/daemon-cwd"].map(directory => ({ directory })) })
  Object.assign(f.connection.client.permission.request, { list: async (input?: { location: { directory: string } }) => {
    assert.ok(input?.location.directory, "must not default to daemon cwd")
    requested.push(input.location.directory)
    return { location: input.location, data: [pending(`${input.location.directory}-${generation}`), { ...pending("foreign"), sessionID: "foreign" }] }
  } })
  Object.assign(f.connection.client.session, { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID,
    location: { directory: sessionID === "foreign" ? "/foreign" : "/project" } }) })
  try {
    for (generation = 1; generation <= 2; generation++) {
      f.bus.publish({ type: "instance.eventStatus", instanceId: "w", status: "connected", generation })
      await f.receipts.stop()
      f.receipts.start()
      for (const directory of directories) f.emit("permission.replied", { sessionID: "s", requestID: `${directory}-${generation}`, reply: "once" })
      await f.receipts.stop()
      f.receipts.start()
    }
    assert.deepEqual(requested, [...directories, ...directories])
    const rows = (await f.receipts.list("w", "s", { messageId: "m" })).receipts
    assert.equal(rows.length, 8)
    for (const row of rows) {
      assert.equal(row.action, "shell")
      assert.deepEqual(row.resources, ["git status"])
      assert.deepEqual(row.source, { messageId: "m", callId: "call" })
      assert.equal(row.origin, "native")
    }
  } finally { await f.close() }
})

test("late recovery snapshots cannot cross workspace or connection replacement", async () => {
  for (const replacement of ["workspace", "connection"]) {
    const f = await fixture()
    let release!: () => void
    let started!: () => void
    const listing = new Promise<void>(resolve => { started = resolve })
    Object.assign(f.connection.client.permission.request, { list: async () => {
      started()
      await new Promise<void>(resolve => { release = resolve })
      return { data: [pending()] }
    } })
    try {
      f.bus.publish({ type: "instance.eventStatus", instanceId: "w", status: "connected", generation: 1 })
      await listing
      if (replacement === "workspace") Object.assign(f.manager, { get: () => ({ id: "w", path: "/project" }) })
      else f.state.current = false
      release()
      await f.receipts.stop()
      assert.deepEqual(await readdir(f.root), [])
    } finally { await f.close() }
  }
})

test("unanchored native decisions survive, pending snapshots are not receipts, deletion fences late success", async () => {
  const f = await fixture()
  try {
    f.emit("permission.asked", pending("unanchored", false))
    f.emit("permission.replied", { sessionID: "s", requestID: "unanchored", reply: "always" })
    const confirm = await f.receipts.prepare("w", f.connection, "s", "pending", "reject", "codenomad", "later")
    await f.receipts.stop()
    assert.deepEqual((await f.receipts.list("w", "s", { unanchored: true })).receipts.map(row => row.requestId), ["unanchored"])
    assert.deepEqual((await f.receipts.list("w", "s", { messageId: "m" })).receipts, [])
    f.receipts.start()
    f.emit("session.deleted", { sessionID: "s" })
    await f.receipts.stop()
    await confirm()
    assert.deepEqual((await f.receipts.list("w", "s", { unanchored: true })).receipts, [])
    assert.deepEqual((await f.receipts.list("w", "s", { messageId: "m" })).receipts, [])
  } finally { await f.close() }
})

test("Yolo is confirmed only on success; a failed transport creates no receipt and never replays", async () => {
  const f = await fixture()
  try {
    const replier = createOpencodePermissionReplier({ workspaceManager: f.manager, permissionReceipts: f.receipts })
    f.state.failure = true
    await assert.rejects(replier({ instanceId: "w", sessionId: "s", permissionId: "failed" }), /after dispatch/)
    assert.equal(f.state.replies, 1)
    assert.equal((await f.receipts.list("w", "s", { messageId: "m" })).receipts.length, 0)
    f.state.failure = false
    await replier({ instanceId: "w", sessionId: "s", permissionId: "accepted" })
    assert.equal(f.state.replies, 2)
    const [receipt] = (await f.receipts.list("w", "s", { messageId: "m" })).receipts
    assert.equal(receipt.origin, "yolo")
    assert.equal(receipt.reason, undefined)
    f.state.owned = false
    await assert.rejects(replier({ instanceId: "w", sessionId: "s", permissionId: "foreign" }), /does not belong/)
    assert.equal(f.state.replies, 2)
  } finally { await f.close() }
})

test("route validates queries and fresh session ownership, returns bounded continuation pages", async () => {
  const f = await fixture()
  const app = Fastify()
  registerPermissionReceiptRoutes(app, f.receipts)
  const url = "/api/workspaces/w/sessions/s/permission-receipts"
  try {
    for (const requestId of ["a", "b", "c"]) await (await f.receipts.prepare("w", f.connection, "s", requestId, "once", "codenomad"))()
    for (const query of ["", "?limit=1000&messageId=m", "?unanchored=false", "?messageId=m&unanchored=true", "?messageId=m&cursor=../../other"]) {
      assert.equal((await app.inject(`${url}${query}`)).statusCode, 400)
    }
    const first = await app.inject(`${url}?messageId=m&limit=2`)
    assert.equal(first.statusCode, 200)
    assert.equal(first.headers["cache-control"], "no-store")
    assert.equal(first.json().receipts.length, 2)
    const second = await app.inject(`${url}?messageId=m&limit=2&cursor=${first.json().next}`)
    assert.equal(second.json().receipts.length, 1)
    assert.equal(second.json().next, undefined)
    f.state.owned = false
    assert.equal((await app.inject(`${url}?messageId=m`)).statusCode, 403)
    f.state.owned = true; f.state.current = false
    assert.equal((await app.inject(`${url}?messageId=m`)).statusCode, 500)
  } finally { await app.close(); await f.close() }
})

test("failed disk writes publish no success; snapshot failure prevents a native mutation", async () => {
  const f = await fixture()
  try {
    await rm(f.root, { recursive: true })
    await writeFile(f.root, "not a directory")
    const replier = createOpencodePermissionReplier({ workspaceManager: f.manager, permissionReceipts: f.receipts })
    await assert.rejects(replier({ instanceId: "w", sessionId: "s", permissionId: "p" }))
    assert.equal(f.state.replies, 0)
    assert.equal(f.changed.length, 0)
  } finally { await f.close() }
})

test("manual proxy captures native success, never failed HTTP or ambiguous transport origins", async () => {
  const f = await fixture()
  const app = Fastify()
  let forwards = 0
  Object.assign(f.connection, { endpoint: { url: "http://127.0.0.1:1" }, profile: async () => "modern", invalidate() {},
    fetch: async (url: string) => {
      forwards++
      if (url.endsWith("/session/s")) return new Response(null, { status: 204 })
      if (url.includes("http-failed")) return new Response("{}", { status: 500 })
      const requestID = url.split("/").at(-2)!
      f.emit("permission.replied", { sessionID: "s", requestID, reply: "reject" })
      if (requestID === "ambiguous") throw new Error("lost reply response")
      return new Response(null, { status: 204 })
    },
  })
  Object.assign(f.manager, {
    getInstanceAuthorizationHeader: () => undefined,
    getServiceDirectory: () => "/project",
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory,
    getWorktreeIdentityForPath: async () => "/project",
    ownsDirectory: async () => true,
    ownsPath: async () => true,
  })
  registerInstanceProxyRoutes(app, { workspaceManager: f.manager, logger, permissionReceipts: f.receipts,
    worktreeDeletionFence: new WorktreeDeletionFence() })
  try {
    const send = (id: string) => app.inject({ method: "POST", url: `/workspaces/w/instance/api/session/s/permission/${id}/reply`,
      payload: { decision: "reject", message: "Manual reason" } })
    assert.equal((await send("manual")).statusCode, 204)
    assert.equal((await send("http-failed")).statusCode, 500)
    assert.equal((await send("ambiguous")).statusCode, 500)
    await f.receipts.stop()
    assert.equal(forwards, 3)
    const rows = (await f.receipts.list("w", "s", { messageId: "m" })).receipts
    assert.equal(rows.length, 2)
    assert.equal(rows.find(row => row.requestId === "manual")?.origin, "codenomad")
    assert.equal(rows.find(row => row.requestId === "manual")?.reason, "Manual reason")
    assert.equal(rows.find(row => row.requestId === "ambiguous")?.origin, "native")
    assert.equal(rows.find(row => row.requestId === "ambiguous")?.reason, undefined)
    f.state.owned = false
    assert.equal((await send("foreign")).statusCode, 403)
    assert.equal(forwards, 3)
    f.state.owned = true
    assert.equal((await app.inject({ method: "DELETE", url: "/workspaces/w/instance/api/session/s" })).statusCode, 204)
    assert.equal((await f.receipts.list("w", "s", { messageId: "m" })).receipts.length, 0)
    const prepare = f.receipts.prepare.bind(f.receipts)
    Object.assign(f.receipts, { prepare: async (...args: Parameters<typeof prepare>) => {
      const confirm = await prepare(...args)
      f.state.current = false
      return confirm
    } })
    const beforeStale = forwards
    assert.equal((await send("stale-after-preparation")).statusCode, 500)
    assert.equal(forwards, beforeStale, "Receipt preparation cannot authorize a stale connection")
  } finally { await app.close(); await f.close() }
})

test("authenticated native channels and WSL hosts isolate identical session/request IDs", async () => {
  const f = await fixture()
  try {
    await (await f.receipts.prepare("w", f.connection, "s", "p", "once", "codenomad"))()
    const otherConnection = { ...f.connection, endpoint: { ...f.connection.endpoint,
      auth: { type: "basic" as const, username: "opencode", password: "other-native-channel" } } }
    const manager = { get: f.manager.get, ownsLocation: f.manager.ownsLocation,
      getServiceWslDistro: f.manager.getServiceWslDistro, getServicePathStyle: f.manager.getServicePathStyle,
      getSharedServiceConnection: f.manager.getSharedServiceConnection }
    const otherManager = { ...manager, getSharedServiceConnection: async () => otherConnection }
    const other = new PermissionReceipts(new PermissionReceiptStore(f.root), otherManager, f.bus, logger)
    assert.equal((await other.list("w", "s", { messageId: "m" })).receipts.length, 0)
    const wsl = new PermissionReceipts(new PermissionReceiptStore(f.root), { ...manager, getServiceWslDistro: () => "Ubuntu" }, f.bus, logger)
    assert.equal((await wsl.list("w", "s", { messageId: "m" })).receipts.length, 0)
    const reconnected = { ...f.connection, endpoint: { ...f.connection.endpoint, url: "http://127.0.0.1:5555" } }
    const reload = new PermissionReceipts(new PermissionReceiptStore(f.root), { ...manager,
      getSharedServiceConnection: async () => reconnected }, f.bus, logger)
    assert.equal((await reload.list("w", "s", { messageId: "m" })).receipts.length, 1)
  } finally { await f.close() }
})

test("confirmed native success is not turned into retryable failure when receipt write fails", async () => {
  const f = await fixture()
  try {
    const confirm = await f.receipts.prepare("w", f.connection, "s", "p", "once", "codenomad")
    await rm(f.root, { recursive: true })
    await writeFile(f.root, "disk unavailable")
    await confirm()
    assert.equal(f.changed.length, 0)
  } finally { await f.close() }
})

test("Yolo never replays a dispatched failure on duplicate events or toggles", async () => {
  const bus = new EventBus()
  let calls = 0
  const manager = new AutoAcceptManager({ eventBus: bus, logger, replier: async () => {
    calls++; throw Object.assign(new Error("ambiguous transport"), { retryable: false })
  } })
  manager.start()
  try {
    manager.handleInstanceEvent("w", { type: "session.created", data: { sessionID: "s" } })
    manager.toggle("w", "s")
    manager.handleInstanceEvent("w", { type: "permission.asked", data: pending() })
    await new Promise<void>(resolve => setImmediate(resolve))
    manager.handleInstanceEvent("w", { type: "permission.asked", data: pending() })
    manager.toggle("w", "s"); manager.toggle("w", "s")
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
  } finally { manager.stop() }
})

test("store bounds request fields and page IO; native namespaces do not collide", async () => {
  const f = await fixture()
  try {
    const request = permissionSnapshot({ ...pending(), resources: Array(100).fill("x".repeat(5000)), message: "y".repeat(5000) })!
    assert.equal(request.resources.length, 64)
    assert.equal(request.resources[0].length, 4096)
    assert.equal(request.requestMessage?.length, 4096)
    const receipt: PermissionReceipt = { ...request, decision: "once", origin: "native", resolvedAt: 1 }
    await f.store.resolve("native-a", receipt)
    assert.equal((await f.store.list("native-b", "s", { messageId: "m" })).receipts.length, 0)
    assert.equal((await f.store.list("native-a", "s", { messageId: "m" })).receipts.length, 1)
    assert.equal((await readdir(f.root)).length, 1)
  } finally { await f.close() }
})
