import assert from "node:assert/strict"
import test from "node:test"

import { miniMaxProviders } from "./minimax"

const normal = {
  base_resp: { status_code: 0, status_msg: "success" },
  model_remains: [{ model_name: "MiniMax-M*", current_interval_remaining_percent: 75,
    current_interval_total_count: 1500, current_interval_usage_count: 1125,
    start_time: 1_800_000_000_000, end_time: 1_800_018_000_000,
    current_weekly_remaining_percent: 40, weekly_start_time: 1_800_000_000_000, weekly_end_time: 1_800_604_800_000 }],
}

for (const [index, provider] of miniMaxProviders.entries()) {
  const urls = index === 0
    ? ["https://api.minimax.io/v1/token_plan/remains", "https://api.minimax.io/v1/api/openplatform/coding_plan/remains"]
    : ["https://api.minimaxi.com/v1/token_plan/remains", "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains"]
  const auth = { [provider.id]: { key: "synthetic-minimax-key" } }

  test(`${provider.id}: normal Token Plan percentages and millisecond resets`, async t => {
    const calls: string[] = []
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push(url)
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-minimax-key")
      assert.equal(init?.method ?? "GET", "GET")
      return Response.json(normal)
    })
    const quota = await provider.fetchQuota(auth)
    assert.equal(quota.ok, true)
    assert.equal(quota.unavailableReason, undefined)
    assert.deepEqual(calls, urls.slice(0, 1))
    assert.deepEqual(quota.usage?.windows, {
      "5h": { usedPercent: 25, remainingPercent: 75, windowSeconds: 18000, resetAt: 1_800_018_000_000 },
      weekly: { usedPercent: 60, remainingPercent: 40, windowSeconds: 604800, resetAt: 1_800_604_800_000 },
    })
  })

  for (const models of ["absent", "empty"] as const) {
    test(`${provider.id}: successful ${models} limits produce the public reason after legacy fallback`, async t => {
      const calls: string[] = []
      t.mock.method(globalThis, "fetch", async (url: string) => {
        calls.push(url)
        return Response.json({ base_resp: { status_code: 0, status_msg: "success" }, ...(models === "empty" ? { model_remains: [] } : {}) })
      })
      const quota = await provider.fetchQuota(auth)
      assert.equal(quota.ok, false)
      assert.equal(quota.configured, true)
      assert.equal(quota.unavailableReason, "minimax-limits-not-shared")
      assert.equal(quota.usage, null)
      assert.equal(quota.status, undefined)
      assert.deepEqual(calls, urls)
    })
  }

  test(`${provider.id}: empty Token Plan still falls back to readable Coding Plan`, async t => {
    let calls = 0
    t.mock.method(globalThis, "fetch", async (url: string) => {
      assert.equal(url, urls[calls++])
      return Response.json(calls === 1 ? { base_resp: { status_code: 0 }, model_remains: [] } : normal)
    })
    const quota = await provider.fetchQuota(auth)
    assert.equal(quota.ok, true)
    assert.equal(quota.usage?.windows["5h"].usedPercent, 25)
    assert.equal(quota.unavailableReason, undefined)
    assert.equal(calls, 2)
  })

  for (const failure of ["1004", "401", "network", "timeout", "malformed", "invalid-json", "missing-status", "null-models"] as const) {
    test(`${provider.id}: ${failure} stays a failure rather than unshared limits`, async t => {
      let calls = 0
      t.mock.method(globalThis, "fetch", async () => {
        // An empty primary response must not mask a failure from the fallback.
        if (++calls === 1) return Response.json({ base_resp: { status_code: 0 }, model_remains: [] })
        if (failure === "401") return new Response(null, { status: 401 })
        if (failure === "network") throw new TypeError("Synthetic network failure")
        if (failure === "timeout") throw new DOMException("Synthetic timeout", "TimeoutError")
        if (failure === "invalid-json") return new Response("{")
        return Response.json(failure === "1004" ? { base_resp: { status_code: 1004 }, model_remains: [] }
          : failure === "missing-status" ? { model_remains: [] }
          : { base_resp: { status_code: 0 }, model_remains: failure === "null-models" ? null : {} })
      })
      const quota = await provider.fetchQuota(auth)
      assert.equal(quota.ok, false)
      assert.equal(quota.unavailableReason, undefined)
      assert.equal(quota.usage, null)
      assert.equal(quota.status, failure === "401" ? 401 : undefined)
      assert.equal(calls, 2)
    })
  }

  test(`${provider.id}: missing credential makes no request`, async t => {
    t.mock.method(globalThis, "fetch", async () => { assert.fail("unexpected request") })
    const quota = await provider.fetchQuota({})
    assert.equal(quota.configured, false)
    assert.equal(quota.unavailableReason, undefined)
  })
}
