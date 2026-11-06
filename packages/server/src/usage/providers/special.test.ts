import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"

import { specialProviders } from "./special"

test("fails closed without requesting quota for an expired Cursor access token", async () => {
  const previousAccess = process.env.CURSOR_ACCESS_TOKEN
  const previousToken = process.env.CURSOR_TOKEN
  const previousFetch = globalThis.fetch
  const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")
  process.env.CURSOR_ACCESS_TOKEN = `header.${payload}.signature`
  delete process.env.CURSOR_TOKEN
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error("expired token must not make requests")
  }

  try {
    const usage = await specialProviders.find((provider) => provider.id === "cursor")!.fetchQuota({})
    assert.equal(usage.ok, false)
    assert.equal(usage.configured, true)
    assert.equal(usage.unavailableReason, "cursor-token-expired")
    assert.equal(usage.error, "Cursor access token expired. Provide a current CURSOR_ACCESS_TOKEN or CURSOR_TOKEN.")
    assert.equal(calls, 0)
    assert.equal(usage.error?.includes(process.env.CURSOR_ACCESS_TOKEN), false)
  } finally {
    globalThis.fetch = previousFetch
    if (previousAccess === undefined) delete process.env.CURSOR_ACCESS_TOKEN
    else process.env.CURSOR_ACCESS_TOKEN = previousAccess
    if (previousToken === undefined) delete process.env.CURSOR_TOKEN
    else process.env.CURSOR_TOKEN = previousToken
  }
})

const cursor = specialProviders.find(provider => provider.id === "cursor")!
const currentPath = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
const planPath = "/aiserver.v1.DashboardService/GetPlanInfo"
const profilePath = "/auth/full_stripe_profile"
const limitPath = "/aiserver.v1.DashboardService/GetHardLimit"

function mockCursor(t: TestContext, responses: Record<string, unknown | (() => Response)> = {}) {
  const previous = { access: process.env.CURSOR_ACCESS_TOKEN, token: process.env.CURSOR_TOKEN }
  process.env.CURSOR_ACCESS_TOKEN = "synthetic-cursor-access"
  process.env.CURSOR_TOKEN = "synthetic-cursor-fallback"
  t.after(() => {
    if (previous.access === undefined) delete process.env.CURSOR_ACCESS_TOKEN
    else process.env.CURSOR_ACCESS_TOKEN = previous.access
    if (previous.token === undefined) delete process.env.CURSOR_TOKEN
    else process.env.CURSOR_TOKEN = previous.token
  })
  const calls: { path: string; init: RequestInit }[] = []
  const defaults: Record<string, unknown> = {
    [currentPath]: {}, [profilePath]: { membershipType: "enterprise", isTeamMember: true, teamId: 42 },
    "/auth/usage": {}, [limitPath]: {},
  }
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).origin, "https://api2.cursor.sh")
    const path = new URL(url).pathname
    calls.push({ path, init })
    assert.equal(init.redirect, "error")
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-cursor-access")
    const response = path in responses ? responses[path] : defaults[path]
    assert.notEqual(response, undefined, `unexpected endpoint ${path}`)
    return typeof response === "function" ? response() : Response.json(response)
  })
  return calls
}

test("Cursor preserves non-Enterprise plan values and request sequence", async t => {
  const calls = mockCursor(t, {
    [currentPath]: { planUsage: { limit: 2000, remaining: 1500, totalSpend: 735, totalPercentUsed: 26.5 } },
    [planPath]: { planInfo: { billingCycleEnd: "2026-12-01T00:00:00Z" } },
  })
  const quota = await cursor.fetchQuota({})
  assert.equal(quota.ok, true)
  assert.deepEqual(quota.usage?.windows, { billing_cycle: {
    usedPercent: 26.5, remainingPercent: 73.5, resetAt: Date.UTC(2026, 11, 1), windowSeconds: null, valueLabel: "$7.35",
  } })
  assert.deepEqual(calls.map(call => call.path), [currentPath, planPath])
  assert.ok(calls.every(call => call.init.method === "POST" && call.init.body === "{}"))
  assert.equal(calls[0].init.signal, calls[1].init.signal)
})

test("Cursor Enterprise reads identified request counts and distinct team-scoped numeric USD caps", async t => {
  const calls = mockCursor(t, {
    "/auth/usage": { "gpt-4": { numRequests: 1250, maxRequestUsage: 1000 },
      unknown: { numRequests: 999, maxRequestUsage: 10000 }, startOfMonth: "2026-11-01T00:00:00Z" },
    [limitPath]: { hardLimitPerUser: 250.5, hardLimit: 5000, teamMemberSpend: [{ userId: "other", spendCents: 790 }] },
  })
  const quota = await cursor.fetchQuota({})
  assert.equal(quota.ok, true)
  assert.deepEqual(Object.keys(quota.usage!.windows), ["requests:gpt-4", "per_user_limit", "team_limit"])
  assert.deepEqual(quota.usage!.windows["requests:gpt-4"], {
    usedPercent: 100, remainingPercent: 0, windowSeconds: null, resetAt: null, consumption: { used: 1250, limit: 1000 },
  })
  for (const [key, amount] of [["per_user_limit", 250.5], ["team_limit", 5000]] as const) {
    assert.deepEqual(quota.usage!.windows[key], {
      usedPercent: null, remainingPercent: null, windowSeconds: null, resetAt: null, limitUSD: amount,
    })
  }
  const hardLimit = calls.find(call => call.path === limitPath)!.init
  assert.equal(hardLimit.method, "POST")
  assert.equal(hardLimit.body, '{"teamId":42}')
  assert.equal(new Headers(hardLimit.headers).get("Connect-Protocol-Version"), "1")
  assert.equal(new Headers(hardLimit.headers).get("Content-Type"), "application/json")
  assert.equal(calls.find(call => call.path === profilePath)!.init.method, undefined)
  assert.ok(calls.every(call => call.init.signal === calls[0].init.signal))
  assert.equal(calls.some(call => /GetMe|GetTeamSpend/.test(call.path)), false, "unqualified spend endpoints stay unread")
})

test("Cursor null request limits retain used-only counts without asserting unlimited capacity", async t => {
  mockCursor(t, { "/auth/usage": { "gpt-4": { numRequests: 7, maxRequestUsage: null } } })
  const quota = await cursor.fetchQuota({})
  assert.equal(quota.ok, true)
  assert.deepEqual(quota.usage!.windows["requests:gpt-4"].consumption, { used: 7 })
  assert.equal(quota.usage!.windows["requests:gpt-4"].usedPercent, null)
})

for (const profile of [{ membershipType: "enterprise" }, { isTeamMember: true, teamId: 0 }, { isTeamMember: true, teamId: -1 }]) {
  test(`Cursor Enterprise without a usable team has an explicit failure (${JSON.stringify(profile)})`, async t => {
    const calls = mockCursor(t, { [profilePath]: profile })
    const quota = await cursor.fetchQuota({})
    assert.equal(quota.ok, false)
    assert.equal(quota.unavailableReason, "cursor-team-unavailable")
    assert.equal(calls.some(call => call.path === limitPath), false)
  })
}

test("Cursor does not apply team endpoints to a non-Enterprise profile", async t => {
  const calls = mockCursor(t, { [profilePath]: { membershipType: "free", isTeamMember: false } })
  const quota = await cursor.fetchQuota({})
  assert.equal(quota.ok, false)
  assert.equal(quota.unavailableReason, "cursor-usage-unavailable")
  assert.deepEqual(calls.map(call => call.path), [currentPath, profilePath])
})

for (const limits of [{}, { hardLimit: null, hardLimitPerUser: null }, { hardLimit: -1, hardLimitPerUser: -1 }]) {
  test(`Cursor absent or sentinel limits never make an empty successful card (${JSON.stringify(limits)})`, async t => {
    mockCursor(t, { [limitPath]: limits })
    const quota = await cursor.fetchQuota({})
    assert.equal(quota.ok, false)
    assert.equal(quota.unavailableReason, "cursor-usage-unavailable")
    assert.equal(quota.usage, null)
  })
}

test("Cursor a cap without matched member spend stays cap-only, including zero", async t => {
  mockCursor(t, { [limitPath]: { hardLimitPerUser: 0, teamMemberSpend: [{ userId: "not-this-member", spendCents: 900 }] } })
  const quota = await cursor.fetchQuota({})
  assert.equal(quota.ok, true)
  assert.deepEqual(quota.usage?.windows, { per_user_limit: {
    usedPercent: null, remainingPercent: null, resetAt: null, windowSeconds: null, limitUSD: 0,
  } })
})

for (const path of [currentPath, profilePath, "/auth/usage", limitPath]) {
  for (const status of [401, 403]) test(`Cursor handles HTTP ${status} at ${path} without publishing secrets`, async t => {
    const calls = mockCursor(t, { [path]: () => new Response("synthetic-private-body", { status }) })
    const quota = await cursor.fetchQuota({})
    assert.equal(quota.ok, false)
    assert.equal(quota.unavailableReason, status === 401 ? "cursor-token-expired" : "cursor-access-denied")
    assert.equal(quota.status, status)
    assert.equal(JSON.stringify(quota).includes("synthetic"), false)
    if (status === 401) assert.equal(calls.at(-1)!.path, path)
  })
}

test("Cursor keeps verified requests when team cap access is forbidden", async t => {
  mockCursor(t, { "/auth/usage": { "gpt-4": { numRequests: 25, maxRequestUsage: 100 } },
    [limitPath]: () => new Response(null, { status: 403 }) })
  const quota = await cursor.fetchQuota({})
  assert.equal(quota.ok, true)
  assert.deepEqual(Object.keys(quota.usage!.windows), ["requests:gpt-4"])
})

test("Cursor Enterprise rejects malformed meters and shares cancellation through every read", async t => {
  const controller = new AbortController()
  const calls = mockCursor(t, { "/auth/usage": () => {
    controller.abort()
    return Response.json({ "gpt-4": { numRequests: 10, maxRequestUsage: 100 } })
  } })
  assert.equal((await cursor.fetchQuota({}, { signal: controller.signal })).ok, false)
  assert.equal(calls.at(-1)!.path, "/auth/usage")
  assert.ok(calls.every(call => call.init.signal === calls[0].init.signal))
  assert.equal(calls[0].init.signal!.aborted, true)
})

test("Cursor malformed and unknown buckets cannot become usage and oversized responses are unavailable", async t => {
  mockCursor(t, { "/auth/usage": { "gpt-4": { numRequests: -1, maxRequestUsage: 100 }, unknown: { numRequests: 2, maxRequestUsage: 100 } },
    [limitPath]: () => Response.json({ padding: "x".repeat(65_536) }) })
  const quota = await cursor.fetchQuota({})
  assert.equal(quota.ok, false)
  assert.equal(quota.unavailableReason, "cursor-usage-unavailable")
})
