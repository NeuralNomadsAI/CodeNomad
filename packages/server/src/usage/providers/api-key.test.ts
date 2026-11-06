import assert from "node:assert/strict"
import test from "node:test"

import { apiKeyProviders, kimiAliases } from "./api-key"
import { projectCredentials } from "../native-credentials"
import { clearProviderUsageCache, getProviderUsage } from "../service"
import type { ProviderReadContext } from "../types"
import { readUsageProviderSettings } from "../native-settings"

const auth = { "zai-coding-plan": { type: "api", key: "test-zai-key" }, "zhipuai-coding-plan": { type: "api", key: "test-zhipu-key" } }

const CREDIT_RESET_AT = 1787849891189
const TOKENS_RESET_AT = 1787950772998

const kimi = apiKeyProviders.find(provider => provider.id === "kimi-for-coding")!
const kimiReset = "2099-12-01T00:00:00Z"
const kimiPayload = { usages: { limit_5h: { used_ratio: 0.3, reset_time: kimiReset } } }

for (const alias of kimiAliases) test(`Kimi alias ${alias} uses its official host and bounded transport`, async t => {
  const calls: string[] = []
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    calls.push(String(url))
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-kimi-key")
    assert.equal(init.redirect, "error")
    assert.equal(init.signal instanceof AbortSignal, true)
    return respondWith(kimiPayload)
  })
  const response = await kimi.fetchQuota({ [alias]: { type: "api", key: "synthetic-kimi-key" } })
  assert.equal(response.ok, true)
  assert.deepEqual(calls, [`https://${alias === "kimi-code-plan-global" ? "api.kimi.ai" : "api.kimi.com"}/coding/v1/usages`])
})

test("Kimi tries selected credentials in session-integration order, deduplicates keys and ignores inactive accounts", async t => {
  const calls: string[] = []
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const key = new Headers(init.headers).get("Authorization")!
    calls.push(key)
    return key === "Bearer synthetic-success" ? respondWith(kimiPayload) : new Response(null, { status: 401 })
  })
  const auth = projectCredentials([
    { id: "global", integrationID: "kimi-code-plan-global", active: true, label: "global", value: { type: "key", key: "synthetic-failure" } },
    { id: "legacy", integrationID: "kimi-for-coding", active: true, label: "legacy", value: { type: "key", key: "synthetic-failure" } },
    { id: "cn", integrationID: "kimi-code-plan-cn", active: true, label: "cn", value: { type: "key", key: "synthetic-success" } },
    { id: "inactive", integrationID: "kimi", active: false, label: "inactive", value: { type: "key", key: "synthetic-inactive" } },
  ])
  assert.equal((await kimi.fetchQuota(auth, { integrationID: "kimi-code-plan-global" })).ok, true)
  assert.deepEqual(calls, ["Bearer synthetic-failure", "Bearer synthetic-success"])
})

test("Kimi uses the session provider's verified native integration and skips missing keys", async t => {
  const directory = "D:/synthetic-project"
  const connection = { assertCurrent() {}, client: { provider: { get: async () => ({
    location: { directory }, data: { id: "kimi", integrationID: "kimi-code-plan-global", settings: {} },
  }) } } } as unknown as Parameters<typeof readUsageProviderSettings>[0]
  const { context } = await readUsageProviderSettings(connection, "kimi", directory, new AbortController().signal)
  assert.equal(context.integrationID, "kimi-code-plan-global")
  const requests: string[] = []
  t.mock.method(globalThis, "fetch", async (url: unknown) => { requests.push(String(url)); return respondWith(kimiPayload) })
  const missing = await kimi.fetchQuota({ kimi: { key: " " } }, context)
  assert.equal(missing.configured, false)
  assert.deepEqual(requests, [])
  assert.equal((await kimi.fetchQuota({ kimi: "synthetic-cn", "kimi-code-plan-global": "synthetic-global" }, context)).ok, true)
  assert.deepEqual(requests, ["https://api.kimi.ai/coding/v1/usages"])
})

test("Kimi keeps the final HTTP failure and exposes no windows when all selected keys fail", async t => {
  let requests = 0
  t.mock.method(globalThis, "fetch", async () => new Response("synthetic-secret", { status: ++requests === 1 ? 401 : 403 }))
  const response = await kimi.fetchQuota({ kimi: "synthetic-first", "kimi-code-plan-cn": "synthetic-second" })
  assert.equal(requests, 2)
  assert.equal(response.ok, false)
  assert.equal(response.configured, true)
  assert.equal(response.status, 403)
  assert.equal(response.usage, null)
  assert.equal(JSON.stringify(response).includes("synthetic-secret"), false)
})

test("Kimi shares one sub-route deadline across attempts and stops on global timeout", async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const deadlines: number[] = []
  t.mock.method(AbortSignal, "timeout", (ms: number) => { deadlines.push(ms); return timeout(30) })
  const signals: AbortSignal[] = []
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    signals.push(init.signal!)
    if (signals.length === 1) return new Response(null, { status: 401 })
    return await new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("Synthetic timeout")), { once: true })
    })
  })
  // Keep the test alive while AbortSignal.timeout's unref'ed deadline expires.
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const response = await kimi.fetchQuota({ kimi: "synthetic-first", "kimi-code-plan-cn": "synthetic-second", "kimi-code-plan-global": "synthetic-third" })
    assert.deepEqual(deadlines, [12_000])
    assert.equal(signals.length, 2)
    assert.equal(signals[0], signals[1])
    assert.equal(signals[0].aborted, true)
    assert.equal(response.ok, false)
    assert.equal(response.usage, null)
  } finally { clearTimeout(keepAlive) }
})

test("Kimi propagates owner cancellation and skips every later key", async t => {
  const controller = new AbortController()
  let calls = 0
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++
    controller.abort()
    assert.equal(init.signal!.aborted, true)
    throw new Error("Synthetic cancellation")
  })
  const response = await kimi.fetchQuota({ kimi: "synthetic-first", "kimi-code-plan-cn": "synthetic-second" }, { signal: controller.signal })
  assert.equal(response.ok, false)
  assert.equal(response.usage, null)
  assert.equal(calls, 1)
  await kimi.fetchQuota({ kimi: "synthetic-first" }, { signal: controller.signal })
  assert.equal(calls, 1, "already aborted readers send no credential")
})

test("Kimi ratios expose consumed and remaining percentages with independent calendar-month caps", async () => {
  const { result } = await withFetchStub({ usages: {
    limit_5h: { used_ratio: 0.3, reset_time: kimiReset },
    limit_7d: { used_ratio: "0.3", reset_time: kimiReset },
    limit_month_total: { used_ratio: 1, reset_time: kimiReset },
    limit_month_code: { used_ratio: "0", reset_time: kimiReset },
  } }, () => kimi.fetchQuota({ kimi: "synthetic-key" }))
  assert.equal(result.ok, true)
  const windows = result.usage!.windows
  assert.deepEqual(Object.keys(windows), ["5h", "weekly", "monthly", "monthly-code"])
  for (const label of ["5h", "weekly"]) {
    assert.equal(windows[label].usedPercent, 30)
    assert.equal(windows[label].remainingPercent, 70)
  }
  assert.equal(windows["5h"].windowSeconds, 18_000)
  assert.equal(windows.weekly.windowSeconds, 604_800)
  assert.equal(windows.monthly.usedPercent, 100)
  assert.equal(windows.monthly.remainingPercent, 0)
  assert.equal(windows["monthly-code"].usedPercent, 0)
  for (const label of ["monthly", "monthly-code"]) {
    assert.equal(windows[label].windowSeconds, null)
    assert.equal(windows[label].resetAt, Date.parse(kimiReset))
    assert.equal(windows[label].valueLabel, undefined, "common used-percent rendering owns the monthly value")
  }
})

test("Kimi ignores invalid ratios instead of clamping them into available quota", async () => {
  for (const used_ratio of [null, "", " ", "invalid", true, -0.1, 1.1, "-1", "2"]) {
    const { result } = await withFetchStub({ usages: { limit_month_total: { used_ratio } } }, () => kimi.fetchQuota({ kimi: "synthetic-key" }))
    assert.equal(result.ok, false, `invalid ratio ${String(used_ratio)}`)
    assert.equal(result.usage, null)
  }
  const { result } = await withFetchStub({ usages: {
    limit_5h: { used_ratio: 0.3 }, limit_7d: { used_ratio: "bad" }, limit_month_total: { used_ratio: -1 },
  } }, () => kimi.fetchQuota({ kimi: "synthetic-key" }))
  assert.deepEqual(Object.keys(result.usage!.windows), ["5h"])
})

test("Kimi preserves legacy usage/limits and merges overlapping ratio windows without duplicates", async () => {
  const legacy = { usage: { limit: "100", remaining: "70", resetTime: kimiReset }, limits: [
    { window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: 100, remaining: 80, resetTime: kimiReset } },
    { window: { duration: 7, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: 100, remaining: 60, resetTime: kimiReset } },
  ] }
  const { result } = await withFetchStub(legacy, () => kimi.fetchQuota({ kimi: "synthetic-key" }))
  assert.deepEqual(Object.keys(result.usage!.windows), ["weekly", "5h"])
  assert.equal(result.usage!.windows.weekly.usedPercent, 40)
  assert.equal(result.usage!.windows["5h"].usedPercent, 20)
  const merged = await withFetchStub({ ...legacy, ...kimiPayload }, () => kimi.fetchQuota({ kimi: "synthetic-key" }))
  assert.deepEqual(Object.keys(merged.result.usage!.windows), ["weekly", "5h"])
  assert.equal(merged.result.usage!.windows["5h"].usedPercent, 30)
  const usageOnly = await withFetchStub({ usage: legacy.usage }, () => kimi.fetchQuota({ kimi: "synthetic-key" }))
  assert.equal(usageOnly.result.usage!.windows.weekly.usedPercent, 30)
})

function respondWith(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } })
}

async function withFetchStub<T>(payload: unknown, run: () => Promise<T>): Promise<{ result: T; requestUrl: string | undefined }> {
  const original = globalThis.fetch
  let requestUrl: string | undefined
  globalThis.fetch = (async (input: any) => {
    requestUrl = String(input)
    return respondWith(payload)
  }) as typeof fetch
  try {
    return { result: await run(), requestUrl }
  } finally {
    globalThis.fetch = original
  }
}

const zai = apiKeyProviders.find((provider) => provider.id === "zai-coding-plan")!
const zhipu = apiKeyProviders.find((provider) => provider.id === "zhipuai-coding-plan")!

const tokenQuota = { code: 200, success: true, data: { limits: [
  { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25 },
] } }

async function nativeKeyContext(providerID: string, apiKey: string) {
  const directory = "D:/synthetic-project"
  const connection = { assertCurrent() {}, client: { provider: { get: async () => ({
    location: { directory }, data: { id: providerID, settings: { apiKey } },
  }) } } } as unknown as Parameters<typeof readUsageProviderSettings>[0]
  return (await readUsageProviderSettings(connection, providerID, directory, AbortSignal.timeout(15_000))).context
}

for (const provider of [zai, zhipu]) {
  test(`${provider.id} prefers the effective native key, including resolved file/env references`, async () => {
    const previous = globalThis.fetch
    const keys: string[] = []
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), provider === zai ? "https://api.z.ai/api/monitor/usage/quota/limit" : "https://open.bigmodel.cn/api/monitor/usage/quota/limit")
      assert.equal(init?.method ?? "GET", "GET", "quota reads never activate gifts")
      assert.equal(init?.redirect, "error")
      assert.equal(init?.signal instanceof AbortSignal, true)
      keys.push(new Headers(init?.headers).get("Authorization")!)
      return respondWith(tokenQuota)
    }
    try {
      // Native substitution is qualified separately by test-usage-settings-native.mjs.
      for (const key of ["synthetic-literal-key", "synthetic-env-key", "synthetic-file-key"]) {
        const context = await nativeKeyContext(provider.id, key)
        assert.equal((await provider.fetchQuota(auth, context)).ok, true)
      }
      assert.deepEqual(keys, ["Bearer synthetic-literal-key", "Bearer synthetic-env-key", "Bearer synthetic-file-key"])
      for (const value of ["", "{env:SYNTHETIC_MISSING}", "{file:./synthetic-missing.txt}"]) {
        const context = await nativeKeyContext(provider.id, value)
        const missing = await provider.fetchQuota({}, context)
        assert.equal(missing.configured, false)
        assert.equal(missing.ok, false)
        assert.equal(keys.length, 3, "absent/unresolved references never make a request")
      }
      for (const value of ["", "{env:SYNTHETIC_MISSING}", "{file:./synthetic-missing.txt}"]) {
        const context = await nativeKeyContext(provider.id, value)
        assert.equal((await provider.fetchQuota(auth, context)).ok, true)
      }
      assert.deepEqual(keys.slice(3), Array(3).fill(`Bearer ${provider === zai ? "test-zai-key" : "test-zhipu-key"}`))
    } finally { globalThis.fetch = previous }
  })

  test(`${provider.id} publishes only a bounded business code from HTTP 200 failures`, async () => {
    for (const code of [1001, "1001", 999999999, "1001\n", "synthetic-secret", null]) {
      clearProviderUsageCache()
      const { result } = await withFetchStub({ code, success: false, msg: "synthetic-secret", data: tokenQuota.data },
        () => getProviderUsage(provider.id, { auth }))
      assert.equal(result.ok, false)
      assert.equal(result.configured, true)
      assert.equal(result.unavailableReason, "provider-error")
      assert.equal(result.providerErrorCode, code === 1001 || code === "1001" ? "1001" : undefined)
      assert.deepEqual(result.windows, {}, "a business error cannot retain quota values")
      assert.equal(JSON.stringify(result).includes("synthetic-secret"), false)
      assert.equal(JSON.stringify(result).includes("test-zai-key"), false)
    }
    // An explicit non-success code wins even if success is absent or contradictory.
    for (const success of [undefined, true]) {
      const { result } = await withFetchStub({ code: 1001, success, data: tokenQuota.data }, () => provider.fetchQuota(auth))
      assert.equal(result.ok, false)
      assert.equal(result.providerErrorCode, "1001")
    }
    clearProviderUsageCache()
  })

  test(`${provider.id} makes empty or unusable payloads unavailable instead of successful empty cards`, async () => {
    for (const payload of [null, {}, { code: 200, success: true }, { data: { limits: [] } },
      { data: { limits: [{ type: "TOKENS_LIMIT" }, { type: "CREDIT_LIMIT", usage: 0 }, { type: "GIFT_LIMIT", percentage: 10 }] } }]) {
      const { result } = await withFetchStub(payload, () => provider.fetchQuota(auth))
      assert.equal(result.ok, false)
      assert.equal(result.usage, null)
      assert.equal(result.unavailableReason, "provider-error")
    }
  })

  test(`${provider.id} preserves HTTP failure status and redacts upstream bodies`, async () => {
    const previous = globalThis.fetch
    globalThis.fetch = async () => new Response("synthetic-secret", { status: 401 })
    try {
      const result = await provider.fetchQuota(auth)
      assert.equal(result.ok, false)
      assert.equal(result.status, 401)
      assert.equal(result.unavailableReason, undefined)
      assert.equal(JSON.stringify(result).includes("synthetic-secret"), false)
    } finally { globalThis.fetch = previous }
  })
}

test("parses credit-based limits into usage windows", async () => {
  const { result } = await withFetchStub(
    {
      code: 200,
      msg: "Operation successful",
      success: true,
      data: {
        level: "lite",
        limits: [
          { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 157, remaining: 1842, percentage: 7, nextResetTime: CREDIT_RESET_AT },
          { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 157, remaining: 9843, percentage: 1, nextResetTime: TOKENS_RESET_AT },
        ],
      },
    },
    () => zai.fetchQuota(auth),
  )

  assert.equal(result.ok, true)
  const windows = result.usage!.windows
  assert.equal(windows["5h"]?.usedPercent, 7)
  assert.equal(windows["5h"]?.windowSeconds, 18_000)
  assert.equal(windows["5h"]?.resetAt, CREDIT_RESET_AT)
  assert.equal(windows["weekly"]?.usedPercent, 1)
  assert.equal(windows["weekly"]?.windowSeconds, 604_800)
  assert.equal("valueLabel" in (windows["weekly"] ?? {}), false)
})

test("derives usedPercent when the credit payload omits percentage", async () => {
  const { result } = await withFetchStub(
    {
      data: { limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 2000, currentValue: 158, remaining: 1842, nextResetTime: CREDIT_RESET_AT }] },
    },
    () => zai.fetchQuota(auth),
  )

  const window = result.usage!.windows["weekly"]
  // (2000 - 1842) / 2000
  assert.ok(Math.abs((window?.usedPercent ?? 0) - 7.9) < 0.001)
  assert.equal(window?.windowSeconds, 604_800)
})

test("coerces string quota fields and skips unusable or unknown entries without throwing", async () => {
  const { result } = await withFetchStub(
    {
      data: {
        limits: [
          null,
          { type: "UNKNOWN_LIMIT" },
          { type: "PROMO_LIMIT", percentage: 55, remaining: 10, usage: 20 },
          { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: "10000", remaining: "9800", percentage: "2", nextResetTime: TOKENS_RESET_AT },
        ],
      },
    },
    () => zai.fetchQuota(auth),
  )

  assert.equal(result.ok, true)
  const windows = result.usage!.windows
  assert.equal(Object.keys(windows).length, 1)
  assert.equal(windows["weekly"]?.usedPercent, 2)
})

test("keeps legacy token and time windows intact for the bigmodel endpoint", async () => {
  const { result, requestUrl } = await withFetchStub(
    {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 1, percentage: 42, nextResetTime: TOKENS_RESET_AT },
          { type: "TIME_LIMIT", number: 1, percentage: 11 },
        ],
      },
    },
    () => zhipu.fetchQuota(auth),
  )

  assert.equal(requestUrl, "https://open.bigmodel.cn/api/monitor/usage/quota/limit")
  assert.equal(result.ok, true)
  const windows = result.usage!.windows
  assert.equal(windows["1h"]?.usedPercent, 42)
  assert.equal(windows["mcp-tools"]?.usedPercent, 11)
})

test("credit consumption uses currentValue when remaining and percentage are absent", async () => {
  const { result } = await withFetchStub({ code: 200, success: true, data: { limits: [
    { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 160, nextResetTime: CREDIT_RESET_AT },
  ] } }, () => zai.fetchQuota(auth))
  assert.equal(result.ok, true)
  assert.equal(result.usage?.windows["5h"].usedPercent, 8)
  assert.equal(result.usage?.windows["5h"].resetAt, CREDIT_RESET_AT)
  assert.equal(result.usage?.windows["5h"].balanceUSD, undefined, "plan credits are never USD")
})

const openrouter = apiKeyProviders.find(provider => provider.id === "openrouter")!
const routerAuth = { openrouter: { type: "api", key: "synthetic-stored-key" } }

test("OpenRouter rejects explicit invalid native destinations, including a missing substituted environment value", async t => {
  let requests = 0
  t.mock.method(globalThis, "fetch", async () => { requests++; return respondWith({ data: { limit: 100, limit_remaining: 75 } }) })
  const directory = "D:/synthetic-project"
  for (const baseURL of ["", "   ", null, 123, "{env:SYNTHETIC_MISSING_URL}", "https://localhost/v1"]) {
    const connection = { assertCurrent() {}, client: { provider: { get: async () => ({
      location: { directory }, data: { id: "openrouter", settings: { baseURL } },
    }) } } } as unknown as Parameters<typeof readUsageProviderSettings>[0]
    // The daemon substitutes an absent {env:...} variable with an explicit empty string.
    const { context } = await readUsageProviderSettings(connection, "openrouter", directory, AbortSignal.timeout(15_000))
    const response = await openrouter.fetchQuota(routerAuth, context)
    assert.equal(response.unavailableReason, "invalid-base-url", `native destination ${String(baseURL)}`)
    assert.equal(response.ok, false)
    assert.equal(requests, 0, "an explicit invalid destination never authorizes the public fallback")
  }
})

test("OpenRouter keeps the stored-key fallback when the native apiKey is empty", async () => {
  await withRouterStub(async requests => {
    const context = await nativeKeyContext("openrouter", "")
    assert.equal((await openrouter.fetchQuota(routerAuth, context)).ok, true)
    assert.deepEqual(requests, ["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/credits"])
  })
})

async function withRouterStub(run: (requests: string[]) => Promise<void>, keyData: unknown = { limit: 100, limit_remaining: 75, usage: 999 }, creditsStatus = 403) {
  const previous = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    requests.push(String(input))
    assert.equal(init?.redirect, "error")
    assert.equal(init?.signal instanceof AbortSignal, true)
    assert.match(new Headers(init?.headers).get("Authorization") ?? "", /^Bearer synthetic-/)
    return String(input).endsWith("/key") ? respondWith({ data: keyData })
      : new Response(JSON.stringify({ data: { total_credits: 200, total_usage: 50 } }), { status: creditsStatus })
  }
  clearProviderUsageCache()
  try { await run(requests) } finally { globalThis.fetch = previous; clearProviderUsageCache() }
}

for (const baseURL of [undefined, "https://gateway.example/prefix/api/v1", "https://gateway.example/prefix/api/v1/"]) {
  test(`OpenRouter reads /key and optional /credits at the validated base ${baseURL ?? "default"}`, async () => {
    await withRouterStub(async requests => {
      const result = await openrouter.fetchQuota(routerAuth, { settings: { baseURL } })
      const base = (baseURL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "")
      assert.deepEqual(requests, [`${base}/key`, `${base}/credits`])
      assert.equal(result.ok, true, "a /credits denial leaves the key limit available")
      assert.equal(result.usage?.windows.key_limit.usedPercent, 25, "lifetime usage is unrelated to the current key limit")
      assert.deepEqual(result.usage?.windows.key_limit.balanceUSD, { remaining: 75, total: 100 })
      assert.equal(result.usage?.windows.key_limit.valueLabel, undefined)
      assert.equal(result.usage?.windows.credits, undefined)
    })
  })
}

test("OpenRouter rejects invalid destinations and unreadable settings without any request or public fallback", async () => {
  await withRouterStub(async requests => {
    for (const baseURL of ["", "http://gateway.example/v1", "https://user:pass@gateway.example/v1", "https://gateway.example:443/v1", "https://gateway.example/v1?q=1", "https://gateway.example/v1#frag", "https://localhost/v1", "https://sub.localhost/v1", "https://127.0.0.1/v1", "https://[::1]/v1", "https://2130706433/v1", "{env:ROUTER_URL}"]) {
      const response = await getProviderUsage("openrouter", { auth: routerAuth, context: { settings: { baseURL } } })
      assert.equal(response.unavailableReason, "invalid-base-url")
      assert.equal(response.ok, false)
      assert.deepEqual(response.windows, {})
      assert.equal(JSON.stringify(response).includes(baseURL || "synthetic-"), false)
    }
    for (const settingsStatus of ["unavailable", "unresolved"] as const) {
      const response = await openrouter.fetchQuota(routerAuth, { settingsStatus })
      assert.equal(response.ok, false)
      assert.equal(response.unavailableReason, "provider-error")
    }
    assert.deepEqual(requests, [])
  })
})

test("OpenRouter keeps account credits distinct and omits an unlimited key's limit", async () => {
  await withRouterStub(async () => {
    const result = await openrouter.fetchQuota(routerAuth)
    assert.equal(result.ok, true)
    assert.equal(result.usage?.windows.key_limit, undefined)
    assert.equal(result.usage?.windows.credits.usedPercent, 25)
    assert.deepEqual(result.usage?.windows.credits.balanceUSD, { remaining: 150, total: 200 })
  }, { limit: null, limit_remaining: null, usage: 999 }, 200)
})

test("OpenRouter's explicit zero limit is exhausted rather than unlimited", async () => {
  await withRouterStub(async () => {
    const result = await openrouter.fetchQuota(routerAuth)
    assert.equal(result.usage?.windows.key_limit.usedPercent, 100)
  }, { limit: 0, limit_remaining: 0 })
})

test("OpenRouter shows the key limit and successful account credits as separate rows", async () => {
  await withRouterStub(async () => {
    const result = await openrouter.fetchQuota(routerAuth)
    assert.deepEqual(Object.keys(result.usage!.windows), ["key_limit", "credits"])
    assert.deepEqual(result.usage?.windows.key_limit.balanceUSD, { remaining: 75, total: 100 })
    assert.deepEqual(result.usage?.windows.credits.balanceUSD, { remaining: 150, total: 200 })
  }, { limit: 100, limit_remaining: 75 }, 200)
})

test("OpenRouter leaves an unlimited key without a fake zero-percent window when account credits are denied", async () => {
  await withRouterStub(async () => {
    const result = await openrouter.fetchQuota(routerAuth)
    assert.equal(result.ok, true)
    assert.deepEqual(result.usage?.windows, {})
  }, { limit: null, limit_remaining: null })
})

test("OpenRouter's optional credit read can time out without discarding the key limit", async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async input => {
    if (String(input).endsWith("/key")) return respondWith({ data: { limit: 100, limit_remaining: 75 } })
    throw new DOMException("Synthetic timeout", "TimeoutError")
  }
  try {
    const result = await openrouter.fetchQuota(routerAuth)
    assert.equal(result.ok, true)
    assert.equal(result.usage?.windows.key_limit.usedPercent, 25)
    assert.equal(result.usage?.windows.credits, undefined)
  } finally { globalThis.fetch = previous }
})

test("OpenRouter never invents a limit from lifetime usage or a malformed payload", async () => {
  for (const data of [null, {}, { usage: 999 }, { limit: -1, limit_remaining: 1 }]) await withRouterStub(async requests => {
    const result = await openrouter.fetchQuota(routerAuth)
    assert.equal(result.ok, false)
    assert.equal(requests.length, 1)
  }, data)
})

test("OpenRouter gateway without /key preserves HTTP status and never forwards the key elsewhere", async () => {
  const previous = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async input => { requests.push(String(input)); return new Response(null, { status: 404 }) }
  try {
    const result = await openrouter.fetchQuota(routerAuth, { settings: { baseURL: "https://gateway.example/prefix" } })
    assert.equal(result.ok, false)
    assert.equal(result.status, 404)
    assert.deepEqual(requests, ["https://gateway.example/prefix/key"])
  } finally { globalThis.fetch = previous }
})

test("OpenRouter settings keys and changed base URLs are used and fence the display cache", async () => {
  const previous = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    requests.push(String(input))
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-configured-key")
    return String(input).endsWith("/key") ? respondWith({ data: { limit: 100, limit_remaining: requests.length === 1 ? 75 : 50 } })
      : new Response(null, { status: 403 })
  }
  clearProviderUsageCache()
  try {
    const context: ProviderReadContext = { settingsStatus: "available", settings: { apiKey: "synthetic-configured-key", baseURL: "https://first.example/api/v1" } }
    const read = () => getProviderUsage("openrouter", { auth: routerAuth, context })
    assert.equal((await read()).windows.key_limit.usedPercent, 25)
    assert.equal((await read()).windows.key_limit.usedPercent, 25)
    context.settings!.baseURL = "https://second.example/prefix"
    assert.equal((await read()).windows.key_limit.usedPercent, 50)
    assert.deepEqual(requests, ["https://first.example/api/v1/key", "https://first.example/api/v1/credits", "https://second.example/prefix/key", "https://second.example/prefix/credits"])
  } finally { globalThis.fetch = previous; clearProviderUsageCache() }
})
