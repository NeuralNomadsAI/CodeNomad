import assert from "node:assert/strict"
import crypto from "node:crypto"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { brotliCompressSync, gzipSync } from "node:zlib"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"
import { backendAdmissionFixture, backendAuthorityHeader, backendBootstrap, assertServerCapabilities, assertPrivateBackendReply } from "./test-support/backend-admission"

const HOST = FAKE_TUNNEL_HOST
const ORIGIN = `https://${HOST}`

for (const reason of ["flag-off", "server-request", "foreign-origin", "missing-origin"] as const) {
  test(`server-profile persistence admission: ingress ${reason} cannot patch or delete saved profiles`, async t => {
    const f = await backendAdmissionFixture(t, reason !== "flag-off")
    const { target, code } = await startRemoteSurface(t, { settings: f.settings })
    const cookie = await pair(target(), code)
    const headers: Record<string, string> = { cookie, "content-type": "application/json" }
    if (reason !== "missing-origin" && reason !== "server-request") headers.origin = reason === "foreign-origin" ? "https://foreign.test" : ORIGIN
    if (reason === "server-request") headers["x-codenomad-server-request"] = "1"
    const stateFile = path.join(f.directory, "state.yaml")
    const before = fs.readFileSync(stateFile, "utf8")
    const snapshot = structuredClone(f.settings.getDoc("state"))
    for (const [url, payload] of [
      ["/api/storage/state/ui", { remoteServers: [] }],
      ["/api/storage/state/ui", { remoteServers: null }],
      ["/api/storage/state", { ui: { remoteServers: [] } }],
      ["/api/storage/state", { ui: { remoteServers: null } }],
      ["/api/storage/state", { ui: null }],
    ] as const) {
      const result = await send(target(), url, { method: "PATCH", headers, body: JSON.stringify(payload) })
      assert.equal(fs.readFileSync(stateFile, "utf8"), before, `${reason} ${url}: persisted a refused profile change`)
      assert.deepEqual(f.settings.getDoc("state"), snapshot, `${reason} ${url}: changed cached state`)
      assert.ok([401, 403, 404].includes(result.status), `${reason} ${url}: ${result.status} ${result.body}`)
    }
    assert.equal(f.io(), 0)
  })
}

test("server-profile persistence admission: enabled paired ingress may manage saved profiles", async t => {
  const f = await backendAdmissionFixture(t)
  const { target, code } = await startRemoteSurface(t, { settings: f.settings })
  const cookie = await pair(target(), code)
  const headers = { cookie, origin: ORIGIN, "content-type": "application/json" }
  const remoteServers = [{ id: "managed", baseUrl: f.remotes[0]!.origin, skipTlsVerify: true, ssh: { host: "fixture-host" } }]
  for (const [url, payload] of [
    ["/api/storage/state/ui", { remoteServers }],
    ["/api/storage/state", { ui: { remoteServers } }],
  ] as const) {
    const result = await send(target(), url, { method: "PATCH", headers, body: JSON.stringify(payload) })
    assert.equal(result.status, 200, result.body)
    assert.deepEqual(f.settings.getOwner("state", "ui").remoteServers, remoteServers)
  }
  const deleted = await send(target(), "/api/storage/state", { method: "PATCH", headers, body: JSON.stringify({ ui: null }) })
  assert.equal(deleted.status, 200, deleted.body)
  assert.equal(f.settings.getOwner("state", "ui").remoteServers, undefined)
  assert.equal(f.io(), 0)
})

test("multi-backend admission: paired ingress browses, connects and relays colliding A/B IDs", async t => {
  const f = await backendAdmissionFixture(t)
  const { target, code } = await startRemoteSurface(t, { settings: f.settings })
  const cookie = await pair(target(), code)
  const headers = { cookie, origin: ORIGIN, "content-type": "application/json" }
  t.mock.method(os, "homedir", () => f.directory)
  const ssh = await send(target(), "/api/remote-servers/ssh-hosts", { headers: { cookie } })
  assert.equal(ssh.status, 200, ssh.body)
  assert.deepEqual(JSON.parse(ssh.body), { hosts: ["fixture-host"] })
  const probe = await send(target(), "/api/remote-servers/probe", { method: "POST", headers,
    body: JSON.stringify({ baseUrl: f.remotes[0]!.origin }) })
  assert.equal(probe.status, 200, probe.body)
  assert.equal(JSON.parse(probe.body).ok, true)
  for (const id of ["A", "B"]) {
    for (const action of ["connect", "browse"]) {
      const response = await send(target(), `/api/remote-servers/${id}/${action}`, { method: "POST", headers, body: "{}" })
      assert.equal(response.status, 200, `${id}/${action}: ${response.body}`)
      assertPrivateBackendReply(response.body, response.headers)
    }
    const bootstrap = await send(target(), `/api/backends/${id}/api/meta`, {
      headers: { cookie, [backendAuthorityHeader]: backendBootstrap },
    })
    assert.equal(bootstrap.status, 200, bootstrap.body)
    const proof = String(bootstrap.headers[backendAuthorityHeader])
    assert.match(proof, /^[A-Za-z0-9_-]{43}$/)
    for (const route of ["/api/workspaces", "/workspaces/same-workspace/instance/api/session/same-session"]) {
      const response = await send(target(), `/api/backends/${id}${route}`, { headers: { cookie, [backendAuthorityHeader]: proof } })
      assert.equal(response.status, 200, response.body)
      const body = JSON.parse(response.body)
      assert.equal((Array.isArray(body) ? body[0] : body).server, id)
      assertPrivateBackendReply(response.body, response.headers)
    }
    assert.equal((await send(target(), `/api/remote-servers/${id}/forget`, { method: "POST", headers, body: "{}" })).status, 200)
  }
  const meta = await send(target(), "/api/meta", { headers: { cookie } })
  assertServerCapabilities(JSON.parse(meta.body), true, true)
  for (const remote of f.remotes) for (const request of remote.state.requests) {
    assert.equal(request.headers.cookie?.includes(cookie), undefined)
    assert.equal(request.headers[backendAuthorityHeader], undefined)
  }
})

test("multi-backend admission: ingress rejects hostile provenance and explicit server protocol before IO", async t => {
  const f = await backendAdmissionFixture(t)
  const { target, code, manager } = await startRemoteSurface(t, { settings: f.settings })
  const cookie = await pair(target(), code)
  const before = f.io()
  const hostileHeaders: Record<string, string>[] = [
    { origin: "https://foreign.test" }, { origin: "null" }, { referer: "https://foreign.test/page" },
    { "x-codenomad-server-request": "1" },
    { origin: "https://foreign.test", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": HOST, "x-forwarded-proto": "https" },
  ]
  for (const extra of hostileHeaders) {
    const response = await send(target(), "/api/backends/A/api/meta", { headers: { cookie, ...extra } })
    assert.ok([403, 404].includes(response.status), `${JSON.stringify(extra)}: ${response.status}`)
  }
  for (const pathname of ["/api/backends/A/api/backends/B/api/meta", "/api/backends/A/api/remote-%73ervers/probe",
    "/api/backends/A/api/auth/password", "/api/backends/A/preview-capabilities"]) {
    assert.equal((await send(target(), pathname, { headers: { cookie } })).status, 404, pathname)
  }
  assert.equal(f.io(), before)
  manager.revokeDevice(manager.devices()[0]!.id)
  for (const credential of [undefined, cookie]) {
    const response = await send(target(), "/api/backends/A/api/meta", { headers: credential ? { cookie: credential } : {} })
    assert.ok([401, 404].includes(response.status), String(response.status))
  }
  assert.equal(f.io(), before)
})

test("multi-backend admission: ingress feature-off refuses before remote IO", async t => {
  const f = await backendAdmissionFixture(t, false)
  const { target, code } = await startRemoteSurface(t, { settings: f.settings })
  const cookie = await pair(target(), code)
  const response = await send(target(), "/api/backends/A/api/meta", { headers: { cookie } })
  assert.ok([403, 404].includes(response.status))
  assert.equal(f.io(), 0)
  assertServerCapabilities(JSON.parse((await send(target(), "/api/meta", { headers: { cookie } })).body), false, false)
})

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
  bytes: Buffer
}

// Speaks plain HTTP to the ingress, as the in-process TLS terminator does.
function send(target: string, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const [hostname, port] = target.split(":")
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname, port: Number(port), path: pathname, method: options.method ?? "GET",
      headers: { host: HOST, ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => {
        const bytes = Buffer.concat(chunks)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: bytes.toString(), bytes })
      })
    })
    request.on("error", reject)
    request.end(options.body)
  })
}

async function pair(target: string, code: string): Promise<string> {
  const response = await send(target, "/api/remote-control/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ code }),
  })
  assert.equal(response.status, 200, response.body)
  const cookie = String(response.headers["set-cookie"])
  return cookie.split(";")[0]!
}

test("an unpaired remote browser reaches only the pairing surface", async (t) => {
  const { target, code } = await startRemoteSurface(t)
  assert.equal((await send(target(), "/api/test/echo")).status, 401)
  const headers = { accept: "text/html", referer: "https://outside.invalid/link" }
  for (const method of ["GET", "HEAD"]) {
    const page = await send(target(), "/", { method, headers })
    assert.equal(page.status, 302)
    assert.equal(page.headers.location, "/remote-pair")
    const pairPage = await send(target(), "/remote-pair", { method, headers })
    assert.equal(pairPage.status, 200)
    assert.equal(pairPage.headers["cache-control"], "no-store")
  }
  // Password login is a host-only surface, so it cannot be guessed remotely.
  const login = await send(target(), "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username: "codenomad", password: "local-password" }),
  })
  assert.equal(login.status, 404)
  // Recovery is told to pair again rather than to offer password login.
  assert.deepEqual(JSON.parse((await send(target(), "/api/auth/status")).body), { authenticated: false, pairingRequired: true })
  const cookie = await pair(target(), code)
  for (const method of ["GET", "HEAD"]) {
    const headers = { cookie, accept: "text/html", referer: "https://outside.invalid/previews/external" }
    assert.equal((await send(target(), "/remote-pair", { method, headers })).status, 200)
    const httpReferer = { ...headers, referer: `http://${HOST}/previews/external` }
    assert.equal((await send(target(), "/remote-pair", { method, headers: httpReferer })).headers["referrer-policy"], "no-referrer")
    assert.equal((await send(target(), "/?source=external", { method, headers })).status, 200)
    assert.equal((await send(target(), "/;source=external", { method, headers })).status, 200)
  }
})

test("the static UI bundle stays public while HTML entry points require pairing", async (t) => {
  const { target } = await startRemoteSurface(t)
  // Browsers fetch the PWA manifest without cookies.
  const manifest = await send(target(), "/manifest.webmanifest")
  assert.equal(manifest.status, 200)
  assert.equal(JSON.parse(manifest.body).name, "CodeNomad")
  assert.equal((await send(target(), "/index.html")).status, 401)
  assert.equal((await send(target(), "/api/test/echo.json")).status, 401)
  assert.equal((await send(target(), "/sidecars/example/app.js")).status, 404)
})

test("negotiates precompressed static assets without loosening HTML entry admission", async t => {
  const { target, code, registryPath } = await startRemoteSurface(t)
  const ui = path.join(path.dirname(registryPath), "ui")
  const wasm = Buffer.from("static byte fixture ".repeat(200))
  const br = brotliCompressSync(wasm)
  const gzip = gzipSync(wasm)
  fs.writeFileSync(path.join(ui, "app.wasm"), wasm)
  fs.writeFileSync(path.join(ui, "app.wasm.br"), br)
  fs.writeFileSync(path.join(ui, "app.wasm.gz"), gzip)
  fs.writeFileSync(path.join(ui, "only-gzip.wasm"), wasm)
  fs.writeFileSync(path.join(ui, "only-gzip.wasm.gz"), gzip)
  fs.writeFileSync(path.join(ui, "archive#1.gz"), gzip)
  fs.writeFileSync(path.join(ui, "archive%.gz"), gzip)
  const index = fs.readFileSync(path.join(ui, "index.html"))
  fs.writeFileSync(path.join(ui, "index.html.br"), brotliCompressSync(index))
  fs.mkdirSync(path.join(ui, "nested.assets"))
  fs.writeFileSync(path.join(ui, "nested.assets", "index.html"), index)
  fs.writeFileSync(path.join(ui, "nested.assets", "index.html.br"), brotliCompressSync(index))

  const variants = [
    ["/app.wasm", "br, gzip", "br", br],
    ["/app.wasm", "gzip, br", "br", br],
    ["/app.wasm", "gzip, *", "br", br],
    ["/app.wasm", "br;q=0, gzip", "gzip", gzip],
    ["/app.wasm", "br;q=0.2, gzip;q=0.8", "gzip", gzip],
    ["/app.wasm", "gzip;q=0, *;q=1, identity;q=0", "br", br],
    ["/app.wasm", "identity", undefined, wasm],
    ["/app.wasm", "identity;q=1, br;q=0.1", undefined, wasm],
    ["/only-gzip.wasm", "br, gzip", "gzip", gzip],
  ] as const
  for (const [route, accept, encoding, bytes] of variants) {
    const headers = { "accept-encoding": accept }
    const response = await send(target(), route, { headers })
    assert.equal(response.status, 200)
    assert.equal(response.headers["content-encoding"], encoding)
    assert.equal(response.headers["content-type"], "application/wasm")
    assert.match(String(response.headers.vary), /(?:^|,\s*)accept-encoding(?:,|$)/i)
    assert.deepEqual(response.bytes, bytes)
    const head = await send(target(), route, { method: "HEAD", headers })
    assert.equal(head.headers["content-encoding"], encoding)
    assert.equal(Number(head.headers["content-length"]), bytes.length)
    assert.equal(head.bytes.length, 0)
  }
  const headers = { "accept-encoding": "br" }
  for (const extra of [{}, { range: "bytes=9999-" }, { "if-match": '"unrelated"' }] as Record<string, string>[]) {
    const rejected = await send(target(), "/only-gzip.wasm", { headers: { "accept-encoding": "br, identity;q=0", ...extra } })
    assert.equal(rejected.status, 406)
    assert.equal(rejected.bytes.length, 0)
    assert.match(String(rejected.headers.vary), /(?:^|,\s*)accept-encoding(?:,|$)/i)
  }
  assert.equal((await send(target(), "/archive%231.gz", { headers: { "accept-encoding": "br, identity;q=0" } })).status, 406)
  assert.equal((await send(target(), "/archive%25.gz", { headers: { "accept-encoding": "br, identity;q=0" } })).status, 406)
  for (const url of ["/index.html", "/index.html.br"]) {
    assert.equal((await send(target(), url, { headers })).status, 401)
  }
  assert.equal((await send(target(), "/absent.wasm", { headers })).status, 404)
  const hidden = await send(target(), "/nested.assets", { headers })
  assert.equal(hidden.status, 404)
  assert.equal(hidden.headers["cache-control"], "no-store")
  const cookie = await pair(target(), code)
  const rangedHead = await send(target(), "/", { method: "HEAD", headers: { cookie, "accept-encoding": "br", range: "bytes=0-0" } })
  assert.equal(rangedHead.status, 200)
  assert.equal(Number(rangedHead.headers["content-length"]), brotliCompressSync(index).length)
  const rangedFallback = await send(target(), "/settings", {
    method: "POST", headers: {
      cookie, origin: ORIGIN, "accept-encoding": "br", range: "bytes=0-0",
      "if-modified-since": String(rangedHead.headers["last-modified"]),
    },
  })
  assert.equal(rangedFallback.status, 200)
  assert.deepEqual(rangedFallback.bytes, index)
  const rejectedHead = await send(target(), "/", { method: "HEAD", headers: { cookie, "accept-encoding": "identity;q=0" } })
  assert.equal(rejectedHead.status, 406)
  assert.equal(Number(rejectedHead.headers["content-length"] ?? 0), 0)
  assert.equal(rejectedHead.headers["content-type"], undefined)
  for (const route of ["/", "/settings"]) {
    const page = await send(target(), route, { headers: { "accept-encoding": "br, identity;q=0", cookie, accept: "text/html" } })
    assert.equal(page.status, 200)
    assert.equal(page.headers["content-encoding"], "br")
    assert.equal(page.headers["cache-control"], "no-store")
    assert.match(String(page.headers["content-type"]), /^text\/html\b/)
    assert.deepEqual(page.bytes, brotliCompressSync(index))
  }
})

test("pairing requires the public origin and issues a host-only secure cookie once", async (t) => {
  const { target, code } = await startRemoteSurface(t)
  const crossSite = await send(target(), "/api/remote-control/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://other.tunnel.test" },
    body: JSON.stringify({ code }),
  })
  assert.equal(crossSite.status, 403)

  const response = await send(target(), "/api/remote-control/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "user-agent": "Mozilla/5.0 (iPhone) Safari/604.1" },
    body: JSON.stringify({ code }),
  })
  assert.equal(response.status, 200)
  const cookie = String(response.headers["set-cookie"])
  assert.match(cookie, /^__Host-codenomad_device=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax;/)
  assert.equal(JSON.parse(response.body).device.name, "iPhone · Safari")

  const replay = await send(target(), "/api/remote-control/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ code }),
  })
  assert.equal(replay.status, 401)
})

test("server-to-server pairing uses its one-use code without Origin, while browser pairing requires its origin", async t => {
  const { target, code } = await startRemoteSurface(t)
  const browserHeaders: Record<string, string>[] = [{ origin: "https://other.tunnel.test" }, { "sec-fetch-site": "cross-site" }, { referer: "https://other.tunnel.test/" }]
  for (const headers of browserHeaders) {
    const denied = await send(target(), "/api/remote-control/pair", { method: "POST",
      headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ code }) })
    assert.equal(denied.status, 403)
  }
  const native = await send(target(), "/api/remote-control/pair", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })
  assert.equal(native.status, 200)
  assert.ok(native.headers["set-cookie"])
  const replay = await send(target(), "/api/remote-control/pair", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })
  assert.equal(replay.status, 401)
  const cookie = String(native.headers["set-cookie"]).split(";")[0]!
  const mutation = await send(target(), "/api/test/echo", { method: "POST", headers: { cookie } })
  assert.equal(mutation.status, 403)
})

test("a paired device uses the app without loopback privileges or spoofed metadata", async (t) => {
  const { target, code } = await startRemoteSurface(t)
  const cookie = await pair(target(), code)

  const ui = await send(target(), "/", { headers: { cookie, accept: "text/html" } })
  assert.equal(ui.status, 200)
  assert.match(ui.body, /CodeNomad UI/)

  const echo = await send(target(), "/api/test/echo", {
    headers: { cookie, "x-forwarded-for": "203.0.113.9", "x-codenomad-remote-control": "0" },
  })
  assert.equal(echo.status, 200)
  assert.deepEqual(JSON.parse(echo.body), { loopbackPrivileges: false, forwardedFor: null, remoteControlHeader: null })
  assert.equal(JSON.parse((await send(target(), "/api/auth/status", { headers: { cookie } })).body).authenticated, true)
  // Web previews are allowed by default.
  assert.equal(JSON.parse((await send(target(), "/api/meta", { headers: { cookie } })).body).previewsUnavailable, undefined)

  const status = JSON.parse((await send(target(), "/api/remote-control/status", { headers: { cookie } })).body)
  assert.equal(status.manageable, false)
})

test("host-only interfaces stay closed to paired devices, including encoded paths", async (t) => {
  const { target, code } = await startRemoteSurface(t)
  const cookie = await pair(target(), code)
  const mutation = { cookie, origin: ORIGIN, "content-type": "application/json" }
  for (const [method, pathname] of [
    ["POST", "/api/remote-control/pairings"],
    ["POST", "/api/remote-%63ontrol/pairings"],
    ["DELETE", "/api/remote-control"],
    ["GET", "/api/remote-control/devices"],
    ["POST", "/api/auth/token"],
    ["GET", "/auth/token"],
    ["POST", "/api/opencode-plugin/automation"],
    ["POST", "/api/remote-proxy/sessions"],
    ["GET", "/sidecars/example/"],
    // The router treats ";" as a path-parameter delimiter.
    ["POST", "/api/auth/password;x"],
    ["DELETE", "/api/remote-control;x"],
    ["POST", "/api/remote-servers/probe;x"],
    ["GET", "/login;x"],
  ] as const) {
    const response = await send(target(), pathname, { method, headers: mutation, body: method === "GET" ? undefined : "{}" }).catch((error: Error) => {
      throw new Error(`${method} ${pathname}: ${error.message}`)
    })
    assert.equal(response.status, 404, `${method} ${pathname}`)
  }
})

test("paired devices retain SideCar registration API access without content or local privileges", async t => {
  const { target, code } = await startRemoteSurface(t)
  assert.equal((await send(target(), "/api/sidecars")).status, 401)
  const cookie = await pair(target(), code)
  const headers = { cookie, origin: ORIGIN, "content-type": "application/json" }
  assert.equal((await send(target(), "/api/sidecars", { headers })).status, 200)
  const created = await send(target(), "/api/sidecars", { method: "POST", headers,
    body: JSON.stringify({ name: "Fixture", port: 3000 }) })
  assert.equal(created.status, 201, created.body)
  assert.equal((await send(target(), "/sidecars/fixture/", { headers })).status, 404)
  const meta = JSON.parse((await send(target(), "/api/meta", { headers })).body)
  assert.equal(meta.localRequest, false)
})

// Writes a raw request line, which the HTTP client would otherwise normalize.
function sendRaw(target: string, requestTarget: string, method: string, cookie: string): Promise<number> {
  const [hostname, port] = target.split(":")
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => socket.end(
      `${method} ${requestTarget} HTTP/1.1\r\nHost: ${HOST}\r\nCookie: ${cookie}\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    ))
    let data = ""
    socket.on("data", (chunk) => { data += chunk })
    socket.on("close", () => resolve(Number(data.split(" ")[1])))
    socket.on("error", reject)
  })
}

test("request targets the router would reinterpret cannot reach host-only routes", async (t) => {
  const { target, code } = await startRemoteSurface(t)
  const cookie = await pair(target(), code)
  for (const [method, requestTarget, expected] of [
    ["POST", "/api/auth/password;x", 404],
    ["POST", `http://${HOST}/api/auth/password`, 400],
    ["POST", `http://${HOST}/api/remote-proxy/sessions`, 400],
    ["POST", "/api/auth/password#x", 400],
    ["POST", "//api/auth/password", 400],
  ] as const) {
    assert.equal(await sendRaw(target(), requestTarget, method, cookie), expected, `${method} ${requestTarget}`)
  }
})

test("requests must target the tunnel hostname and cannot upgrade outside web previews", async (t) => {
  const { target, code } = await startRemoteSurface(t)
  const cookie = await pair(target(), code)
  assert.equal((await send(target(), "/api/test/echo", { headers: { cookie, host: "localhost" } })).status, 421)

  const [hostname, port] = target().split(":")
  const upgrade = await new Promise<number>((resolve, reject) => {
    const request = http.request({ hostname, port: Number(port), path: "/api/events", headers: { host: HOST, cookie, connection: "upgrade", upgrade: "websocket" } })
    request.on("response", (response) => resolve(response.statusCode ?? 0))
    request.on("upgrade", () => reject(new Error("upgrade accepted")))
    request.on("error", reject)
    request.end()
  })
  assert.equal(upgrade, 404)
})

// A previewed dev server: records requests and completes WebSocket upgrades.
async function startPreviewUpstream(t: TestContext) {
  const requests: Array<[string | undefined, string | undefined, string | undefined]> = []
  const sockets = new Set<net.Socket>()
  const server = http.createServer((request, response) => {
    requests.push([request.method, request.url, request.headers.cookie])
    request.resume()
    response.writeHead(200, { "content-type": "application/json" }).end("{\"ok\":true}")
  })
  server.on("upgrade", (request, socket: net.Socket) => {
    sockets.add(socket)
    const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, requests }
}

function upgrade(target: string, pathname: string): Promise<{ status: number; socket?: net.Socket }> {
  const [hostname, port] = target.split(":")
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port: Number(port), path: pathname, headers: {
      host: HOST, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
    } })
    request.on("response", (response) => { response.resume(); resolve({ status: response.statusCode ?? 0 }) })
    request.on("upgrade", (response, socket) => resolve({ status: response.statusCode ?? 0, socket }))
    request.on("error", reject)
    request.end()
  })
}

test("web previews reach Remote Control through their capability while the host allows them", async (t) => {
  const { manager, previewManager, target, code } = await startRemoteSurface(t)
  const cookie = await pair(target(), code)
  const upstream = await startPreviewUpstream(t)
  const { token } = previewManager.create("session", upstream.url)

  // A sandboxed preview document sends neither the device cookie nor a usable Origin.
  const page = await send(target(), `/previews/${token}/page`)
  assert.equal(page.status, 200, page.body)
  assert.equal(page.headers["content-security-policy"], "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads")
  assert.equal(page.headers["referrer-policy"], "same-origin")
  const form = await send(target(), `/previews/${token}/form`, {
    method: "POST", headers: { origin: "null", "content-type": "application/x-www-form-urlencoded" }, body: "a=1",
  })
  assert.equal(form.status, 200, form.body)
  assert.equal((await send(target(), `/previews/${crypto.randomUUID()}/page`)).status, 404)
  // A paired device's root-relative asset resolves through the preview named by its Referer.
  const asset = () => send(target(), "/assets/probe.json", { headers: { cookie, referer: `${ORIGIN}/previews/${token}/page` } })
  assert.equal((await asset()).body, "{\"ok\":true}")
  assert.equal((await send(target(), "/remote-pair", { headers: { cookie, referer: `/previews/${token}/page` } })).body, "{\"ok\":true}")
  assert.equal((await send(target(), "/;version=1", { headers: { cookie, referer: `${ORIGIN}/previews/${token}/page` } })).body, "{\"ok\":true}")

  const live = await upgrade(target(), `/previews/${token}/ws`)
  assert.equal(live.status, 101)
  for (const pathname of [`/previews/${token}/../../api/test/stream`, "/api/test/stream", `/previews/${crypto.randomUUID()}/ws`]) {
    assert.equal((await upgrade(target(), pathname)).status, 404, pathname)
  }
  assert.equal(JSON.parse((await send(target(), "/api/meta", { headers: { cookie } })).body).previewsUnavailable, undefined)
  // Only the host changes the choice.
  const remoteChange = await send(target(), "/api/remote-control/previews", {
    method: "PUT", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
  })
  assert.equal(remoteChange.status, 404)

  const closed = new Promise<void>((resolve) => live.socket!.once("close", () => resolve()))
  assert.equal(manager.setPreviewsAllowed(false).previews, false)
  await closed
  assert.equal((await send(target(), `/previews/${token}/page`)).status, 404)
  assert.equal((await upgrade(target(), `/previews/${token}/ws`)).status, 404)
  assert.notEqual((await asset()).body, "{\"ok\":true}")
  assert.equal(JSON.parse((await send(target(), "/api/meta", { headers: { cookie } })).body).previewsUnavailable, true)
  assert.deepEqual(upstream.requests, [["GET", "/page", undefined], ["POST", "/form", undefined], ["GET", "/assets/probe.json", undefined], ["GET", "/remote-pair", undefined], ["GET", "/;version=1", undefined]])
})

test("a shared HTTP listener preserves same-origin previews and admits external HTTPS entry links", async t => {
  const host = "direct.fixture.test"
  const origin = `https://${host}`
  const { app, authManager, manager, previewManager } = await startRemoteSurface(t, { allowedOrigins: [origin], configureApp(app) {
    app.addHook("onRequest", (request, _reply, done) => {
      const socket = request.raw.socket
      socket.destroy ??= () => { socket.emit("close"); return socket }
      done()
    })
  } })
  const upstream = await startPreviewUpstream(t)
  const { token } = previewManager.create("session", upstream.url)
  const referer = `http://${host}/previews/${token}/page`
  const session = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  const direct = manager.exchangeDirectPairing(new URL(manager.createDirectPairing(origin).url).hash.slice(1), origin, undefined)
  assert.ok(direct)
  for (const url of ["/remote-pair", "/;version=1"]) {
    const http = await app.inject({ url, headers: { host, referer, cookie: session, "sec-fetch-site": "same-origin" } })
    assert.deepEqual(http.json(), { ok: true })
    const entryResponse: { statusCode: number; headers: Record<string, unknown> } = await app.inject({
      url, headers: { host, referer, cookie: `__Host-codenomad_device=${direct.token}`,
      accept: "text/html", "sec-fetch-site": "cross-site" } })
    assert.equal(entryResponse.statusCode, 200)
    assert.match(String(entryResponse.headers["content-type"]), /^text\/html/)
  }
})

test("web previews served through Remote Control stay on the preview origin", async (t) => {
  const { previewManager, target, code } = await startRemoteSurface(t)
  const cookie = await pair(target(), code)
  const upstream = await startPreviewUpstream(t)
  const other = await startPreviewUpstream(t)
  const { token } = previewManager.create("session", upstream.url)
  const host = other.url.slice("http://".length)
  for (const pathname of [`/previews/${token}/%5C%5C${host}/x`, `/previews/${token}/%5C/${host}/x`, `/previews/${token}/\\\\${host}/x`]) {
    await send(target(), pathname)
  }
  await send(target(), `/\\\\${host}/x`, { headers: { cookie, referer: `${ORIGIN}/previews/${token}/page` } })
  assert.deepEqual(other.requests, [])
  assert.equal((await send(target(), `/previews/${token}/@vite/client?t=1`)).status, 200)
  assert.deepEqual(upstream.requests.at(-1), ["GET", "/@vite/client?t=1", undefined])
})

test("revoking a device ends its live streams and later requests", async (t) => {
  const { manager, target, code } = await startRemoteSurface(t)
  const cookie = await pair(target(), code)
  const [hostname, port] = target().split(":")
  const ended = new Promise<void>((resolve, reject) => {
    const request = http.get({ hostname, port: Number(port), path: "/api/test/stream", headers: { host: HOST, cookie } }, (response) => {
      assert.equal(response.statusCode, 200)
      response.once("data", () => manager.revokeDevice(manager.devices()[0]!.id))
      response.on("close", () => resolve())
      response.on("error", () => resolve())
      response.resume()
    })
    request.on("error", () => resolve())
    setTimeout(() => reject(new Error("stream outlived revocation")), 5_000).unref()
  })
  await ended
  assert.equal((await send(target(), "/api/test/echo", { headers: { cookie } })).status, 401)
})

test("a device replaced at the pairing limit loses its live streams", async (t) => {
  const { manager, target, code } = await startRemoteSurface(t)
  const cookie = await pair(target(), code)
  const [hostname, port] = target().split(":")
  const ended = new Promise<void>((resolve, reject) => {
    const request = http.get({ hostname, port: Number(port), path: "/api/test/stream", headers: { host: HOST, cookie } }, (response) => {
      assert.equal(response.statusCode, 200)
      response.once("data", () => {
        // Later pairings must outrank the streaming device's last use.
        setTimeout(() => {
          for (let index = 0; index < 32; index += 1) {
            const next = new URL(manager.createPairing().url).hash.slice(1)
            assert.ok(manager.exchangePairing(next, "Mozilla/5.0 (Android) Chrome/140.0"))
          }
        }, 5)
      })
      response.on("close", () => resolve())
      response.on("error", () => resolve())
      response.resume()
    })
    request.on("error", () => resolve())
    setTimeout(() => reject(new Error("evicted stream stayed open")), 5_000).unref()
  })
  await ended
  assert.equal(manager.devices().length, 32)
  assert.equal((await send(target(), "/api/test/echo", { headers: { cookie } })).status, 401)
})

test("remote access requires a paired device even when local authentication is skipped", async (t) => {
  const { target, local } = await startRemoteSurface(t, { skipAuth: true })
  assert.equal((await send(target(), "/api/test/echo")).status, 401)
  const [hostname, port] = local.split(":")
  const localEcho = await new Promise<number>((resolve, reject) => {
    http.get({ hostname, port: Number(port), path: "/api/test/echo" }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    }).on("error", reject)
  })
  assert.equal(localEcho, 200)
})

test("a tunnel that stops fatally turns Remote Control off and closes the surface", async (t) => {
  const { manager, target, code, stopTunnel } = await startRemoteSurface(t)
  const cookie = await pair(target(), code)
  const address = target()
  stopTunnel("Bridge attach failed: bad_token")
  await new Promise((resolve) => setTimeout(resolve, 50))
  const status = manager.status()
  assert.equal(status.enabled, false)
  assert.equal(status.state, "error")
  assert.equal(status.error, "Bridge attach failed: bad_token")
  await assert.rejects(send(address, "/api/test/echo", { headers: { cookie } }))
})

test("stopping Remote Control closes the remote surface", async (t) => {
  const { manager, target, code } = await startRemoteSurface(t)
  const cookie = await pair(target(), code)
  const address = target()
  await manager.stop()
  await assert.rejects(send(address, "/api/test/echo", { headers: { cookie } }))
  assert.equal(manager.status().state, "stopped")
})
