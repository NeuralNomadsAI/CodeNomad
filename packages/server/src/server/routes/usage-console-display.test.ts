import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerUsageRoutes } from "./usage"
import { clearProviderUsageCache } from "../../usage/service"
import { createOpenCodeFreeUsage } from "../../usage/opencode-free-usage"

test("free Console models keep their aggregate bar and optional credits without reset or detailed tables", async t => {
  clearProviderUsageCache()
  const summary = { totalRequests: "42", totalInputTokens: "0", totalOutputTokens: "0", totalCacheReadTokens: "0",
    totalCacheWrite5mTokens: "0", totalCacheWrite1hTokens: "0", totalCostMicroCents: "0", services: [] }
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = new URL(String(input))
    return Response.json(url.pathname.endsWith("/billing/status") ? { availableMicroCents: "125000000" } : url.pathname.endsWith("/summary") ? summary
      : { items: [{ ...summary, provider: "vendor", model: "big-pickle" }], pageInfo: { page: 1, pageSize: 50, total: 1, pageCount: 1 } })
  })
  const workspace = {}
  const connection = { assertCurrent() {}, client: {
    session: { get: async () => ({ location: { directory: "/repo" } }), stats: async () => { assert.fail("No local usage estimate") } },
    credential: { list: async () => [{ active: true, integrationID: "opencode", value: { type: "key", key: "synthetic" } }] },
  } }
  const app = Fastify()
  const freeUsage = createOpenCodeFreeUsage()
  registerUsageRoutes(app, { workspaceManager: { get: () => workspace, getSharedServiceConnection: async () => connection,
    ownsLocation: async () => true }, freeUsage } as never)
  try {
    for (const model of ["big-pickle", "example-free"]) {
      const result = await app.inject(`/api/usage/opencode?instanceId=fixture&sessionId=session&modelId=${model}`)
      assert.equal(result.statusCode, 200)
      assert.equal(result.json().console, undefined)
      assert.deepEqual(result.json().freeEstimate, { requests: 42, reference: 800 })
      assert.equal(result.json().windows.daily.valueLabel, "42 / 800")
      assert.equal(result.json().windows.daily.usedPercent, 5.25)
      assert.equal(result.json().windows.daily.resetAt, null)
      assert.deepEqual(Object.keys(result.json().windows), ["daily", "credits_balance"])
      assert.deepEqual(result.json().windows.credits_balance, {
        usedPercent: null, remainingPercent: null, resetAt: null, windowSeconds: null, balanceUSD: { remaining: 1.25 },
      })
      assert.equal(result.json().estimated, undefined)
    }
  } finally { await app.close(); freeUsage.dispose(); clearProviderUsageCache() }
})
