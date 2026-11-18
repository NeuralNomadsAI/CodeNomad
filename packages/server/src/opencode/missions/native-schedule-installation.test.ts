import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Service } from "@opencode/client/service"
import { Context, Effect } from "effect"
import { acquireNativeScheduleInstallation } from "./native-schedule-installation"

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "schedule-installation-")), state = path.join(root, "state")
  mkdirSync(state)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const artifact = (name: string) => {
    const bytes = Buffer.from(name), file = path.join(root, name)
    writeFileSync(file, bytes)
    return { file, sha256: createHash("sha256").update(bytes).digest("hex") }
  }
  const artifacts = { provider: artifact("provider.mjs"), runtime: artifact("runtime.mjs") }
  const identity = { id: "owned-service", pid: process.pid, url: "http://127.0.0.1:1", version: "99.7.0-compatible" }
  const registrationFile = path.join(state, "service-owned-channel.json")
  const register = (overrides = {}) => writeFileSync(registrationFile, JSON.stringify({ ...identity, password: "fixture-private", ...overrides }))
  register()
  const global = { state }, server = { urls: () => [identity.url] }
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
    Effect.provideService(Context.Service<never, unknown>("@opencode/Global"), global),
    Effect.provideService(Context.Service<never, unknown>("@opencode/server/ServerInfo"), server))
  return { root, state, artifacts, identity, registrationFile, register, global, server, provide }
}

test("arming acquires the exact channel using official discover, without lifecycle, default lookup or secrets", async t => {
  const f = fixture(t), requests: string[] = []
  for (const method of ["ensure", "stop"] as const) t.mock.method(Service, method, () => { throw new Error("Forbidden lifecycle") })
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const)
    t.mock.method(childProcess, method, () => { throw new Error("Forbidden child") })
  const server = createServer((request, response) => {
    requests.push(request.url!)
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("opencode:fixture-private").toString("base64")}`)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ version: f.identity.version, pid: process.pid }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert(address && typeof address === "object" && address.port !== 28894)
  f.identity.url = `http://127.0.0.1:${address.port}`; f.register()
  // A default channel in the same namespace belongs to a different process.
  writeFileSync(path.join(f.state, "service.json"), JSON.stringify({ ...f.identity, pid: process.pid + 1 }))
  const result = await Effect.runPromise(f.provide(Effect.scoped(Effect.gen(function* () {
    const acquired = yield* acquireNativeScheduleInstallation(f.artifacts)
    assert.equal(acquired.assertCurrent(), true)
    assert(Object.isFrozen(acquired.installation.provider))
    return acquired
  }))))
  assert.deepEqual(result.installation, { registrationFile: f.registrationFile, ...f.artifacts })
  assert.equal(JSON.stringify(result.installation).includes("fixture-private"), false)
  assert.deepEqual(requests, ["/api/info"])
  assert.throws(result.assertCurrent, /installation-unavailable/, "released RPC graph invalidates the guard")
})

test("fresh arming refuses absent, ambiguous, oversized, replaced or foreign-process registration", async t => {
  const f = fixture(t)
  let discoveries = 0
  t.mock.method(Service, "discover", async (options: unknown) => {
    assert.deepEqual(options, { file: f.registrationFile }); discoveries++
    return { url: f.identity.url }
  })
  const acquire = () => Effect.runPromise(f.provide(Effect.scoped(acquireNativeScheduleInstallation(f.artifacts))))
  for (const bad of [{ pid: process.pid + 1 }, { id: "" }, { url: "https://example.com" }, { padding: "x".repeat(32768) }]) {
    f.register(bad)
    await assert.rejects(acquire(), /installation-unavailable/)
  }
  assert.equal(discoveries, 0)
  f.register()
  const duplicate = path.join(f.state, "service-another.json")
  writeFileSync(duplicate, JSON.stringify(f.identity))
  await assert.rejects(acquire(), /installation-unavailable/)
  rmSync(duplicate)
  rmSync(f.registrationFile)
  await assert.rejects(acquire(), /installation-unavailable/)
  f.register()
  f.server.urls = () => ["http://127.0.0.1:2"]
  await assert.rejects(acquire(), /installation-unavailable/)
  f.server.urls = () => [f.identity.url]
  t.mock.method(Service, "discover", async () => { f.register({ id: "replacement" }); return { url: f.identity.url } })
  await assert.rejects(acquire(), /installation-unavailable/)
  f.register()
  await assert.rejects(Effect.runPromise(Effect.scoped(acquireNativeScheduleInstallation(f.artifacts))), /installation-unavailable/)
})

test("arming guards retain exact native graph, process identity, URLs and artifact bytes", async t => {
  const f = fixture(t)
  t.mock.method(Service, "discover", async () => ({ url: f.identity.url }))
  await Effect.runPromise(f.provide(Effect.scoped(Effect.gen(function* () {
    const { assertCurrent } = yield* acquireNativeScheduleInstallation(f.artifacts)
    f.global.state = f.root
    assert.throws(assertCurrent)
    f.global.state = f.state
    const urls = f.server.urls
    f.server.urls = () => [f.identity.url]
    assert.throws(assertCurrent)
    f.server.urls = urls
    f.register({ id: "replaced" }); assert.throws(assertCurrent)
    f.register()
    assert.equal(assertCurrent(), true)
    writeFileSync(f.artifacts.provider.file, "corrupt")
    assert.throws(assertCurrent)
  }))))
})

test("arming bounds discovery and never exposes a guard after timeout", async t => {
  const f = fixture(t)
  t.mock.method(Service, "discover", () => new Promise(() => {}))
  await assert.rejects(Effect.runPromise(f.provide(Effect.scoped(acquireNativeScheduleInstallation(f.artifacts)))), /installation-unavailable/)
})
