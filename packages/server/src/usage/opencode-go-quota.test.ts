import assert from "node:assert/strict"
import test from "node:test"
import { fetchOpenCodeGoQuota, OPENCODE_GO_USAGE_URL, parseOpenCodeGoQuota } from "./opencode-go-quota"
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
