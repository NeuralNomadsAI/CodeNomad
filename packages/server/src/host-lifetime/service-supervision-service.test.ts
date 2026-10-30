import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import Fastify from "fastify"
import { ServiceSupervisionStore } from "./service-supervision-store"
import { ServiceSupervisionSettings, type SupervisionSettingsControl } from "./service-supervision-service"
import { supervisionStatus, type SupervisionNamespace, type SupervisionObservation } from "./service-supervision-contract"
import { registerServiceSupervisionRoutes } from "../server/routes/service-supervision"

async function fixture(t: TestContext) {
  const temporary = path.join(os.tmpdir(), "opencode")
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(path.join(temporary, "supervision-settings-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  const namespace: SupervisionNamespace = { platform: "win32", host: "isolated-test", user: "S-1-5-21-1-2-3-1000",
    configDirectory: "C:\\isolated\\config\\opencode", stateDirectory: "C:\\isolated\\state\\opencode", registrationName: "service-test.json" }
  const policy = { async verify(file: string, directory: boolean) {
    const stat = await lstat(file)
    assert.equal(stat.isSymbolicLink(), false)
    assert.equal(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, true)
  } }
  const store = new ServiceSupervisionStore(root, namespace, { binary: "C:\\isolated\\OpenCode.exe", provenance: "custom" }, policy)
  const key = (await store.read()).key
  let current = true, failure = false, observations = 0, effects = 0, observing: (() => Promise<void>) | undefined
  const adapter = {
    async reconcile(revision: number) {
      effects++
      if (failure) throw new Error("private-password-and-environment")
      await store.acknowledge(revision)
    },
    async observe(): Promise<SupervisionObservation> {
      observations++
      const manifest = await store.read()
      await observing?.()
      return { revision: manifest.revision, resources: manifest.desired === "on" ? "installed" : "absent",
        guard: manifest.desired === "on" ? "active" : "absent",
        health: { state: "healthy", pid: 123, id: "incumbent", startIdentity: "same-start" } }
    },
  }
  const acquire = async () => ({ store, adapter, assertCurrent: () => { if (!current) throw new Error("changed") } })
  const service = new ServiceSupervisionSettings(acquire)
  const control = (action: SupervisionSettingsControl["action"], expectedRevision: number): SupervisionSettingsControl => ({
    serviceKey: key, requestID: randomUUID(), action, expectedRevision,
  })
  return { root, store, key, service, acquire, control, adapter,
    get effects() { return effects }, get observations() { return observations },
    change: () => { current = false }, fail: (value: boolean) => { failure = value },
    observe: (value: () => Promise<void>) => { observing = value },
  }
}

test("Settings controls share durable intent; passive reads and acknowledged replays perform no OS effects", async t => {
  const f = await fixture(t), authorize = () => {}, on = f.control("on", 0)
  await f.service.read()
  assert.equal(f.effects, 0)
  assert.equal((await f.service.control(on, authorize)).state, "running")
  assert.equal(f.effects, 1)
  const other = new ServiceSupervisionSettings(f.acquire)
  const exact = await other.read({ serviceKey: f.key, requestID: on.requestID })
  assert.deepEqual(exact.request, { requestID: on.requestID, state: "recorded", action: "on", appliedRevision: 1 })
  await other.control(on, authorize)
  assert.equal(f.effects, 1)
  const off = await other.control(f.control("off", 1), authorize)
  assert.equal(off.state, "off")
  assert.equal(off.serviceResponding, true)
  assert.equal(f.effects, 2)
  assert.equal((await other.read({ requestID: on.requestID })).request?.state, "unknown")
  await assert.rejects(other.control(on, authorize), /conflict/)
  assert.doesNotMatch(JSON.stringify(exact), /binary|configDirectory|stateDirectory|target|password|incumbent|startIdentity/)
})

test("explicit binary publication preserves the service/preference and fences competing revisions and OFF", async t => {
  const f = await fixture(t)
  await f.service.control(f.control("on", 0), () => {})
  let selectedTarget = { binary: "C:\\new path\\opencode.exe", provenance: "custom" as const, sha256: "a".repeat(64) }
  const acquire = async () => ({ ...await f.acquire(), selectedTarget })
  const service = new ServiceSupervisionSettings(acquire)
  assert.equal((await service.read()).desired, "on")
  assert.equal((await f.store.read()).target.binary, "C:\\isolated\\OpenCode.exe", "passive read preserves target")
  await service.selectBinary()
  const published = await f.store.read()
  assert.equal(published.key, f.key); assert.equal(published.desired, "on")
  assert.deepEqual(published.target, selectedTarget)
  assert.equal(published.reconciledRevision, 2)
  await f.store.control({ action: "off", requestID: randomUUID(), expectedRevision: 2 })
  selectedTarget = { ...selectedTarget, sha256: "b".repeat(64) }
  await assert.rejects(service.selectBinary(), /busy/)
  assert.equal((await f.store.read()).desired, "off")
  await f.store.acknowledge(3)
  let atWrite = 0
  await assert.rejects(service.selectBinary(() => { if (++atWrite === 2) throw new Error("selection-changed") }), /selection-changed/)
  assert.equal((await f.store.read()).revision, 3)
  const results = await Promise.allSettled([service.selectBinary(), service.selectBinary()])
  assert.ok(results.some(result => result.status === "fulfilled"))
  assert.equal((await f.store.read()).revision, 4)
  assert.equal((await f.store.read()).desired, "off")
})

test("another profile can read and turn OFF a shared service without publishing its selected binary", async t => {
  const f = await fixture(t)
  await f.service.control(f.control("on", 0), () => {})
  const before = await f.store.read()
  const other = new ServiceSupervisionSettings(async () => ({ ...await f.acquire(),
    selectedTarget: { binary: "C:\\another-profile\\opencode.exe", provenance: "standalone" as const } }))
  assert.equal((await other.read({ serviceKey: f.key })).state, "running")
  await assert.rejects(other.read({ serviceKey: "0".repeat(64) }), /conflict/)
  assert.equal((await other.control(f.control("off", 1), () => {})).state, "off")
  assert.deepEqual((await f.store.read()).target, before.target)
})

test("fixed failure survives refresh and Retry reconciles the same revision without exposing native errors", async t => {
  const f = await fixture(t), on = f.control("on", 0)
  f.fail(true)
  const failed = await f.service.control(on, () => {})
  assert.equal(failed.state, "failing"); assert.equal(failed.cause, "adapter-failed")
  assert.equal(failed.desired, "on"); assert.ok(failed.lastAttemptAt)
  const other = new ServiceSupervisionSettings(f.acquire)
  assert.equal((await other.read()).cause, "adapter-failed")
  assert.equal(f.effects, 1)
  assert.doesNotMatch(await readFile(path.join(f.store.directory, "manifest.json"), "utf8"), /private-password-and-environment/)
  f.fail(false)
  const retried = await other.control(f.control("retry", 1), () => {})
  assert.equal(retried.state, "running"); assert.equal(retried.revision, 1)
  assert.equal((await f.store.read()).receipt?.control.requestID, on.requestID)
  assert.equal(f.effects, 2)
  f.adapter.observe = async () => { throw new Error("private-observer-error") }
  const unknown = await other.read()
  assert.equal(unknown.state, "failing"); assert.equal(unknown.cause, "resources-unknown")
  assert.equal(unknown.serviceResponding, false)
  assert.doesNotMatch(JSON.stringify(unknown), /private-observer-error/)
})

test("first Play defaults only unset to ON; an explicit OFF and another pending ON remain untouched", async t => {
  const f = await fixture(t)
  const first = await f.service.firstPlay({ serviceKey: f.key, requestID: randomUUID() }, () => {})
  assert.equal(first.desired, "on"); assert.equal(first.state, "running")
  await f.service.control(f.control("off", 1), () => {})
  const before = await f.store.read(), effects = f.effects
  await f.service.firstPlay({ serviceKey: f.key, requestID: randomUUID() }, () => {})
  assert.deepEqual(await f.store.read(), before)
  assert.equal(f.effects, effects)
  const on = await f.store.control({ requestID: randomUUID(), expectedRevision: 2, action: "on" })
  await f.service.firstPlay({ serviceKey: f.key, requestID: randomUUID() }, () => {})
  assert.deepEqual(await f.store.read(), on)
  assert.equal(f.effects, effects)
})

test("key, context and human fences refuse mutations; schema refuses UI command strings and internal controls", async t => {
  const f = await fixture(t), on = f.control("on", 0)
  await assert.rejects(f.service.control({ ...on, serviceKey: "0".repeat(64) }, () => {}), /conflict/)
  await assert.rejects(f.service.control(on, () => { throw new Error("revoked") }), /revoked/)
  for (const change of [{ target: { binary: "C:\\other.exe" } }, { action: "first-play" }, { command: "anything" }, { expectedRevision: -1 }])
    await assert.rejects(f.service.control({ ...on, ...change } as SupervisionSettingsControl, () => {}), /invalid/)
  f.change()
  await assert.rejects(f.service.control(on, () => {}), /changed/)
  assert.equal((await f.store.read()).revision, 0)
  assert.equal(f.effects, 0)
})

test("human loss at the serialized write and a revision change during observation are fenced", async t => {
  const f = await fixture(t)
  let checks = 0
  await assert.rejects(f.service.control(f.control("on", 0), () => { if (++checks === 3) throw new Error("revoked-at-write") }), /revoked-at-write/)
  assert.equal((await f.store.read()).revision, 0)
  await f.service.control(f.control("on", 0), () => {})
  f.observe(async () => { await f.store.control({ requestID: randomUUID(), expectedRevision: 1, action: "off" }) })
  const result = await f.service.read()
  assert.equal(result.desired, "off"); assert.equal(result.state, "failing")
  assert.equal(result.cause, "observation-stale"); assert.equal(result.serviceResponding, false)
  assert.equal(f.effects, 1)
})

test("an older failed installation cannot overwrite a competing OFF or acknowledge its resources", async t => {
  const f = await fixture(t)
  f.adapter.reconcile = async () => {
    await f.store.control({ requestID: randomUUID(), expectedRevision: 1, action: "off" })
    throw new Error("old-installer-error")
  }
  const result = await f.service.control(f.control("on", 0), () => {})
  assert.equal(result.desired, "off"); assert.equal(result.state, "pending")
  assert.equal((await f.store.read()).attempt?.revision, 1)
  assert.equal(result.lastAttemptAt, undefined)
})

test("guard diagnostics are revision-fenced, retain actual backoff and cannot conceal native disabled", async t => {
  const f = await fixture(t)
  await f.service.control(f.control("on", 0), () => {})
  const manifest = await f.store.read(), observation = await f.adapter.observe()
  const detail = { cause: "start-failed" as const, lastAttemptAt: "2026-10-30T12:00:00.000Z", retryAt: "2026-10-30T12:00:30.000Z" }
  const result = supervisionStatus(manifest, { ...observation, detail })
  assert.equal(result.state, "failing"); assert.equal(result.cause, "start-failed")
  assert.equal(result.retryAt, detail.retryAt); assert.equal(result.lastAttemptAt, detail.lastAttemptAt)
  assert.equal(supervisionStatus(manifest, { ...observation, detail: { cause: "native-service-disabled-or-unknown" } }).state, "failing")
  assert.equal(supervisionStatus(manifest, { ...observation, guard: "absent", detail }).retryAt, undefined)
  assert.equal(supervisionStatus(manifest, { ...observation, revision: 0, detail }).retryAt, undefined)
  const tick = "2026-10-30T12:01:00.000Z"
  const missing = supervisionStatus(manifest, { ...observation, guard: "absent", artifactMissing: true, recoveryNextTickAt: tick })
  assert.equal(missing.state, "failing"); assert.equal(missing.cause, "artifact-missing")
  assert.equal(missing.recoveryNextTickAt, tick); assert.equal(missing.serviceResponding, true)
  assert.equal(supervisionStatus(manifest, { ...observation, revision: 0, recoveryNextTickAt: tick }).recoveryNextTickAt, undefined)
})

test("product Play pins the acquired service and uses one deterministic receipt while preserving OFF", async t => {
  const f = await fixture(t), connection = { assertCurrent() {} }
  const service = new ServiceSupervisionSettings(async expected => {
    assert.equal(expected, connection)
    return f.acquire()
  })
  await service.missionPlay(connection as never, "mission-play-original", () => {})
  const before = await f.store.read()
  assert.equal(before.receipt?.control.action, "first-play")
  assert.equal(before.desired, "on")
  await service.missionPlay(connection as never, "mission-play-original", () => {})
  assert.deepEqual(await f.store.read(), before)
  await f.service.control(f.control("off", 1), () => {})
  await service.missionPlay(connection as never, "another-play", () => {})
  assert.equal((await f.store.read()).desired, "off")
  const effects = f.effects
  await assert.rejects(service.missionPlay(connection as never, "revoked-play", () => { throw new Error("revoked") }), /revoked/)
  assert.equal(f.effects, effects)
})

test("Settings HTTP requires a live human before acquisition; strict inputs and fixed errors preserve privacy", async t => {
  const f = await fixture(t), app = Fastify()
  t.after(() => app.close())
  let enabled = true, acquisitions = 0
  const service = new ServiceSupervisionSettings(async () => { acquisitions++; return f.acquire() })
  registerServiceSupervisionRoutes(app, { service, auth: { isAuthEnabled: () => enabled,
    getSessionFromRequest: request => request.headers.cookie === "human=valid" ? { username: "human", sessionId: "live-cookie" } : null } })
  for (const method of ["GET", "POST"] as const) {
    const reply = await app.inject({ method, url: "/api/opencode/supervision", ...(method === "POST" ? { payload: f.control("on", 0) } : {}) })
    assert.equal(reply.statusCode, 401)
  }
  assert.equal(acquisitions, 0)
  const invalid = await app.inject({ method: "POST", url: "/api/opencode/supervision", headers: { cookie: "human=valid" },
    payload: { ...f.control("on", 0), command: "private-command" } })
  assert.equal(invalid.statusCode, 400); assert.equal(acquisitions, 0)
  const ambiguous = await app.inject({ method: "POST", url: `/api/opencode/supervision?serviceKey=${"0".repeat(64)}`,
    headers: { cookie: "human=valid" }, payload: f.control("on", 0) })
  assert.equal(ambiguous.statusCode, 400); assert.equal(acquisitions, 0)
  enabled = false
  assert.equal((await app.inject({ method: "GET", url: "/api/opencode/supervision", headers: { cookie: "human=valid" } })).statusCode, 401)
  enabled = true
  const on = f.control("on", 0)
  assert.equal((await app.inject({ method: "POST", url: "/api/opencode/supervision", headers: { cookie: "human=valid" }, payload: on })).statusCode, 200)
  const read = await app.inject({ method: "GET", url: `/api/opencode/supervision?serviceKey=${f.key}&requestID=${on.requestID}`, headers: { cookie: "human=valid" } })
  assert.equal(read.json().request.state, "recorded"); assert.equal(f.effects, 1)
  const conflict = await app.inject({ method: "POST", url: "/api/opencode/supervision", headers: { cookie: "human=valid" }, payload: f.control("off", 0) })
  assert.equal(conflict.statusCode, 409); assert.deepEqual(conflict.json(), { error: "supervision-conflict" })
  f.change()
  const changed = await app.inject({ method: "GET", url: "/api/opencode/supervision", headers: { cookie: "human=valid" } })
  assert.equal(changed.statusCode, 503); assert.deepEqual(changed.json(), { error: "supervision-unavailable" })
})
