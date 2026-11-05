import assert from "node:assert/strict"
import test from "node:test"
import { request as httpRequest } from "node:http"
import { randomUUID } from "node:crypto"
import pino from "pino"
import { EventBus } from "../../events/bus"
import { ClientConnectionManager } from "../../clients/connection-manager"
import { ProjectParticipants, PARTICIPATION_HEADER } from "../../workspaces/project-participants"
import { startRemoteSurface, FAKE_TUNNEL_HOST } from "../../remote-control/test-support/surface"

function send(target: string, path: string, headers: Record<string, string>, body: unknown, raw = false) {
  return new Promise<{ status: number; body: string; cookie?: string; cache?: string; challenge?: string }>((resolve, reject) => {
    const request = httpRequest(`http://${target}`, { path, agent: false, method: "POST", headers: { "content-type": "application/json", ...headers } }, response => {
      let text = ""; response.setEncoding("utf8").on("data", chunk => { text += chunk }).on("end", () => resolve({
        status: response.statusCode!, body: text, cookie: response.headers["set-cookie"]?.[0]?.split(";")[0],
        cache: response.headers["cache-control"], challenge: response.headers["www-authenticate"],
      }))
    })
    request.on("error", reject); request.end(raw ? body as string : JSON.stringify(body))
  })
}

function stream(target: string, headers: Record<string, string>, ids = randomUUID()) {
  return new Promise<{ token: string; cache: string | undefined; close(): void }>((resolve, reject) => {
    const request = httpRequest(`http://${target}/api/events?clientId=${ids}&connectionId=${ids}&participation=1`, { agent: false, headers }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`SSE status ${response.statusCode}`)); return }
      let text = ""
      response.setEncoding("utf8").on("data", chunk => {
        text += chunk
        const match = text.match(/event: codenomad\.project\.participation\ndata: ([^\n]+)\n\n/)
        if (match) resolve({ token: JSON.parse(match[1]!).token, cache: response.headers["cache-control"], close() { request.destroy(); response.destroy() } })
      })
      response.on("error", reject)
    })
    request.on("error", reject); request.end()
  })
}

async function fixture(t: test.TestContext) {
  const logs: string[] = [], logger = pino({ level: "trace" }, { write: text => logs.push(text) })
  const owner = new ProjectParticipants(), connections = new ClientConnectionManager(logger)
  let calls = 0
  const bindings = new Map([["same", { serverId: "A", directory: "/PARTICIPANT_PRIVATE_PATH_é " }], ["other", { serverId: "B", directory: "/PARTICIPANT_PRIVATE_PATH_é " }]])
  const surface = await startRemoteSurface(t, { logger, events: { eventBus: new EventBus(), connections },
    workspaceManager: { projectParticipants: owner, get: (id: string) => { calls++; const binding = bindings.get(id); return binding && { id, binding } } } })
  t.after(() => { connections.shutdown(); owner.dispose() })
  const session = surface.authManager.createSession("codenomad"), second = surface.authManager.createSession("codenomad")
  const cookie = `${surface.authManager.getCookieName()}=${session.id}`, otherCookie = `${surface.authManager.getCookieName()}=${second.id}`
  const headers = { cookie, host: surface.local, origin: `http://${surface.local}`, "sec-fetch-site": "same-origin" }
  return { ...surface, owner, logs, bindings, headers, otherCookie, calls: () => calls }
}

test("real SSE grants bind an authenticated stream, not supplied connection IDs; early guards and metadata remain private", async t => {
  const f = await fixture(t), ids = randomUUID(), live = await stream(f.local, f.headers, ids)
  assert.equal(live.cache, "no-store")
  t.after(() => live.close())
  const payload = { revision: 1, refs: [{ tabId: randomUUID(), workspaceId: "same", serverId: "A", directory: f.bindings.get("same")!.directory }] }
  const headers = { ...f.headers, [PARTICIPATION_HEADER]: live.token }
  const before = f.owner.snapshot("A")
  for (const extra of [{ cookie: "" }, { cookie: f.otherCookie }, { origin: "null" }, { origin: "https://foreign.test" },
    { host: "forged.test" }, { "sec-fetch-site": "cross-site" }, { [PARTICIPATION_HEADER]: ids }, { [PARTICIPATION_HEADER]: "0".repeat(64) }]) {
    const response = await f.app.inject({ method: "POST", url: "/api/project-participation", headers: { ...headers, ...extra }, payload: "{PRIVATE_UNPARSED", remoteAddress: "127.0.0.1" })
    assert.equal(response.statusCode, 403)
    assert.equal(response.headers["cache-control"], "no-store")
    assert.equal(response.body, '{"code":"participation_unavailable"}')
    assert.equal(f.calls(), 0, "guards run before body parsing and metadata/native IO")
  }
  assert.equal(f.owner.isCurrent(before.receipt), true, "foreign attempts cannot invalidate the other principal")
  const accepted = await send(f.local, "/api/project-participation", headers, payload)
  assert.equal(accepted.status, 204)
  assert.equal(f.owner.snapshot("A").refs[0]!.directory, payload.refs[0]!.directory)
  assert.equal(f.owner.snapshot("A").status, "unknown")
  const replay = await send(f.local, "/api/project-participation", headers, payload)
  assert.equal(replay.status, 409)
  assert.equal((await send(f.local, "/api/project-participation", headers, { ...payload, revision: 2 })).status, 204)
  const stable = f.owner.snapshot("A")
  const replacement = await stream(f.local, { ...f.headers, cookie: f.otherCookie }, ids)
  t.after(() => replacement.close())
  assert.equal(f.owner.isCurrent(stable.receipt), false, "the real connection manager retires the replaced response")
  assert.equal((await send(f.local, "/api/project-participation", headers, { ...payload, revision: 3 })).status, 403)
  assert.equal((await send(f.local, "/api/project-participation", { ...headers, cookie: f.otherCookie, [PARTICIPATION_HEADER]: replacement.token }, { ...payload, revision: 1 })).status, 204)
  for (const invalid of [{ ...payload, revision: 4, profile: "/PRIVATE_CONFIG" }, { ...payload, revision: 5, refs: [{ ...payload.refs[0], serverId: "B" }] }]) {
    const calls = f.calls()
    const response = await send(f.local, "/api/project-participation", { ...headers, cookie: f.otherCookie, [PARTICIPATION_HEADER]: replacement.token }, invalid)
    assert.equal(response.status, 409)
    if ("profile" in invalid) assert.equal(f.calls(), calls)
  }
  assert.equal((await send(f.local, "/api/project-participation", { ...headers, cookie: f.otherCookie, [PARTICIPATION_HEADER]: replacement.token }, { ...payload, revision: 6 })).status, 204)
  assert.doesNotMatch(f.logs.join(""), new RegExp(`${live.token}|${replacement.token}|PARTICIPANT_PRIVATE_PATH|PRIVATE_CONFIG|PRIVATE_UNPARSED`))
})

test("paired ingress can declare only its stream's refs; revocation retires them without host/admin absence", async t => {
  const f = await fixture(t), pairedHeaders = { host: FAKE_TUNNEL_HOST, origin: `https://${FAKE_TUNNEL_HOST}`, "sec-fetch-site": "same-origin" }
  const paired = await send(f.target(), "/api/remote-control/pair", pairedHeaders, { code: f.code })
  assert.equal(paired.status, 200)
  const headers = { ...pairedHeaders, cookie: paired.cookie! }, live = await stream(f.target(), headers)
  t.after(() => live.close())
  const payload = { revision: 1, refs: [{ tabId: randomUUID(), workspaceId: "same", serverId: "A", directory: f.bindings.get("same")!.directory }] }
  assert.equal((await send(f.target(), "/api/project-participation", { ...headers, [PARTICIPATION_HEADER]: live.token }, payload)).status, 204)
  const captured = f.owner.snapshot("A")
  assert.equal(captured.status, "unknown")
  assert.equal((await send(f.target(), "/api/opencode-servers/probe", headers, { origin: "http://127.0.0.1:1" })).status, 404)
  assert.equal((await send(f.target(), "/api/storage/config/server", headers, { opencodeServers: [] })).status >= 400, true)
  f.manager.revokeDevice(f.manager.devices()[0]!.id)
  assert.equal(f.owner.isCurrent(captured.receipt), false)
  assert.equal(f.owner.snapshot("A").status, "unknown")
  assert.equal(f.owner.snapshot("A").unresolvedOwners, 1)
  assert.equal(f.owner.snapshot("A").refs.length, 1)
  assert.equal((await send(f.target(), "/api/project-participation", { ...headers, [PARTICIPATION_HEADER]: live.token }, { ...payload, revision: 2 })).status, 401)
})

test("encoded publication routes, malformed and oversized bodies stay fixed/private before metadata IO", async t => {
  const f = await fixture(t), live = await stream(f.local, f.headers)
  t.after(() => live.close())
  const headers = { ...f.headers, [PARTICIPATION_HEADER]: live.token, "content-type": "application/json" }
  let revision = 0
  for (const [url, payload, expected] of [
    ["/%61pi/project-participation", '{"revision":1,"refs":[],"profile":"PRIVATE_SELECTOR"}', 409],
    ["/api/%70roject-participation", "{PRIVATE_MALFORMED", 400],
    ["/api/project-participation?credential=PRIVATE_QUERY", "{PRIVATE_UNPARSED", 400],
    ["/api/project-participation", JSON.stringify("PRIVATE_OVERSIZE".repeat(80_000)), 413],
  ] as const) {
    const response = await f.app.inject({ method: "POST", url, headers, payload, remoteAddress: "127.0.0.1" })
    assert.equal(response.statusCode, expected)
    assert.equal(response.headers["cache-control"], "no-store")
    assert.equal(response.body, '{"code":"participation_unavailable"}')
    assert.equal(f.calls(), 0)
    assert.equal((await send(f.local, "/api/project-participation", headers, { revision: ++revision, refs: [] })).status, 204)
    assert.equal(f.owner.snapshot("A").status, "unknown")
  }
  assert.doesNotMatch(f.logs.join(""), new RegExp(`${live.token}|PRIVATE_SELECTOR|PRIVATE_MALFORMED|PRIVATE_QUERY|PRIVATE_UNPARSED|PRIVATE_OVERSIZE`))
})

test("both raw query delimiters refuse before body parsing, admission and metadata IO; fresh no-query declarations still publish", async t => {
  const f = await fixture(t), live = await stream(f.local, f.headers)
  t.after(() => live.close())
  const headers = { ...f.headers, [PARTICIPATION_HEADER]: live.token }
  const ref = { tabId: randomUUID(), workspaceId: "same", serverId: "A", directory: f.bindings.get("same")!.directory }
  let revision = 0
  for (const route of ["/api/project-participation", "/%61pi/project-participation", "/api/%70roject-participation"]) {
    for (const delimiter of [";", "?"]) for (const query of ["", "profile", "profile=PRIVATE_QUERY", "profile=PRIVATE_QUERY&config=PRIVATE_CONFIG"]) {
      for (const body of [JSON.stringify({ revision: revision + 1, refs: [ref] }), "{PRIVATE_UNPARSED", "PRIVATE_OVERSIZE".repeat(80_000)]) {
        const before = f.owner.snapshot("A"), calls = f.calls()
        const url = `${route}${delimiter}${query}`
        // Send only a prefix with the oversized declared length: an early refusal can close
        // without racing a megabyte of unread TCP writes. Explicit path preserves bare "?".
        const oversized = body.length > 1024 * 1024
        const response = await send(f.local, url, oversized ? { ...headers, "content-length": String(Buffer.byteLength(body)) } : headers,
          oversized ? "{PRIVATE_UNPARSED" : body, true)
        assert.equal(response.status, 400)
        assert.equal(response.body, '{"code":"participation_unavailable"}')
        assert.equal(response.cache, "no-store")
        assert.equal(response.challenge, undefined)
        assert.equal(f.calls(), calls, "no metadata resolution on refusal")
        assert.equal(f.owner.isCurrent(before.receipt), true, "query refusal precedes even capability admission")
        assert.deepEqual(f.owner.snapshot("A").refs, before.refs)
        // An oversized declared body would produce 413 after admission; the query guard must win.
        assert.equal((await send(f.local, route, headers, { revision: ++revision, refs: [ref] })).status, 204)
        assert.equal(f.owner.snapshot("A").refs[0]!.directory, ref.directory)
      }
    }
  }
  assert.equal(f.owner.snapshot("A").status, "unknown")
  assert.doesNotMatch(f.logs.join(""), new RegExp(`${live.token}|PRIVATE_QUERY|PRIVATE_CONFIG|PRIVATE_UNPARSED|PRIVATE_OVERSIZE|PARTICIPANT_PRIVATE_PATH`))
})

test("encoded reserved separators and raw route case stay non-routable without publication or private diagnostics", async t => {
  const f = await fixture(t), live = await stream(f.local, f.headers)
  t.after(() => live.close())
  const headers = { ...f.headers, [PARTICIPATION_HEADER]: live.token }
  let revision = 0
  for (const [route, status] of [["/API/project-participation", 200], ["/api/PROJECT-PARTICIPATION", 404], ["/api%2Fproject-participation", 200],
    ["/api/project-participation%3Bprofile=PRIVATE_QUERY", 404], ["/api/project-participation%3Fprofile=PRIVATE_QUERY", 404],
    ["/api/project-participation%253Bprofile=PRIVATE_QUERY", 404]] as const) {
    const before = f.owner.snapshot("A"), calls = f.calls()
    const response = await send(f.local, route, headers, { revision: revision + 1, refs: [] })
    assert.equal(response.status, status)
    assert.equal(response.body, status === 404 ? '{"code":"participation_unavailable"}' : "<!doctype html><title>CodeNomad UI</title>")
    assert.equal(response.cache, "no-store")
    assert.equal(response.challenge, undefined)
    assert.equal(f.calls(), calls)
    assert.equal(f.owner.isCurrent(before.receipt), true)
    assert.deepEqual(f.owner.snapshot("A").refs, before.refs)
    assert.equal((await send(f.local, "/api/project-participation", headers, { revision: ++revision, refs: [] })).status, 204)
  }
  const before = f.owner.snapshot("A"), calls = f.calls()
  const invalid = await send(f.local, "/api/project-participation", { ...headers, [PARTICIPATION_HEADER]: "0".repeat(64) }, "{PRIVATE_UNPARSED", true)
  assert.equal(invalid.status, 403)
  assert.equal(invalid.body, '{"code":"participation_unavailable"}')
  assert.equal(f.calls(), calls)
  assert.equal(f.owner.isCurrent(before.receipt), true)
  assert.equal((await send(f.local, "/api/project-participation", headers, { revision: ++revision, refs: [] })).status, 204)
  assert.doesNotMatch(f.logs.join(""), new RegExp(`${live.token}|PRIVATE_QUERY|PRIVATE_UNPARSED`))
})
