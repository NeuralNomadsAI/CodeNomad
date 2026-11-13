import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import type { ServerResponse } from "node:http"
import { CodeNomadServerClient } from "./client"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"

const STATUS = "/api/auth/status", LOGIN = "/api/auth/login", BUSINESS = "/api/test/slow"
const secret = { kind: "password" as const, username: "codenomad", password: "r2-private", cookie: "codenomad_session=initial" }
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function json(res: ServerResponse, body: unknown, code = 200) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)) }
function result(promise: Promise<Response>) { return promise.then(async res => ({ status: res.status, body: await res.text() }), error => ({ error: String(error.code ?? error.name) })) }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("barrier timeout")), 3000) })]) }
  finally { clearTimeout(timer) }
}

for (const ownerOld of [true, false]) for (const cancelOriginating of [true, false]) test(`r2: surviving ${ownerOld ? "fresh" : "retired"} flight borrows private login; originating cancellation=${cancelOriginating}`, async t => {
  const remote = await startFakeCodeNomad({ anonymous: true })
  const persisted: string[] = []; let rejected = 0, statuses = 0, logins = 0
  const client = new CodeNomadServerClient(remote.origin, secret, { onSecretChanged: value => { persisted.push(value.cookie!) }, onRejected: () => { rejected++ } })
  t.after(async () => { client.close(); await remote.close() })
  const businessEntered = gate(), releaseBusiness = gate(), loginEntered = gate(), releaseLogin = gate()
  remote.state.handlers.set("/api/test/barrier", (_req, res) => json(res, {}))
  const barrier = async () => { await (await fetch(remote.origin + "/api/test/barrier")).text() }
  remote.state.handlers.set(BUSINESS, (_req, res) => { businessEntered.resolve(); void releaseBusiness.promise.then(() => json(res, { original: true }, 401)) })
  remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: ++statuses === 1 || persisted.length > 0 }))
  remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); logins++; loginEntered.resolve(); void releaseLogin.promise.then(() => { if (!res.destroyed) { res.setHeader("set-cookie", "codenomad_session=restored"); json(res, {}) } }) })
  const oldController = new AbortController(), freshController = new AbortController()
  const old = result(client.fetch(BUSINESS, { signal: oldController.signal }, "observe-status"))
  await bounded(businessEntered.promise)
  assert.deepEqual(await (await client.fetch(STATUS, {}, "observe-status")).json(), { authenticated: true })
  let fresh: ReturnType<typeof result>
  if (ownerOld) {
    releaseBusiness.resolve(); await bounded(loginEntered.promise)
    fresh = result(client.fetch(STATUS, { signal: freshController.signal }, "observe-status"))
  } else {
    fresh = result(client.fetch(STATUS, { signal: freshController.signal }, "observe-status"))
    await bounded(loginEntered.promise); releaseBusiness.resolve()
  }
  await barrier()
  // Two independent HTTP round trips admit the held business response's continuations.
  await barrier()
  assert.deepEqual([statuses, logins], [2, 1], "borrower waits on existing login rather than issuing status/login")
  const originating = ownerOld ? old : fresh!, surviving = ownerOld ? fresh! : old
  if (cancelOriginating) {
    ;(ownerOld ? oldController : freshController).abort()
    await bounded(originating)
  }
  releaseLogin.resolve()
  const actual = await bounded(surviving)
  if (!cancelOriginating) await bounded(originating)
  const expected = ownerOld ? { status: 200, body: JSON.stringify({ authenticated: true }) } : { status: 401, body: JSON.stringify({ original: true }) }
  assert.deepEqual(actual, expected)
  // A cancelled fresh origin spends no final GET: initial old GET + fresh false
  // + surviving old GET = three. With both live, the fresh final GET makes four.
  assert.deepEqual([statuses, logins, persisted.length, rejected], [ownerOld ? 3 : cancelOriginating ? 3 : 4, 1, 1, 0], "only live flights get post-login status; exactly one cookie effect")
})

test("r2: concurrent retired observations keep old quota; old finally and release preserve replacement flight", async t => {
  const remote = await startFakeCodeNomad({ anonymous: true })
  const client = new CodeNomadServerClient(remote.origin, { kind: "session", cookie: "codenomad_session=old" })
  t.after(async () => { client.close(); await remote.close() })
  const entered = [gate(), gate(), gate()], release = [gate(), gate(), gate()]
  const freshEntered = gate(), oldEntered = gate(), releaseFresh = gate(), releaseOld = gate()
  let businesses = 0, statuses = 0
  remote.state.handlers.set(BUSINESS, (req, res) => { const i = Number(new URL(req.url!, remote.origin).searchParams.get("i")); businesses++; entered[i]!.resolve(); void release[i]!.promise.then(() => json(res, { original: i }, 401)) })
  remote.state.handlers.set(STATUS, (_req, res) => {
    const i = ++statuses
    if (i === 1) json(res, { authenticated: true })
    else if (i === 2) { freshEntered.resolve(); void releaseFresh.promise.then(() => json(res, { authenticated: true })) }
    else { oldEntered.resolve(); void releaseOld.promise.then(() => json(res, { authenticated: true })) }
  })
  remote.state.handlers.set("/api/test/barrier", (_req, res) => json(res, {}))
  const barrier = async () => { await (await fetch(remote.origin + "/api/test/barrier")).text() }
  const old = entered.map((_, i) => result(client.fetch(BUSINESS + "?i=" + i, {}, "observe-status")))
  await bounded(Promise.all(entered.map(item => item.promise)))
  await (await client.fetch(STATUS, {}, "observe-status")).text()
  const fresh = result(client.fetch(STATUS, {}, "observe-status")); await bounded(freshEntered.promise)
  release[0]!.resolve(); await bounded(oldEntered.promise)
  release[1]!.resolve(); await barrier()
  assert.equal(statuses, 3, "concurrent old lease shares old observation")
  releaseOld.resolve(); await bounded(Promise.all(old.slice(0, 2)))
  const follower = result(client.fetch(STATUS, {}, "observe-status")); await barrier()
  assert.equal(statuses, 3, "old finally did not clear active replacement")
  release[2]!.resolve(); const exhausted = await bounded(old[2]!)
  assert.deepEqual(exhausted, { status: 401, body: JSON.stringify({ original: 2 }) })
  const afterRelease = result(client.fetch(STATUS, {}, "observe-status")); await barrier()
  assert.equal(statuses, 3, "old release and exhausted observation did not clear active replacement or reset quota")
  releaseFresh.resolve()
  const results = await bounded(Promise.all([fresh, follower, afterRelease]))
  assert.deepEqual(results, Array.from({ length: 3 }, () => ({ status: 200, body: JSON.stringify({ authenticated: true }) })))
  assert.equal(statuses, 3)
  assert.equal(businesses, 3, "business operations are never replayed")
  assert.equal(remote.state.requests.filter(req => req.path === LOGIN).length, 0)
})

for (const code of [400, 401]) test(`r2: legacy filesystem recovery promoted from private login publishes rejection ${code} after observed departure`, async t => {
  const remote = await startFakeCodeNomad({ anonymous: true })
  let rejected = 0, statuses = 0, logins = 0
  const client = new CodeNomadServerClient(remote.origin, secret, { onRejected: () => { rejected++ } })
  t.after(async () => { client.close(); await remote.close() })
  const loginEntered = gate(), releaseLogin = gate(), legacyEntered = gate()
  remote.state.handlers.set(STATUS, (_req, res) => { statuses++; json(res, { authenticated: false }) })
  remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); logins++; loginEntered.resolve(); void releaseLogin.promise.then(() => { if (!res.destroyed) json(res, {}, code) }) })
  remote.state.handlers.set("/api/filesystem", (_req, res) => { legacyEntered.resolve(); json(res, {}, 401) })
  remote.state.handlers.set("/api/test/barrier", (_req, res) => json(res, {}))
  const barrier = async () => { await (await fetch(remote.origin + "/api/test/barrier")).text() }
  const controller = new AbortController()
  const observed = result(client.fetch(STATUS, { signal: controller.signal }, "observe-status"))
  await bounded(loginEntered.promise)
  // The legacy client path used by browse-manager.ts.
  const legacy = result(client.fetch("/api/filesystem"))
  await bounded(legacyEntered.promise); await barrier(); await barrier()
  controller.abort(); await bounded(observed)
  releaseLogin.resolve()
  assert.deepEqual(await bounded(legacy), { error: "auth" }, "legacy owner remains alive and receives confirmed credential rejection")
  assert.deepEqual([statuses, logins, rejected], [1, 1, 1], "legacy destructive intent publishes rejection once")
})

async function crossFlight(t: TestContext, ownerOld: boolean, stagger = false, stallCookie = false, admissionDelay = 2000) {
  const remote = await startFakeCodeNomad({ anonymous: true })
  const persisted: string[] = []
  let rejected = 0, statuses = 0, logins = 0, businesses = 0
  let started = 0
  const client = new CodeNomadServerClient(remote.origin, secret, {
    onSecretChanged: value => {
      persisted.push(value.cookie!)
      if (stallCookie) while (performance.now() - started < 8150) { /* Real synchronous callback starves the old lease's abort timer. */ }
    }, onRejected: () => { rejected++ },
  })
  const businessEntered = gate(), releaseBusiness = gate(), loginEntered = gate()
  const releaseLogin = gate(), loginClosed = gate(), loginReleased = gate()
  let loginCode = 200, admissionTimer: ReturnType<typeof setTimeout> | undefined
  t.after(async () => { clearTimeout(admissionTimer); client.close(); await remote.close() })
  remote.state.handlers.set("/api/test/barrier", (_req, res) => json(res, {}))
  // A real HTTP response admits the new lease two seconds after the old lease.
  // The only other wait is the product's own eight-second deadline.
  remote.state.handlers.set("/api/test/admit", (_req, res) => { admissionTimer = setTimeout(() => json(res, {}), admissionDelay) })
  const barrier = async () => { await (await fetch(remote.origin + "/api/test/barrier")).text() }
  remote.state.handlers.set(BUSINESS, (_req, res) => {
    businesses++; businessEntered.resolve()
    void releaseBusiness.promise.then(() => { if (!res.destroyed) json(res, { original: true }, 401) })
  })
  remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: ++statuses === 1 || persisted.length > 0 }))
  remote.state.handlers.set(LOGIN, (req, res) => {
    req.resume(); logins++; loginEntered.resolve(); res.once("close", () => loginClosed.resolve())
    void releaseLogin.promise.then(() => {
      if (!res.destroyed) {
        if (loginCode === 200) res.setHeader("set-cookie", "codenomad_session=restored")
        json(res, {}, loginCode)
      }
      loginReleased.resolve()
    })
  })
  const oldController = new AbortController(), freshController = new AbortController()
  started = performance.now()
  const old = result(client.fetch(BUSINESS, { signal: oldController.signal }, "observe-status"))
  await bounded(businessEntered.promise)
  assert.deepEqual(await (await client.fetch(STATUS, {}, "observe-status")).json(), { authenticated: true })
  if (ownerOld) { releaseBusiness.resolve(); await bounded(loginEntered.promise) }
  if (stagger) await (await fetch(remote.origin + "/api/test/admit")).text()
  const freshStarted = performance.now()
  const fresh = result(client.fetch(STATUS, { signal: freshController.signal }, "observe-status"))
  if (!ownerOld) { await bounded(loginEntered.promise); releaseBusiness.resolve() }
  await barrier(); await barrier()
  assert.deepEqual([statuses, logins, businesses], [2, 1, 1], "separate leases borrow one login without replay")
  return {
    remote, client, old, fresh, oldController, freshController, persisted, started, freshStarted, barrier,
    loginClosed, loginReleased,
    release(code = 200) { loginCode = code; releaseLogin.resolve() },
    counts: () => [statuses, logins, businesses, persisted.length, rejected],
  }
}

for (const ownerOld of [true, false]) test(`r2: ${ownerOld ? "originating" : "borrowing"} AuthFlight expires while the other remains live`, async t => {
  const f = await crossFlight(t, ownerOld, true)
  assert.deepEqual(await f.old, { status: 401, body: JSON.stringify({ original: true }) }, "expired old business keeps its original readable 401")
  assert.ok(performance.now() - f.started >= 7600, "the real eight-second lease deadline elapsed")
  assert.deepEqual(f.counts(), [2, 1, 1, 0, 0], "expiry alone has no cookie or rejection effect")
  f.release()
  assert.deepEqual(await bounded(f.fresh), { status: 200, body: JSON.stringify({ authenticated: true }) })
  assert.deepEqual(f.counts(), [3, 1, 1, 1, 0], "the still-live lease completes the same login and its own final GET")
  assert.deepEqual(f.persisted, ["codenomad_session=restored"])
})

for (const ownerOld of [true, false]) test(`r2: cancelling the ${ownerOld ? "fresh" : "retired"} borrower preserves the originating private login`, async t => {
  const f = await crossFlight(t, ownerOld)
  const borrower = ownerOld ? f.fresh : f.old
  ;(ownerOld ? f.freshController : f.oldController).abort()
  assert.ok("error" in await bounded(borrower), "only the cancelled borrower fails")
  f.release()
  const origin = await bounded(ownerOld ? f.old : f.fresh)
  assert.deepEqual(origin, ownerOld ? { status: 401, body: JSON.stringify({ original: true }) } : { status: 200, body: JSON.stringify({ authenticated: true }) })
  // The old origin already spent both GETs; cancelling its fresh borrower
  // leaves no eligible final GET. A surviving fresh origin still has one.
  assert.deepEqual(f.counts(), [ownerOld ? 2 : 3, 1, 1, 1, 0])
})

test("r2: cookie callback starves origin deadline timer; live borrower still owns login settlement", async t => {
  const f = await crossFlight(t, true, true, true)
  f.release()
  const [old, fresh] = await Promise.all([f.old, f.fresh])
  assert.ok(performance.now() - f.started >= 8150, "callback crossed the origin's real deadline before its timer ran")
  assert.deepEqual(old, { status: 401, body: JSON.stringify({ original: true }) })
  assert.deepEqual(fresh, { status: 200, body: JSON.stringify({ authenticated: true }) }, "post-cookie check uses the live borrower, not the captured origin")
  assert.deepEqual(f.counts(), [3, 1, 1, 1, 0])
})

test("r2: live borrower cannot extend the physical login's ten-second timeout", async t => {
  const f = await crossFlight(t, true, true, false, 4000)
  assert.deepEqual(await f.old, { status: 401, body: JSON.stringify({ original: true }) })
  const fresh = await f.fresh
  assert.deepEqual(fresh, { error: "timeout" }, "physical timeout remains unknown, never a credential rejection")
  assert.ok(performance.now() - f.started >= 9700, "the physical ten-second deadline elapsed")
  assert.ok(performance.now() - f.freshStarted < 8000, "borrower was still inside its own lease deadline")
  await bounded(f.loginClosed.promise)
  f.release(401); await bounded(f.loginReleased.promise); await f.barrier()
  assert.deepEqual(f.counts(), [2, 1, 1, 0, 0], "late rejection after physical timeout has no effects")
})

for (const ownerOld of [true, false]) for (const code of [200, 400, 401]) test(`r2: all cross-flight owners cancelled; late login ${code} has zero effects; old origin=${ownerOld}`, async t => {
  const f = await crossFlight(t, ownerOld)
  f.oldController.abort(); f.freshController.abort()
  const departed = await bounded(Promise.all([f.old, f.fresh]))
  assert.ok(departed.every(value => "error" in value))
  f.release(code); await bounded(f.loginReleased.promise); await f.barrier()
  assert.deepEqual(f.counts(), [2, 1, 1, 0, 0], "closed exchange cannot persist a late cookie or publish rejection")
  await bounded(f.loginClosed.promise)
  // An immediate real replacement proves late cleanup left no stale login pointer.
  f.remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: true }))
  assert.deepEqual(await (await f.client.fetch(STATUS, {}, "observe-status")).json(), { authenticated: true })
  assert.deepEqual(f.counts(), [2, 1, 1, 0, 0])
})

for (const ownerOld of [true, false]) for (const code of [400, 401]) test(`r2: private login ${code} rejection publishes once across separate AuthFlights; old origin=${ownerOld}`, async t => {
  const f = await crossFlight(t, ownerOld)
  f.release(code)
  const results = await bounded(Promise.all([f.old, f.fresh]))
  assert.deepEqual(results, [{ error: "auth" }, { status: 200, body: JSON.stringify({ authenticated: false }) }])
  assert.deepEqual(f.counts(), [2, 1, 1, 0, 1], "two live flights share exactly one rejection publication")
  await f.barrier()
  assert.deepEqual(f.counts(), [2, 1, 1, 0, 1], "settled followers cannot republish rejection")
})
