import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { ServiceUsage } from "./service-usage"
import { registerServiceUsageRoutes } from "../server/routes/service-usage"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SettingsService } from "../settings/service"
import { resolveConfigLocation } from "../config/location"
import { ServiceUsageCache } from "./service-usage-cache"

function fixture() {
  let current = true, present = true, defer: (() => void) | undefined
  const record = { path: "/fixture/project" }, calls: any[] = []
  let root = "/fixture/discovery", distro: string | undefined
  const connection = { endpoint: { url: "http://127.0.0.1:1234", auth: { type: "basic", username: "fixture", password: "secret-must-not-persist" } },
    assertCurrent() { assert.ok(current, "stale connection") }, client: {
    config: { get: async () => [{ type: "directory", path: root }] },
    session: { stats: async (input: any) => { calls.push(input); if (defer) await new Promise<void>(resolve => { defer = resolve }); return stats(input.from, input.to) } },
  } }
  const manager: any = { get: () => present ? record : undefined, getSharedServiceConnection: async () => connection,
    getServiceWslDistro: () => distro, getServicePathStyle: () => "posix" }
  return { service: new ServiceUsage(manager), calls, manager, connection, record, root: (value: string) => { root = value }, distro: (value: string) => { distro = value },
    stale: () => { current = false }, close: () => { present = false },
    defer: () => { defer = () => {} }, release: () => defer?.() }
}
const query = { from: 1, to: 2, timezone: "UTC" }
function stats(from: number, to: number) {
  return { range: { from, to }, sessions: 3, subagents: 1, prompts: 5, steps: 42,
    tokens: { input: 123, output: 45, reasoning: 0, cache: { read: 6, write: 7 } }, cost: 0.1,
    tools: { mode: "none" as const }, activeDays: 1, streak: 1, models: [], activity: [{ date: "2026-10-20", steps: 42 }] }
}
test("usage explicitly returns service-wide statistics without a misleading project filter", async () => {
  const f = fixture()
  assert.equal((await f.service.read("w", query)).scope, "service")
  assert.deepEqual(f.calls, [{ from: 1, to: 2, timezone: "UTC", tools: "none" }])
  f.close()
  await assert.rejects(f.service.read("w", query), /not found/)
  assert.equal(f.calls.length, 1)
})
test("usage rejects late connection and workspace changes", async () => {
  for (const invalidate of ["stale", "close"] as const) {
    const f = fixture(); f.defer()
    const pending = f.service.read("w", query)
    while (!f.calls.length) await new Promise(resolve => setImmediate(resolve))
    f[invalidate](); f.release()
    await assert.rejects(pending)
  }
})
test("usage route bounds periods and rejects misleading directory/project and tool-detail selectors", async () => {
  const app = Fastify(), f = fixture()
  registerServiceUsageRoutes(app, f.service)
  const url = "/api/workspaces/w/service-usage?from=1&to=2&timezone=UTC"
  try {
    assert.equal((await app.inject(url)).statusCode, 200)
    assert.equal((await app.inject("/api/workspaces/w/usage?from=1&to=2&timezone=UTC")).statusCode, 404)
    for (const extra of ["&project=foreign", "&directory=/repo", "&tools=detail", "&workspaceID=legacy", "&from=0"]) assert.equal((await app.inject(url + extra)).statusCode, 400)
    for (const invalid of [url.replace("to=2", "to=1"), url.replace("to=2", "to=999999999999"), url.replace("UTC", "Invalid/Zone")]) assert.equal((await app.inject(invalid)).statusCode, 400)
    assert.equal(f.calls.length, 1)
    assert.equal((await app.inject("/api/workspaces/w/service-usage/cache?timezone=UTC")).statusCode, 200)
    for (const extra of ["&days=366", "&directory=/foreign", "&identity=chosen"]) assert.equal((await app.inject("/api/workspaces/w/service-usage/cache?timezone=UTC" + extra)).statusCode, 400)
    assert.equal(f.calls.length, 1, "restoration never calls session.stats")
  } finally { await app.close() }
})

test("Stats UI-owner snapshots survive a new backend/settings instance, not workspace UUIDs; connection/folder scopes stay isolated", async () => {
  const parent = path.join(os.tmpdir(), "opencode"); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "stats-state-"))
  const logger: any = { child() { return this }, warn() {}, info() {}, debug() {} }
  const settings = () => new SettingsService(resolveConfigLocation(path.join(root, "config.yaml")), undefined, logger)
  const period = { from: 1, to: 1 + 7 * 86_400_000, timezone: "UTC" }
  try {
    const first = fixture(), owner = settings()
    owner.mergePatchOwner("state", "ui", { recentFolders: ["keep-me"] })
    await new ServiceUsage(first.manager, owner).read("old-uuid", period)
    const serialized = JSON.stringify(owner.getOwner("state", "ui"))
    assert.ok(!serialized.includes("secret-must-not-persist") && !serialized.includes("old-uuid") && !serialized.includes("/fixture"))
    const reopened = fixture(), restored = settings(), service = new ServiceUsage(reopened.manager, restored)
    reopened.connection.endpoint.url = "http://127.0.0.1:5678"
    assert.equal((await service.cached("new-uuid", "UTC")).snapshot?.stats.steps, 42)
    assert.equal((await service.cached("new-uuid", "UTC")).days, 7)
    assert.equal(reopened.calls.length, 0)
    assert.deepEqual(restored.getOwner("state", "ui").recentFolders, ["keep-me"])
    assert.equal((await service.cached("new-uuid", "Europe/Paris")).snapshot, undefined)
    assert.equal((await service.cached("new-uuid", "UTC", 30)).snapshot, undefined)
    reopened.record.path = "/different/project"
    assert.equal((await service.cached("new-uuid", "UTC")).snapshot, undefined)
    for (const change of [() => reopened.root("/other/service"), () => { reopened.connection.endpoint.auth.password = "other-service" }, () => reopened.distro("other-distro")]) {
      reopened.record.path = "/fixture/project"; change()
      assert.equal((await new ServiceUsage(reopened.manager, restored).cached("new-uuid", "UTC")).snapshot, undefined)
    }
    const stale = fixture(); stale.defer()
    const pending = new ServiceUsage(stale.manager, restored).read("stale", { ...period, to: period.to + 1, from: 2 })
    while (!stale.calls.length) await new Promise(resolve => setImmediate(resolve))
    stale.stale(); stale.release(); await assert.rejects(pending)
    assert.equal(JSON.stringify(restored.getOwner("state", "ui")), serialized, "late connection reads cannot alter saved state")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("Stats cache validates optional display state, caps retention and keeps a newer result", () => {
  let owner: any = { unrelated: true }
  const settings: any = { getOwner: () => owner, mergePatchOwner: (_kind: string, _owner: string, patch: any) => { owner = { ...owner, ...patch } } }
  const cache = new ServiceUsageCache(settings), identity = "a".repeat(64), snapshot = { scope: "service" as const, stats: stats(1, 1 + 30 * 86_400_000) }
  cache.set(identity, "UTC", 30, snapshot)
  cache.set(identity, "UTC", 30, { ...snapshot, stats: { ...snapshot.stats, range: { from: 0, to: 30 * 86_400_000 }, steps: 1 } })
  assert.equal(cache.get(identity, "UTC").snapshot?.stats.steps, 42)
  for (const broken of [null, { version: 2, entries: owner.serviceUsage.entries }, { version: 1, entries: [{ ...owner.serviceUsage.entries[0], days: 7 }] },
    { version: 1, entries: [{ ...owner.serviceUsage.entries[0], snapshot: { ...snapshot, stats: { ...snapshot.stats, steps: -1 } } }] }]) {
    owner.serviceUsage = broken
    assert.equal(cache.get(identity, "UTC").snapshot, undefined)
  }
  for (let index = 0; index < 20; index++) cache.set(index.toString(16).padStart(64, "0"), "UTC", 30, snapshot)
  assert.equal(owner.serviceUsage.entries.length, 8)
  assert.equal(owner.unrelated, true)
})

test("optional cache identity/storage failures do not suppress fresh native totals", async () => {
  const period = { from: 1, to: 1 + 7 * 86_400_000, timezone: "UTC" }
  const settings: any = { getOwner: () => ({}), mergePatchOwner: () => { throw new Error("fixture disk unavailable") } }
  const unavailable = fixture()
  unavailable.connection.client.config.get = async () => { throw new Error("fixture identity unavailable") }
  assert.equal((await new ServiceUsage(unavailable.manager, settings).read("w", period)).stats.steps, 42)
  assert.equal((await new ServiceUsage(fixture().manager, settings).read("w", period)).stats.steps, 42)
})
