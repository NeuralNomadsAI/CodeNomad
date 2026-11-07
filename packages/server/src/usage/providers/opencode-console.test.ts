import assert from "node:assert/strict"
import test from "node:test"
import { openCodeConsole, parseOpenCodeConsoleModelsPage, parseOpenCodeConsoleSummary } from "./opencode-console"

const counters = (requests: unknown = "0") => ({ totalRequests: requests, totalInputTokens: "0", totalOutputTokens: "0",
  totalCacheReadTokens: "0", totalCacheWrite5mTokens: "0", totalCacheWrite1hTokens: "0", totalCostMicroCents: "0" })
const summary = (requests: unknown = "0") => ({ ...counters(requests), services: [] })
const item = (index = 0, requests: unknown = "1") => ({ ...counters(requests), provider: "openai", model: `model-${index}` })
const page = (number = 1, total = 0, pageCount = Math.ceil(total / 50)) => ({
  items: Array.from({ length: Math.min(50, Math.max(0, total - (number - 1) * 50)) }, (_, i) => item((number - 1) * 50 + i)),
  pageInfo: { page: number, pageSize: 50, total, pageCount },
})
const key = { opencode: { type: "api", key: "secret-key" } }
const oauth = (extra = {}) => ({ opencode: { type: "oauth", access: "secret-access", refresh: "secret-refresh",
  expires: Date.now() + 3600000, orgId: "wrk_fixture", server: "https://opencode.ai/console", ...extra } })

test("summary accepts decimal strings and zero, converts micro-cents to USD", () => {
  assert.deepEqual(parseOpenCodeConsoleSummary(summary()), { requests: 0, spentUsd: 0 })
  assert.deepEqual(parseOpenCodeConsoleSummary({ ...summary("42"), totalCostMicroCents: "125000000" }), { requests: 42, spentUsd: 1.25 })
  assert.equal(parseOpenCodeConsoleSummary(summary(String(Number.MAX_SAFE_INTEGER))).requests, Number.MAX_SAFE_INTEGER)
})

test("summary rejects wrong types, unsafe/negative/fractional metrics and overflowing service sums", () => {
  for (const invalid of [0, -1, "-1", "1.2", "1e3", " 1", "", "9007199254740992", null]) {
    assert.throws(() => parseOpenCodeConsoleSummary(summary(invalid)))
    assert.throws(() => parseOpenCodeConsoleSummary({ ...summary(), totalInputTokens: invalid }))
  }
  for (const invalid of [{}, null, { ...summary(), services: {} }, { ...summary(), services: [{ service: "api", totalRequests: "1" }] }]) {
    assert.throws(() => parseOpenCodeConsoleSummary(invalid))
  }
  for (const field of ["totalRequests", "totalCostMicroCents"]) {
    assert.throws(() => parseOpenCodeConsoleSummary({ ...summary(), services: [
      { service: "a", totalRequests: "0", totalCostMicroCents: "0", [field]: String(Number.MAX_SAFE_INTEGER) },
      { service: "b", totalRequests: "0", totalCostMicroCents: "0", [field]: "1" },
    ] }))
  }
})

test("model page validates pairs, decimal metrics and pagination including both empty shapes", () => {
  for (const count of [0, 1]) assert.deepEqual(parseOpenCodeConsoleModelsPage(page(1, 0, count), 1).models, [])
  const data = page(1, 2)
  data.items[1].provider = "anthropic"; data.items[1].model = data.items[0].model
  assert.deepEqual(parseOpenCodeConsoleModelsPage(data, 1).models, [
    { provider: "openai", model: "model-0", requests: 1 }, { provider: "anthropic", model: "model-0", requests: 1 },
  ])
  for (const info of [{ page: 2 }, { page: 0 }, { pageSize: 100 }, { pageCount: -1 }, { total: -1 },
    { pageCount: 3 }, { page: "1" }, { total: 1.1 }, { total: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => parseOpenCodeConsoleModelsPage({ ...page(1, 1), pageInfo: { ...page(1, 1).pageInfo, ...info } }, 1))
  }
  assert.throws(() => parseOpenCodeConsoleModelsPage({ ...page(1, 51), items: [] }, 1))
  assert.throws(() => parseOpenCodeConsoleModelsPage(page(2, 0), 2))
  assert.throws(() => parseOpenCodeConsoleModelsPage({ ...page(1, 1), items: [item(0, 1)] }, 1))
  assert.throws(() => parseOpenCodeConsoleModelsPage({ ...page(1, 2), items: [item(0, String(Number.MAX_SAFE_INTEGER)), item(1)] }, 1))
})

test("reader uses fixed bounded transport, mandatory summaries and sequential pages, with unavailable budgets", async t => {
  const urls: string[] = []
  let active = 0
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.equal(++active, 1)
    const url = new URL(String(input)); urls.push(url.pathname + url.search)
    assert.equal(url.origin, "https://opencode.ai")
    assert.equal(init?.redirect, "error")
    assert.ok(init?.signal)
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-access")
    assert.equal(new Headers(init?.headers).get("x-org-id"), "wrk_fixture")
    active--
    return Response.json(url.pathname.endsWith("summary") ? summary("0") : page(Number(url.searchParams.get("page")), 51))
  })
  const result = await openCodeConsole.fetchQuota(oauth())
  assert.equal(result.ok, true)
  assert.deepEqual(result.usage?.console?.requests, { "24h": 0, "7d": 0, "30d": 0 })
  assert.equal(result.usage?.console?.models.length, 51)
  assert.deepEqual(result.usage?.console?.budgets, { status: "unavailable", items: [] })
  assert.deepEqual(urls, ["/console/api/usage/summary?range=24h", "/console/api/usage/summary?range=7d",
    "/console/api/usage/summary?range=30d", "/console/api/usage/models?range=30d&page=1&pageSize=50",
    "/console/api/usage/models?range=30d&page=2&pageSize=50"])
  assert.equal(JSON.stringify(result).includes("secret-"), false)
})

test("API key uses only Authorization; missing/invalid OAuth and third-party credentials send nothing", async t => {
  let calls = 0
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    calls++
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-key")
    assert.equal(new Headers(init?.headers).get("x-org-id"), null)
    return Response.json(String(input).includes("summary") ? summary() : page())
  })
  assert.equal((await openCodeConsole.fetchQuota(key)).ok, true)
  assert.equal(calls, 4)
  for (const [auth, reason, configured] of [
    [{}, "missing-credential", false],
    [oauth({ expires: 1 }), "invalid-credential", true],
    [oauth({ orgId: "org_bad-header\r\n" }), "invalid-credential", true],
    [oauth({ orgId: "org_" }), "invalid-credential", true],
    [oauth({ server: "https://other.invalid" }), "invalid-credential", true],
    [oauth({ server: "https://opencode.ai/console/" }), "invalid-credential", true],
    [{ opencode: { ...key.opencode, server: "https://third-party.invalid" } }, "invalid-credential", true],
    [{ "opencode-go": key.opencode }, "missing-credential", false],
  ] as const) {
    const result = await openCodeConsole.fetchQuota(auth)
    assert.equal(result.unavailableReason, `opencode-console-${reason}`)
    assert.equal(result.configured, configured)
  }
  assert.equal(calls, 4)
})

for (const [status, reason] of [[401, "invalid-credential"], [403, "access-denied"], [500, "network-error"]] as const) {
  test(`HTTP ${status} is a redacted ${reason} without fallback`, async t => {
    let calls = 0
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("secret-upstream", { status }) })
    const result = await openCodeConsole.fetchQuota(oauth())
    assert.equal(result.unavailableReason, `opencode-console-${reason}`)
    assert.equal(result.usage, null)
    assert.equal(calls, 1)
    assert.equal(JSON.stringify(result).includes("secret"), false)
  })
}

for (const failed of ["summary24h", "summary7d", "summary30d", "models1", "models2"]) {
  test(`failed mandatory read ${failed} discards every partial result`, async t => {
    t.mock.method(globalThis, "fetch", async (input: unknown) => {
      const url = new URL(String(input)), isSummary = url.pathname.endsWith("summary")
      const current = isSummary ? `summary${url.searchParams.get("range")}` : `models${url.searchParams.get("page")}`
      return current === failed ? new Response("secret", { status: 403 }) :
        Response.json(isSummary ? summary() : page(Number(url.searchParams.get("page")), 51))
    })
    const result = await openCodeConsole.fetchQuota(key)
    assert.equal(result.ok, false); assert.equal(result.usage, null)
    assert.equal(result.unavailableReason, "opencode-console-access-denied")
  })
}

for (const failure of ["unsafe", "oversize", "json", "bound", "changed", "sum", "redirect", "network", "abort"]) {
  test(`rejects ${failure} without truncated or secret output`, async t => {
    const controller = new AbortController()
    let calls = 0
    t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
      calls++
      if (failure === "redirect") { assert.equal(init?.redirect, "error"); throw new TypeError("secret redirect") }
      if (failure === "network") throw new Error("secret network")
      if (failure === "abort") { controller.abort(); init?.signal?.throwIfAborted() }
      if (failure === "oversize") return new Response(" ".repeat(65537))
      if (failure === "json") return new Response("secret malformed JSON")
      const url = new URL(String(input))
      if (url.pathname.endsWith("summary")) return Response.json(summary(failure === "unsafe" ? "9007199254740992" : "0"))
      const number = Number(url.searchParams.get("page"))
      if (failure === "bound") return Response.json(page(1, 1001))
      if (failure === "changed") return Response.json(page(number, number === 1 ? 51 : 52))
      const data = page(number, 51)
      if (failure === "sum") data.items = data.items.map((_, i) => item(i, number === 1 && i === 0 ? String(Number.MAX_SAFE_INTEGER) : "0"))
      if (failure === "sum" && number === 2) data.items[0] = item(50)
      return Response.json(data)
    })
    const result = await openCodeConsole.fetchQuota(key, { signal: controller.signal })
    assert.equal(result.ok, false); assert.equal(result.usage, null)
    assert.equal(result.unavailableReason, ["redirect", "network", "abort"].includes(failure)
      ? "opencode-console-network-error" : "opencode-console-invalid-response")
    assert.equal(JSON.stringify(result).includes("secret"), false)
    assert.ok(calls <= 5)
  })
}

test("overall timeout aborts the credential-bearing request", async t => {
  const controller = new AbortController()
  t.mock.method(AbortSignal, "timeout", () => controller.signal)
  let transportSignal: AbortSignal | undefined
  t.mock.method(globalThis, "fetch", (_input: unknown, init?: RequestInit) => {
    transportSignal = init?.signal ?? undefined
    return new Promise((_resolve, reject) => {
      transportSignal?.addEventListener("abort", () => reject(new Error("secret timeout")), { once: true })
      controller.abort()
    })
  })
  assert.equal((await openCodeConsole.fetchQuota(key)).unavailableReason, "opencode-console-network-error")
  assert.equal(transportSignal?.aborted, true)
})

test("the permitted 1,000-row boundary reads exactly 20 sequential pages", async t => {
  let calls = 0, expectedPage = 1
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    calls++
    const url = new URL(String(input))
    if (url.pathname.endsWith("summary")) return Response.json(summary())
    const number = Number(url.searchParams.get("page"))
    assert.equal(number, expectedPage++)
    return Response.json(page(number, 1000))
  })
  const result = await openCodeConsole.fetchQuota(key)
  assert.equal(result.ok, true)
  assert.equal(result.usage?.console?.models.length, 1000)
  assert.equal(calls, 23)
  assert.equal(expectedPage, 21)
})
