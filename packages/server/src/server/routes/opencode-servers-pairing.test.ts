// prototype-1236: host-only exchange of an `opencode pair` link from the Add server field.
import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http"
import { once } from "node:events"
import { join } from "node:path"
import pino from "pino"
import { startRemoteSurface, FAKE_TUNNEL_HOST } from "../../remote-control/test-support/surface"
import { SettingsService } from "../../settings/service"
import { resolveConfigLocation } from "../../config/location"
import { explicitContractFixture } from "../../opencode/compatibility/contract-fixture"

const TOKEN = "4102444800000.syntheticPairedTokenHmac"

function send(target: string, path: string, method: string, headers: Record<string, string>, payload?: unknown) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpRequest(`http://${target}${path}`, { method, headers: { ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers } }, response => {
      let body = ""
      response.setEncoding("utf8").on("data", chunk => { body += chunk }).on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }))
    })
    request.on("error", reject); request.end(payload === undefined ? undefined : JSON.stringify(payload))
  })
}

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(process.cwd(), ".tmp-pair-")), logs: string[] = [], calls: string[] = []
  const logger = pino({ level: "trace" }, { write: text => logs.push(text) })
  const configPath = join(root, "config.yaml")
  const settings = new SettingsService(resolveConfigLocation(configPath), undefined, logger)
  const owner = settings.getOpenCodeServerConnections({ acquire: async () => assert.fail("local must stay untouched"), existing: () => undefined, invalidate: () => {} })
  const codes = new Set(["fresh-code", "second-code"])
  const state = { redirect: false, rejectToken: false, accepts: [] as string[] }
  const upstream = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`)
    const connect = /^\/auth\/connect\/([^/]+)$/.exec(request.url ?? "")
    if (connect) {
      state.accepts.push(String(request.headers.accept))
      if (state.redirect) { response.writeHead(302, { location: "/" }); response.end(); return }
      const valid = codes.delete(connect[1]!)
      response.writeHead(valid ? 200 : 401, { "content-type": "application/json" })
      response.end(JSON.stringify(valid ? { token: TOKEN } : { name: "UnauthorizedError" }))
      return
    }
    const expected = `Basic ${Buffer.from(`opencode:${TOKEN}`).toString("base64")}`
    if (state.rejectToken || request.headers.authorization !== expected) { response.writeHead(401); response.end(); return }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(request.url === "/openapi.json" ? explicitContractFixture() : { version: "99.0.0" }))
  })
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening")
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  const surface = await startRemoteSurface(t, { settings, logger, workspaceManager: { getServerConnections: () => owner } })
  const session = surface.authManager.createSession("codenomad")
  const cookie = `${surface.authManager.getCookieName()}=${session.id}`
  const add = (address: string, extra: Record<string, string> = {}) => send(surface.local, "/api/opencode-servers/add", "POST", { cookie, ...extra }, { name: "Box", address })
  t.after(async () => { await owner.dispose(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); rmSync(root, { recursive: true, force: true }) })
  return { ...surface, root, configPath, settings, owner, origin, calls, logs, cookie, state, add, pairings: join(root, "opencode-server-pairings.json") }
}

test("a pasted pairing link is exchanged once and its token stays on the backend across launches", async t => {
  const f = await fixture(t)
  const added = await f.add(`${f.origin}/auth/connect/fresh-code`)
  assert.equal(added.status, 200, added.body)
  const profile = JSON.parse(added.body)
  assert.deepEqual(Object.keys(profile).sort(), ["id", "label", "origin"])
  assert.equal(profile.origin, f.origin); assert.equal(profile.label, "Box")
  assert.deepEqual(f.calls, ["GET /auth/connect/fresh-code"])
  assert.deepEqual(f.state.accepts, ["application/json"])
  assert.doesNotMatch(added.body, /syntheticPairedToken|fresh-code/)
  // Metadata only in the config; the token lives in the backend-private pairing file.
  assert.doesNotMatch(readFileSync(f.configPath, "utf8"), /syntheticPairedToken|fresh-code/)
  assert.match(readFileSync(f.pairings, "utf8"), /syntheticPairedToken/)
  const list = await send(f.local, "/api/opencode-servers", "GET", { cookie: f.cookie })
  assert.equal(JSON.parse(list.body).servers[1].hasCredentials, true)
  assert.doesNotMatch(list.body, /syntheticPairedToken/)
  // The token authenticates the API as Basic opencode:<token>.
  await f.owner.connect(profile.id)
  assert.ok(f.calls.includes("GET /openapi.json"))
  // A relaunch reads it again without a new link.
  const restarted = new SettingsService(resolveConfigLocation(f.configPath), undefined, pino({ level: "silent" }))
  assert.equal(await restarted.getOpenCodeServerCredentials().readForConnection(profile.id), JSON.stringify({ username: "opencode", password: TOKEN }))
  await restarted.disposeOpenCodeServers()
  assert.doesNotMatch(f.logs.join("\n"), /syntheticPairedToken|fresh-code/)
})

test("a spent or expired code is refused without adding a server", async t => {
  const f = await fixture(t)
  assert.equal((await f.add(`${f.origin}/auth/connect/fresh-code`)).status, 200)
  const spent = await f.add(`${f.origin}/auth/connect/fresh-code`, {})
  assert.equal(spent.status, 400); assert.equal(JSON.parse(spent.body).code, "pairing_expired")
  const unknown = await send(f.local, "/api/opencode-servers/add", "POST", { cookie: f.cookie }, { address: `${f.origin}/auth/connect/never-issued` })
  assert.equal(JSON.parse(unknown.body).code, "pairing_expired")
  assert.equal(f.settings.getOpenCodeServerRegistry().list().filter(profile => profile.kind === "explicit").length, 1)
})

test("http outside loopback, query or fragment links are refused before any request", async t => {
  const f = await fixture(t)
  for (const [link, code] of [["http://192.168.1.10:4096/auth/connect/abc", "https_required"], ["http://example.test/auth/connect/abc", "https_required"],
    [`${f.origin}/auth/connect/abc?x=1`, "invalid_link"], [`${f.origin}/auth/connect/abc#x`, "invalid_link"]] as const) {
    const response = await f.add(link)
    assert.equal(response.status, 400, link); assert.equal(JSON.parse(response.body).code, code, link)
  }
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.pairings), false)
})

test("a redirect is never followed", async t => {
  const f = await fixture(t)
  f.state.redirect = true
  const response = await f.add(`${f.origin}/auth/connect/fresh-code`)
  assert.equal(response.status, 502); assert.equal(JSON.parse(response.body).code, "unreachable")
  assert.deepEqual(f.calls, ["GET /auth/connect/fresh-code"])
  assert.equal(response.headers.location, undefined)
})

test("a paired Remote Control device can neither exchange a link nor read the token", async t => {
  const f = await fixture(t)
  assert.equal((await f.add(`${f.origin}/auth/connect/fresh-code`)).status, 200)
  const pair = await send(f.target(), "/api/remote-control/pair", "POST", { host: FAKE_TUNNEL_HOST, origin: `https://${FAKE_TUNNEL_HOST}` }, { code: f.code })
  assert.equal(pair.status, 200, pair.body)
  const cookie = pair.headers["set-cookie"]![0]!.split(";")[0]!, headers = { host: FAKE_TUNNEL_HOST, cookie, origin: `https://${FAKE_TUNNEL_HOST}` }
  const exchange = await send(f.target(), "/api/opencode-servers/add", "POST", headers, { address: `${f.origin}/auth/connect/second-code` })
  assert.equal(exchange.status, 404)
  assert.deepEqual(f.calls, ["GET /auth/connect/fresh-code"])
  const config = await send(f.target(), "/api/storage/config", "GET", headers)
  assert.equal(config.status, 200, config.body)
  assert.match(config.body, new RegExp(f.origin.replace(/[.:/]/g, "\\$&")))
  assert.doesNotMatch(config.body, /syntheticPairedToken/)
})

test("a 401 after pairing leaves the server waiting for a new link", async t => {
  const f = await fixture(t)
  const { id } = JSON.parse((await f.add(`${f.origin}/auth/connect/fresh-code`)).body)
  f.state.rejectToken = true
  await assert.rejects(f.owner.connect(id), { code: "auth" })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.settings.getOpenCodeServerCredentials().hasCredentials(id), false)
  assert.doesNotMatch(readFileSync(f.pairings, "utf8"), /syntheticPairedToken/)
  f.state.rejectToken = false
  assert.equal((await f.add(`${f.origin}/auth/connect/second-code`)).status, 200)
  assert.equal(f.settings.getOpenCodeServerCredentials().hasCredentials(id), true)
})

// prototype-1236 (R17): an address with a password stays connected across launches, like a paired link.
test("a manual password is kept in the private backend file across launches, then forgotten on removal", async t => {
  const f = await fixture(t)
  const address = f.origin.replace("http://", `http://opencode:${encodeURIComponent(TOKEN)}@`)
  const added = await f.add(address)
  assert.equal(added.status, 200, added.body)
  const { id } = JSON.parse(added.body)
  assert.doesNotMatch(added.body, /syntheticPairedToken/)
  assert.doesNotMatch(readFileSync(f.configPath, "utf8"), /syntheticPairedToken/)
  assert.match(readFileSync(f.pairings, "utf8"), /syntheticPairedToken/)
  const restarted = new SettingsService(resolveConfigLocation(f.configPath), undefined, pino({ level: "silent" }))
  assert.equal(await restarted.getOpenCodeServerCredentials().readForConnection(id), JSON.stringify({ username: "opencode", password: TOKEN }))
  await restarted.disposeOpenCodeServers()
  assert.equal((await send(f.local, `/api/opencode-servers/${id}`, "DELETE", { cookie: f.cookie })).status, 204)
  assert.doesNotMatch(readFileSync(f.pairings, "utf8"), /syntheticPairedToken/)
  assert.doesNotMatch(f.logs.join("\n"), /syntheticPairedToken/)
})

test("removing a server forgets its token and profile", async t => {
  const f = await fixture(t)
  const { id } = JSON.parse((await f.add(`${f.origin}/auth/connect/fresh-code`)).body)
  const removed = await send(f.local, `/api/opencode-servers/${id}`, "DELETE", { cookie: f.cookie })
  assert.equal(removed.status, 204, removed.body)
  assert.equal(f.settings.getOpenCodeServerRegistry().get(id), undefined)
  assert.doesNotMatch(readFileSync(f.pairings, "utf8"), /syntheticPairedToken/)
})
