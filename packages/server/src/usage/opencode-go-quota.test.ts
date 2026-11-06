import assert from "node:assert/strict"
import test from "node:test"
import { fetchOpenCodeGoQuota, OPENCODE_GO_USAGE_URL, OPENCODE_GO_CONSOLE_URL, OPENCODE_GO_BILLING_URL, parseOpenCodeGoQuota } from "./opencode-go-quota"
import { ProviderHttpError } from "./shared"
import { quotaState } from "../provider-accounts/service"

const now = Date.UTC(2026, 9, 12)
const reset = new Date(now + 3_600_000).toISOString()

test("parses the current and the older Go usage shapes", () => {
  const current = parseOpenCodeGoQuota({ usage: {
    rolling: { status: "ok", percent: 40, resetsAt: reset },
    weekly: { status: "rate-limited", percent: 12, resetsAt: reset },
    monthly: { status: "ok", percent: 5, resetsAt: reset },
  } }, now)
  assert.deepEqual(Object.keys(current.windows), ["5h", "weekly", "monthly"])
  assert.equal(current.windows["5h"].windowSeconds, 18_000)
  assert.equal(current.windows["5h"].usedPercent, 40)
  assert.equal(current.windows.weekly.usedPercent, 100, "rate-limited means exhausted")
  assert.equal(quotaState(current, now), "exhausted")

  const older = parseOpenCodeGoQuota({ rollingUsage: { usagePercent: 120, resetInSec: 60 }, weeklyUsage: { usagePercent: 3, resetInSec: 600 } }, now)
  assert.equal(older.windows["5h"].usedPercent, 100)
  assert.equal(older.windows["5h"].resetAt, now + 60_000)
  assert.equal(quotaState(older, now), "exhausted")
  assert.equal(quotaState(parseOpenCodeGoQuota({ usage: { rolling: { status: "ok", percent: 10, resetsAt: reset } } }, now), now), "available")
})

const consoleQuota = () => ({ product: "go-teams", useBalance: true, access: { meters: {
  fiveHour: { usedMicroCents: "25000000", limitMicroCents: "100000000", resetsAt: reset },
  week: { usedMicroCents: "50000000", limitMicroCents: "200000000", resetsAt: reset },
  month: { usedMicroCents: "75000000", limitMicroCents: "300000000", resetsAt: reset },
} } })

for (const [balance, expected] of [["150000000", 1.5], [150000000, 1.5], [0, 0], ["0", 0], ["150000000.5", 1.500000005],
  [undefined, null], [null, null], ["not-money", null], ["", null], ["0x10", null], ["1e8", null], ["9007199254740992", null]] as const) {
  test(`Console OAuth separates its wallet from unchanged Go windows (${String(balance)})`, async t => {
    const requests: string[] = []
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push(url)
      assert.equal(init.redirect, "error")
      assert.equal(init.signal, signal)
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer fixture-console")
      assert.equal(new Headers(init.headers).get("x-org-id"), "org_fixture")
      return Response.json(url === OPENCODE_GO_CONSOLE_URL ? consoleQuota() : { availableMicroCents: balance })
    })
    const signal = AbortSignal.timeout(2000)
    const usage = await fetchOpenCodeGoQuota({ token: "fixture-console", orgID: "org_fixture", consoleOAuth: true }, signal)
    assert.deepEqual(requests, [OPENCODE_GO_CONSOLE_URL, OPENCODE_GO_BILLING_URL])
    const { credits_balance, ...windows } = usage.windows
    assert.equal(credits_balance?.balanceUSD?.remaining ?? null, expected)
    assert.deepEqual(Object.keys(windows), ["5h", "weekly", "monthly"])
    assert.ok(Object.values(windows).every(window => window.usedPercent === 25 && window.resetAt === Date.parse(reset)))
    if (credits_balance) assert.equal(quotaState({ windows: { credits_balance } }, now), "unknown", "wallet alone never proves quota availability")
    assert.equal(quotaState(usage, now), "available")
  })
}

test("Console wallet alone remains unknown; missing billing access preserves Go windows", async t => {
  let walletOnly = true
  t.mock.method(globalThis, "fetch", async (url: string) => url === OPENCODE_GO_CONSOLE_URL
    ? Response.json(walletOnly ? { access: null } : consoleQuota())
    : walletOnly ? Response.json({ availableMicroCents: "0" }) : Response.json({ message: "fixture-private" }, { status: 403 }))
  const auth = { token: "fixture-console", orgID: "org_fixture", consoleOAuth: true as const }
  const usage = await fetchOpenCodeGoQuota(auth, AbortSignal.timeout(2000))
  assert.deepEqual(Object.keys(usage.windows), ["credits_balance"])
  assert.equal(quotaState(usage, now), "unknown")
  walletOnly = false
  assert.deepEqual(Object.keys((await fetchOpenCodeGoQuota(auth, AbortSignal.timeout(2000))).windows), ["5h", "weekly", "monthly"])
})

test("Console missing workspace, malformed declared meters and cancellation stay unavailable", async t => {
  let calls = 0
  let payload: unknown = consoleQuota()
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(payload) })
  await assert.rejects(fetchOpenCodeGoQuota({ token: "fixture-console", consoleOAuth: true }, AbortSignal.timeout(2000)))
  assert.equal(calls, 0)
  const auth = { token: "fixture-console", orgID: "org_fixture", consoleOAuth: true as const }
  for (const meter of ["malformed", {}, { usedMicroCents: "bad", limitMicroCents: "10" },
    { usedMicroCents: "1", limitMicroCents: "10", resetsAt: "invalid" }]) {
    payload = { access: { meters: { ...consoleQuota().access.meters, month: meter } } }
    await assert.rejects(fetchOpenCodeGoQuota(auth, AbortSignal.timeout(2000)), /Quota unavailable/)
  }
  const controller = new AbortController()
  controller.abort()
  const before = calls
  await assert.rejects(fetchOpenCodeGoQuota(auth, controller.signal))
  assert.equal(calls, before)
})

test("a Console authentication failure at billing revokes partial Go readings", async t => {
  t.mock.method(globalThis, "fetch", async (url: string) => url === OPENCODE_GO_CONSOLE_URL
    ? Response.json(consoleQuota()) : Response.json({ message: "fixture-private" }, { status: 401 }))
  await assert.rejects(fetchOpenCodeGoQuota({ token: "fixture-console", orgID: "org_fixture", consoleOAuth: true }, AbortSignal.timeout(2000)),
    error => error instanceof ProviderHttpError && error.status === 401)
})

test("only the exact expired-key code is retained from bounded HTTP errors", async t => {
  let body: unknown = {}, status = 401
  t.mock.method(globalThis, "fetch", async () => Response.json(body, { status }))
  for (const code of ["api_key_expired", "invalid_api_key", "fixture-private", undefined]) {
    for (const nested of [false, true]) {
      body = nested ? { error: { code, message: "fixture-private" } } : { code, message: "fixture-private" }
      await assert.rejects(fetchOpenCodeGoQuota({ token: "fixture-key" }, AbortSignal.timeout(2000)), error => {
        assert.ok(error instanceof ProviderHttpError)
        assert.equal(error.status, 401)
        assert.equal(error.code, code === "api_key_expired" ? code : undefined)
        assert.equal(JSON.stringify(error).includes("fixture"), false)
        return true
      })
    }
  }
  status = 403; body = { code: "api_key_expired" }
  await assert.rejects(fetchOpenCodeGoQuota({ token: "fixture-key" }, AbortSignal.timeout(2000)), error => error instanceof ProviderHttpError && error.status === 403)
})

test("unknown statuses, malformed windows and empty payloads are not evidence", () => {
  for (const payload of [
    {}, null, "garbage", [], { usage: {} },
    { usage: { rolling: { status: "paused", percent: 10, resetsAt: reset } } },
    { usage: { rolling: { status: "ok", percent: "many", resetsAt: reset } } },
    { usage: { rolling: { status: "ok", percent: -1, resetsAt: reset } } },
    { usage: { rolling: { status: "ok", percent: 10, resetsAt: "not a date" } } },
    { usage: { rolling: 7 } },
    { rollingUsage: { usagePercent: 10, resetInSec: -5 } },
  ]) assert.throws(() => parseOpenCodeGoQuota(payload, now), /Quota unavailable/)
})

test("reads with the explicit token and organization, bounded and without redirects", async () => {
  const previous = globalThis.fetch
  const requests: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = []
  let response = () => new Response(JSON.stringify({ usage: { rolling: { status: "ok", percent: 1, resetsAt: new Date(Date.now() + 60_000).toISOString() } } }))
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), headers: init?.headers as Record<string, string>, redirect: init?.redirect })
    return response()
  }
  try {
    const usage = await fetchOpenCodeGoQuota({ token: "fixture-token", orgID: "org_fixture" }, AbortSignal.timeout(2000))
    assert.equal(usage.windows["5h"].usedPercent, 1)
    assert.equal(requests[0].url, OPENCODE_GO_USAGE_URL)
    assert.equal(requests[0].redirect, "error")
    assert.equal(requests[0].headers.Authorization, "Bearer fixture-token")
    assert.equal(requests[0].headers["x-org-id"], "org_fixture")
    await fetchOpenCodeGoQuota({ token: "key-only" }, AbortSignal.timeout(2000))
    assert.equal("x-org-id" in requests[1].headers, false)

    for (const status of [401, 403]) {
      response = () => new Response(JSON.stringify({ type: "error", error: { type: "AuthError", message: "fixture-token" } }), { status })
      await assert.rejects(fetchOpenCodeGoQuota({ token: "fixture-token" }, AbortSignal.timeout(2000)),
        error => error instanceof ProviderHttpError && error.status === status && !String(error.message).includes("fixture-token"))
    }
    response = () => new Response("x".repeat(70_000))
    await assert.rejects(fetchOpenCodeGoQuota({ token: "fixture-token" }, AbortSignal.timeout(2000)), /too large/)
    response = () => new Response("<html>not json</html>")
    await assert.rejects(fetchOpenCodeGoQuota({ token: "fixture-token" }, AbortSignal.timeout(2000)))
  } finally { globalThis.fetch = previous }
})
