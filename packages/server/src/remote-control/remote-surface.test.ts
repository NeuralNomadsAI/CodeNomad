import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"

const HOST = FAKE_TUNNEL_HOST
const ORIGIN = `https://${HOST}`

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

// Speaks plain HTTP to the ingress, as the in-process TLS terminator does.
function send(target: string, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const [hostname, port] = target.split(":")
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname, port: Number(port), path: pathname, method: options.method ?? "GET",
      headers: { host: HOST, ...options.headers },
    }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
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
  const { target } = await startRemoteSurface(t)
  assert.equal((await send(target(), "/api/test/echo")).status, 401)
  const page = await send(target(), "/", { headers: { accept: "text/html" } })
  assert.equal(page.status, 302)
  assert.equal(page.headers.location, "/remote-pair")
  const pairPage = await send(target(), "/remote-pair")
  assert.equal(pairPage.status, 200)
  assert.equal(pairPage.headers["cache-control"], "no-store")
  // Password login is a host-only surface, so it cannot be guessed remotely.
  const login = await send(target(), "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username: "codenomad", password: "local-password" }),
  })
  assert.equal(login.status, 404)
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
  ] as const) {
    const response = await send(target(), pathname, { method, headers: mutation, body: method === "GET" ? undefined : "{}" }).catch((error: Error) => {
      throw new Error(`${method} ${pathname}: ${error.message}`)
    })
    assert.equal(response.status, 404, `${method} ${pathname}`)
  }
})

test("requests must target the tunnel hostname and cannot upgrade", async (t) => {
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
