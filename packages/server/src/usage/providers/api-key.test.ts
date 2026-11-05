import assert from "node:assert/strict"
import test from "node:test"

import { apiKeyProviders } from "./api-key"
import { clearProviderUsageCache, getProviderUsage } from "../service"
import type { ProviderReadContext } from "../types"

const auth = { "zai-coding-plan": { type: "api", key: "test-zai-key" }, "zhipuai-coding-plan": { type: "api", key: "test-zhipu-key" } }

const CREDIT_RESET_AT = 1787849891189
const TOKENS_RESET_AT = 1787950772998

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

const openrouter = apiKeyProviders.find(provider => provider.id === "openrouter")!
const routerAuth = { openrouter: { type: "api", key: "synthetic-stored-key" } }

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
