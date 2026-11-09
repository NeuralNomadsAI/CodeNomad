import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ServerResponse } from "node:http"
import { test, type TestContext } from "node:test"
import { RemoteServerBrowseManager } from "./browse-manager"
import { CodeNomadServerClient } from "./client"
import { CodeNomadServerCredentials } from "./credentials"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"
import { RELAY_AUTHORITY_HEADER as AUTHORITY, RELAY_BOOTSTRAP } from "./relay-authority"

const STATUS = "/api/auth/status", LOGIN = "/api/auth/login", BUSINESS = "/api/test/once"
const password = { kind: "password" as const, username: "codenomad", password: "schedule-private", cookie: "codenomad_session=initial-private" }
function gate<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function json(res: ServerResponse, body: unknown, code = 200) {
  res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body))
}
function outcome(promise: Promise<unknown>) {
  return promise.then(() => "ok", error => String(error.code ?? error.name))
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("HTTP barrier timed out")), 3000) })]) }
  finally { clearTimeout(timer) }
}
async function fixture(t: TestContext, cookie: string | null = password.cookie) {
  const remote = await startFakeCodeNomad({ anonymous: true })
  const persisted: string[] = []
  let rejected = 0
  const client = new CodeNomadServerClient(remote.origin, { ...password, cookie: cookie ?? undefined }, {
    onRejected: () => { rejected++ }, onSecretChanged: secret => { persisted.push(secret.cookie ?? "") },
  })
  remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: true }))
  remote.state.handlers.set("/api/test/barrier", (_req, res) => json(res, {}))
  t.after(async () => { client.close(); await remote.close() })
  const count = (route: string) => remote.state.requests.filter(req => req.path === route).length
  const barrier = async () => { await (await fetch(remote.origin + "/api/test/barrier")).text() }
  return { remote, client, persisted, count, barrier, rejected: () => rejected }
}
async function managerFixture(t: TestContext, cookie: string | null = password.cookie) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-auth-schedules-"))
  const remote = await startFakeCodeNomad({ anonymous: true })
  const other = await startFakeCodeNomad({ anonymous: true })
  const file = path.join(directory, "remote-server-credentials.json")
  const credentials = new CodeNomadServerCredentials(file)
  credentials.set("saved", remote.origin, { ...password, cookie: cookie ?? undefined })
  credentials.set("other", other.origin, password)
  const profiles = [{ id: "saved", baseUrl: remote.origin }, { id: "other", baseUrl: other.origin }]
  const manager = new RemoteServerBrowseManager({ getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(directory, "config.yaml") })
  t.after(async () => { manager.close(); await Promise.all([remote.close(), other.close()]); fs.rmSync(directory, { recursive: true }) })
  for (const [server, id] of [[remote, "A"], [other, "B"]] as const) {
    server.state.handlers.set("/api/meta", (_req, res) => json(res, { serverId: id, apiContract: 1 }))
    server.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: true }))
    // Deliberately successful without a cookie: permits real proof/SSE admission
    // while retaining the password client's preliminary-login path for F4.
    server.state.handlers.set(LOGIN, (req, res) => { req.resume(); json(res, {}) })
  }
  const admit = async (id: string) => {
    const response = await manager.relay(id, "/api/meta", {}, RELAY_BOOTSTRAP)
    await response.text()
    const proof = response.headers.get(AUTHORITY)!
    assert.match(proof, /^[A-Za-z0-9_-]{43}$/)
    return proof
  }
  const proof = await admit("saved"), bProof = await admit("other")
  const live = async (id: string, authority: string, server = remote) => {
    let upstream!: ServerResponse
    server.state.handlers.set("/api/events", (_req, res) => { upstream = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: initial\n\n") })
    const response = await manager.relay(id, "/api/events", {}, authority)
    const reader = response.body!.getReader()
    assert.equal((await bounded(reader.read())).done, false)
    const closed = gate(); upstream.once("close", () => closed.resolve())
    t.after(() => reader.cancel().catch(() => {}))
    return {
      async revoked() {
        await bounded(closed.promise)
        const end = await bounded(reader.read().then(chunk => chunk.done ? "closed" : "data", () => "closed"))
        assert.equal(end, "closed", "revocation closes the existing SSE without an upstream write")
      },
      async tick() {
        const next = reader.read()
        upstream.write("data: live\n\n")
        assert.equal(new TextDecoder().decode((await bounded(next)).value), "data: live\n\n")
      },
    }
  }
  const revoked = async (stream: Awaited<ReturnType<typeof live>>) => {
    assert.equal(new CodeNomadServerCredentials(file).has("saved", remote.origin), false)
    assert.throws(() => manager.assertProof("saved", proof), { code: "unreachable" })
    await stream.revoked()
    const requests = remote.state.requests.length
    await assert.rejects(manager.relay("saved", STATUS, {}, proof), { code: "unreachable" })
    assert.equal(remote.state.requests.length, requests, "stale proof refuses before HTTP")
  }
  const healthyB = async () => {
    manager.assertProof("other", bProof)
    assert.deepEqual(new CodeNomadServerCredentials(file).read("other", other.origin), password)
    assert.deepEqual(await (await manager.relay("other", STATUS, {}, bProof)).json(), { authenticated: true })
  }
  return { remote, other, file, manager, proof, bProof, admit, live, revoked, healthyB }
}

test("F1: completed status is fresh despite a slow business lease; false revokes vault, proof and SSE", async t => {
  const f = await managerFixture(t), stream = await f.live("saved", f.proof)
  const held = gate(), release = gate()
  f.remote.state.handlers.set(BUSINESS, (_req, res) => { held.resolve(); void release.promise.then(() => { if (!res.destroyed) json(res, { once: true }, 401) }) })
  const slow = outcome(f.manager.relay("saved", BUSINESS, {}, f.proof))
  await bounded(held.promise)
  let statuses = 0
  f.remote.state.handlers.set(STATUS, (_req, res) => json(res, ++statuses === 1 ? { authenticated: true } : { authenticated: false, pairingRequired: true }))
  assert.deepEqual(await (await f.manager.relay("saved", STATUS, {}, f.proof)).json(), { authenticated: true })
  const next = await f.manager.relay("saved", STATUS, {}, f.proof)
  assert.deepEqual(await next.json(), { authenticated: false, pairingRequired: true })
  assert.equal(statuses, 2)
  await f.revoked(stream)
  release.resolve(); assert.notEqual(await slow, "ok")
  await f.healthyB()
})

test("F1: new business 401 gets fresh status while old business retains its completed episode quotas", async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  let business = 0, statuses = 0, logins = 0
  f.remote.state.handlers.set(BUSINESS, (_req, res) => {
    if (++business === 1) { entered.resolve(); void release.promise.then(() => json(res, { original: "old" }, 401)) }
    else json(res, { original: "new" }, 401)
  })
  // First episode spends its full quota. A genuinely new operation needs its
  // own fresh observation; the admitted old operation must not get a new one.
  f.remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: ++statuses !== 1 }))
  f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); logins++; json(res, {}) })
  const slow = f.client.fetch(BUSINESS, {}, "observe-status")
  await bounded(entered.promise)
  assert.deepEqual(await (await f.client.fetch(STATUS, {}, "observe-status")).json(), { authenticated: true })
  assert.deepEqual({ statuses, logins }, { statuses: 2, logins: 1 })
  const fresh = await f.client.fetch(BUSINESS, {}, "observe-status")
  assert.equal(fresh.status, 401); assert.deepEqual(await fresh.json(), { original: "new" })
  assert.deepEqual({ statuses, logins }, { statuses: 3, logins: 1 })
  release.resolve()
  const old = await slow
  assert.equal(old.status, 401); assert.deepEqual(await old.json(), { original: "old" })
  assert.deepEqual({ statuses, logins, business }, { statuses: 3, logins: 1, business: 2 })
  assert.equal(f.rejected(), 0)
})

test("F1: old business 401 consumes its remaining GET instead of reusing the completed verdict", async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  let businesses = 0, statuses = 0
  f.remote.state.handlers.set(BUSINESS, (_req, res) => {
    if (++businesses === 1) { entered.resolve(); void release.promise.then(() => json(res, { original: "old" }, 401)) }
    else json(res, { original: "new" }, 401)
  })
  f.remote.state.handlers.set(STATUS, (_req, res) => json(res, ++statuses <= 2 ? { authenticated: true } : { authenticated: false, pairingRequired: true }))
  const slow = outcome(f.client.fetch(BUSINESS, {}, "observe-status"))
  await bounded(entered.promise)
  assert.deepEqual(await (await f.client.fetch(STATUS, {}, "observe-status")).json(), { authenticated: true })
  const fresh = await f.client.fetch(BUSINESS, {}, "observe-status")
  assert.equal(fresh.status, 401); assert.deepEqual(await fresh.json(), { original: "new" })
  assert.equal(statuses, 2)
  release.resolve()
  assert.equal(await slow, "auth", "old lease must observe current false with its remaining GET")
  assert.deepEqual([statuses, f.count(LOGIN), businesses, f.rejected()], [3, 0, 2, 1])
})

test("first follower aborts during private login; survivor retains two-status/one-login budget", async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  let statuses = 0
  f.remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: ++statuses > 1 }))
  f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); entered.resolve(); void release.promise.then(() => { res.setHeader("set-cookie", "codenomad_session=rotated"); json(res, {}) }) })
  const controller = new AbortController()
  const first = outcome(f.client.fetch(STATUS, { signal: controller.signal }, "observe-status"))
  await bounded(entered.promise)
  const second = f.client.fetch(STATUS, {}, "observe-status")
  controller.abort(); release.resolve()
  assert.notEqual(await first, "ok")
  assert.deepEqual(await (await second).json(), { authenticated: true })
  assert.deepEqual([statuses, f.count(LOGIN), f.rejected()], [2, 1, 0])
  assert.deepEqual(f.persisted, ["codenomad_session=rotated"])
})

test("F2: blocking persistence callback fences dispatch before the expired timer executes", { timeout: 15000 }, async t => {
  const remote = await startFakeCodeNomad({ anonymous: true })
  const dispatches: number[] = []
  let start = 0, statuses = 0, persisted = 0, rejected = 0
  remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: ++statuses > 1 }))
  remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); res.setHeader("set-cookie", "codenomad_session=rotated"); json(res, {}) })
  const client = new CodeNomadServerClient(remote.origin.replace("127.0.0.1", "schedule.test"), password, {
    resolve: async () => { dispatches.push(performance.now() - start); return [{ address: "127.0.0.1", family: 4 }] },
    onRejected: () => { rejected++ },
    onSecretChanged: () => { persisted++; while (performance.now() - start < 8150) { /* Explicit synchronous persistence stall, real deadline. */ } },
  })
  t.after(async () => { client.close(); await remote.close() })
  start = performance.now()
  assert.equal(await outcome(client.fetch(STATUS, {}, "observe-status")), "unreachable")
  assert.equal(persisted, 1)
  assert.equal(dispatches.length, 2, "only initial status and login resolve DNS")
  assert.equal(dispatches.some(ms => ms >= 8000), false, "no dispatch after logical expiry")
  assert.equal(statuses, 1)
  assert.equal(rejected, 0, "logical expiry alone never revokes auth")
})

test("F3: cancelling last observed follower preserves the independent legacy login owner", async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); entered.resolve(); void release.promise.then(() => { if (!res.destroyed) json(res, {}) }) })
  const legacy = outcome(f.client.login())
  await bounded(entered.promise)
  const controller = new AbortController()
  const observed = outcome(f.client.fetch(STATUS, { signal: controller.signal }, "observe-status"))
  await f.barrier()
  controller.abort(); assert.notEqual(await observed, "ok")
  await f.barrier(); release.resolve()
  assert.equal(await legacy, "ok")
  assert.deepEqual([f.count(LOGIN), f.count(STATUS), f.rejected()], [1, 0, 0])
})

for (const code of [400, 401]) test(`F4: preliminary login ${code} revokes via surviving follower only; B and new owner work`, async t => {
  const f = await managerFixture(t, null), stream = await f.live("saved", f.proof)
  const bStream = await f.live("other", f.bProof, f.other)
  const entered = gate(), release = gate()
  const beforeLogin = f.remote.state.requests.filter(req => req.path === LOGIN).length
  const saved = fs.readFileSync(f.file, "utf8")
  let logins = 0, businesses = 0
  f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); logins++; entered.resolve(); void release.promise.then(() => json(res, {}, code)) })
  f.remote.state.handlers.set(BUSINESS, (_req, res) => { businesses++; json(res, {}) })
  const controller = new AbortController()
  const first = outcome(f.manager.relay("saved", BUSINESS, { signal: controller.signal }, f.proof))
  await bounded(entered.promise)
  const second = outcome(f.manager.relay("saved", BUSINESS, {}, f.proof))
  controller.abort(); assert.notEqual(await first, "ok")
  f.manager.assertProof("saved", f.proof)
  assert.equal(fs.readFileSync(f.file, "utf8"), saved, "cancelled initiator has no destructive authority")
  await stream.tick()
  release.resolve()
  assert.equal(await second, "auth")
  assert.deepEqual({ logins, businesses }, { logins: 1, businesses: 0 })
  assert.equal(f.remote.state.requests.filter(req => req.path === LOGIN).length - beforeLogin, 1)
  await f.revoked(stream); await f.healthyB(); await bStream.tick()
  f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); res.setHeader("set-cookie", "codenomad_session=replacement"); json(res, {}) })
  await f.manager.connect("saved", { username: password.username, password: "new-principal" })
  const proof = await f.admit("saved"), replacement = await f.live("saved", proof)
  assert.notEqual(proof, f.proof)
  assert.deepEqual(await (await f.manager.relay("saved", STATUS, {}, proof)).json(), { authenticated: true })
  assert.equal(new CodeNomadServerCredentials(f.file).read("saved", f.remote.origin)?.cookie, "codenomad_session=replacement")
  await replacement.tick(); await f.healthyB()
})

test("F4: surviving preliminary-login followers publish rejection exactly once", async t => {
  const f = await fixture(t, null), entered = gate(), release = gate()
  f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); entered.resolve(); void release.promise.then(() => json(res, {}, 401)) })
  const controller = new AbortController()
  const first = outcome(f.client.fetch(BUSINESS, { signal: controller.signal }, "observe-status"))
  await bounded(entered.promise)
  const second = outcome(f.client.fetch(BUSINESS, {}, "observe-status"))
  const third = outcome(f.client.fetch(BUSINESS, {}, "observe-status"))
  controller.abort(); assert.notEqual(await first, "ok")
  assert.equal(f.rejected(), 0)
  release.resolve()
  assert.deepEqual(await Promise.all([second, third]), ["auth", "auth"])
  assert.deepEqual([f.rejected(), f.count(LOGIN), f.count(BUSINESS), f.count(STATUS)], [1, 1, 0, 0])
})

test("cancellation after private login preserves second status for surviving follower", async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  let statuses = 0
  f.remote.state.handlers.set(STATUS, (_req, res) => {
    if (++statuses === 1) json(res, { authenticated: false })
    else { entered.resolve(); void release.promise.then(() => json(res, { authenticated: true })) }
  })
  f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); json(res, {}) })
  const controller = new AbortController()
  const first = outcome(f.client.fetch(STATUS, { signal: controller.signal }, "observe-status"))
  await bounded(entered.promise)
  const second = f.client.fetch(STATUS, {}, "observe-status")
  controller.abort(); release.resolve()
  assert.notEqual(await first, "ok")
  assert.deepEqual(await (await second).json(), { authenticated: true })
  assert.deepEqual([statuses, f.count(LOGIN), f.rejected()], [2, 1, 0])
})

test("F2: status settlement is unknown after a blocking cookie callback starves the timer", { timeout: 15000 }, async t => {
  const remote = await startFakeCodeNomad({ anonymous: true })
  let start = 0, persisted = 0, rejected = 0
  remote.state.handlers.set(STATUS, (_req, res) => { res.setHeader("set-cookie", "codenomad_session=status-rotation"); json(res, { authenticated: true }) })
  const client = new CodeNomadServerClient(remote.origin, password, { onRejected: () => { rejected++ }, onSecretChanged: () => { persisted++; while (performance.now() - start < 8150) { /* Starve timer through body/settlement continuation. */ } } })
  t.after(async () => { client.close(); await remote.close() })
  start = performance.now()
  assert.equal(await outcome(client.fetch(STATUS, {}, "observe-status")), "unreachable")
  assert.equal(persisted, 1)
  assert.equal(rejected, 0)
  assert.equal(remote.state.requests.filter(req => req.path === STATUS).length, 1)
})

test("replacement starts immediately after all old followers abort; late login cannot persist", async t => {
  const f = await fixture(t), entered = gate(), release = gate(), released = gate()
  let statuses = 0, logins = 0
  f.remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: ++statuses >= 3 }))
  f.remote.state.handlers.set(LOGIN, (req, res) => {
    req.resume()
    if (++logins === 1) {
      entered.resolve()
      void release.promise.then(() => { if (!res.destroyed) { res.setHeader("set-cookie", "codenomad_session=old"); json(res, {}) } released.resolve() })
    } else { res.setHeader("set-cookie", "codenomad_session=fresh"); json(res, {}) }
  })
  const controller = new AbortController()
  const first = outcome(f.client.fetch(STATUS, { signal: controller.signal }, "observe-status"))
  await bounded(entered.promise); controller.abort(); assert.notEqual(await first, "ok")
  // No socket-close or old-finally barrier before the replacement admission.
  assert.deepEqual(await (await f.client.fetch(STATUS, {}, "observe-status")).json(), { authenticated: true })
  release.resolve(); await released.promise; await f.barrier()
  assert.deepEqual([statuses, logins, f.rejected()], [3, 2, 0])
  assert.deepEqual(f.persisted, ["codenomad_session=fresh"])
})

for (const cancelled of ["owner", "follower"] as const) test(`legacy login overlap preserves baseline ${cancelled} signal semantics`, async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); entered.resolve(); void release.promise.then(() => { if (!res.destroyed) { res.setHeader("set-cookie", "codenomad_session=renewed"); json(res, {}) } }) })
  const owner = new AbortController(), follower = new AbortController()
  const first = outcome(f.client.login(owner.signal))
  await bounded(entered.promise)
  const second = outcome(f.client.login(follower.signal))
  ;(cancelled === "owner" ? owner : follower).abort()
  await f.barrier(); release.resolve()
  assert.deepEqual(await Promise.all([first, second]), cancelled === "owner" ? ["timeout", "timeout"] : ["ok", "ok"])
  assert.equal(f.count(LOGIN), 1); assert.equal(f.rejected(), 0)
  assert.deepEqual(f.persisted, cancelled === "owner" ? [] : ["codenomad_session=renewed"])
})

test("public legacy follower promotes a private login before its last observed owner departs", async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  let statuses = 0
  f.remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: ++statuses > 1 }))
  f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); entered.resolve(); void release.promise.then(() => { if (!res.destroyed) { res.setHeader("set-cookie", "codenomad_session=promoted"); json(res, {}) } }) })
  const controller = new AbortController(), legacyFollower = new AbortController()
  const observed = outcome(f.client.fetch(STATUS, { signal: controller.signal }, "observe-status"))
  await bounded(entered.promise)
  const legacy = outcome(f.client.login(legacyFollower.signal))
  // Baseline follower signals never become the existing exchange's owner.
  legacyFollower.abort(); controller.abort()
  assert.notEqual(await observed, "ok")
  await f.barrier(); release.resolve()
  assert.equal(await legacy, "ok")
  assert.deepEqual([statuses, f.count(LOGIN), f.rejected()], [1, 1, 0])
  assert.deepEqual(f.persisted, ["codenomad_session=promoted"])
  assert.deepEqual(await (await f.client.fetch(STATUS, {}, "observe-status")).json(), { authenticated: true })
  assert.deepEqual([statuses, f.count(LOGIN)], [2, 1])
})

test("legacy owner cancellation leaves observed business 401 readable as unknown", async t => {
  const f = await fixture(t), entered = gate(), release = gate(), businessEntered = gate()
  f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); entered.resolve(); void release.promise.then(() => { if (!res.destroyed) json(res, {}, 401) }) })
  f.remote.state.handlers.set(BUSINESS, (_req, res) => { businessEntered.resolve(); res.writeHead(401); res.end("original-401") })
  const controller = new AbortController(), legacy = outcome(f.client.login(controller.signal))
  await bounded(entered.promise)
  const business = f.client.fetch(BUSINESS, {}, "observe-status")
  await bounded(businessEntered.promise); await f.barrier()
  controller.abort(); assert.equal(await legacy, "timeout")
  const response = await business
  assert.equal(response.status, 401); assert.equal(await response.text(), "original-401")
  release.resolve(); await f.barrier()
  assert.deepEqual([f.count(LOGIN), f.count(STATUS), f.count(BUSINESS), f.rejected(), f.persisted.length], [1, 0, 1, 0, 0])
})

test("deadline closes retained private login; late cleanup cannot affect fresh restoration", { timeout: 15000 }, async t => {
  const f = await fixture(t), entered = gate(), closed = gate(), release = gate(), released = gate()
  let statuses = 0, logins = 0
  f.remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: ++statuses >= 3 }))
  f.remote.state.handlers.set(LOGIN, (req, res) => {
    req.resume()
    if (++logins === 1) {
      entered.resolve(); res.once("close", () => closed.resolve())
      void release.promise.then(() => { if (!res.destroyed) { res.setHeader("set-cookie", "codenomad_session=late"); json(res, {}) } released.resolve() })
    } else { res.setHeader("set-cookie", "codenomad_session=fresh"); json(res, {}) }
  })
  const start = performance.now(), first = outcome(f.client.fetch(STATUS, {}, "observe-status"))
  await bounded(entered.promise)
  assert.equal(await first, "unreachable")
  assert(performance.now() - start >= 7600, "real eight-second expiry")
  await bounded(closed.promise)
  release.resolve(); await released.promise
  assert.deepEqual(await (await f.client.fetch(STATUS, {}, "observe-status")).json(), { authenticated: true })
  await f.barrier()
  assert.deepEqual([statuses, logins, f.rejected()], [3, 2, 0])
  assert.deepEqual(f.persisted, ["codenomad_session=fresh"])
})

test("reentrant cookie callback joins published observation without another restoration", async t => {
  const remote = await startFakeCodeNomad({ anonymous: true })
  let statuses = 0, logins = 0, rejected = 0
  let reentrant: Promise<Response> | undefined
  const client = new CodeNomadServerClient(remote.origin, password, {
    onSecretChanged: () => { reentrant = client.fetch(STATUS, {}, "observe-status"); void reentrant.catch(() => {}) },
    onRejected: () => { rejected++ },
  })
  t.after(async () => { client.close(); await remote.close() })
  remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: ++statuses > 1 }))
  remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); logins++; res.setHeader("set-cookie", "codenomad_session=reentrant"); json(res, {}) })
  assert.deepEqual(await (await client.fetch(STATUS, {}, "observe-status")).json(), { authenticated: true })
  assert.ok(reentrant, "real Set-Cookie invoked callback")
  assert.deepEqual(await (await reentrant).json(), { authenticated: true })
  assert.deepEqual({ statuses, logins, rejected }, { statuses: 2, logins: 1, rejected: 0 })
})
