import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import { oauthProviders, parseCodexUsage } from "./oauth"

test("parses Codex rate limits, credits, and business spend limits", () => {
  const usage = parseCodexUsage({
    rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 25, reset_at: 2_000_000_000 } },
    credits: { balance: 12.5, unlimited: false },
    spend_control: { individual_limit: { used: 10, limit: 100, used_percent: 10 } },
  })
  assert.equal(usage.windows["5h"].usedPercent, 25)
  assert.equal(usage.windows.credits_balance.valueLabel, "$12.50")
  assert.equal(usage.windows.credits.valueLabel, "10 / 100 used")
})

const copilot = oauthProviders.find(provider => provider.id === "github-copilot")!
const copilotAuth = (enterpriseUrl?: unknown) => ({ "github-copilot": { type: "oauth", access: "synthetic-copilot",
  ...(enterpriseUrl !== undefined ? { enterpriseUrl } : {}) } })

test("Copilot reads public and Enterprise credentials only at their validated destination", async () => {
  const previousFetch = globalThis.fetch
  try {
    for (const [enterpriseUrl, endpoint] of [
      [undefined, "https://api.github.com/copilot_internal/user"],
      ["github.com", "https://api.github.com/copilot_internal/user"],
      ["company.ghe.com", "https://api.company.ghe.com/copilot_internal/user"],
      ["https://Company.GHE.com/", "https://api.company.ghe.com/copilot_internal/user"],
      ["github.corp.example.com", "https://api.github.corp.example.com/copilot_internal/user"],
    ]) {
      const signal = AbortSignal.timeout(1000)
      let calls = 0
      globalThis.fetch = async (input, init) => {
        calls++
        assert.equal(input, endpoint)
        assert.equal(new Headers(init?.headers).get("authorization"), "token synthetic-copilot")
        assert.equal(init?.redirect, "error")
        assert.equal(init?.signal, signal)
        return Response.json({ copilot_plan: "enterprise", quota_reset_date: "2026-12-01",
          quota_snapshots: { premium_interactions: { entitlement: "100", quota_remaining: 74.25,
            percent_remaining: 80, credits_used: 999, quota_reset_at: 1_900_000_000 } } })
      }
      const result = await copilot.fetchQuota(copilotAuth(enterpriseUrl), { signal })
      assert.equal(result.ok, true)
      assert.equal(calls, 1)
      assert.equal(result.usage?.copilotPlan, "enterprise")
      assert.deepEqual(result.usage?.windows.premium.consumption, { used: 25.75, limit: 100 })
      assert.equal(result.usage?.windows.premium.usedPercent, 20, "server percentage governs the bar independently of credits_used")
      assert.equal(result.usage?.windows.premium.resetAt, 1_900_000_000_000)
    }
  } finally { globalThis.fetch = previousFetch }
})

test("Copilot refuses unsafe raw Enterprise destinations without requests or public fallback", async () => {
  const previousFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("must not send") }
  try {
    for (const host of ["", null, 443, {}, "http://company.ghe.com", "//company.ghe.com", "https://user@company.ghe.com",
      "https://user:pass@company.ghe.com", "company.ghe.com:443", "https://company.ghe.com:443/", "company.ghe.com:80",
      "https://company.ghe.com/path", "https://company.ghe.com/.", "https://company.ghe.com/a/..", "company.ghe.com//",
      "company.ghe.com?x=1", "company.ghe.com#fragment", "company.ghe.com?", "company.ghe.com#",
      "https://company.ghe.com\\@evil.example.com", "company.ghe.com\n", " company.ghe.com", "company.ghe.com\u0000",
      "localhost", "api.localhost", "github", "127.0.0.1", "https://127.0.0.1", "127.1", "2130706433",
      "0x7f000001", "0177.0.0.1", "https://[::1]", "https://%63ompany.ghe.com", "company%2eghe.com", "company.ghe.com%2f",
      "company..ghe.com", "-company.ghe.com", "company.ghe.com.", "https://company.ghe.com/%2e", `${"a".repeat(64)}.ghe.com`]) {
      const result = await copilot.fetchQuota(copilotAuth(host))
      assert.equal(result.ok, false)
      assert.equal(result.configured, true)
      assert.equal(result.unavailableReason, "invalid-base-url", String(host))
      assert.equal(result.usage, null)
      assert.equal(calls, 0)
    }
  } finally { globalThis.fetch = previousFetch }
})

test("Copilot handles percentage-only, fractional, unlimited and absent allocations faithfully", async () => {
  const previousFetch = globalThis.fetch
  const snapshots = { chat: { percent_remaining: 62.5 }, completions: { unlimited: true },
    premium_interactions: { entitlement: 300, percent_remaining: 99.5, credits_used: 500 } }
  try {
    globalThis.fetch = async () => Response.json({ quota_reset_date_utc: "2026-12-01T12:00:00Z", quota_reset_date: "2026-12-01",
      quota_snapshots: snapshots })
    const result = await copilot.fetchQuota(copilotAuth())
    assert.equal(result.usage?.copilotPlan, undefined)
    assert.equal(result.usage?.windows.chat.usedPercent, 37.5)
    assert.equal(result.usage?.windows.chat.consumption, undefined)
    assert.deepEqual(result.usage?.windows.completions.consumption, { unlimited: true })
    assert.equal(result.usage?.windows.completions.usedPercent, null)
    assert.deepEqual(result.usage?.windows.premium.consumption, { used: 1.5, limit: 300 })
    assert.equal(result.usage?.windows.premium.resetAt, Date.parse("2026-12-01T12:00:00Z"))
    for (const [source, consumption] of [
      [{ unlimited: true, credits_used: 12.125, entitlement: 100, percent_remaining: 100 }, { creditsUsed: 12.125 }],
      [{ unlimited: true, credits_used: 0 }, { creditsUsed: 0 }],
      [{ unlimited: true, credits_used: 1, has_quota: false }, { unlimited: true }],
      [{ unlimited: true, credits_used: -1 }, { unlimited: true }],
      [{ entitlement: 100, quota_remaining: 75 }, { used: 25, limit: 100 }],
    ] as const) {
      globalThis.fetch = async () => Response.json({ limited_user_reset_date: "2026-12-02", quota_snapshots: { premium_interactions: source } })
      const usage = await copilot.fetchQuota(copilotAuth())
      assert.deepEqual(usage.usage?.windows.premium.consumption, consumption)
      assert.equal(usage.usage?.windows.premium.resetAt, Date.parse("2026-12-02"))
    }
    globalThis.fetch = async () => Response.json({ quota_snapshots: { premium_interactions: { entitlement: 0, percent_remaining: 0 } } })
    assert.equal((await copilot.fetchQuota(copilotAuth())).ok, false)
  } finally { globalThis.fetch = previousFetch }
})

test("Copilot publishes only verified bounded plan names and preserves upstream 401", async () => {
  const previousFetch = globalThis.fetch
  try {
    for (const [plan, sku, expected] of [
      ["individual", undefined, "pro"], ["individual_pro", undefined, "proPlus"], ["individual_max", undefined, "max"],
      ["individual_edu", undefined, "student"], ["business", undefined, "business"], ["enterprise", undefined, "enterprise"],
      [undefined, "free_limited_copilot", "free"], [undefined, "free_educational_quota", "student"],
      ["unrecognized".repeat(100), undefined, undefined], ["__proto__", undefined, undefined],
    ]) {
      globalThis.fetch = async () => Response.json({ copilot_plan: plan, access_type_sku: sku, quota_snapshots: { chat: { unlimited: true } } })
      assert.equal((await copilot.fetchQuota(copilotAuth())).usage?.copilotPlan, expected)
    }
    for (const host of [undefined, "company.ghe.com"]) {
      globalThis.fetch = async () => new Response("do not expose upstream body", { status: 401 })
      const result = await copilot.fetchQuota(copilotAuth(host))
      assert.equal(result.status, 401)
      assert.equal(result.ok, false)
      assert.equal(result.usage, null)
      assert.equal(result.error, "Provider returned HTTP 401")
    }
  } finally { globalThis.fetch = previousFetch }
})

test("rejects empty and malformed Codex usage payloads", () => {
  assert.throws(() => parseCodexUsage({}), /no quota data/)
  assert.throws(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent: "invalid" } } }), /no quota data/)
})

test("unscoped Codex requests never read or fall back to host legacy/CLI credentials", async () => {
  const previousRead = fs.readFileSync
  const previousFetch = globalThis.fetch
  let reads = 0
  let calls = 0
  fs.readFileSync = (() => {
    reads++
    return JSON.stringify({ openai: { type: "oauth", access: "legacy", expires: Date.now() + 3600000 },
      tokens: { access_token: "cli" } })
  }) as unknown as typeof fs.readFileSync
  globalThis.fetch = async () => { calls++; return Response.json({ rate_limit: { primary_window: { used_percent: 5 } } }) }
  try {
    const usage = await oauthProviders.find(provider => provider.id === "codex")!.fetchQuota({
      openai: { type: "oauth", access: "projected", expires: Date.now() + 3600000 },
    })
    assert.equal(usage.ok, false)
    assert.equal(reads, 0)
    assert.equal(calls, 0)
  } finally { fs.readFileSync = previousRead; globalThis.fetch = previousFetch }
})

test("rejects empty and malformed Copilot usage payloads after OAuth alias fallback", async () => {
  const previousFetch = globalThis.fetch
  const auth = { "github-copilot": { type: "api", key: "api-key" }, copilot: { type: "oauth", access: "copilot-access" } }
  try {
    for (const payload of [{}, { quota_snapshots: { chat: { entitlement: "invalid", remaining: 1 } } }]) {
      globalThis.fetch = async (_input, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "token copilot-access")
        return Response.json(payload)
      }
      const usage = await oauthProviders.find(provider => provider.id === "github-copilot")!.fetchQuota(auth)
      assert.equal(usage.ok, false)
      assert.match(usage.error ?? "", /no quota data/)
    }
  } finally {
    globalThis.fetch = previousFetch
  }
})
