import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { DEVICE_COOKIE_NAME } from "./gate"
import { verifiedDirectHttpsOrigin, verifiedHttpsOrigins } from "./direct-https"
import { SERVER_PAIR_PATH } from "./server-pairing"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"

// A TLS-terminating reverse proxy forwards the public Host and the browser's Origin
// to the plain-HTTP listener, over loopback or from another machine.
const PUBLIC = "https://code.example.test"
const PUBLIC_HOST = "code.example.test"
const LAN_HTTP = "http://lan.example.test:9899"
const MUTATION = "/api/workspaces/relay-test"
const PROXY_PEERS = ["127.0.0.1", "192.0.2.20"]

type Surface = Awaited<ReturnType<typeof startRemoteSurface>>

async function surface(t: test.TestContext, options: Parameters<typeof startRemoteSurface>[1] = {}) {
  const allowedOrigins = [PUBLIC, LAN_HTTP, "https://localhost:8443"]
  const f = await startRemoteSurface(t, { allowedOrigins, ...options, configureApp: app => {
    // Inject sockets lack destroy(); revocation closes them like real sockets.
    app.addHook("onRequest", (request, _reply, done) => {
      const socket = request.raw.socket as unknown as { destroy?: () => void; emit(event: string): void }
      socket.destroy ??= () => socket.emit("close")
      done()
    })
  } })
  // Direct pairing and admission never need the tunnel.
  await f.manager.stop()
  const session = `${f.authManager.getCookieName()}=${f.authManager.createSession("codenomad").id}`
  return { ...f, allowedOrigins, session }
}

function code(url: string) {
  return new URL(url).hash.slice(1)
}

async function pairDirect(f: Surface, remoteAddress = "127.0.0.1") {
  const pairing = f.manager.createDirectPairing(PUBLIC)
  const response = await f.app.inject({ method: "POST", url: "/api/remote-control/pair", remoteAddress,
    headers: { host: PUBLIC_HOST, origin: PUBLIC, "user-agent": "Mozilla/5.0 (Android) Chrome/140.0" }, payload: { code: code(pairing.url) } })
  assert.equal(response.statusCode, 200, response.body)
  const setCookie = String(response.headers["set-cookie"])
  const id = response.json().device.id as string
  return { cookie: setCookie.split(";")[0]!, setCookie, id, response }
}

test("the verified direct HTTPS origin set and request predicate", () => {
  assert.deepEqual(verifiedHttpsOrigins({ localUrl: "https://127.0.0.1:9898", remoteUrl: "https://192.0.2.10:9898",
    addresses: [{ remoteUrl: "https://[::1]:9898" }, { remoteUrl: "https://lan.test:9898" }] as never },
  [PUBLIC, LAN_HTTP, "https://localhost:1", "https://app.localhost", "https://0.0.0.0:1", "https://[::]:1", "https://[::ffff:127.0.0.1]:1", "not a url"]),
  ["https://192.0.2.10:9898", "https://lan.test:9898", PUBLIC])
  const origins = [PUBLIC]
  const raw = { socket: undefined } as never
  const judge = (method: string, headers: Record<string, string | undefined>) => verifiedDirectHttpsOrigin({ raw, method, headers: headers as Record<string, string> }, origins)
  assert.equal(judge("POST", { origin: PUBLIC, host: "127.0.0.1:9899" }), PUBLIC)
  for (const headers of [{ host: PUBLIC_HOST }, { referer: `${PUBLIC}/`, host: PUBLIC_HOST }, { origin: "null" }, { origin: "" },
    { origin: "http://code.example.test" }, { origin: "https://code.example.test.evil.test" }, { origin: "https://localhost:8443" }]) {
    assert.equal(judge("POST", headers), null, JSON.stringify(headers))
  }
  assert.equal(judge("GET", { host: PUBLIC_HOST }), PUBLIC)
  assert.equal(judge("GET", { host: `${PUBLIC_HOST}:443` }), PUBLIC)
  assert.equal(judge("GET", { referer: `${PUBLIC}/app`, host: "127.0.0.1:9899" }), PUBLIC)
  for (const headers of [{ host: "127.0.0.1:9899" }, { host: `user@${PUBLIC_HOST}` }, { referer: "http://code.example.test/", host: PUBLIC_HOST },
    { origin: "null", host: PUBLIC_HOST }, { origin: LAN_HTTP, host: PUBLIC_HOST }, {}]) {
    assert.equal(judge("GET", headers), null, JSON.stringify(headers))
  }
  assert.equal(verifiedDirectHttpsOrigin({ raw, method: "GET", headers: { host: PUBLIC_HOST } }, []), null)
})

test("the host issues a direct HTTPS link while the tunnel is stopped; pairing is single-use and origin-bound", async t => {
  const f = await surface(t)
  assert.deepEqual(f.manager.status().directOrigins, [PUBLIC])
  const local = await f.app.inject({ url: "/api/remote-control/status", headers: { cookie: f.session } })
  assert.deepEqual(local.json().directOrigins, [PUBLIC])
  assert.equal((await f.app.inject({ url: "/api/remote-control/status", remoteAddress: "192.0.2.20", headers: { cookie: f.session } })).json().directOrigins, undefined)
  const created = await f.app.inject({ method: "POST", url: "/api/remote-control/pairings", headers: { cookie: f.session }, payload: { origin: PUBLIC } })
  assert.equal(created.statusCode, 200, created.body)
  assert.match(created.json().url, /^https:\/\/code\.example\.test\/remote-pair#[A-Za-z0-9_-]{32}$/)
  for (const origin of [LAN_HTTP, "https://localhost:8443", "https://foreign.test"]) {
    assert.equal((await f.app.inject({ method: "POST", url: "/api/remote-control/pairings", headers: { cookie: f.session }, payload: { origin } })).statusCode, 409, origin)
  }
  assert.equal((await f.app.inject({ method: "POST", url: "/api/remote-control/pairings", headers: { cookie: f.session }, payload: { origin: PUBLIC, extra: 1 } })).statusCode, 400)
  assert.equal((await f.app.inject({ method: "POST", url: "/api/remote-control/pairings", remoteAddress: "192.0.2.20",
    headers: { origin: PUBLIC, cookie: f.session }, payload: { origin: PUBLIC } })).statusCode, 404, "issuance stays host-only")

  // The pairing page answers on the verified origin only.
  assert.equal((await f.app.inject({ url: "/remote-pair", headers: { host: PUBLIC_HOST } })).statusCode, 200)
  for (const headers of [{}, { host: "lan.example.test:9899" }, { host: PUBLIC_HOST, referer: `${LAN_HTTP}/` }]) {
    assert.equal((await f.app.inject({ url: "/remote-pair", headers })).statusCode, 404, JSON.stringify(headers))
  }
  assert.equal((await f.app.inject({ url: "/remote-pair", headers: { host: PUBLIC_HOST, origin: "null" } })).statusCode, 403)
  // The exchange needs its own verified https Origin and never consumes the code otherwise.
  const pairingCode = code(created.json().url)
  for (const headers of [{ host: PUBLIC_HOST }, { host: PUBLIC_HOST, origin: LAN_HTTP }, { host: PUBLIC_HOST, origin: "https://localhost:8443" }]) {
    assert.equal((await f.app.inject({ method: "POST", url: "/api/remote-control/pair", headers, payload: { code: pairingCode } })).statusCode, 404, JSON.stringify(headers))
  }
  for (const origin of ["https://foreign.test", "null"]) {
    assert.equal((await f.app.inject({ method: "POST", url: "/api/remote-control/pair", headers: { host: PUBLIC_HOST, origin }, payload: { code: pairingCode } })).statusCode, 403, origin)
  }
  const paired = await f.app.inject({ method: "POST", url: "/api/remote-control/pair", remoteAddress: "192.0.2.20",
    headers: { host: PUBLIC_HOST, origin: PUBLIC, "user-agent": "Mozilla/5.0 (iPhone) Safari/605.1" }, payload: { code: pairingCode } })
  assert.equal(paired.statusCode, 200, paired.body)
  assert.match(String(paired.headers["set-cookie"]), new RegExp(`^${DEVICE_COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=\\d+$`))
  assert.equal(paired.headers["cache-control"], "no-store")
  assert.deepEqual(f.manager.devices().map(device => [device.name, device.origin]), [["iPhone · Safari", PUBLIC]])
  assert.equal((await f.app.inject({ method: "POST", url: "/api/remote-control/pair", headers: { host: PUBLIC_HOST, origin: PUBLIC }, payload: { code: pairingCode } })).statusCode, 401, "single use")
})

test("codes and devices stay on their channel: tunnel and direct HTTPS never cross", async t => {
  const f = await surface(t)
  const tunnelCode = code((await f.manager.start()).pairing.url)
  // A tunnel code is refused on the direct origin, and stays valid for the tunnel.
  assert.equal((await f.app.inject({ method: "POST", url: "/api/remote-control/pair", headers: { host: PUBLIC_HOST, origin: PUBLIC }, payload: { code: tunnelCode } })).statusCode, 401)
  const serverPair = await new Promise<string>((resolve, reject) => {
    const request = http.request(`http://${f.target()}${SERVER_PAIR_PATH}`, { method: "POST", agent: false, headers: { host: FAKE_TUNNEL_HOST, "x-codenomad-server-pairing": "1", "content-type": "application/json" } }, response => {
      let body = ""
      response.setEncoding("utf8").on("data", chunk => { body += chunk }).on("end", () => response.statusCode === 200 ? resolve(JSON.parse(body).credential) : reject(new Error(body)))
    })
    request.on("error", reject)
    request.end(JSON.stringify({ code: tunnelCode, hostName: "relay" }))
  })
  // A direct code is refused by server pairing and is not cancelled by Stop.
  const direct = code(f.manager.createDirectPairing(PUBLIC).url)
  assert.equal(f.manager.exchangePairing(direct, undefined, "relay"), null)
  await f.manager.stop()
  const { cookie } = await (async () => {
    const response = await f.app.inject({ method: "POST", url: "/api/remote-control/pair", headers: { host: PUBLIC_HOST, origin: PUBLIC }, payload: { code: direct } })
    assert.equal(response.statusCode, 200, response.body)
    return { cookie: String(response.headers["set-cookie"]).split(";")[0]! }
  })()
  // The tunnel device's credential is refused on the direct origin, without password fallback.
  const tunnelOnDirect = await f.app.inject({ url: "/api/test/echo", headers: { host: PUBLIC_HOST, cookie: `${DEVICE_COOKIE_NAME}=${serverPair}` } })
  assert.equal(tunnelOnDirect.statusCode, 401)
  assert.equal((await f.app.inject({ url: "/api/test/echo", headers: { host: PUBLIC_HOST, cookie } })).statusCode, 200)
  // The direct device is refused through the tunnel.
  await f.manager.start()
  const ingress = await new Promise<number>((resolve, reject) => {
    http.get(`http://${f.target()}/api/test/echo`, { agent: false, headers: { host: FAKE_TUNNEL_HOST, cookie } }, response => { response.resume(); resolve(response.statusCode!) }).on("error", reject)
  })
  assert.equal(ingress, 401)
})

test("a direct HTTPS device is admitted through a reverse proxy, in device scope, without loopback privileges", async t => {
  const f = await surface(t)
  const { cookie, id } = await pairDirect(f)
  assert.equal(f.manager.isDeviceAuthorized(id), true, "mission and automation routes see a live principal")
  for (const remoteAddress of PROXY_PEERS) {
    const echo = await f.app.inject({ url: "/api/test/echo", remoteAddress, headers: { host: PUBLIC_HOST, cookie, "x-forwarded-for": "198.51.100.7" } })
    assert.equal(echo.statusCode, 200, echo.body)
    assert.deepEqual(echo.json(), { loopbackPrivileges: false, forwardedFor: null, remoteControlHeader: null })
    assert.equal((await f.app.inject({ url: "/api/test/echo", remoteAddress, headers: { host: "127.0.0.1:9899", referer: `${PUBLIC}/`, cookie } })).statusCode, 200)
    assert.equal((await f.app.inject({ url: "/api/auth/status", remoteAddress, headers: { host: PUBLIC_HOST, cookie } })).json().authenticated, true)
    assert.equal((await f.app.inject({ url: "/api/meta", remoteAddress, headers: { host: PUBLIC_HOST, cookie } })).json().localRequest, false)
    assert.equal((await f.app.inject({ url: "/api/remote-control/status", remoteAddress, headers: { host: PUBLIC_HOST, cookie } })).json().manageable, false)
    const mutation = await f.app.inject({ method: "DELETE", url: MUTATION, remoteAddress, headers: { host: PUBLIC_HOST, origin: PUBLIC, cookie } })
    assert.equal(mutation.statusCode, 204, mutation.body)
    for (const [method, path] of [["POST", "/api/auth/token"], ["POST", "/api/auth/logout"], ["GET", "/login"], ["POST", "/api/remote-control/pairings"],
      ["GET", "/api/remote-control/devices"], ["GET", "/api/backends/x/api/meta"], ["GET", "/api/remote-servers"], ["GET", "/sidecars/x/"],
      ["POST", "/api/memory"], ["GET", "/api/memory/settings"], ["POST", "/api/remote-%63ontrol/pairings"]] as const) {
      const response = await f.app.inject({ method, url: path, remoteAddress, headers: { host: PUBLIC_HOST, origin: PUBLIC, cookie } })
      assert.equal(response.statusCode, 404, `${remoteAddress} ${method} ${path}`)
    }
  }
})

test("device credentials are ignored outside the verified origin and never authenticate there", async t => {
  const f = await surface(t)
  const { cookie } = await pairDirect(f)
  for (const remoteAddress of PROXY_PEERS) {
    // Plain-HTTP LAN, loopback HTTP pages, opaque and foreign origins: password rules apply untouched.
    for (const headers of [{ host: "lan.example.test:9899" }, { host: "127.0.0.1:9899" }, { host: "localhost:8443" },
      { host: PUBLIC_HOST, origin: LAN_HTTP }, { host: PUBLIC_HOST, referer: `${LAN_HTTP}/` }]) {
      const response = await f.app.inject({ url: "/api/test/echo", remoteAddress, headers: { ...headers, cookie } })
      assert.equal(response.statusCode, 401, `${remoteAddress} ${JSON.stringify(headers)}`)
      assert.equal((await f.app.inject({ url: "/api/auth/status", remoteAddress, headers: { ...headers, cookie } })).json().pairingRequired, undefined)
    }
    // Mutations need the verified Origin itself; without one, the device credential is unused.
    for (const [headers, status] of [[{ host: PUBLIC_HOST }, remoteAddress === "127.0.0.1" ? 401 : 403],
      [{ host: PUBLIC_HOST, referer: `${PUBLIC}/` }, 401], [{ host: PUBLIC_HOST, origin: LAN_HTTP }, 401]] as const) {
      const response = await f.app.inject({ method: "DELETE", url: MUTATION, remoteAddress, headers: { ...headers, cookie } })
      assert.equal(response.statusCode, status, `${remoteAddress} ${JSON.stringify(headers)}`)
    }
    for (const origin of ["null", "https://foreign.test", `https://${FAKE_TUNNEL_HOST}`]) {
      const response = await f.app.inject({ method: "DELETE", url: MUTATION, remoteAddress, headers: { host: PUBLIC_HOST, origin, cookie } })
      assert.equal(response.statusCode, 403, `${remoteAddress} ${origin}`)
    }
  }
})

test("an invalid device credential never falls back to a password session or skipped authentication", async t => {
  for (const skipAuth of [false, true]) {
    const f = await surface(t, { skipAuth })
    const session = `${f.authManager.getCookieName()}=${f.authManager.createSession("codenomad").id}`
    // Password sessions on the same verified origin keep working without a device cookie.
    if (!skipAuth) {
      assert.equal((await f.app.inject({ url: "/api/test/echo", headers: { host: PUBLIC_HOST, cookie: session } })).statusCode, 200)
      const login = await f.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "192.0.2.20", headers: { host: PUBLIC_HOST, origin: PUBLIC },
        payload: { username: "codenomad", password: "local-password" } })
      assert.equal(login.statusCode, 200)
      assert.equal((await f.app.inject({ method: "DELETE", url: MUTATION, remoteAddress: "192.0.2.20", headers: { host: PUBLIC_HOST, origin: PUBLIC, cookie: session } })).statusCode, 204)
    }
    for (const value of ["invalid", (await pairDirect(f)).cookie.split("=")[1]!]) {
      if (value !== "invalid") {
        const [device] = f.manager.devices()
        assert(f.manager.revokeDevice(device!.id))
      }
      const cookie = `${DEVICE_COOKIE_NAME}=${value}; ${session}`
      for (const remoteAddress of PROXY_PEERS) {
        const headers = { host: PUBLIC_HOST, cookie }
        assert.equal((await f.app.inject({ url: "/api/test/echo", remoteAddress, headers })).statusCode, 401)
        assert.equal((await f.app.inject({ method: "DELETE", url: MUTATION, remoteAddress, headers: { ...headers, origin: PUBLIC } })).statusCode, 401)
        assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress, headers: { ...headers, origin: PUBLIC },
          payload: { username: "codenomad", password: "local-password" } })).statusCode, 401)
        assert.deepEqual((await f.app.inject({ url: "/api/auth/status", remoteAddress, headers })).json(), { authenticated: false, pairingRequired: true })
        const page = await f.app.inject({ url: "/", remoteAddress, headers: { ...headers, accept: "text/html" } })
        assert.equal(page.headers.location, "/remote-pair")
        assert.equal((await f.app.inject({ url: "/remote-pair", remoteAddress, headers })).statusCode, 200, "the device can pair again")
        assert.equal((await f.app.inject({ url: "/manifest.webmanifest", remoteAddress, headers })).statusCode, 200)
      }
    }
  }
})

test("ten wrong direct codes are throttled by the shared bucket, which never locks out the valid code", async t => {
  const f = await surface(t)
  const valid = code(f.manager.createDirectPairing(PUBLIC).url)
  const attempt = (pairingCode: string) => f.app.inject({ method: "POST", url: "/api/remote-control/pair", headers: { host: PUBLIC_HOST, origin: PUBLIC }, payload: { code: pairingCode } })
  for (let index = 0; index < 10; index++) assert.equal((await attempt("x".repeat(32))).statusCode, 401)
  const limited = await attempt("x".repeat(32))
  assert.equal(limited.statusCode, 429)
  assert.match(String(limited.headers["retry-after"]), /^[1-6]?[0-9]$/)
  assert.equal((await attempt(valid)).statusCode, 200, "the valid code is checked before the quota")
  assert.equal((await attempt(valid)).statusCode, 429, "a replay counts as a failure")
})

async function stream(target: string, cookie: string) {
  const [hostname, port] = target.split(":")
  return new Promise<{ closed: Promise<void>; ticks: () => number }>((resolve, reject) => {
    const request = http.get({ hostname, port, agent: false, path: "/api/test/stream", headers: { host: PUBLIC_HOST, cookie } }, response => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`stream rejected: ${response.statusCode}`))
        return
      }
      let ticks = 0
      const closed = new Promise<void>(done => response.once("close", done))
      response.on("data", () => { ticks++ })
      response.once("data", () => resolve({ closed, ticks: () => ticks }))
      response.on("error", () => undefined)
    })
    request.on("error", reject)
  })
}

test("a device loses its authority once its origin is no longer verified", async t => {
  const f = await surface(t)
  const { cookie, id } = await pairDirect(f)
  f.allowedOrigins.splice(0, f.allowedOrigins.length)
  assert.equal(f.manager.isDeviceAuthorized(id), false)
  assert.equal(f.manager.status().directOrigins, undefined)
  assert.equal((await f.app.inject({ url: "/api/test/echo", headers: { host: PUBLIC_HOST, cookie } })).statusCode, 401)
  assert.equal(f.manager.exchangeDirectPairing("x".repeat(32), PUBLIC, undefined), null)
  assert.throws(() => f.manager.createDirectPairing(PUBLIC), /cannot pair/)
})

for (const action of ["revoke", "evict"] as const) {
  test(`${action} closes direct HTTPS device streams; Stop and tunnel failure leave them open`, { timeout: 10_000 }, async t => {
    const f = await surface(t)
    const { cookie, id } = await pairDirect(f)
    const open = await stream(f.local, cookie)
    await f.manager.start()
    f.stopTunnel("test failure")
    await f.manager.stop()
    const before = open.ticks()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(open.ticks() > before, "the stream outlives Stop")
    if (action === "revoke") assert(f.manager.revokeDevice(id))
    else {
      for (let index = 0; index < 32; index++) {
        assert(f.manager.exchangeDirectPairing(code(f.manager.createDirectPairing(PUBLIC).url), PUBLIC, undefined))
      }
    }
    await open.closed
    assert.equal(f.manager.isDeviceAuthorized(id), false)
    assert.equal((await f.app.inject({ url: "/api/test/echo", headers: { host: PUBLIC_HOST, cookie } })).statusCode, 401)
  })
}
