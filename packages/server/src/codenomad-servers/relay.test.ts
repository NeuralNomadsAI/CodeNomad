import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import { gzipSync } from "node:zlib"
import { test, type TestContext } from "node:test"
import Fastify from "fastify"
import { RemoteServerBrowseManager } from "./browse-manager"
import { CodeNomadServerCredentials } from "./credentials"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"
import { registerBackendRelayRoutes } from "../server/routes/backend-relay"
import { RemoteIngress } from "../remote-control/ingress"
import { DEVICE_COOKIE_NAME } from "../remote-control/gate"
import { SERVER_PAIR_PATH } from "../remote-control/server-pairing"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "../remote-control/test-support/surface"
import { registerRequestLogging } from "../server/request-logging"
import type { Logger } from "../logger"

const PREFIX = "/api/backends/saved"

test("compressed upstream bodies publish decoded bytes without a stale wire length", async t => {
  const f = await fixture(t)
  assert.equal((await f.connect()).status, 200)
  const text = JSON.stringify({ text: "remote response ".repeat(100) })
  f.remote.state.handlers.set("/api/test/compressed", (_request, response) => {
    const body = gzipSync(text)
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": body.length })
    response.end(body)
  })
  const response = await f.call("/api/test/compressed")
  assert.equal(response.status, 200)
  assert.equal(response.body, text)
  assert.equal(response.headers["content-encoding"], undefined)
})

test("forget revokes a connection queued before its first dispatch", async t => {
  const f = await fixture(t)
  const pending = f.manager.connect("saved", { username: "codenomad", password: "remote-password" })
  await f.manager.forget("saved")
  await assert.rejects(pending, { code: "unreachable" })
  assert.equal(f.remote.state.requests.length, 0)
  assert.equal(fs.existsSync(f.file), false)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Relay did not progress within 3 seconds")), 3000)
    })])
  } finally { clearTimeout(timer) }
}

function open(origin: string, target: string, options: { method?: string; headers?: http.OutgoingHttpHeaders } = {}) {
  const received = deferred<IncomingMessage>()
  const headers = Object.fromEntries(Object.entries({ origin, ...options.headers }).filter(([, value]) => value !== undefined))
  const request = http.request(new URL(origin), { path: target, method: options.method ?? "GET", agent: false,
    headers }, response => received.resolve(response))
  request.once("error", received.reject)
  return { request, response: received.promise }
}

async function read(response: IncomingMessage) {
  let body = ""
  for await (const chunk of response) body += chunk
  return { status: response.statusCode!, headers: response.headers, body }
}

async function send(origin: string, target: string, options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {}) {
  const socket = open(origin, target, options)
  socket.request.end(options.body)
  return bounded(socket.response.then(read))
}

async function fixture(t: TestContext, remoteOrigin?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-relay-"))
  const remote = await startFakeCodeNomad()
  const profiles = [{ id: "saved", baseUrl: remoteOrigin ?? remote.origin, skipTlsVerify: false }]
  const file = path.join(directory, "remote-server-credentials.json")
  const manager = new RemoteServerBrowseManager({ getOwner: () => ({ remoteServers: profiles }),
    configYamlPathForAuthority: () => path.join(directory, "config.yaml") })
  const app = Fastify()
  const logs: unknown[] = []
  registerRequestLogging(app, { debug: (record: unknown) => logs.push(record), trace: (record: unknown) => logs.push(record), isLevelEnabled: () => true } as unknown as Logger)
  let origin = ""
  registerBackendRelayRoutes(app, { manager, getSelfOrigins: () => new Set([origin, "http://192.168.1.50", "https://remote.test"]) })
  origin = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(async () => {
    manager.close()
    app.server.closeAllConnections()
    await app.close()
    await remote.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const call = (target: string, options: Parameters<typeof send>[2] = {}) => send(origin, `${PREFIX}${target}`, options)
  const connect = (password = "remote-password") => call("/api/auth/login", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "codenomad", password }) })
  return { remote, manager, app, origin, profiles, file, call, connect, logs }
}

test("relay diagnostics omit private request bodies and target queries", async t => {
  const f = await fixture(t)
  assert.equal((await f.connect()).status, 200)
  await f.call("/api/filesystem?credential=private-query-marker")
  const output = JSON.stringify(f.logs)
  assert(output.includes("/api/backends/:id/*"))
  for (const secret of ["private-query-marker", "remote-password", "codenomad_session", "username"]) assert.equal(output.includes(secret), false, secret)
})

test("SDK location, media and reconciliation contracts survive the relay while Retry-After reaches recovery", async t => {
  const f = await fixture(t)
  assert.equal((await f.connect()).status, 200)
  const headers = { "x-codenomad-location": encodeURIComponent(JSON.stringify({ directory: "/srv/worktree" })),
    "x-codenomad-media": "deferred", "x-codenomad-pending-reconciliation": "1", "x-codenomad-human-answer": "1",
    "x-opencode-directory": encodeURIComponent("/srv/worktree") }
  f.remote.state.handlers.set("/workspaces/ws/instance/api/session/s", (request, response) => {
    for (const [name, value] of Object.entries(headers)) assert.equal(request.headers[name], value, name)
    response.writeHead(503, { "content-type": "application/json", "retry-after": "30" })
    response.end("{}")
  })
  const response = await f.call("/workspaces/ws/instance/api/session/s", { headers })
  assert.equal(response.status, 503)
  assert.equal(response.headers["retry-after"], "30")
})

test("server-advertised LAN and remote origins never gain loopback relay authority", async t => {
  const f = await fixture(t)
  for (const remote of ["http://192.168.1.50", "https://remote.test"]) {
    assert.equal((await f.call("/api/auth/status", { headers: { origin: remote } })).status, 403)
    assert.equal((await f.call("/api/auth/status", { headers: { origin: undefined, referer: `${remote}/`, "sec-fetch-site": "same-origin" } })).status, 403)
  }
  assert.equal(f.remote.state.requests.length, 0)
})

test("relay HTTP preserves query, method and raw POST while isolating private headers", async t => {
  const f = await fixture(t)
  assert.equal((await f.connect()).status, 200)
  f.remote.state.handlers.set("/api/test/echo", (request, response) => {
    let body = ""
    request.on("data", chunk => { body += chunk })
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json", "set-cookie": "private=secret", location: "https://foreign.test/",
        "access-control-allow-origin": "*", "content-disposition": "attachment; filename=test.json", etag: "test-etag" })
      response.end(JSON.stringify({ url: request.url, method: request.method, body }))
    })
  })
  for (const method of ["GET", "POST"]) {
    const body = method === "POST" ? "{\"raw\":\"é &?\"}" : undefined
    const result = await f.call("/api/test/echo?a=one%20two&a=%26%3F&empty=", { method, body, headers: {
      "content-type": "application/json", accept: "application/json", "accept-language": "fr", "if-none-match": "previous",
      cookie: "caller=must-not-leak", authorization: "Bearer must-not-leak", "x-forwarded-for": "192.168.1.1",
      "sec-fetch-site": "same-origin", referer: `${f.origin}/`,
    } })
    assert.equal(result.status, 201)
    assert.deepEqual(JSON.parse(result.body), { url: "/api/test/echo?a=one%20two&a=%26%3F&empty=", method, body: body ?? "" })
    assert.equal(result.headers["set-cookie"], undefined)
    assert.equal(result.headers.location, undefined)
    assert.equal(result.headers["access-control-allow-origin"], undefined)
    assert.equal(result.headers["content-disposition"], "attachment; filename=test.json")
    assert.equal(result.headers.etag, "test-etag")
    assert.equal(result.headers["cache-control"], "no-store")
    assert.equal(result.headers["content-security-policy"], "sandbox")
    assert.equal(result.headers["x-content-type-options"], "nosniff")
    const forwarded = f.remote.state.requests.at(-1)!
    assert.match(forwarded.headers.cookie!, /^codenomad_session=/)
    for (const name of ["origin", "referer", "sec-fetch-site", "authorization", "x-forwarded-for"]) assert.equal(forwarded.headers[name], undefined, name)
    assert.equal(forwarded.headers["if-none-match"], "previous")
    assert.equal(forwarded.headers["accept-language"], "fr")
  }
})

test("streaming POST reaches remote before caller ends its upload", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await f.connect()
  const first = deferred<string>()
  let ended = false
  f.remote.state.handlers.set("/api/test/upload", (request, response) => {
    let body = ""
    request.on("data", chunk => { body += chunk; first.resolve(body) })
    request.on("end", () => { ended = true; response.end(body) })
  })
  const upload = open(f.origin, `${PREFIX}/api/test/upload`, { method: "POST", headers: { "content-type": "application/octet-stream" } })
  t.after(() => upload.request.destroy())
  upload.request.write("first-")
  assert.equal(await bounded(first.promise), "first-")
  assert.equal(ended, false)
  assert.equal(upload.request.writableEnded, false)
  upload.request.end("last")
  assert.equal((await bounded(upload.response.then(read))).body, "first-last")
  assert.equal(ended, true)
})

for (const contentType of ["application/octet-stream", "text/event-stream"]) {
  test(`${contentType} forwards the first chunk before remote completion`, { timeout: 10_000 }, async t => {
    const f = await fixture(t)
    await f.connect()
    let upstream!: ServerResponse
    f.remote.state.handlers.set("/api/test/stream", (_request, response) => {
      upstream = response
      response.writeHead(200, { "content-type": contentType })
      response.write("data: first\n\n")
    })
    const stream = open(f.origin, `${PREFIX}/api/test/stream`, { headers: { "last-event-id": "event-7" } })
    t.after(() => stream.request.destroy())
    stream.request.end()
    const response = await bounded(stream.response)
    const first = deferred<string>()
    const chunks: string[] = []
    response.on("data", chunk => { chunks.push(String(chunk)); first.resolve(String(chunk)) })
    const finished = new Promise<void>(resolve => response.once("end", resolve))
    assert.equal(await bounded(first.promise), "data: first\n\n")
    assert.equal(upstream.writableEnded, false)
    assert.equal(response.complete, false)
    assert.equal(response.headers["content-type"], contentType)
    assert.equal(f.remote.state.requests.at(-1)!.headers["last-event-id"], "event-7")
    upstream.end("data: last\n\n")
    await bounded(finished)
    assert.equal(chunks.join(""), "data: first\n\ndata: last\n\n")
  })
}

test("client disconnect cancels remote response and incomplete upload", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await f.connect()
  for (const method of ["GET", "POST"]) {
    const started = deferred<void>()
    const closed = deferred<void>()
    let ended = false
    f.remote.state.handlers.set("/api/test/abort", (request, response) => {
      response.once("close", () => closed.resolve())
      request.once("end", () => { ended = true })
      if (method === "GET") { response.writeHead(200); response.write("first"); started.resolve() }
      else request.once("data", () => started.resolve())
    })
    const stream = open(f.origin, `${PREFIX}/api/test/abort`, { method, headers: { "content-type": "application/octet-stream" } })
    // A cancelled upload may never produce response headers.
    void stream.response.catch(() => undefined)
    t.after(() => stream.request.destroy())
    if (method === "GET") stream.request.end()
    else stream.request.write("incomplete")
    await bounded(started.promise)
    stream.request.destroy()
    await bounded(closed.promise)
    if (method === "POST") assert.equal(ended, false)
  }
})

for (const action of ["logout", "removed", "retargeted"] as const) {
  test(`${action} revokes live transfers and deletes private credentials`, { timeout: 10_000 }, async t => {
    const f = await fixture(t)
    await f.connect()
    assert(fs.readFileSync(f.file, "utf8").includes("remote-password"))
    const closed: Promise<void>[] = []
    f.remote.state.handlers.set("/api/test/live", (_request, response) => {
      closed.push(new Promise<void>(resolve => response.once("close", resolve)))
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write("data: live\n\n")
    })
    const streams = await Promise.all([1, 2].map(async () => {
      const stream = open(f.origin, `${PREFIX}/api/test/live`)
      t.after(() => stream.request.destroy())
      stream.request.end()
      const response = await bounded(stream.response)
      response.on("error", () => undefined)
      const first = deferred<void>()
      response.once("data", () => first.resolve())
      await bounded(first.promise)
      return { response, closed: new Promise<void>(resolve => response.once("close", resolve)) }
    }))
    if (action === "logout") assert.equal((await f.call("/api/auth/logout", { method: "POST" })).status, 200)
    else {
      if (action === "removed") f.profiles.splice(0)
      else f.profiles[0]!.baseUrl = "http://127.0.0.1:1"
      f.manager.reconcile()
    }
    await bounded(Promise.all([...closed, ...streams.map(stream => stream.closed)]))
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { servers: {} })
    const after = await f.call("/api/filesystem")
    assert.equal(after.status, action === "removed" ? 404 : action === "retargeted" ? 502 : 401)
  })
}

test("wrong password and remote 401 are sanitized; expired GET session reauthenticates once", async t => {
  const f = await fixture(t)
  const missing = await f.call("/api/filesystem")
  assert.equal(missing.status, 401)
  assert.deepEqual(JSON.parse(missing.body), { error: "needs_credentials" })
  const wrong = await f.connect("wrong")
  assert.equal(wrong.status, 401)
  assert.deepEqual(JSON.parse(wrong.body), { error: "auth" })
  assert.equal(fs.existsSync(f.file), false)
  await f.connect()
  const before = f.remote.state.logins
  f.remote.restart()
  assert.equal((await f.call("/api/filesystem?path=%2Fsrv%2Fprojects")).status, 200)
  assert.equal(f.remote.state.logins, before + 1)
  const saved = fs.readFileSync(f.file, "utf8")
  assert(saved.includes("codenomad_session="))
  f.remote.state.overrides.set("/api/test/unauthorized", { status: 401, body: { password: "must-not-leak" } })
  const unauthorized = await f.call("/api/test/unauthorized")
  assert.equal(unauthorized.status, 401)
  assert.deepEqual(JSON.parse(unauthorized.body), { error: "auth" })
  assert.equal(f.remote.state.logins, before + 2, "at most one retry for repeated 401")
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { servers: {} })
})

test("401 never replays a streaming mutation", async t => {
  const f = await fixture(t)
  await f.connect()
  f.remote.restart()
  const before = f.remote.state.logins
  const response = await f.call("/api/test/upload", { method: "POST", headers: { "content-type": "text/plain" }, body: "only-once" })
  assert.equal(response.status, 401)
  assert.deepEqual(JSON.parse(response.body), { error: "auth" })
  assert.equal(f.remote.state.logins, before)
  assert.equal(f.remote.state.requests.filter(request => request.path === "/api/test/upload").length, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { servers: {} })
})

test("redirects never forward credentials or rotate the saved session", async t => {
  const f = await fixture(t)
  await f.connect()
  const other = await startFakeCodeNomad()
  t.after(() => other.close())
  const saved = fs.readFileSync(f.file, "utf8")
  for (const location of [`${other.origin}/api/filesystem`, "/api/filesystem"]) {
    f.remote.state.overrides.set("/api/test/redirect", { status: 302, body: { secret: "must-not-leak" },
      headers: { location, "set-cookie": "codenomad_session=redirect-secret; Path=/" } })
    const result = await f.call("/api/test/redirect")
    assert.equal(result.status, 502)
    assert.deepEqual(JSON.parse(result.body), { error: "unreachable" })
    assert.equal(result.headers["set-cookie"], undefined)
    assert.equal(fs.readFileSync(f.file, "utf8"), saved)
  }
  assert.equal(other.state.requests.length, 0)
  assert.equal(f.remote.state.requests.filter(request => request.path === "/api/filesystem").length, 0)
})

test("raw and escaped URL injection cannot dispatch to a different authority or local-only route", async t => {
  const f = await fixture(t)
  await f.connect()
  const before = f.remote.state.requests.length
  for (const target of [
    `http://foreign.test${PREFIX}/api/filesystem`, `//foreign.test${PREFIX}/api/filesystem`,
    `${PREFIX}//foreign.test/api/filesystem`, `${PREFIX}/http://foreign.test/api/filesystem`,
    `${PREFIX}/api/../api/filesystem`, `${PREFIX}/api/%2e%2e/api/filesystem`, `${PREFIX}/api/.%2e/api/filesystem`,
    `${PREFIX}/api/%2E./api/filesystem`, `${PREFIX}/api/%2e/api/filesystem`,
    `${PREFIX}/api/remote-control/status`, `${PREFIX}/api/remote-%63ontrol/status`,
    `${PREFIX}/api/auth/%74oken`, `${PREFIX}/api/backends/other/api/filesystem`,
    `${PREFIX}/api/auth/password;x`, `${PREFIX}/api/%`, `${PREFIX}/api/filesystem#fragment`,
  ]) {
    const result = await send(f.origin, target)
    assert([400, 404].includes(result.status), `${target}: ${result.status} ${result.body}`)
    assert.equal(f.remote.state.requests.length, before, target)
  }
})

test("host guard refuses opaque/absent/foreign origins, LAN and ingress sockets with forged headers", async t => {
  const f = await fixture(t)
  for (const [method, target] of [["GET", "/api/filesystem"], ["POST", "/api/auth/login"], ["POST", "/api/auth/logout"]] as const) {
    for (const origin of [undefined, "", "null", "https://foreign.test", "file://", "http://127.0.0.1:1"]) {
      const response = await f.app.inject({ method, url: `${PREFIX}${target}`, headers: origin === undefined ? {} : { origin } })
      assert.equal(response.statusCode, 403, `${method} ${origin}`)
      assert.deepEqual(response.json(), { error: "auth" })
    }
    const lan = await f.app.inject({ method, url: `${PREFIX}${target}`, remoteAddress: "192.168.1.8", headers: { origin: f.origin } })
    assert.equal(lan.statusCode, 403)
  }
  const ingress = new RemoteIngress((request, response) => f.app.server.emit("request", request, response))
  const target = await ingress.start()
  t.after(() => ingress.stop())
  for (const method of ["GET", "POST"]) {
    const response = await send(`http://${target}`, `${PREFIX}/api/filesystem`, { method, headers: {
      origin: f.origin, "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1", "x-codenomad-remote-control": "0",
    } })
    assert.equal(response.status, 403)
    assert.deepEqual(JSON.parse(response.body), { error: "auth" })
  }
  assert.equal(f.remote.state.requests.length, 0)
  assert.equal(fs.existsSync(f.file), false)
})

test("originless same-origin EventSource/media provenance works but opaque metadata cannot claim it", async t => {
  const f = await fixture(t)
  await f.connect()
  const url = `${PREFIX}/api/filesystem`
  assert.equal((await f.app.inject({ url, headers: { "sec-fetch-site": "same-origin", referer: `${f.origin}/window` } })).statusCode, 200)
  for (const headers of [
    { "sec-fetch-site": "same-origin" }, { referer: `${f.origin}/window` },
    { "sec-fetch-site": "cross-site", referer: `${f.origin}/window` },
    { "sec-fetch-site": "same-origin", referer: "https://foreign.test/window" },
    { origin: "null", "sec-fetch-site": "same-origin", referer: `${f.origin}/window` },
  ]) assert.equal((await f.app.inject({ url, headers })).statusCode, 403)
})

test("backend relay performs a real device-authenticated mutation without browser provenance", { timeout: 20_000 }, async t => {
  const remote = await startRemoteSurface(t)
  const paired = await send(`http://${remote.target()}`, SERVER_PAIR_PATH, { method: "POST", headers: {
    host: FAKE_TUNNEL_HOST, "x-codenomad-server-pairing": "1", "content-type": "application/json",
    // Suppress the local test helper's Origin: this exchange is a backend request.
    origin: undefined,
  }, body: JSON.stringify({ code: remote.code, hostName: "backend-relay" }) })
  assert.equal(paired.status, 200, paired.body)
  const { credential } = JSON.parse(paired.body)
  const origin = `http://${remote.local}`
  const f = await fixture(t, origin)
  new CodeNomadServerCredentials(f.file).set("saved", origin, { kind: "device", cookie: `${DEVICE_COOKIE_NAME}=${credential}` })
  const deleted = await f.call("/api/workspaces/relay-test", { method: "DELETE", headers: {
    "sec-fetch-site": "same-origin", referer: `${f.origin}/`, cookie: "caller=must-not-leak",
  } })
  assert.equal(deleted.status, 204, deleted.body)
  const echo = await f.call("/api/auth/status")
  assert.equal(echo.status, 200)
  assert.equal(JSON.parse(echo.body).authenticated, true)
  assert.equal(echo.headers["set-cookie"], undefined)
  assert.equal((await f.call("/api/test/echo")).status, 404)
})
