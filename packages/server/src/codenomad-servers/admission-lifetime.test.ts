import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { backendAdmissionFixture, backendAuthorityHeader, backendBootstrap } from "../remote-control/test-support/backend-admission"
import { startRemoteSurface } from "../remote-control/test-support/surface"
import { RemoteServerBrowseManager } from "./browse-manager"
import { CodeNomadServerClient } from "./client"
import { CodeNomadServerCredentials } from "./credentials"

const PUBLIC = "https://ui.example.test"
type Caller = { address: string; headers: Record<string, string> }
type Outcome = { status: number; body: string } | { error: Error }

function rendezvous<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function reached(promise: Promise<unknown>, label: string) {
  const controller = new AbortController()
  try {
    await Promise.race([promise, delay(2000, undefined, { signal: controller.signal }).then(() => {
      throw new Error(`rendezvous timed out: ${label}`)
    })])
  } finally { controller.abort() }
}

function call(caller: Caller, target: string, payload?: unknown, method = payload === undefined ? "GET" : "POST"): Promise<Outcome> {
  return new Promise(resolve => {
    const request = http.request(`http://${caller.address}${target}`, {
      method, agent: false,
      headers: { ...caller.headers, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    }, response => {
      let body = ""
      response.on("data", chunk => { body += chunk })
      response.on("error", error => resolve({ error }))
      response.on("end", () => resolve({ status: response.statusCode!, body }))
    })
    request.on("error", error => resolve({ error }))
    request.end(payload === undefined ? undefined : JSON.stringify(payload))
  })
}

function ok(outcome: Outcome) {
  assert.ok("status" in outcome, "authorized operation receives a response")
  assert.equal(outcome.status, 200, outcome.body)
}

async function fixture(t: test.TestContext, configureApp?: NonNullable<Parameters<typeof startRemoteSurface>[1]>["configureApp"]) {
  const backend = await backendAdmissionFixture(t)
  const surface = await startRemoteSurface(t, { settings: backend.settings, allowedOrigins: [PUBLIC], configureApp })
  const principal = (): Caller => ({ address: surface.local, headers: { host: "ui.example.test", origin: PUBLIC,
    cookie: `${surface.authManager.getCookieName()}=${surface.authManager.createSession("codenomad").id}` } })
  return { ...backend, ...surface, principal, remote: backend.remotes[0]!,
    logout: (caller: Caller) => call(caller, "/api/auth/logout", {}) }
}

test("queued connect loses its principal before starting and never dispatches", { timeout: 8000 }, async t => {
  const f = await fixture(t)
  const entered = rendezvous()
  const release = rendezvous()
  f.remote.state.handlers.set("/api/auth/status", async (_request, response) => {
    entered.resolve()
    await release.promise
    response.writeHead(200, { "content-type": "application/json" })
    response.end('{"authenticated":true}')
  })
  const first = call(f.principal(), "/api/remote-servers/A/connect", {})
  await reached(entered.promise, "first connect owns queue")
  const queued = rendezvous()
  const actual = RemoteServerBrowseManager.prototype.connect
  t.mock.method(RemoteServerBrowseManager.prototype, "connect", function (this: RemoteServerBrowseManager, ...args: Parameters<typeof actual>) {
    const pending = actual.apply(this, args)
    queued.resolve()
    return pending
  })
  const caller = f.principal()
  const second = call(caller, "/api/remote-servers/A/connect", {})
  await reached(queued.promise, "second connect enqueued")
  ok(await f.logout(caller))
  release.resolve()
  ok(await first)
  const result = await second
  assert.ok("error" in result, "logged-out queued connect must lose its response")
  assert.equal(f.remote.state.requests.length, 1, "cancelled queue entry must never reach its destination")
})

for (const bootstrapTarget of ["/api/meta", "/api/auth/status"]) {
test(`browse cancellation preserves another principal's shared bootstrap ${bootstrapTarget}`, { timeout: 8000 }, async t => {
  const f = await fixture(t)
  new CodeNomadServerCredentials(path.join(f.directory, "remote-server-credentials.json"))
    .set("A", f.remote.origin, { kind: "password", username: "codenomad", password: "remote-password" })
  const loginEntered = rendezvous()
  const releaseLogin = rendezvous()
  let logins = 0
  f.remote.state.handlers.set("/api/auth/login", async (_request, response) => {
    logins++
    loginEntered.resolve()
    await releaseLogin.promise
    response.writeHead(200, { "content-type": "application/json", "set-cookie": "codenomad_session=shared-login; Path=/" })
    response.end('{"ok":true}')
  })
  const borrowerEntered = rendezvous()
  const actual = CodeNomadServerClient.prototype.fetch
  t.mock.method(CodeNomadServerClient.prototype, "fetch", function (this: CodeNomadServerClient, ...args: Parameters<typeof actual>) {
    const pending = actual.apply(this, args)
    if (args[0] === bootstrapTarget) borrowerEntered.resolve()
    return pending
  })
  const caller = f.principal()
  const browse = call(caller, "/api/remote-servers/A/browse", {})
  await reached(loginEntered.promise, "browse private login")
  const otherCaller = f.principal()
  otherCaller.headers[backendAuthorityHeader] = backendBootstrap
  const other = call(otherCaller, `/api/backends/A${bootstrapTarget}`)
  await reached(borrowerEntered.promise, "other principal borrowing login")
  ok(await f.logout(caller))
  releaseLogin.resolve()
  const [cancelled, retained] = await Promise.all([browse, other])
  assert.ok("error" in cancelled, "logged-out browser must lose publication authority")
  ok(retained)
  assert.equal(logins, 1, "both operations share one private login")
})
}

test("queued browse loses only its own queue slot before any upstream dispatch", { timeout: 8000 }, async t => {
  const f = await fixture(t)
  const entered = rendezvous()
  const release = rendezvous()
  let reads = 0
  f.remote.state.handlers.set("/api/storage/state/ui", async (_request, response) => {
    reads++
    entered.resolve()
    await release.promise
    response.writeHead(200, { "content-type": "application/json" })
    response.end('{"recentFolders":[]}')
  })
  t.after(() => release.resolve())
  const first = call(f.principal(), "/api/remote-servers/A/browse", {})
  await reached(entered.promise, "first browse owns queue")
  const queued = rendezvous()
  const actual = RemoteServerBrowseManager.prototype.browse
  t.mock.method(RemoteServerBrowseManager.prototype, "browse", function (this: RemoteServerBrowseManager, ...args: Parameters<typeof actual>) {
    const pending = actual.apply(this, args)
    queued.resolve()
    return pending
  })
  const caller = f.principal()
  const second = call(caller, "/api/remote-servers/A/browse", {})
  await reached(queued.promise, "second browse enqueued")
  ok(await f.logout(caller))
  assert.ok("error" in await second, "queued cancellation completes without releasing the active operation")
  const other = call(f.principal(), "/api/remote-servers/A/browse", {})
  release.resolve()
  ok(await first)
  ok(await other)
  assert.equal(reads, 2, "only the two live principals dispatch")
  assert.equal(f.remote.state.requests.filter(request => request.path === "/api/filesystem").length, 2)
})

for (const action of ["browse", "connect"] as const) {
  test(`${action} principal ends during upstream IO`, { timeout: 8000 }, async t => {
    const f = await fixture(t)
    const entered = rendezvous()
    const closed = rendezvous()
    const release = rendezvous()
    const target = action === "browse" ? "/api/filesystem" : "/api/auth/status"
    f.remote.state.handlers.set(target, async (_request, response) => {
      response.once("close", () => closed.resolve())
      entered.resolve()
      await release.promise
      response.writeHead(200, { "content-type": "application/json" })
      response.end('{"authenticated":true}')
    })
    t.after(() => release.resolve())
    const caller = f.principal()
    const pending = call(caller, `/api/remote-servers/A/${action}`, {})
    await reached(entered.promise, `${action} upstream starts`)
    ok(await f.logout(caller))
    await reached(closed.promise, `${action} upstream closes on principal end`)
    assert.ok("error" in await pending, "invalidated principal receives no response")
    f.remote.state.handlers.delete(target)
    ok(await call(f.principal(), `/api/remote-servers/A/${action}`, {}))
  })

  test(`${action} principal ends after result is ready but before publication`, { timeout: 8000 }, async t => {
    const f = await fixture(t)
    const ready = rendezvous()
    const release = rendezvous()
    const actual = RemoteServerBrowseManager.prototype[action]
    t.mock.method(RemoteServerBrowseManager.prototype, action, async function (this: RemoteServerBrowseManager, ...args: Parameters<typeof actual>) {
      const result = await (actual as (...args: unknown[]) => Promise<unknown>).apply(this, args)
      ready.resolve()
      await release.promise
      return result
    })
    t.after(() => release.resolve())
    const caller = f.principal()
    const pending = call(caller, `/api/remote-servers/A/${action}`, {})
    await reached(ready.promise, `${action} result ready`)
    ok(await f.logout(caller))
    release.resolve()
    assert.ok("error" in await pending, "ready result cannot publish after logout")
  })
}

const bodyRows = [
  { name: "browse", method: "POST", target: "/api/remote-servers/A/browse", body: {} },
  { name: "connect", method: "POST", target: "/api/remote-servers/A/connect", body: {} },
  { name: "forget", method: "POST", target: "/api/remote-servers/A/forget", body: {} },
  { name: "probe", method: "POST", target: "/api/remote-servers/probe", body: {} },
  { name: "relay login", method: "POST", target: "/api/backends/A/api/auth/login", body: {} },
  { name: "relay logout", method: "POST", target: "/api/backends/A/api/auth/logout", body: {} },
  { name: "profile owner patch", method: "PATCH", target: "/api/storage/state/ui", body: { remoteServers: [] } },
  { name: "profile owner key deletion", method: "PATCH", target: "/api/storage/state/ui", body: { remoteServers: null } },
  { name: "profile document replacement", method: "PATCH", target: "/api/storage/state", body: { ui: { remoteServers: [] } } },
  { name: "profile document key deletion", method: "PATCH", target: "/api/storage/state", body: { ui: { remoteServers: null } } },
  { name: "profile document patch", method: "PATCH", target: "/api/storage/state", body: { ui: null } },
] as const

test("each saved-profile and relay action captures its principal before parsing a delayed body", { timeout: 15000 }, async t => {
  let expected: { target: string; parsing: ReturnType<typeof rendezvous<void>> } | undefined
  const f = await fixture(t, app => {
    app.addHook("preParsing", async (request, _reply, payload) => {
      if (expected && request.url === expected.target) expected.parsing.resolve()
      return payload
    })
  })
  for (const row of bodyRows) {
    const parsing = rendezvous()
    expected = { target: row.target, parsing }
    const caller = f.principal()
    const before = f.settings.getOwner("state", "ui")
    const body = JSON.stringify(row.name === "probe" ? { baseUrl: f.remote.origin } : row.body)
    let request!: http.ClientRequest
    const pending = new Promise<Outcome>(resolve => {
      request = http.request(`http://${caller.address}${row.target}`, {
        method: row.method, agent: false, headers: { ...caller.headers, "content-type": "application/json",
          "content-length": Buffer.byteLength(body) },
      }, response => {
        let result = ""
        response.on("data", chunk => { result += chunk })
        response.on("error", error => resolve({ error }))
        response.on("end", () => resolve({ status: response.statusCode!, body: result }))
      })
      request.on("error", error => resolve({ error }))
      request.flushHeaders()
    })
    try {
      await reached(parsing.promise, `${row.name} preParsing reached with unread body`)
      ok(await f.logout(caller))
      request.end(body)
      assert.ok("error" in await pending, `${row.name}: principal ended before any body could be parsed or dispatched`)
      assert.equal(f.io(), 0, `${row.name}: no upstream access after principal end`)
      assert.deepEqual(f.settings.getOwner("state", "ui"), before, `${row.name}: administrative and private connection state remain unchanged`)
    } finally { request.destroy() }
  }
})

test("saved-profile action guards reject before parsing malformed JSON", { timeout: 8000 }, async t => {
  let parsed = 0
  const f = await fixture(t, app => {
    app.addHook("preParsing", async (_request, _reply, payload) => { parsed++; return payload })
  })
  f.setEnabled(false)
  const caller = f.principal()
  for (const row of bodyRows.filter(row => !row.target.startsWith("/api/storage/"))) {
    const outcome = await new Promise<Outcome>(resolve => {
      const request = http.request(`http://${caller.address}${row.target}`, {
        method: row.method, agent: false,
        headers: { ...caller.headers, "content-type": "application/json" },
      }, response => {
        let body = ""
        response.on("data", chunk => { body += chunk })
        response.on("error", error => resolve({ error }))
        response.on("end", () => resolve({ status: response.statusCode!, body }))
      })
      request.on("error", error => resolve({ error }))
      request.end('{"remoteServers":')
    })
    assert.ok("status" in outcome, row.name)
    assert.equal(outcome.status, 403, `${row.name} refuses admission before JSON parsing: ${outcome.body}`)
  }
  assert.equal(parsed, 0, "refused requests never enter body parsing")
  assert.equal(f.io(), 0)
})

test("probe aborts its upstream when its principal logs out", { timeout: 8000 }, async t => {
  const f = await fixture(t)
  const entered = rendezvous()
  const closed = rendezvous()
  f.remote.state.handlers.set("/api/auth/status", (_request, response) => {
    response.once("close", () => closed.resolve())
    entered.resolve()
  })
  const caller = f.principal()
  const pending = call(caller, "/api/remote-servers/probe", { baseUrl: f.remote.origin })
  await reached(entered.promise, "probe upstream IO")
  ok(await f.logout(caller))
  await reached(closed.promise, "probe upstream cancellation")
  assert.ok("error" in await pending)
})

test("backend relay WebSocket upgrade is refused before upstream IO", { timeout: 8000 }, async t => {
  const f = await fixture(t)
  const caller = f.principal()
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.request(`http://${caller.address}/api/backends/A/api/events`, {
      headers: { ...caller.headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)) })
    request.on("error", reject)
    t.after(() => request.destroy())
    request.setTimeout(2000, () => request.destroy(new Error("backend relay upgrade received no explicit refusal")))
    request.on("upgrade", (_response, socket) => { socket.destroy(); reject(new Error("backend relay accepted WebSocket upgrade")) })
    request.end()
  })
  assert.equal(status, 404)
  assert.equal(f.io(), 0, "upgrade must never open a backend connection")
})

test("logout aborts a real incomplete relay upload while another principal remains usable", { timeout: 8000 }, async t => {
  const f = await fixture(t)
  const firstChunk = rendezvous()
  const closed = rendezvous()
  f.remote.state.handlers.set("/api/workspaces", (request, response) => {
    request.once("data", () => firstChunk.resolve())
    response.once("close", () => closed.resolve())
    request.on("end", () => response.end("uploaded"))
  })
  const caller = f.principal()
  const clientClosed = rendezvous()
  const request = http.request(`http://${caller.address}/api/backends/A/api/workspaces`, {
    method: "POST", agent: false, headers: { ...caller.headers, "content-type": "application/octet-stream" },
  }, response => { response.resume(); response.on("close", () => clientClosed.resolve()) })
  request.on("error", () => clientClosed.resolve())
  t.after(() => request.destroy())
  request.write("first-private-chunk")
  await reached(firstChunk.promise, "upload reached upstream before body end")
  assert.equal(request.writableEnded, false)
  ok(await f.logout(caller))
  await reached(closed.promise, "upstream incomplete upload closes")
  await reached(clientClosed.promise, "caller upload closes")
  f.remote.state.handlers.delete("/api/workspaces")
  ok(await call(f.principal(), "/api/backends/A/api/workspaces"))
})

const publicationRows = [
  { name: "bootstrap metadata", target: "/api/backends/A/api/meta", method: "GET", status: 200, bootstrap: true },
  { name: "bootstrap status", target: "/api/backends/A/api/auth/status", method: "GET", status: 200, bootstrap: true },
  { name: "ordinary read 401", target: "/api/backends/A/api/workspaces", method: "GET", status: 401 },
  { name: "ordinary mutation 201", target: "/api/backends/A/api/workspaces", method: "POST", status: 201, body: {} },
  { name: "ordinary mutation 403", target: "/api/backends/A/api/workspaces", method: "POST", status: 403, body: {} },
  { name: "probe", target: "/api/remote-servers/probe", method: "POST", status: 200, body: {} },
  { name: "SSH host inventory", target: "/api/remote-servers/ssh-hosts", method: "GET", status: 200 },
  { name: "profile document inventory", target: "/api/storage/state", method: "GET", status: 200 },
  { name: "profile owner inventory", target: "/api/storage/state/ui", method: "GET", status: 200 },
  { name: "Forget", target: "/api/remote-servers/A/forget", method: "POST", status: 200, body: {} },
  { name: "durable profile patch", target: "/api/storage/state/ui", method: "PATCH", status: 200, body: { remoteServers: [] } },
] as const

for (const row of publicationRows) {
  test(`${row.name} fences publication after logout and preserves another principal's method/status`, { timeout: 8000 }, async t => {
    const ready = rendezvous()
    const release = rendezvous()
    let heldCookie: string | undefined
    const f = await fixture(t, app => {
      app.addHook("onSend", async (request, _reply, payload) => {
        if (request.url === row.target && request.headers.cookie === heldCookie) {
          ready.resolve()
          await release.promise
        }
        return payload
      })
    })
    t.after(() => release.resolve())
    if (row.target.endsWith("/api/workspaces")) {
      f.remote.state.overrides.set("/api/workspaces", { status: row.status, body: { result: "private-response" } })
    }
    if (row.name === "Forget") {
      new CodeNomadServerCredentials(path.join(f.directory, "remote-server-credentials.json"))
        .set("A", f.remote.origin, { kind: "password", username: "codenomad", password: "remote-password" })
    }
    const body = row.name === "probe" ? { baseUrl: f.remote.origin } : "body" in row ? row.body : undefined
    const caller = f.principal()
    heldCookie = caller.headers.cookie
    if ("bootstrap" in row) caller.headers[backendAuthorityHeader] = backendBootstrap
    const pending = call(caller, row.target, body, row.method)
    await reached(ready.promise, `${row.name} response ready`)
    const durable = () => {
      if (row.name === "durable profile patch") assert.deepEqual(f.settings.getOwner("state", "ui").remoteServers, [])
      if (row.name === "Forget") assert.equal(
        new CodeNomadServerCredentials(path.join(f.directory, "remote-server-credentials.json")).read("A", f.remote.origin), undefined)
    }
    durable()
    ok(await f.logout(caller))
    const otherCaller = f.principal()
    if ("bootstrap" in row) otherCaller.headers[backendAuthorityHeader] = backendBootstrap
    const retained = await call(otherCaller, row.target, body, row.method)
    assert.ok("status" in retained, "other principal receives its independent result")
    assert.equal(retained.status, row.status, retained.body)
    release.resolve()
    assert.ok("error" in await pending, "invalidated principal receives no ready payload")
    durable()
    if (row.target.endsWith("/api/workspaces")) {
      assert.deepEqual(f.remote.state.requests.filter(request => request.path === "/api/workspaces").map(request => request.method),
        [row.method, row.method], "business requests retain the method and dispatch once per principal")
    }
    if (row.name === "SSH host inventory" || row.name === "Forget" || row.name === "durable profile patch"
      || row.name === "profile document inventory" || row.name === "profile owner inventory") {
      assert.equal(f.io(), 0, "synchronous administration performs no upstream IO")
    }
  })
}

test("password connect cannot persist its candidate credentials after principal end", { timeout: 8000 }, async t => {
  const f = await fixture(t)
  const ready = rendezvous()
  const release = rendezvous()
  const settled = rendezvous()
  let held = false
  const json = CodeNomadServerClient.prototype.json
  t.mock.method(CodeNomadServerClient.prototype, "json", async function (this: CodeNomadServerClient, ...args: Parameters<typeof json>) {
    const result = await json.apply(this, args)
    if (args[0] === "/api/auth/status" && !held) {
      held = true
      ready.resolve()
      await release.promise
    }
    return result
  })
  const connect = RemoteServerBrowseManager.prototype.connect
  t.mock.method(RemoteServerBrowseManager.prototype, "connect", async function (this: RemoteServerBrowseManager, ...args: Parameters<typeof connect>) {
    try { return await connect.apply(this, args) }
    finally { settled.resolve() }
  })
  t.after(() => release.resolve())
  const read = () => new CodeNomadServerCredentials(path.join(f.directory, "remote-server-credentials.json")).read("A", f.remote.origin)
  const body = { username: "codenomad", password: "remote-password" }
  const caller = f.principal()
  const pending = call(caller, "/api/remote-servers/A/connect", body)
  await reached(ready.promise, "private candidate authentication ready before credential persistence")
  assert.equal(read(), undefined)
  ok(await f.logout(caller))
  release.resolve()
  await reached(settled.promise, "candidate connect settled after invalidation")
  assert.ok("error" in await pending)
  assert.equal(read(), undefined, "cancelled candidate never becomes the saved identity")
  ok(await call(f.principal(), "/api/remote-servers/A/connect", body))
  assert.equal(read()?.kind, "password", "another principal can explicitly save its own successful connection")
})

test("originless public HTTP Host retains remote principal lifetime and forbids secret entry through loopback proxy", { timeout: 8000 }, async t => {
  const backend = await backendAdmissionFixture(t)
  const ready = rendezvous()
  const release = rendezvous()
  const publicOrigin = "http://ui.example.test"
  const surface = await startRemoteSurface(t, {
    settings: backend.settings,
    allowedOrigins: [publicOrigin],
    configureApp: app => {
      app.addHook("onSend", async (request, _reply, payload) => {
        if (request.url === "/api/storage/state/ui" && request.headers.host === "ui.example.test") {
          ready.resolve()
          await release.promise
        }
        return payload
      })
    },
  })
  t.after(() => release.resolve())
  const caller: Caller = { address: surface.local, headers: { host: "ui.example.test",
    cookie: `${surface.authManager.getCookieName()}=${surface.authManager.createSession("codenomad").id}` } }
  const metadata = await call(caller, "/api/meta")
  ok(metadata)
  assert.ok("body" in metadata)
  const localMetadata = await call({ ...caller, headers: { ...caller.headers, host: "localhost:0" } }, "/api/meta")
  ok(localMetadata)
  assert.ok("body" in localMetadata)
  assert.equal(JSON.parse(localMetadata.body).secretEntryAllowed, true, "originless localhost native caller retains local authority")
  const pending = call(caller, "/api/storage/state/ui")
  await reached(ready.promise, "originless public HTTP inventory ready before publication")
  ok(await call({ ...caller, headers: { ...caller.headers, origin: publicOrigin } }, "/api/auth/logout", {}))
  release.resolve()
  const outcome = await pending
  assert.deepEqual({
    publicationAborted: "error" in outcome,
    secretEntryAllowed: JSON.parse(metadata.body).secretEntryAllowed,
  }, { publicationAborted: true, secretEntryAllowed: false },
  "physical loopback through a public HTTP Host grants neither unrevocable publication nor secret entry")
  assert.equal(backend.io(), 0)
})
