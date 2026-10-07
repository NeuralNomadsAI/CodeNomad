import assert from "node:assert/strict"
import { test } from "node:test"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { createRuntimeFetch } from "../../opencode/compatibility/transport"
import { rememberRuntime } from "../../opencode/compatibility/runtime"
import { registerPendingRequestRoutes, type PendingRequestsRouteDeps } from "./pending-requests"
import { observePendingDiscovery, markLoadedPendingSupported, deferPendingDiscovery } from "../../workspaces/pending-discovery"

const git = promisify(execFile)
const permission = { id: "permission", sessionID: "background", action: "read", resources: ["file"] }
const form = { id: "form", sessionID: "global", title: "Question", fields: [{ key: "answer", type: "string" }] }
const complete = (directory: string, locations: unknown[] = []) => ({ directory, status: "complete", locations })
const emptyLocation = (directory: string) => ({ location: { directory }, permissions: [], forms: [] })

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "codenomad-pending-"))
  await git("git", ["init", "--quiet", root])
  const subdirectory = join(root, "session-directory")
  await mkdir(subdirectory)
  const state = { current: true, blocked: false, present: true, status: 200, calls: [] as URL[],
    batches: [] as string[][], origin: root, bootstrap: root, wire: false, blockedIdentities: new Set<string>(),
    allowed: new Set([root, subdirectory]), ownershipReads: [] as string[],
    result: { data: [complete(root)] } as unknown, onFetch: () => {}, onOwnership: () => {},
  }
  const workspace = { path: root } as NonNullable<ReturnType<PendingRequestsRouteDeps["workspaceManager"]["get"]>>
  const connection = {
    endpoint: { url: "http://isolated-native.invalid" },
    client: new Proxy({}, { get() { throw new Error("No native location/permission/form/session list warming permitted") } }),
    assertCurrent: () => { assert.ok(state.current, "stale connection") },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, "/api/rpc/codenomad.pending-requests/snapshot")
      assert.equal(init?.method, "POST")
      assert.equal(init?.redirect, "error")
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json")
      assert.deepEqual([...url.searchParams], [["location[directory]", state.bootstrap]])
      const body = JSON.parse(String(init?.body))
      assert.deepEqual(Object.keys(body), ["input"])
      assert.deepEqual(Object.keys(body.input), ["directories"])
      assert(body.input.directories.length > 0 && body.input.directories.length <= 64)
      state.batches.push(body.input.directories)
      state.calls.push(url)
      state.onFetch()
      return Response.json(state.wire || state.status !== 200 ? state.result : { output: { originDirectory: state.origin, ...state.result as object } }, { status: state.status })
    },
  } as unknown as ServiceConnection
  const manager: PendingRequestsRouteDeps["workspaceManager"] = {
    get: (id) => id === "fixture" && state.present ? workspace : undefined,
    getSharedServiceConnection: async () => connection,
    getServiceLocation: () => ({ directory: state.bootstrap }),
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceDirectoryForPath: async (_id, candidate) => state.allowed.has(candidate) ? candidate : undefined,
    getWorktreeIdentityForPath: async (_id, candidate) => state.allowed.has(candidate) ? root : undefined,
    getHostPathForServicePath: async (_id, candidate) => candidate,
    ownsLocation: async (_id, location) => {
      state.ownershipReads.push(location.directory)
      state.onOwnership()
      return state.allowed.has(location.directory) && location.workspaceID === undefined
    },
  }
  const app = Fastify()
  registerPendingRequestRoutes(app, { workspaceManager: manager, worktreeDeletionFence: { isBlocked: (identity) => state.blocked || state.blockedIdentities.has(identity) } })
  const url = (directories = [root]) => `/api/workspaces/fixture/pending-requests?${new URLSearchParams(directories.map((directory) => ["directories", directory]))}`
  return { root, subdirectory, state, manager, connection, app, url, async cleanup() { await app.close(); await rm(root, { recursive: true, force: true }) } }
}

test("raw pending adapter retains the bound service authentication and fails closed when disconnected", async () => {
  const h = await harness()
  try {
    const endpoint = { url: "http://127.0.0.1:4321", auth: { type: "basic" as const, username: "opencode", password: "isolated-fixture" } }
    rememberRuntime(endpoint, { version: "2.0.11", pid: 123, discovery: "info" })
    h.connection.endpoint = endpoint
    h.connection.fetch = createRuntimeFetch(endpoint, async (input, init) => {
      h.state.calls.push(new URL(String(input)))
      assert.equal(init?.method, "POST")
      assert.equal(init?.redirect, "error")
      assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:isolated-fixture").toString("base64")}`)
      assert.deepEqual(await new Request(String(input), init).json(), { input: { directories: [h.root] } })
      return Response.json({ output: { originDirectory: h.root, ...h.state.result as object } })
    })
    assert.equal((await h.app.inject({ url: h.url() })).statusCode, 200)
    assert.equal(h.state.calls[0].pathname, "/api/rpc/codenomad.pending-requests/snapshot")
    h.state.calls.length = 0
    h.manager.getSharedServiceConnection = async () => undefined
    assert.equal((await h.app.inject({ url: h.url() })).statusCode, 503)
    assert.deepEqual(h.state.calls, [])
  } finally { await h.cleanup() }
})

test("backend compaction admission prevents unsupported fallback and inventory reads, while verified loaded-only snapshots remain available", async () => {
  const h = await harness()
  try {
    observePendingDiscovery(h.connection, { type: "session.compaction.started", created: 1,
      durable: { aggregateID: "unknown", seq: 1, version: 1 }, data: { sessionID: "unknown" } } as any)
    const translate = h.manager.getServiceDirectoryForPath
    let directories = 0
    h.manager.getServiceDirectoryForPath = async (...args) => { directories++; return translate(...args) }
    h.state.status = 404
    const response = await h.app.inject({ url: h.url() })
    assert.equal(response.statusCode, 503)
    assert.equal(response.headers["retry-after"], "30")
    assert.equal(directories, 0)
    assert.deepEqual(h.state.calls, [])
    markLoadedPendingSupported(h.connection, true)
    h.state.status = 200
    assert.equal((await h.app.inject({ url: h.url() })).statusCode, 200)
    assert.equal(h.state.calls.length, 1)
  } finally { await h.cleanup() }
})

test("cold coverage and idle/global pending recover through only the fixed loaded-only RPC", async () => {
  const h = await harness()
  try {
    h.state.result = { data: [complete(h.root), complete(h.subdirectory, [{
      location: { directory: h.subdirectory }, permissions: [permission], forms: [form],
    }])] }
    const response = await h.app.inject({ url: h.url([h.root, h.subdirectory]) })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers["cache-control"], "no-store")
    assert.deepEqual(response.json(), { supported: true, directories: [
      { directory: h.root, status: "ok", locations: [emptyLocation(h.root)] }, { directory: h.subdirectory, status: "ok", locations: [{
        location: { directory: h.subdirectory }, permissions: [permission], forms: [form],
      }] },
    ] })
    assert.deepEqual(h.state.batches[0], [h.root, h.subdirectory])
    assert.deepEqual(h.state.ownershipReads, [h.subdirectory])
  } finally { await h.cleanup() }
})

test("unowned directories, nested independent clones and arbitrary query selectors never reach native", async () => {
  const h = await harness()
  try {
    assert.equal((await h.app.inject({ url: h.url(["/foreign"]) })).statusCode, 403)
    const clone = join(h.root, "clone")
    await git("git", ["init", "--quiet", clone])
    // Model the existing containing-worktree directory fence: the broker must
    // additionally reject the clone's different Git common-directory identity.
    h.state.allowed.add(clone)
    assert.equal((await h.app.inject({ url: h.url([clone]) })).statusCode, 403)
    assert.equal((await h.app.inject({ url: `${h.url()}&rpcID=arbitrary` })).statusCode, 400)
    assert.equal((await h.app.inject({ url: h.url(Array.from({ length: 65 }, () => h.root)) })).statusCode, 400)
    assert.equal((await h.app.inject({ url: h.url(["x".repeat(4097)]) })).statusCode, 400)
    assert.deepEqual(h.state.calls, [])
  } finally { await h.cleanup() }
})

test("WSL host roots and worktrees are translated before dispatch with exact native placement and original input coverage", async () => {
  const h = await harness()
  try {
    await git("git", ["-C", h.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"])
    const hostWorktree = join(h.root, "linked-worktree")
    await git("git", ["-C", h.root, "worktree", "add", "--quiet", "--detach", hostWorktree])
    const serviceRoot = "/home/fixture/repo", serviceWorktree = "/home/fixture/worktree"
    const hostRootAlias = "C:/fixture/repo"
    const directories = new Map([[h.root, serviceRoot], [hostRootAlias, serviceRoot], [serviceRoot, serviceRoot],
      [hostWorktree, serviceWorktree], [serviceWorktree, serviceWorktree]])
    const hosts = new Map([[serviceRoot, h.root], [serviceWorktree, hostWorktree]])
    h.state.bootstrap = serviceRoot
    h.state.origin = serviceRoot
    h.manager.getServicePathStyle = () => "posix"
    h.manager.getServiceDirectoryForPath = async (_id, candidate) => directories.get(candidate)
    h.manager.getHostPathForServicePath = async (_id, candidate) => hosts.get(candidate)
    h.manager.getWorktreeIdentityForPath = async (_id, candidate) => hosts.get(candidate)
    h.manager.ownsLocation = async (_id, location) => {
      h.state.ownershipReads.push(location.directory)
      return hosts.has(location.directory) && location.workspaceID === undefined
    }
    h.state.result = { data: [complete(serviceRoot), complete(serviceWorktree, [{
      location: { directory: serviceWorktree }, permissions: [permission], forms: [form],
    }])] }
    const response = await h.app.inject({ url: h.url([hostRootAlias, hostWorktree]) })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(h.state.batches[0], [serviceRoot, serviceWorktree])
    assert.deepEqual(response.json().directories.map((entry: any) => entry.directory), [hostRootAlias, hostWorktree])
    assert.deepEqual(response.json().directories[0].locations, [emptyLocation(serviceRoot)])
    assert.equal(response.json().directories[1].locations[0].location.directory, serviceWorktree)
    assert.deepEqual(h.state.ownershipReads, [serviceWorktree])
    h.state.origin = hostRootAlias
    assert.equal((await h.app.inject({ url: h.url([hostRootAlias, hostWorktree]) })).statusCode, 503, "A Windows host alias cannot become WSL-native origin")
    h.state.origin = serviceRoot
    h.state.result = { data: [complete(serviceRoot), complete(serviceWorktree, [{
      location: { directory: hostWorktree }, permissions: [permission], forms: [form],
    }])] }
    const foreignSpelling = await h.app.inject({ url: h.url([hostRootAlias, hostWorktree]) })
    assert.equal(foreignSpelling.statusCode, 503)
    assert.equal(foreignSpelling.body.includes('"locations"'), false)
  } finally { await h.cleanup() }
})

test("foreign placement identities are not erased or made authoritative by directory containment", async () => {
  const h = await harness()
  try {
    for (const location of [{ directory: h.root, workspaceID: "foreign" }, { directory: "/foreign" }]) {
      h.state.result = { data: [complete(h.root, [{ location, permissions: [permission], forms: [form] }])] }
      const response = await h.app.inject({ url: h.url() })
      assert.equal(response.statusCode, 503)
      assert.equal(response.body.includes("permission"), false)
    }
    assert.deepEqual(h.state.ownershipReads, [])
    h.state.result = { data: [complete(h.root, [
      { location: { directory: h.root, workspaceID: "foreign" }, permissions: [permission], forms: [form] },
      { location: { directory: h.root }, permissions: [], forms: [form] },
    ])] }
    assert.equal((await h.app.inject({ url: h.url() })).statusCode, 503)
  } finally { await h.cleanup() }
})

test("mixed unowned candidates are rejected without blocking recovery of owned directories or older-daemon fallback", async () => {
  const h = await harness()
  try {
    const response = await h.app.inject({ url: h.url([h.root, "/foreign"]) })
    assert.deepEqual(response.json(), { supported: true, directories: [
      { directory: "/foreign", status: "error" }, { directory: h.root, status: "ok", locations: [emptyLocation(h.root)] },
    ] })
    assert.deepEqual(h.state.batches[0], [h.root])
    h.state.status = 400
    h.state.result = { _tag: "RpcError", type: "rpc.unavailable", message: "RPC unavailable" }
    assert.deepEqual((await h.app.inject({ url: h.url([h.root, "/foreign"]) })).json(), { supported: false })
  } finally { await h.cleanup() }
})

test("partial RPC coverage never verifies capability or publishes authoritative empty coverage", async () => {
  const h = await harness()
  try {
    h.state.result = { data: [complete(h.root), { directory: h.subdirectory, status: "error", error: {
      _tag: "ServiceUnavailableError", message: "retain queues",
    } }] }
    const response = await h.app.inject({ url: h.url([h.root, h.subdirectory]) })
    assert.equal(response.statusCode, 503)
    observePendingDiscovery(h.connection, { type: "session.compaction.started", created: 1, data: { sessionID: "unknown" } } as any)
    assert.equal((await h.app.inject({ url: h.url() })).statusCode, 503)
    assert.equal(h.state.calls.length, 1, "Malformed coverage must not acquire the compaction exception")
  } finally { await h.cleanup() }
})

test("only a bounded declared RPC unavailable/missing-method error denotes unsupported", async () => {
  const h = await harness()
  try {
    for (const type of ["rpc.unavailable", "rpc.method_not_found"]) {
      h.state.status = 400
      h.state.result = { _tag: "RpcError", type, message: "Unavailable" }
      assert.deepEqual((await h.app.inject({ url: h.url() })).json(), { supported: false })
    }
    for (const status of [401, 403, 404, 500, 503]) {
      h.state.status = status
      assert.equal((await h.app.inject({ url: h.url() })).statusCode, 503)
    }
    h.state.status = 400
    for (const result of [{}, { _tag: "RpcError", type: "unavailable", message: "Reader failed", data: {} },
      { _tag: "RpcError", type: "rpc.internal", message: "Server failed" },
      { _tag: "RpcError", type: "rpc.unavailable", message: "Unavailable", data: { unverified: true } },
    ]) {
      h.state.result = result
      assert.equal((await h.app.inject({ url: h.url() })).statusCode, 503)
    }
    h.state.status = 200
    for (const result of [{ data: [] }, { data: [complete("/foreign")] }, { data: [complete(h.root), complete(h.root)] },
      { data: [complete(h.root, [{ location: { directory: h.root }, permissions: [], forms: [{ ...form, fields: [] }] }])] },
      { data: [complete(h.root)], extra: "x".repeat(4 * 1024 * 1024) },
    ]) {
      h.state.result = result
      assert.equal((await h.app.inject({ url: h.url() })).statusCode, 503)
    }
  } finally { await h.cleanup() }
})

test("connection replacement, workspace removal and deletion during reads fence publication", async () => {
  for (const change of ["connection", "workspace", "deletion", "late-ownership"] as const) {
    const h = await harness()
    try {
      h.state.result = { data: [complete(h.root, [{ location: { directory: h.root }, permissions: [], forms: [form] }])] }
      if (change === "late-ownership") h.state.onOwnership = () => { h.state.current = false }
      else h.state.onFetch = () => {
        if (change === "connection") h.state.current = false
        if (change === "workspace") h.state.present = false
        if (change === "deletion") h.state.blocked = true
      }
      const response = await h.app.inject({ url: h.url() })
      assert.equal(response.statusCode, 503)
      assert.equal(response.body.includes('"forms"'), false)
    } finally { await h.cleanup() }
  }
})

test("missing or foreign bootstrap/origin is never authoritative, even for wholly cold coverage", async () => {
  for (const fault of ["missing-root", "root-workspace", "missing-origin", "foreign-origin", "nested-origin"] as const) {
    const h = await harness()
    try {
      if (fault === "missing-root") h.manager.getServiceLocation = () => undefined
      if (fault === "root-workspace") h.manager.getServiceLocation = () => ({ directory: h.root, workspaceID: "foreign" })
      if (fault === "missing-origin") { h.state.wire = true; h.state.result = { output: { data: [complete(h.root)] } } }
      if (fault === "foreign-origin") h.state.origin = "/foreign"
      if (fault === "nested-origin") h.state.origin = h.subdirectory
      const response = await h.app.inject({ url: h.url() })
      assert.equal(response.statusCode, 503)
      observePendingDiscovery(h.connection, { type: "session.compaction.started", created: 1, data: { sessionID: "unknown" } } as any)
      assert(deferPendingDiscovery(h.connection, { loadedOnly: true }), "Invalid provenance must not grant the loaded-only admission exception")
    } finally { await h.cleanup() }
  }
})

test("valid alias origin/placement keeps native spelling and cold coverage keeps translated authority", async () => {
  const h = await harness()
  try {
    const alias = process.platform === "win32" ? h.root.toUpperCase().replaceAll("\\", "/") : `${h.root}/.`
    h.state.allowed.add(alias)
    const translate = h.manager.getServiceDirectoryForPath
    h.manager.getServiceDirectoryForPath = async (id, value) => value === alias ? h.root : translate(id, value)
    h.state.origin = alias
    h.state.result = { data: [complete(h.root, [emptyLocation(alias)])] }
    const response = await h.app.inject({ url: h.url([alias]) })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), { supported: true, directories: [{ directory: alias, status: "ok", locations: [emptyLocation(alias)] }] })
    assert.equal(h.state.calls[0].searchParams.get("location[directory]"), h.root)
    h.state.result = { data: [complete(h.root)] }
    assert.deepEqual((await h.app.inject({ url: h.url([alias]) })).json().directories[0], { directory: alias, status: "ok", locations: [emptyLocation(h.root)] })
  } finally { await h.cleanup() }
})

test("native numeric JSON codec values survive the broker without coercion", async () => {
  const h = await harness()
  try {
    const numeric = { ...form, fields: [{ key: "number", type: "number", minimum: "-Infinity", maximum: "Infinity", default: "NaN" }] }
    h.state.result = { data: [complete(h.root, [{ location: { directory: h.root }, permissions: [permission], forms: [numeric] }])] }
    assert.deepEqual((await h.app.inject({ url: h.url() })).json().directories[0].locations[0].forms, [numeric])
  } finally { await h.cleanup() }
})

test("overflowing raw JSON numbers in fields or metadata fail closed before capability admission", async () => {
  for (const invalid of [
    { ...form, fields: [{ key: "number", type: "number", default: "OVERFLOW" }] },
    { ...form, metadata: { nested: { number: "OVERFLOW" } } },
  ]) {
    const h = await harness()
    try {
      const raw = JSON.stringify({ output: { originDirectory: h.root,
        data: [complete(h.root, [{ ...emptyLocation(h.root), forms: [invalid] }])],
      } }).replace('"OVERFLOW"', "1e400")
      h.connection.fetch = async () => new Response(raw, { headers: { "content-type": "application/json" } })
      assert.equal((await h.app.inject({ url: h.url() })).statusCode, 503)
      observePendingDiscovery(h.connection, { type: "session.compaction.started", created: 1, data: { sessionID: "child" } } as any)
      assert(deferPendingDiscovery(h.connection, { loadedOnly: true }), "Malformed numbers cannot verify capability")
    } finally { await h.cleanup() }
  }
})

test("full provenance/coverage validation precedes connection-scoped capability negotiation", async () => {
  const h = await harness()
  try {
    h.state.result = { data: [complete(h.root, [{ location: { directory: "/foreign" }, permissions: [], forms: [] }])] }
    assert.equal((await h.app.inject({ url: h.url() })).statusCode, 503)
    observePendingDiscovery(h.connection, { type: "session.compaction.started", created: 1, data: { sessionID: "child" } } as any)
    assert(deferPendingDiscovery(h.connection, { loadedOnly: true }))
    observePendingDiscovery(h.connection, { type: "session.compaction.ended", created: 2, data: { sessionID: "child" } } as any)
    h.state.result = { data: [complete(h.root)] }
    assert.equal((await h.app.inject({ url: h.url() })).statusCode, 200)
    observePendingDiscovery(h.connection, { type: "session.compaction.started", created: 3, data: { sessionID: "child" } } as any)
    assert.equal(deferPendingDiscovery(h.connection, { loadedOnly: true }), false)
    const replacement = { ...h.connection } as ServiceConnection
    observePendingDiscovery(replacement, { type: "session.compaction.started", created: 3, data: { sessionID: "child" } } as any)
    assert(deferPendingDiscovery(replacement, { loadedOnly: true }), "A replacement must negotiate independently")
  } finally { await h.cleanup() }
})

test("root-only deletion, bootstrap replacement and candidate authority changes fence supported and unsupported responses", async () => {
  for (const unavailable of [false, true]) for (const fault of ["root-delete", "bootstrap", "root-ownership", "candidate-ownership"] as const) {
    const h = await harness()
    try {
      h.state.result = unavailable ? { _tag: "RpcError", type: "rpc.unavailable", message: "Unavailable" } : { data: [complete(h.subdirectory)] }
      h.state.status = unavailable ? 400 : 200
      h.manager.getWorktreeIdentityForPath = async (_id, directory) => directory === h.root ? "root-identity" : "candidate-identity"
      h.state.onFetch = () => {
        if (fault === "root-delete") h.state.blockedIdentities.add("root-identity")
        if (fault === "bootstrap") h.state.bootstrap = h.subdirectory
        if (fault === "root-ownership") h.state.allowed.delete(h.root)
        if (fault === "candidate-ownership") h.state.allowed.delete(h.subdirectory)
      }
      assert.equal((await h.app.inject({ url: h.url([h.subdirectory]) })).statusCode, 503)
    } finally { await h.cleanup() }
  }
})

test("mid-authorization compaction prevents RPC dispatch, and errors/duplicate placement/queue overflow retain queues", async () => {
  const h = await harness()
  try {
    const identity = h.manager.getWorktreeIdentityForPath
    h.manager.getWorktreeIdentityForPath = async (...args) => {
      observePendingDiscovery(h.connection, { type: "session.compaction.started", created: 1, data: { sessionID: "child" } } as any)
      return identity(...args)
    }
    const held = await h.app.inject({ url: h.url() })
    assert.equal(held.statusCode, 503)
    assert.equal(held.headers["retry-after"], "30")
    assert.deepEqual(h.state.calls, [])
    observePendingDiscovery(h.connection, { type: "session.compaction.ended", created: 2, data: { sessionID: "child" } } as any)
    h.manager.getWorktreeIdentityForPath = identity
    for (const locations of [[emptyLocation(h.root), emptyLocation(h.root)],
      [{ location: { directory: h.root }, permissions: Array(1025).fill(permission), forms: [] }]]) {
      h.state.result = { data: [complete(h.root, locations)] }
      assert.equal((await h.app.inject({ url: h.url() })).statusCode, 503)
    }
    h.connection.fetch = async () => { throw new DOMException("Fixture timeout", "TimeoutError") }
    assert.equal((await h.app.inject({ url: h.url() })).statusCode, 503)
  } finally { await h.cleanup() }
})

test("fresh pre-RPC classification preserves mixed coverage and never fences or queries a foreign repository", async () => {
  const h = await harness()
  try {
    const clone = join(h.root, "foreign-clone")
    await git("git", ["init", "--quiet", clone])
    h.state.allowed.add(clone)
    const alias = process.platform === "win32" ? h.root.toUpperCase().replaceAll("\\", "/") : `${h.root}/.`
    const translate = h.manager.getServiceDirectoryForPath
    h.manager.getServiceDirectoryForPath = async (id, directory) => directory === alias ? h.root : translate(id, directory)
    h.manager.getWorktreeIdentityForPath = async (_id, directory) => directory === clone ? "foreign-identity" : h.root
    h.state.blockedIdentities.add("foreign-identity")
    const response = await h.app.inject({ url: h.url([h.root, alias, clone, "/foreign"]) })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(h.state.batches, [[h.root]])
    const entries = response.json().directories
    for (const directory of [clone, "/foreign"]) assert.deepEqual(entries.find((entry: any) => entry.directory === directory), { directory, status: "error" })
    for (const directory of [h.root, alias]) assert.deepEqual(entries.find((entry: any) => entry.directory === directory), {
      directory, status: "ok", locations: [emptyLocation(h.root)],
    })
    h.state.calls.length = 0
    h.state.batches.length = 0
    assert.equal((await h.app.inject({ url: h.url([clone, "/foreign"]) })).statusCode, 403)
    assert.deepEqual(h.state.calls, [])
  } finally { await h.cleanup() }
})

test("provisional alias, identity and host withdrawal fail the whole request before RPC", async () => {
  for (const fault of ["alias", "identity", "host"] as const) {
    const h = await harness()
    try {
      const alias = process.platform === "win32" ? h.subdirectory.toUpperCase().replaceAll("\\", "/") : `${h.subdirectory}/.`
      const translate = h.manager.getServiceDirectoryForPath
      const identity = h.manager.getWorktreeIdentityForPath
      const host = h.manager.getHostPathForServicePath
      let mappings = 0, identities = 0, hosts = 0
      h.manager.getServiceDirectoryForPath = async (id, directory) => directory === alias
        ? ++mappings === 2 && fault === "alias" ? undefined : h.subdirectory : translate(id, directory)
      h.manager.getWorktreeIdentityForPath = async (id, directory) => directory === h.subdirectory && ++identities === 2 && fault === "identity"
        ? undefined : identity(id, directory)
      h.manager.getHostPathForServicePath = async (id, directory) => directory === h.subdirectory && ++hosts === 2 && fault === "host"
        ? undefined : host(id, directory)
      const response = await h.app.inject({ url: h.url([h.root, alias]) })
      assert.equal(response.statusCode, 503, response.body)
      assert.equal(response.body.includes('"locations"'), false)
      assert.deepEqual(h.state.calls, [])
    } finally { await h.cleanup() }
  }
})

test("root mapping and identity withdrawal after asynchronous candidate preparation prevent RPC", async () => {
  for (const fault of ["mapping", "identity"] as const) {
    const h = await harness()
    try {
      const translate = h.manager.getServiceDirectoryForPath
      const identity = h.manager.getWorktreeIdentityForPath
      const host = h.manager.getHostPathForServicePath
      let hosts = 0, withdrawn = false
      h.manager.getServiceDirectoryForPath = async (id, directory) => withdrawn && directory === h.root && fault === "mapping"
        ? undefined : translate(id, directory)
      h.manager.getWorktreeIdentityForPath = async (id, directory) => withdrawn && directory === h.root && fault === "identity"
        ? undefined : identity(id, directory)
      h.manager.getHostPathForServicePath = async (id, directory) => {
        const result = await host(id, directory)
        if (directory === h.subdirectory && ++hosts === 2) {
          await new Promise<void>(resolve => setImmediate(resolve))
          withdrawn = true
        }
        return result
      }
      const response = await h.app.inject({ url: h.url([h.subdirectory]) })
      assert.equal(response.statusCode, 503, response.body)
      assert.deepEqual(h.state.calls, [])
    } finally { await h.cleanup() }
  }
})

test("actual repository changes during RPC fence both supported and declared unsupported snapshots", async () => {
  for (const unavailable of [false, true]) {
    const h = await harness()
    try {
      h.state.status = unavailable ? 400 : 200
      h.state.result = unavailable ? { _tag: "RpcError", type: "rpc.unavailable", message: "Unavailable" } : { data: [complete(h.subdirectory)] }
      // Normalized mappings and deletion identities stay unchanged; only real Git
      // authority changes after dispatch, so a retained pre-RPC result is unsafe.
      h.state.onFetch = () => { execFileSync("git", ["init", "--quiet", h.subdirectory], { windowsHide: true }) }
      const response = await h.app.inject({ url: h.url([h.subdirectory]) })
      assert.equal(response.statusCode, 503, response.body)
      assert.equal(h.state.calls.length, 1)
      assert.equal(response.body.includes('"locations"'), false)
      observePendingDiscovery(h.connection, { type: "session.compaction.started", created: 1, data: { sessionID: "child" } } as any)
      assert(deferPendingDiscovery(h.connection, { loadedOnly: true }), "Changed repositories cannot negotiate loaded-only capability")
    } finally { await h.cleanup() }
  }
})

for (const phase of ["provisional", "pre-RPC", "supported post-RPC", "unsupported post-RPC"] as const) {
  test(`failed ownership batches retain admitted host reads until settlement: ${phase}`, async () => {
    const h = await harness()
    const gate = () => {
      let resolve!: () => void
      const promise = new Promise<void>(done => { resolve = done })
      return { promise, resolve }
    }
    const started = gate(), release = gate(), failed = gate()
    const ready = async (promise: Promise<void>) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([promise, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Owned custody gate did not become ready")), 30_000)
        })])
      } finally { if (timer) clearTimeout(timer) }
    }
    let request: Promise<{ statusCode: number; body: string }> | undefined
    let hostRead: Promise<string | undefined> | undefined
    let settled = false, held = false, hostReads = 0, identityReads = 0, nextBatchReads = 0
    const failRead = phase === "provisional" ? 1 : phase === "pre-RPC" ? 2 : 3
    try {
      const bad = join(h.root, "withdrawn-custody-peer")
      await mkdir(bad)
      h.state.allowed.add(bad)
      const aliases = Array.from({ length: 7 }, (_, index) => join(h.root, `custody-root-alias-${index}`))
      const nextBatch = aliases[6], directories = [h.subdirectory, bad, ...aliases]
      h.state.status = phase === "unsupported post-RPC" ? 400 : 200
      h.state.result = phase === "unsupported post-RPC"
        ? { _tag: "RpcError", type: "rpc.unavailable", message: "Unavailable" }
        : { data: [h.subdirectory, bad, h.root].map(directory => complete(directory)) }
      const host = h.manager.getHostPathForServicePath, identity = h.manager.getWorktreeIdentityForPath
      const translate = h.manager.getServiceDirectoryForPath
      h.manager.getServiceDirectoryForPath = async (id, directory) => {
        if (directory === nextBatch) nextBatchReads++
        return aliases.includes(directory) ? h.root : translate(id, directory)
      }
      h.manager.getHostPathForServicePath = (id, directory) => {
        if (directory !== h.subdirectory || ++hostReads !== failRead) return host(id, directory)
        hostRead = (async () => {
          await host(id, directory)
          held = true
          started.resolve()
          try { await release.promise }
          finally { held = false }
          // Withdraw on release too: no additional Git read may outlive cleanup,
          // even when this regression is run against the old early-return route.
          return undefined
        })()
        return hostRead
      }
      h.manager.getWorktreeIdentityForPath = async (id, directory) => {
        if (directory === bad && ++identityReads === failRead) {
          await started.promise
          failed.resolve()
          if (phase === "provisional") throw new Error("Owned provisional identity read rejected")
          return undefined
        }
        return identity(id, directory)
      }
      request = h.app.inject({ url: h.url(directories) }).then(response => { settled = true; return response })
      await ready(Promise.race([failed.promise, request.then(() => { throw new Error("Request settled before the failure gate") })]))
      await new Promise<void>(resolve => setTimeout(resolve, 100))
      assert.equal(held, true)
      assert.equal(settled, false, "The failed request must retain custody until the admitted host read settles")
      assert.equal(h.state.calls.length, failRead === 3 ? 1 : 0)
      assert.equal(nextBatchReads, failRead - 1, "Failure must not admit a later ownership batch")
      release.resolve()
      const response = await request
      assert.equal(held, false)
      assert.equal(response.statusCode, 503, response.body)
      assert.equal(response.body, JSON.stringify({ error: "Pending requests unavailable; retain existing queues" }))
      assert.equal(h.state.calls.length, failRead === 3 ? 1 : 0)
      assert.equal(nextBatchReads, failRead - 1)
    } finally {
      started.resolve()
      failed.resolve()
      release.resolve()
      await Promise.allSettled([...(request ? [request] : []), ...(hostRead ? [hostRead] : [])])
      await h.cleanup()
    }
  })
}

test("64 cold directories use one fixed RPC with at most eight concurrent ownership checks", async () => {
  const h = await harness()
  try {
    const cold = Array.from({ length: 64 }, (_, index) => join(h.root, `cold-${index}`))
    await Promise.all(cold.map((directory) => mkdir(directory)))
    for (const directory of cold) h.state.allowed.add(directory)
    h.state.result = { data: cold.map((directory) => complete(directory)) }
    const identity = h.manager.getWorktreeIdentityForPath
    let active = 0, peak = 0
    h.manager.getWorktreeIdentityForPath = async (...args) => {
      peak = Math.max(peak, ++active)
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        return await identity(...args)
      } finally { active-- }
    }
    const response = await h.app.inject({ url: h.url(cold) })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().directories.length, 64)
    assert.deepEqual(h.state.batches, [cold])
    assert.equal(peak, 8)
    assert.equal(active, 0)
  } finally { await h.cleanup() }
})
