import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { MemoryService } from "../memory/service"
import { MemoryStore, encodeMemoryEntry } from "../memory/store"
import { lockMemoryRepository } from "../memory/lock"
import { backendAdmissionFixture, backendAuthorityHeader, backendBootstrap } from "./test-support/backend-admission"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"

const REMOTE = `https://${FAKE_TUNNEL_HOST}`
const HTTPS = "https://memory.example.test"
const LAN = "http://memory-lan.example.test"
const LIST = { operation: { action: "list", scope: "global" } }
type Caller = { target: string; headers: Record<string, string> }

function send(target: string, pathname: string, options: {
  method?: string; headers?: Record<string, string>; body?: string
} = {}) {
  const url = new URL(`http://${target}`)
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path: pathname, agent: false,
      method: options.method ?? "GET", headers: { host: url.host, ...options.headers } }, response => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", chunk => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode!, body, headers: response.headers }))
      response.on("error", reject)
    })
    request.setTimeout(5_000, () => request.destroy(new Error("Memory request timed out")))
    request.on("error", reject)
    request.end(options.body)
  })
}

const call = (caller: Caller, pathname: string, method = "GET", payload?: unknown,
  headers: Record<string, string> = {}) => send(caller.target, pathname, {
    method, headers: { ...caller.headers, ...(payload ? { "content-type": "application/json" } : {}), ...headers },
    body: payload ? JSON.stringify(payload) : undefined,
  })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t: test.TestContext, configureApp?: NonNullable<Parameters<typeof startRemoteSurface>[1]>["configureApp"]) {
  const backend = await backendAdmissionFixture(t)
  const store = new MemoryStore(backend.directory)
  const workspace = { id: "same-workspace", path: backend.directory }
  const workspaceManager = {
    get: (id: string) => id === workspace.id ? workspace : undefined,
    list: () => [workspace],
    getServiceDirectoryForPath: async (id: string, directory: string) =>
      id === workspace.id && directory === workspace.path ? directory : undefined,
    getServiceWslDistro: () => undefined,
  }
  for (const [index, remote] of backend.remotes.entries()) {
    const server = index ? "B" : "A"
    remote.state.overrides.set("/api/memory/settings", { status: 200, body: { enabled: true, server } })
    remote.state.overrides.set("/api/memory", { status: 200, body: {
      entries: [{ id: "same-entry", sessionId: "same-session", title: server, text: `${server}-only` }],
    } })
  }
  const surface = await startRemoteSurface(t, {
    settings: backend.settings, allowedOrigins: [HTTPS, LAN], bindHost: "0.0.0.0",
    memoryStore: store, workspaceManager, configureApp,
  })
  const session = (origin = HTTPS): Caller => ({
    target: surface.local, headers: { host: new URL(origin).host, origin,
      cookie: `${surface.authManager.getCookieName()}=${surface.authManager.createSession("codenomad").id}` },
  })
  // The shared fixture advertises this fixed local origin in ServerMeta.
  const local = session("http://localhost:0")
  const address = Object.values(os.networkInterfaces()).flat().find(value => value?.family === "IPv4" && !value.internal)?.address
  assert.ok(address, "a real non-loopback interface is required")
  const lan = { ...session(LAN), target: `${address}:${new URL(`http://${surface.local}`).port}` }
  const paired = await call({ target: surface.target(), headers: { host: FAKE_TUNNEL_HOST, origin: REMOTE } },
    "/api/remote-control/pair", "POST", { code: surface.code })
  assert.equal(paired.status, 200, paired.body)
  const rc: Caller = { target: surface.target(), headers: { host: FAKE_TUNNEL_HOST, origin: REMOTE,
    cookie: paired.headers["set-cookie"]![0]!.split(";")[0]! } }
  const directPairing = surface.manager.createDirectPairing(HTTPS)
  const directReply = await call({ target: surface.local, headers: { host: "memory.example.test", origin: HTTPS } },
    "/api/remote-control/pair", "POST", { code: new URL(directPairing.url).hash.slice(1) })
  assert.equal(directReply.status, 200, directReply.body)
  const direct: Caller = { target: surface.local, headers: { host: "memory.example.test", origin: HTTPS,
    cookie: directReply.headers["set-cookie"]![0]!.split(";")[0]! } }
  const proof = async (caller: Caller, id = "A") => {
    const response = await call(caller, `/api/backends/${id}/api/meta`, "GET", undefined,
      { [backendAuthorityHeader]: backendBootstrap })
    assert.equal(response.status, 200, response.body)
    const value = String(response.headers[backendAuthorityHeader])
    assert.match(value, /^[A-Za-z0-9_-]{43}$/)
    return { [backendAuthorityHeader]: value }
  }
  return { ...surface, ...backend, store, local, rc, direct, lan, session, proof,
    rcId: JSON.parse(paired.body).device.id as string,
    directId: JSON.parse(directReply.body).device.id as string }
}

test("memory channel matrix: RC, HTTPS session/device and LAN operate host and A/B memory", { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const callers = [["RC", f.rc], ["HTTPS session", f.session()], ["HTTPS device", f.direct], ["LAN", f.lan]] as const
  for (const [label, caller] of callers) await t.test(label, async () => {
    assert.equal((await call(caller, "/api/memory/settings")).status, 200)
    const enabled = await call(caller, "/api/memory/settings", "PUT", { enabled: true })
    assert.equal(enabled.status, 200, enabled.body)
    const host = await call(caller, "/api/memory", "POST", LIST)
    assert.equal(host.status, 200, host.body)
    assert.deepEqual(JSON.parse(host.body).entries, [])
    for (const id of ["A", "B"]) {
      const proof = await f.proof(caller, id)
      const settings = await call(caller, `/api/backends/${id}/api/memory/settings`, "GET", undefined, proof)
      assert.equal(settings.status, 200, settings.body)
      assert.deepEqual(JSON.parse(settings.body), { server: id, enabled: true })
      assert.equal((await call(caller, `/api/backends/${id}/api/memory/settings`, "PUT", { enabled: false }, proof)).status, 200)
      const list = await call(caller, `/api/backends/${id}/api/memory`, "POST", {
        operation: { action: "list", scope: "project" },
        context: { workspaceId: "same-workspace", directory: "/same-project" },
      }, proof)
      assert.equal(list.status, 200, list.body)
      assert.equal(JSON.parse(list.body).entries[0].text, `${id}-only`)
      const request = f.remotes[id === "A" ? 0 : 1]!.state.requests.at(-1)!
      assert.equal(JSON.stringify(request).includes(proof[backendAuthorityHeader]), false, "proof stays on the host")
      assert.notEqual(request.headers.cookie, caller.headers.cookie, "browser credentials stay on the host")
    }
  })
  assert.equal((await call(f.local, "/api/memory/settings", "PUT", { enabled: false })).status, 200)
})

test("memory remote strict flag is authoritative while native loopback stays usable", { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const caller = f.session()
  const proof = await f.proof(caller)
  for (const value of [false, "true", 1, null]) {
    f.setEnabled(value)
    const before = f.io()
    for (const [method, pathname, payload] of [
      ["GET", "/api/memory/settings", undefined],
      ["PUT", "/api/memory/settings", { enabled: true }],
      ["POST", "/api/memory", LIST],
      ["GET", "/api/backends/A/api/memory/settings", undefined],
      ["POST", "/api/backends/A/api/memory", LIST],
    ] as const) {
      const response = await call(caller, pathname, method, payload, proof)
      assert.ok([403, 404].includes(response.status), `${JSON.stringify(value)} ${pathname}: ${response.status}`)
    }
    assert.equal(f.io(), before, "disabled callers cannot reach a saved destination")
    assert.equal((await call(f.local, "/api/memory/settings")).status, 200)
    assert.equal((await call(f.local, "/api/memory", "POST", LIST)).status, 200)
    assert.equal((await call({ target: f.local.target, headers: { cookie: f.local.headers.cookie! } },
      "/api/memory", "POST", LIST)).status, 200, "originless native loopback retains memory authority")
  }
  f.setEnabled(true)
  assert.equal((await call(caller, "/api/memory", "POST", LIST)).status, 200)
})

test("memory refuses hostile provenance, spoofed server headers and encoded routes before storage or relay IO", { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const caller = f.session()
  const proof = await f.proof(caller)
  const reads = t.mock.method(f.store, "listForUI")
  for (const origin of ["https://hostile.example.test", "null", ""]) {
    const hostile = { ...caller, headers: { ...caller.headers, origin, "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "localhost", "x-codenomad-remote-control": "false" } }
    const before = f.io()
    for (const pathname of ["/api/memory", "/api/backends/A/api/memory"]) {
      const response = await call(hostile, pathname, "POST", LIST, proof)
      assert.ok([403, 404].includes(response.status), `${origin} ${pathname}: ${response.status}`)
    }
    assert.equal(f.io(), before)
  }
  const before = f.io()
  for (const pathname of ["/api/%6demory", "/api/memory%2fsettings", "/api/memory/extra",
    "/api/backends/A/api/%6demory", "/api/backends/A/api/memory%2fsettings", "/api/backends/A/api/memory/extra"]) {
    const response = await call(caller, pathname, "POST", LIST, proof)
    assert.ok([400, 403, 404].includes(response.status), `${pathname}: ${response.status}`)
  }
  for (const headers of [
    { "x-codenomad-server-request": "1" },
    { "x-codenomad-server-request": "" },
  ]) {
    const response = await call(caller, "/api/memory", "POST", LIST, headers)
    assert.ok([401, 403, 404].includes(response.status), `explicit server protocol: ${response.status}`)
  }
  assert.equal(f.io(), before)
  assert.equal(reads.mock.callCount(), 0, "refusals never read host memory")
  const noSource = { ...caller, headers: { ...caller.headers } }
  delete noSource.headers.origin
  assert.ok([403, 404].includes((await call(noSource, "/api/memory", "POST", LIST)).status))
  const lanNoSource = { ...f.lan, headers: { ...f.lan.headers } }
  delete lanNoSource.headers.origin
  assert.ok([403, 404].includes((await call(lanNoSource, "/api/memory/settings")).status))
  const refererRead = await call(lanNoSource, "/api/memory/settings", "GET", undefined, { referer: `${LAN}/settings` })
  assert.equal(refererRead.status, 200, refererRead.body)
})

test("memory validates project ownership and strict payload schemas without storage access", { timeout: 15_000 }, async t => {
  const f = await fixture(t)
  const reads = t.mock.method(f.store, "listForUI")
  for (const payload of [
    { operation: { action: "list", scope: "project" }, context: { workspaceId: "missing" } },
    { operation: { action: "list", scope: "project" }, context: { workspaceId: "same-workspace", directory: "/unowned" } },
    { operation: { action: "list", scope: "global", projectId: "a".repeat(64) } },
    { ...LIST, context: { workspaceId: "same-workspace", projectId: "a".repeat(64) } },
    { ...LIST, directory: "/unowned" },
  ]) {
    const response = await call(f.rc, "/api/memory", "POST", payload)
    assert.equal(response.status, 400, response.body)
    assert.equal(JSON.parse(response.body).code, "invalid")
    assert.doesNotMatch(response.body, /unowned|same-workspace/)
  }
  for (const payload of [{ enabled: "true" }, { enabled: true, extra: true }]) {
    assert.equal((await call(f.direct, "/api/memory/settings", "PUT", payload)).status, 400)
  }
  assert.equal(reads.mock.callCount(), 0)
})

test("memory relays require current destination proof and refuse unreviewed methods before IO", { timeout: 15_000 }, async t => {
  const f = await fixture(t)
  const caller = f.session()
  const proofA = await f.proof(caller, "A")
  const proofB = await f.proof(caller, "B")
  const before = f.io()
  for (const headers of [{}, { [backendAuthorityHeader]: backendBootstrap }, proofB]) {
    const response = await call(caller, "/api/backends/A/api/memory", "POST", LIST, headers)
    assert.equal(response.status, 502, response.body)
    assert.deepEqual(JSON.parse(response.body), { error: "unreachable" })
  }
  for (const [method, pathname] of [
    ["DELETE", "/api/memory"], ["PATCH", "/api/memory/settings"],
    ["DELETE", "/api/backends/A/api/memory"], ["PATCH", "/api/backends/A/api/memory/settings"],
    ["POST", "/api/backends/A/api/memory/extra"],
  ] as const) {
    const response = await call(caller, pathname, method, LIST, proofA)
    assert.ok(response.status >= 400 && response.status < 500, `${method} ${pathname}: ${response.status}`)
  }
  assert.equal(f.io(), before)
})

test("reviewed repository source and pruning preview relays dispatch once and reject other methods", { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  const routes = [
    ["GET", "/api/workspaces/same-workspace/repository-source"],
    ["POST", "/api/workspaces/same-workspace/session-pruning/preview"],
  ] as const
  for (const remote of f.remotes) for (const [, pathname] of routes) {
    remote.state.overrides.set(pathname, { status: 200, body: { reviewed: pathname } })
  }
  for (const caller of [f.rc, f.direct, f.session(), f.lan]) {
    const proof = await f.proof(caller)
    for (const [method, pathname] of routes) {
      const before = f.remotes[0]!.state.requests.filter(request => request.path === pathname).length
      const response = await call(caller, `/api/backends/A${pathname}`, method,
        method === "POST" ? { sessionIds: ["same-session"] } : undefined, proof)
      assert.equal(response.status, 200, response.body)
      assert.equal(JSON.parse(response.body).reviewed, pathname)
      assert.equal(f.remotes[0]!.state.requests.filter(request => request.path === pathname).length, before + 1)
      const total = f.io()
      const refused = await call(caller, `/api/backends/A${pathname}`, "DELETE", undefined, proof)
      assert.ok([403, 404].includes(refused.status), refused.body)
      assert.equal(f.io(), total, "unreviewed method cannot reach the destination")
    }
  }
})

function seed(store: MemoryStore) {
  const entry = { id: "same-entry", sessionId: "same-session", title: "Host memory", type: "fact" as const,
    text: "host-only-original", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
  const file = path.join(store.directory, "global", `${entry.id}.md`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, encodeMemoryEntry(entry))
  return { file, bytes: fs.readFileSync(file, "utf8") }
}

test("memory remote human CRUD preserves revision checks, provenance and host/A/B separation", { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  seed(f.store)
  assert.equal((await call(f.rc, "/api/memory/settings", "PUT", { enabled: true })).status, 200)
  const read = await call(f.rc, "/api/memory", "POST", {
    operation: { action: "read", scope: "global", query: "same-entry" },
  })
  assert.equal(read.status, 200, read.body)
  const entry = JSON.parse(read.body).entry
  assert.equal(entry.text, "host-only-original")
  const save = { operation: { action: "save", scope: "global", id: entry.id, revision: entry.revision,
    content: { title: entry.title, type: entry.type, text: "host-only-edited" } } }
  const edited = await call(f.direct, "/api/memory", "POST", save)
  assert.equal(edited.status, 200, edited.body)
  assert.equal((await call(f.rc, "/api/memory", "POST", save)).status, 409, "stale edit conflicts")
  const fresh = JSON.parse((await call(f.session(), "/api/memory", "POST", LIST)).body).entries[0]
  assert.equal(fresh.text, "host-only-edited")
  assert.equal(fresh.sessionId, "same-session")
  for (const id of ["A", "B"]) {
    const remote = await call(f.rc, `/api/backends/${id}/api/memory`, "POST", LIST, await f.proof(f.rc, id))
    assert.equal(JSON.parse(remote.body).entries[0].text, `${id}-only`)
  }
  const forgotten = await call(f.rc, "/api/memory", "POST", {
    operation: { action: "delete", scope: "global", id: fresh.id, revision: fresh.revision },
  })
  assert.equal(forgotten.status, 200, forgotten.body)
  assert.deepEqual(JSON.parse((await call(f.rc, "/api/memory", "POST", LIST)).body).entries, [])
})

test("memory revoked HTTPS session is captured before the request body and performs no storage IO", { timeout: 15_000 }, async t => {
  const admitted = deferred()
  const f = await fixture(t, app => {
    app.addHook("preParsing", (request, _reply, payload, done) => {
      if (request.url === "/api/memory") admitted.resolve()
      done(null, payload)
    })
  })
  const caller = f.session()
  const reads = t.mock.method(f.store, "listForUI")
  const body = JSON.stringify(LIST)
  const url = new URL(`http://${caller.target}`)
  const request = http.request({ hostname: url.hostname, port: url.port, method: "POST", path: "/api/memory",
    agent: false, headers: { ...caller.headers, "content-type": "application/json", "content-length": Buffer.byteLength(body) } })
  t.after(() => request.destroy())
  const outcome = new Promise<number | "closed">(resolve => {
    request.on("response", response => { response.resume(); resolve(response.statusCode!) })
    request.on("error", () => resolve("closed"))
    request.on("close", () => resolve("closed"))
  })
  request.flushHeaders()
  await admitted.promise
  assert.equal((await call(caller, "/api/auth/logout", "POST")).status, 200)
  request.end(body)
  const response = await outcome
  assert.notEqual(response, 200)
  assert.equal(reads.mock.callCount(), 0)
  assert.equal((await call(f.session(), "/api/memory", "POST", LIST)).status, 200, "another session retains authority")
})

for (const principal of ["session", "RC", "direct device"] as const) {
  test(`memory ${principal} revocation fences awaited read publication and preserves another principal`, { timeout: 15_000 }, async t => {
    const f = await fixture(t)
    const caller = principal === "session" ? f.session() : principal === "RC" ? f.rc : f.direct
    const entered = deferred(), release = deferred(), finished = deferred()
    t.after(release.resolve)
    const list = f.store.listForUI.bind(f.store)
    let first = true
    t.mock.method(f.store, "listForUI", async (...args: Parameters<MemoryStore["listForUI"]>) => {
      const result = await list(...args)
      if (first) {
        first = false
        entered.resolve()
        await release.promise
        finished.resolve()
      }
      return result
    })
    const pending = call(caller, "/api/memory", "POST", LIST).catch(() => ({ status: 0, body: "", headers: {} }))
    await entered.promise
    assert.equal((await call(f.session(), "/api/memory", "POST", LIST)).status, 200)
    if (principal === "session") assert.equal((await call(caller, "/api/auth/logout", "POST")).status, 200)
    else assert.equal(f.manager.revokeDevice(principal === "RC" ? f.rcId : f.directId), true)
    release.resolve()
    await finished.promise
    const response = await pending
    assert.notEqual(response.status, 200, response.body)
    assert.equal((await call(f.local, "/api/memory", "POST", LIST)).status, 200, "host-native reads retain authority")
  })
}

test("memory revoked queued edit cannot publish file bytes after the repository lock", { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const seeded = seed(f.store)
  await call(f.local, "/api/memory/settings", "PUT", { enabled: true })
  const entry = JSON.parse((await call(f.direct, "/api/memory", "POST", LIST)).body).entries[0]
  const release = await lockMemoryRepository(f.store.directory)
  t.after(release)
  const entered = deferred(), completed = deferred()
  const mutate = f.store.mutate
  t.mock.method(f.store, "mutate", async (...args: Parameters<MemoryStore["mutate"]>) => {
    entered.resolve()
    try { return await Reflect.apply(mutate, f.store, args) }
    finally { completed.resolve() }
  })
  const caller = f.session()
  const pending = call(caller, "/api/memory", "POST", { operation: {
    action: "save", scope: "global", id: entry.id, revision: entry.revision,
    content: { title: entry.title, type: entry.type, text: "must-never-publish" },
  } }).catch(() => ({ status: 0, body: "", headers: {} }))
  await entered.promise
  assert.equal((await call(caller, "/api/auth/logout", "POST")).status, 200)
  await release()
  await completed.promise
  assert.notEqual((await pending).status, 200)
  assert.equal(fs.readFileSync(seeded.file, "utf8"), seeded.bytes)
  assert.equal(fs.existsSync(path.join(f.store.directory, ".transaction.json")), false)
})

test("memory revoked queued enablement cannot persist configuration", { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const caller = f.session()
  const entered = deferred(), completed = deferred()
  const release = await lockMemoryRepository(f.store.directory)
  t.after(release)
  const setEnabled = MemoryService.prototype.setEnabled
  t.mock.method(MemoryService.prototype, "setEnabled", async function (this: MemoryService, ...args: Parameters<MemoryService["setEnabled"]>) {
    entered.resolve()
    try { return await Reflect.apply(setEnabled, this, args) }
    finally { completed.resolve() }
  })
  const writes = t.mock.method(f.settings, "mergePatchOwner")
  const pending = call(caller, "/api/memory/settings", "PUT", { enabled: true })
    .catch(() => ({ status: 0, body: "", headers: {} }))
  await entered.promise
  assert.equal((await call(caller, "/api/auth/logout", "POST")).status, 200)
  await release()
  await completed.promise
  assert.notEqual((await pending).status, 200)
  assert.equal(writes.mock.callCount(), 0)
  assert.equal(JSON.parse((await call(f.local, "/api/memory/settings")).body).enabled, false)
})

test("memory relayed revocation closes upstream IO and prevents late publication without affecting B", { timeout: 15_000 }, async t => {
  const f = await fixture(t)
  const caller = f.session()
  const proof = await f.proof(caller)
  const entered = deferred(), release = deferred(), closed = deferred()
  t.after(release.resolve)
  f.remotes[0]!.state.handlers.set("/api/memory", (_request, response) => {
    response.on("close", closed.resolve)
    entered.resolve()
    void release.promise.then(() => response.end(JSON.stringify({ entries: [{ text: "late-memory-must-not-publish" }] })))
  })
  const pending = call(caller, "/api/backends/A/api/memory", "POST", LIST, proof)
    .catch(() => ({ status: 0, body: "", headers: {} }))
  await entered.promise
  assert.equal((await call(caller, "/api/auth/logout", "POST")).status, 200)
  await closed.promise
  release.resolve()
  const result = await pending
  assert.notEqual(result.status, 200)
  assert.doesNotMatch(result.body, /late-memory-must-not-publish/)
  const other = await call(f.direct, "/api/backends/B/api/memory", "POST", LIST, await f.proof(f.direct, "B"))
  assert.equal(other.status, 200, other.body)
  assert.equal(JSON.parse(other.body).entries[0].text, "B-only")
})
