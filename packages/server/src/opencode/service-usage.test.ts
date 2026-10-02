import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { ServiceUsage } from "./service-usage"
import { registerServiceUsageRoutes } from "../server/routes/service-usage"

function fixture() {
  let current = true, present = true, defer: (() => void) | undefined
  const record = {}, calls: any[] = []
  const connection = { assertCurrent() { assert.ok(current, "stale connection") }, client: {
    session: { stats: async (input: any) => { calls.push(input); if (defer) await new Promise<void>(resolve => { defer = resolve }); return { sessions: 3, tools: { mode: "none" } } } },
  } }
  const manager: any = { get: () => present ? record : undefined, getSharedServiceConnection: async () => connection }
  return { service: new ServiceUsage(manager), calls,
    stale: () => { current = false }, close: () => { present = false },
    defer: () => { defer = () => {} }, release: () => defer?.() }
}
const query = { from: 1, to: 2, timezone: "UTC" }
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
  } finally { await app.close() }
})
