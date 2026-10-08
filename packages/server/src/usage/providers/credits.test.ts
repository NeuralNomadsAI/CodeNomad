import assert from "node:assert/strict"
import test from "node:test"

import { creditProviders, parseClinePassUsage, parseExeDevUsage } from "./credits"

const provider = (id: string) => creditProviders.find(candidate => candidate.id === id)!

async function withFetch(payload: unknown, run: (requests: { url: string; init?: RequestInit }[]) => Promise<void>, status = 200) {
  const previous = globalThis.fetch
  const requests: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    return Response.json(payload, { status })
  }) as typeof fetch
  try { await run(requests) } finally { globalThis.fetch = previous }
}

async function withEnv(name: string, value: string, run: () => Promise<void>) {
  const previous = process.env[name]
  process.env[name] = value
  try { await run() } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test("ClinePass reports its rolling and monthly limits", () => {
  const usage = parseClinePassUsage({ data: { limits: [
    { type: "five_hour", percentUsed: "12.5", resetsAt: "2026-10-09T05:00:00Z" },
    { type: "weekly", percentUsed: 40 },
    { type: "monthly", percentUsed: 3 },
    { type: "unknown", percentUsed: 99 },
  ] } })
  assert.deepEqual(Object.keys(usage.windows), ["5h", "weekly", "monthly"])
  assert.equal(usage.windows["5h"].usedPercent, 12.5)
  assert.equal(usage.windows["5h"].windowSeconds, 18_000)
  assert.equal(usage.windows.monthly.windowSeconds, null)
  assert.throws(() => parseClinePassUsage({ data: { limits: [] } }), /No quota data/)
})

test("exe.dev reports monthly spend against its allowance", () => {
  const usage = parseExeDevUsage({ total_cost_usd: 5, monthly_allowance_usd: 20, period_end: "2026-11-01T00:00:00Z" })
  assert.equal(usage.windows.monthly.usedPercent, 25)
  assert.equal(usage.windows.monthly.valueLabel, "$5.00 / $20.00")
  assert.throws(() => parseExeDevUsage({ total_cost_usd: 5, monthly_allowance_usd: 20 }), /No quota data/)
})

test("credit balance providers read their stored OpenCode key", async () => {
  await withFetch({ checklist: { stripe_balance: "-12.5" } }, async (requests) => {
    const result = await provider("deepinfra").fetchQuota({ "deep-infra": { type: "api", key: "di-key" } })
    assert.equal(result.usage?.windows.credits_balance.valueLabel, "$12.50")
    assert.equal(new Headers(requests[0].init?.headers).get("Authorization"), "Bearer di-key")
  })
  await withFetch({ balance: 200 }, async () => {
    const result = await provider("hyper").fetchQuota({ hyper: { type: "api", key: "k" } })
    assert.equal(result.usage?.windows.credits_balance.valueLabel, "$10.00")
    assert.equal(result.usage?.windows.credits.valueLabel, "200")
  })
  await withFetch({ balance: "3.456" }, async (requests) => {
    const result = await provider("kilo").fetchQuota({ kilo: { type: "oauth", access: "kilo-access", accountId: "org-1" } })
    assert.equal(result.usage?.windows.credits_balance.valueLabel, "$3.46")
    assert.equal(new Headers(requests[0].init?.headers).get("x-kilocode-organizationid"), "org-1")
  })
  await withFetch({}, async () => {
    const result = await provider("deepinfra").fetchQuota({ deepinfra: { type: "api", key: "k" } })
    assert.equal(result.ok, false)
    assert.match(result.error ?? "", /No quota data/)
  })
  await withFetch({}, async () => {
    const result = await provider("cline-pass").fetchQuota({ "cline-pass": { type: "api", key: "k" } })
    assert.equal(result.ok, false)
  }, 401)
})

test("credentials OpenCode does not hold come from explicit environment variables", async () => {
  for (const id of ["zenmux", "exe-dev"]) {
    const result = await provider(id).fetchQuota({ [id]: { type: "api", key: "inference-key" } })
    assert.equal(result.configured, false)
  }
  await withEnv("ZENMUX_PLATFORM_API_KEY", "platform-key", () => withFetch({ data: { total_credits: 7 } }, async (requests) => {
    const result = await provider("zenmux").fetchQuota({})
    assert.equal(result.usage?.windows.credits_balance.valueLabel, "$7.00")
    assert.equal(new Headers(requests[0].init?.headers).get("Authorization"), "Bearer platform-key")
  }))
})
