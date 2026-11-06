import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { startRemoteSurface, FAKE_TUNNEL_HOST } from "./test-support/surface"
import { SERVER_PAIR_PATH } from "./server-pairing"
import { PAIRING_TTL_MS } from "./devices"

function send(target: string, code: string, options: { method?: string; headers?: Record<string, string>; path?: string; body?: string } = {}) {
  const [hostname, port] = target.split(":")
  const body = options.body ?? (options.method === "GET" || options.method === "HEAD" ? undefined : JSON.stringify({ code, hostName: "test-host" }))
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request({ hostname, port, agent: false, path: options.path ?? SERVER_PAIR_PATH, method: options.method ?? "POST",
      headers: { host: FAKE_TUNNEL_HOST, "content-length": String(Buffer.byteLength(body ?? "")), "content-type": "application/json", "x-codenomad-server-pairing": "1", ...options.headers } }, response => {
      let body = ""
      response.setEncoding("utf8").on("data", chunk => { body += chunk }).on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }))
    })
    request.on("error", error => reject(new Error(`${options.method ?? "POST"} ${target}${options.path ?? SERVER_PAIR_PATH}: ${error.message}`)))
    request.end(body)
  })
}

function privateResponse(response: Awaited<ReturnType<typeof send>>) {
  assert.equal(response.headers["set-cookie"], undefined)
  assert(!Object.keys(response.headers).some(name => name.startsWith("access-control-")))
}

test("dedicated exchange is ingress-only, consumes the shared code and creates a listed revocable device", async t => {
  const f = await startRemoteSurface(t)
  const direct = await send(f.local, f.code)
  assert.equal(direct.status, 404)
  privateResponse(direct)
  const wrongHost = await send(f.target(), f.code, { headers: { host: "foreign.test", "x-forwarded-host": FAKE_TUNNEL_HOST } })
  assert.equal(wrongHost.status, 421)
  privateResponse(wrongHost)
  const response = await send(f.target(), f.code, { headers: { "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https", "x-codenomad-remote-control": "0" } })
  assert.equal(response.status, 200, response.body)
  assert.equal(response.headers["cache-control"], "no-store")
  privateResponse(response)
  const { credential, device } = JSON.parse(response.body)
  assert.match(credential, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(device.name, "CodeNomad · test-host")
  assert.deepEqual(f.manager.devices(), [device])
  const cookie = `__Host-codenomad_device=${credential}`
  const auth = await send(f.target(), "", { method: "GET", path: "/api/test/echo", headers: { cookie } })
  assert.equal(auth.status, 200)
  assert.equal(JSON.parse(auth.body).loopbackPrivileges, false)
  assert.equal((await send(f.target(), f.code)).status, 401)
  assert.equal((await send(f.target(), f.code, { path: "/api/remote-control/pair", headers: { origin: `https://${FAKE_TUNNEL_HOST}` } })).status, 401)
  assert(f.manager.revokeDevice(device.id))
  assert.equal((await send(f.target(), "", { method: "GET", path: "/api/test/echo", headers: { cookie } })).status, 401)
  const next = new URL(f.manager.createPairing().url).hash.slice(1)
  assert.equal((await send(f.target(), next, { path: "/api/remote-control/pair", headers: { origin: `https://${FAKE_TUNNEL_HOST}` } })).status, 200)
  assert.equal((await send(f.target(), next)).status, 401, "browser consumption also forbids server replay")
})

test("browser/ambient auth headers and every non-POST fail before CORS without consuming the code", async t => {
  const f = await startRemoteSurface(t)
  for (const [name, value] of [
    ["origin", "null"], ["origin", `https://${FAKE_TUNNEL_HOST}`], ["origin", "https://foreign.test"], ["origin", ""],
    ["cookie", "guest=1"], ["cookie", "__Host-codenomad_device=guest"], ["authorization", "Bearer guest"], ["proxy-authorization", "Basic guest"],
    ["referer", `https://${FAKE_TUNNEL_HOST}/`], ["sec-fetch-site", "same-origin"], ["sec-fetch-mode", "cors"], ["sec-fetch-dest", "empty"],
    ["access-control-request-method", "POST"], ["access-control-request-headers", "x-codenomad-server-pairing"],
    ["x-codenomad-server-pairing", ""], ["content-type", "text/plain"],
  ]) {
    const response = await send(f.target(), f.code, { headers: { [name!]: value! } })
    assert.equal(response.status, 403, name)
    privateResponse(response)
  }
  for (const target of [f.target(), f.local]) {
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await send(target, f.code, { method, headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" } })
      assert.equal(response.status, target === f.local ? 404 : 403, method)
      privateResponse(response)
    }
  }
  assert.equal((await send(f.target(), f.code)).status, 200)
})

test("ten wrong codes cannot lock out a fresh valid code or permit its replay", async t => {
  const f = await startRemoteSurface(t)
  for (let i = 0; i < 10; i++) assert.equal((await send(f.target(), "x".repeat(32))).status, 401)
  const valid = new URL(f.manager.createPairing().url).hash.slice(1)
  assert.equal((await send(f.target(), valid)).status, 200)
  assert.equal(f.manager.devices().length, 1)
  assert.notEqual((await send(f.target(), valid)).status, 200)
  assert.equal((await send(f.target(), valid, { path: "/api/remote-control/pair", headers: { origin: `https://${FAKE_TUNNEL_HOST}` } })).status, 401)
  assert.equal(f.manager.devices().length, 1)
})

test("strict bodies, expiry and wrong codes are refused; only the server route has a bounded limiter", async t => {
  let now = Date.now()
  const f = await startRemoteSurface(t, { now: () => now })
  for (const body of [JSON.stringify({ code: f.code, hostName: "" }), JSON.stringify({ code: f.code, hostName: "x", extra: true }), JSON.stringify({ code: "short", hostName: "x" })]) {
    assert.equal((await send(f.target(), f.code, { body })).status, 400)
  }
  const oversized = await send(f.target(), f.code, { body: JSON.stringify({ code: f.code, hostName: "x".repeat(4096) }) })
  assert.equal(oversized.status, 413)
  privateResponse(oversized)
  assert.equal((await send(f.target(), "x".repeat(32))).status, 401)
  now += PAIRING_TTL_MS + 1
  assert.equal((await send(f.target(), f.code)).status, 401)
  for (let i = 0; i < 5; i++) assert.equal((await send(f.target(), "x".repeat(32))).status, 401)
  const next = new URL(f.manager.createPairing().url).hash.slice(1)
  assert.equal((await send(f.target(), next)).status, 200, "a valid code bypasses the failure quota")
  assert.equal(f.manager.devices().length, 1)
  const limited = await send(f.target(), next)
  assert.equal(limited.status, 429)
  assert.match(String(limited.headers["retry-after"]), /^[1-6]?[0-9]$/)
  privateResponse(limited)
  assert.equal((await send(f.target(), next, { path: "/api/remote-control/pair", headers: { origin: `https://${FAKE_TUNNEL_HOST}` } })).status, 401, "redemption consumes the shared browser code")
  const browserCode = new URL(f.manager.createPairing().url).hash.slice(1)
  assert.equal((await send(f.target(), browserCode, { path: "/api/remote-control/pair", headers: { origin: `https://${FAKE_TUNNEL_HOST}` } })).status, 200, "browser flow stays independent")
})
