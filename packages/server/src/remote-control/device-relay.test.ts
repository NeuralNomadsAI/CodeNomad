import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { DEVICE_COOKIE_NAME } from "./gate"
import { SERVER_PAIR_PATH } from "./server-pairing"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"

const ORIGIN = `https://${FAKE_TUNNEL_HOST}`
const MUTATION = "/api/workspaces/relay-test"

function send(target: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const [hostname, port] = target.split(":")
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request({ hostname, port, agent: false, path, method: options.method ?? "GET",
      headers: { host: target, ...(options.headers?.cookie ? { "x-codenomad-server-request": "1" } : {}), ...options.headers } }, response => {
      let body = ""
      response.setEncoding("utf8").on("data", chunk => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode!, body, headers: response.headers }))
    })
    request.on("error", reject)
    request.end(options.body)
  })
}

async function pair(f: Awaited<ReturnType<typeof startRemoteSurface>>) {
  const response = await send(f.target(), SERVER_PAIR_PATH, {
    method: "POST",
    headers: { host: FAKE_TUNNEL_HOST, "x-codenomad-server-pairing": "1", "content-type": "application/json" },
    body: JSON.stringify({ code: f.code, hostName: "relay-host" }),
  })
  assert.equal(response.status, 200, response.body)
  const { credential, device } = JSON.parse(response.body)
  return { cookie: `${DEVICE_COOKIE_NAME}=${credential}`, id: device.id as string }
}

test("P2 credentials admit non-browser mutations on ingress and direct, always in device scope", async t => {
  const f = await startRemoteSurface(t)
  const { cookie } = await pair(f)
  assert.equal((await send(f.target(), MUTATION, { method: "DELETE", headers: { host: FAKE_TUNNEL_HOST, cookie, "x-codenomad-server-request": "" } })).status, 403)
  for (const target of [f.target(), f.local]) {
    const headers = { host: target === f.local ? f.local : FAKE_TUNNEL_HOST, cookie }
    assert.equal((await send(target, MUTATION, { method: "DELETE", headers })).status, 204)
    const echo = await send(target, "/api/test/echo", { headers: { ...headers, "x-forwarded-for": "127.0.0.1", "x-codenomad-remote-control": "0" } })
    assert.equal(echo.status, 200)
    assert.deepEqual(JSON.parse(echo.body), { loopbackPrivileges: false, forwardedFor: null, remoteControlHeader: null })
    const status = await send(target, "/api/auth/status", { headers })
    assert.equal(JSON.parse(status.body).authenticated, true)
    const remote = await send(target, "/api/remote-control/status", { headers })
    assert.equal(JSON.parse(remote.body).manageable, false)
    for (const path of ["/api/auth/token", "/api/auth/password;x", "/api/remote-%63ontrol/pairings", "/api/remote-proxy/sessions", "/api/opencode-plugin/automation", "/sidecars/test/", "/previews/test/", "/api/remote-control/pair"]) {
      assert.equal((await send(target, path, { method: "POST", headers })).status, 404, path)
    }
  }
})

test("browser context never gets the originless exemption, including empty and spoofed headers", async t => {
  const f = await startRemoteSurface(t)
  const { cookie } = await pair(f)
  for (const target of [f.target(), f.local]) {
    const headers = { host: target === f.local ? f.local : FAKE_TUNNEL_HOST, cookie }
    for (const [name, value] of [
      ["origin", ""], ["origin", "null"], ["origin", "https://foreign.test"],
      ["referer", ""], ["referer", `${ORIGIN}/`],
      ["sec-fetch-site", "same-origin"], ["sec-fetch-mode", "cors"], ["sec-fetch-dest", ""],
      ["sec-ch-ua", "browser"], ["access-control-request-method", "DELETE"],
    ]) {
      const response = await send(target, MUTATION, { method: "DELETE", headers: { ...headers, [name!]: value!, "x-forwarded-for": "127.0.0.1", "x-codenomad-remote-control": "1" } })
      assert.equal(response.status, 403, `${target}: ${name}`)
    }
  }
  // Existing same-origin browser admission on the ingress remains usable.
  assert.equal((await send(f.target(), MUTATION, { method: "DELETE", headers: { host: FAKE_TUNNEL_HOST, cookie, origin: ORIGIN, "sec-fetch-mode": "cors" } })).status, 204)
})

test("invalid credentials never fall back to local sessions or skipped authentication", async t => {
  for (const skipAuth of [false, true]) {
    const f = await startRemoteSurface(t, { skipAuth })
    const login = await send(f.local, "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "codenomad", password: "local-password" }) })
    assert.equal(login.status, 200)
    const sessionCookie = String(login.headers["set-cookie"]).split(";")[0]
    for (const target of [f.target(), f.local]) {
      const headers = { host: target === f.local ? f.local : FAKE_TUNNEL_HOST, cookie: `${DEVICE_COOKIE_NAME}=invalid; ${sessionCookie}` }
      assert.equal((await send(target, "/api/test/echo", { headers })).status, 401)
      assert.equal((await send(target, MUTATION, { method: "DELETE", headers })).status, 403)
      assert.equal((await send(target, MUTATION, { method: "DELETE", headers: { ...headers, origin: ORIGIN } })).status, 401)
      assert.equal((await send(target, "/api/test/echo", { headers: { ...headers, cookie: `${DEVICE_COOKIE_NAME}=%ZZ` } })).status, 400)
    }
    if (skipAuth) assert.equal((await send(f.local, MUTATION, { method: "DELETE" })).status, 204)
  }
})

async function stream(target: string, cookie: string, host = target) {
  const [hostname, port] = target.split(":")
  return new Promise<{ closed: Promise<void> }>((resolve, reject) => {
    const request = http.get({ hostname, port, agent: false, path: "/api/test/stream", headers: { host, cookie, "x-codenomad-server-request": "1" } }, response => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`stream rejected: ${response.statusCode}`))
        return
      }
      const closed = new Promise<void>(done => response.once("close", done))
      response.once("data", () => resolve({ closed }))
      response.on("error", () => undefined)
      response.resume()
    })
    request.on("error", reject)
  })
}

for (const action of ["revoke", "stop", "shutdown", "failure", "evict"] as const) {
  test(`${action} closes device streams on both listeners and revokes direct authority`, { timeout: 10_000 }, async t => {
    const f = await startRemoteSurface(t)
    const { cookie, id } = await pair(f)
    const streams = await Promise.all([stream(f.target(), cookie, FAKE_TUNNEL_HOST), stream(f.local, cookie)])
    if (action === "revoke") assert(f.manager.revokeDevice(id))
    else if (action === "stop") await f.manager.stop()
    else if (action === "shutdown") await f.manager.shutdown()
    else if (action === "failure") f.stopTunnel("test failure")
    else {
      for (let index = 0; index < 32; index++) {
        const code = new URL(f.manager.createPairing().url).hash.slice(1)
        assert(f.manager.exchangePairing(code, undefined, "replacement"))
      }
    }
    await Promise.all(streams.map(s => s.closed))
    assert.equal(f.manager.isDeviceAuthorized(id), false)
    assert.equal((await send(f.local, "/api/test/echo", { headers: { cookie } })).status, 401)
  })
}
