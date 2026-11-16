import assert from "node:assert/strict"
import dns from "node:dns"
import http from "node:http"
import os from "node:os"
import test from "node:test"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "../remote-control/test-support/surface"
import { targetsListener } from "./proxy-destination"

function request(target: string, pathname: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get(`http://${target}${pathname}`, { agent: false, headers }, response => {
      let body = ""
      response.setEncoding("utf8").on("data", chunk => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode!, body }))
    })
    req.setTimeout(5000, () => req.destroy(new Error("Request timed out")))
    req.on("upgrade", (response, socket) => { socket.destroy(); resolve({ status: response.statusCode!, body: "" }) })
    req.on("error", reject)
  })
}

for (const skipAuth of [false, true]) test(`DNS aliases cannot turn previews into local requests (skipAuth=${skipAuth})`, async t => {
  const f = await startRemoteSurface(t, { skipAuth })
  const alias = "backend-alias.invalid"
  let lookups = 0
  t.mock.method(dns, "lookup", ((host: string, ...args: unknown[]) => {
    assert.equal(host, alias, "external DNS is forbidden")
    lookups++
    const callback = args.at(-1) as (...values: unknown[]) => void
    if ((args[0] as { all?: boolean })?.all) callback(null, [{ address: "127.0.0.1", family: 4 }])
    else callback(null, "127.0.0.1", 4)
  }) as typeof dns.lookup)
  let contacts = 0
  f.app.server.on("connection", () => { contacts++ })
  const preview = f.previewManager.create("alias", `http://${alias}:${f.local.split(":")[1]}`)
  const response = await request(f.target(), `/previews/${preview.token}/api/remote-control/devices`, { host: FAKE_TUNNEL_HOST })
  t.diagnostic(`status=${response.status}, upstream contacts=${contacts}, DNS lookups=${lookups}`)
  // With auth enabled the existing cookie stripping already protects the data.
  if (!skipAuth) assert.notEqual(response.status, 200)
  assert.equal(response.status, 404)
  assert.equal(contacts, 0, "refuse before connecting to the privileged listener")
  assert.equal(lookups, 1)
})

test("fallback, capability-host and preview/SideCar upgrades refuse DNS aliases before contact", async t => {
  let origin = ""
  const f = await startRemoteSurface(t, { skipAuth: true, sidecarManager: {
    get: async () => ({ id: "fixture", prefixMode: "strip" }),
    buildProxyBasePath: () => "/sidecars/fixture",
    buildTargetOrigin: () => origin,
    buildTargetPath: () => "/api/remote-control/devices",
  } })
  origin = `http://backend-alias.invalid:${f.local.split(":")[1]}`
  let lookups = 0
  t.mock.method(dns, "lookup", ((host: string, ...args: unknown[]) => {
    assert.equal(host, "backend-alias.invalid", "external DNS is forbidden")
    lookups++
    const callback = args.at(-1) as (...values: unknown[]) => void
    callback(null, [{ address: "127.0.0.1", family: 4 }])
  }) as typeof dns.lookup)
  let contacts = 0
  f.app.server.on("connection", () => { contacts++ })
  const preview = f.previewManager.create("alias", origin)
  const fallback = await f.app.inject({ url: "/assets/probe.json", headers: {
    referer: `http://${f.local}/previews/${preview.token}/page`,
  } })
  assert.equal(fallback.statusCode, 404)
  assert.equal((await f.app.inject({ url: "/page", headers: { host: `${preview.token}.preview.localhost` } })).statusCode, 404)
  assert.equal((await f.app.inject({ url: "/sidecars/fixture/page" })).statusCode, 404)
  const upgradeHeaders = { connection: "Upgrade", upgrade: "websocket" }
  assert.equal((await request(f.target(), `/previews/${preview.token}/ws`, {
    host: FAKE_TUNNEL_HOST, ...upgradeHeaders,
  })).status, 404)
  // Direct SideCar admission is local; exclude this one incoming connection.
  assert.equal((await request(f.local, "/sidecars/fixture/ws", upgradeHeaders)).status, 404)
  assert.equal(contacts, 1)
  assert.equal(lookups, 5)
})

test("listener matching covers bound interfaces, dual-stack and mapped loopback without blocking LAN apps", t => {
  t.mock.method(os, "networkInterfaces", () => ({
    fixture: [{ address: "192.0.2.10" }, { address: "2001:db8::10" }],
  }) as unknown as ReturnType<typeof os.networkInterfaces>)
  const port = 43210
  for (const host of ["0.0.0.0", "::"]) {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "192.0.2.10", "2001:db8::10"]) {
      assert.equal(targetsListener(address, port, { address: host, port }),
        host !== "0.0.0.0" || !["::1", "2001:db8::10"].includes(address), `${host} <- ${address}`)
      assert.equal(targetsListener(address, port + 1, { address: host, port }), false)
    }
    assert.equal(targetsListener("192.0.2.20", port, { address: host, port }), false)
  }
  assert.equal(targetsListener("192.0.2.10", port, { address: "192.0.2.10", port }), true)
  assert.equal(targetsListener("192.0.2.20", port, { address: "192.0.2.10", port }), false)
  assert.equal(targetsListener("::ffff:127.0.0.1", port, { address: "127.0.0.1", port }), true)
})

test("implicit HTTP and HTTPS ports use the same listener boundary", async t => {
  const f = await startRemoteSurface(t, { skipAuth: true })
  t.mock.method(dns, "lookup", ((host: string, _options: unknown, callback: (...values: unknown[]) => void) => {
    assert.equal(host, "backend-alias.invalid", "external DNS is forbidden")
    callback(null, [{ address: "127.0.0.1", family: 4 }])
  }) as typeof dns.lookup)
  let port = 80
  t.mock.method(f.app.server, "address", () => ({ address: "127.0.0.1", port, family: "IPv4" }))
  for (const protocol of ["http", "https"]) {
    port = protocol === "http" ? 80 : 443
    const preview = f.previewManager.create(protocol, `${protocol}://backend-alias.invalid`)
    assert.equal((await request(f.target(), `/previews/${preview.token}/page`, { host: FAKE_TUNNEL_HOST })).status, 404)
  }
})

test("ordinary loopback preview ports retain dual-stack fallback with one pinned DNS lookup", async t => {
  const f = await startRemoteSurface(t, { skipAuth: true })
  const app = http.createServer((_request, reply) => reply.end("ordinary preview"))
  app.on("upgrade", (req, socket) => {
    assert.equal(req.headers.host, `${alias}:${(app.address() as { port: number }).port}`)
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
  })
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>(resolve => app.close(() => resolve())))
  const alias = "app-alias.invalid"
  let lookups = 0
  t.mock.method(dns, "lookup", ((host: string, ...args: unknown[]) => {
    assert.equal(host, alias, "external DNS is forbidden")
    assert.equal(++lookups, 1, "a second DNS answer could rebind to the backend")
    const callback = args.at(-1) as (...values: unknown[]) => void
    if ((args[0] as { all?: boolean })?.all) callback(null, [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }])
    else callback(null, "127.0.0.1", 4)
  }) as typeof dns.lookup)
  const preview = f.previewManager.create("ordinary", `http://${alias}:${(app.address() as { port: number }).port}`)
  const response = await request(f.target(), `/previews/${preview.token}/page`, { host: FAKE_TUNNEL_HOST })
  assert.equal(response.status, 200)
  assert.equal(response.body, "ordinary preview")
  assert.equal(lookups, 1)
  lookups = 0
  assert.equal((await request(f.target(), `/previews/${preview.token}/ws`, {
    host: FAKE_TUNNEL_HOST, connection: "Upgrade", upgrade: "websocket",
  })).status, 101)
  assert.equal(lookups, 1)
})
