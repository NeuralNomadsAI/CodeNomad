import assert from "node:assert/strict"
import test from "node:test"
import { googleUsage, selectGoogleModelWindows } from "./google"

const auth = (changes: Record<string, unknown> = {}) => ({ google: { type: "oauth", methodID: "gemini-cli",
  access: "fake-reader-native", refresh: "fake-reader-refresh|fake-project|fake-managed", expires: Date.now() + 3600_000, ...changes } })
const quota = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"

test("Gemini remaining fractions become separate exact per-model limits, never summed", async t => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), quota)
    assert.equal(init?.method, "POST")
    assert.equal(init?.redirect, "error")
    assert.equal(init?.body, '{"project":"fake-project"}')
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-reader-native")
    return Response.json({ buckets: [
      { modelId: "models/gemini-2.5-pro", tokenType: "REQUESTS", remainingFraction: 0.75, remainingAmount: "300", resetTime: "2026-11-06T00:00:00Z" },
      { modelId: "gemini-2.5-flash", remainingFraction: 0.5 },
      { modelId: "gemini-2.5-flash-lite", remainingFraction: 0.1 },
      { modelId: "gemini-3-pro-preview", remainingAmount: "5" },
      { modelId: "fake-upstream-error-native-access", remainingFraction: 0 },
    ] })
  })
  const reading = await googleUsage.fetchQuota(auth())
  assert.equal(reading.ok, true)
  const windows = selectGoogleModelWindows(reading)
  assert.deepEqual(Object.keys(windows), ["requests:gemini-2.5-pro", "usage:gemini-2.5-flash", "usage:gemini-2.5-flash-lite", "usage:gemini-3-pro-preview"])
  assert.equal(windows["requests:gemini-2.5-pro"].usedPercent, 25)
  assert.equal(windows["requests:gemini-2.5-pro"].resetAt, Date.parse("2026-11-06T00:00:00Z"))
  assert.equal(windows["usage:gemini-2.5-flash"].usedPercent, 50)
  assert.equal(windows["usage:gemini-2.5-flash"].resetAt, null)
  assert.equal(windows["usage:gemini-3-pro-preview"].usedPercent, null, "amount without a limit is not zero usage")
  for (const id of ["gemini-2.5-flash", "models/gemini-2.5-flash", "google/gemini-2.5-flash", "gemini-cli/gemini-2.5-flash", "gemini-cli-gemini-2.5-flash"]) {
    assert.deepEqual(Object.keys(selectGoogleModelWindows(reading, id)), ["usage:gemini-2.5-flash"])
  }
  assert.deepEqual(selectGoogleModelWindows(reading, "gemini-2.5-pro-preview"), {}, "never borrow another model's quota")
  assert.deepEqual(selectGoogleModelWindows(reading, "gemini-2.5"), {})
  reading.usage!.windows.weekly = { usedPercent: 10, remainingPercent: 90, windowSeconds: 604_800, resetAt: null }
  assert.deepEqual(Object.keys(selectGoogleModelWindows(reading, "gemini-2.5-flash")), ["weekly", "usage:gemini-2.5-flash"])
})

test("each Google method sends its preferred saved project to its own quota endpoint", async t => {
  const requests: Array<{ url: string; body: unknown }> = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body })
    return String(input) === quota
      ? Response.json({ buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.5 }] })
      : Response.json({ groups: [{ buckets: [{ window: "5h", remainingFraction: 0.5 }] }] })
  })
  for (const methodID of ["gemini-cli", "antigravity"]) {
    assert.equal((await googleUsage.fetchQuota(auth({ methodID,
      refresh: "fake-refresh|fake-billing-project|fake-managed-project" }))).ok, true)
  }
  assert.deepEqual(requests, [
    { url: quota, body: '{"project":"fake-billing-project"}' },
    { url: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", body: '{"project":"fake-managed-project"}' },
  ])
})

test("discovers an existing project only when packed context is absent; never onboards", async t => {
  const requests: Array<{ url: string; body: unknown; signal?: AbortSignal | null }> = []
  const signal = AbortSignal.timeout(2000)
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body, signal: init?.signal })
    return String(input).endsWith(":loadCodeAssist") ? Response.json({ cloudaicompanionProject: "fake-discovered" })
      : Response.json({ buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0 }] })
  })
  const reading = await googleUsage.fetchQuota(auth({ refresh: "fake-refresh" }), signal)
  assert.equal(reading.ok, true)
  assert.equal(selectGoogleModelWindows(reading)["usage:gemini-2.5-pro"].usedPercent, 100)
  assert.deepEqual(requests.map(request => request.url), ["https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", quota])
  assert.equal(requests[1].body, '{"project":"fake-discovered"}')
  assert.ok(requests.every(request => request.signal === requests[0].signal && !request.signal?.aborted))
})

test("missing project, malformed quota, HTTP errors, redirects, timeout and oversized JSON are unknown", async t => {
  let respond: () => Response = () => Response.json({})
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return respond() })
  for (const response of [
    () => Response.json({}), () => Response.json({ buckets: [] }),
    () => Response.json({ buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 2 }] }),
    () => Response.json({ buckets: [{ modelId: "gemini-2.5-pro" }] }),
    () => Response.json({ buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0 }, { modelId: "gemini-2.5-pro", remainingFraction: 1 }] }),
    ...[401, 403, 429, 500].map(status => () => new Response("fake-upstream-secret", { status })),
    () => new Response(null, { status: 302, headers: { location: "https://not-allowed.invalid" } }),
    () => new Response("fake-invalid-json-secret"), () => new Response("x".repeat(65_537)),
  ]) {
    respond = response
    const reading = await googleUsage.fetchQuota(auth())
    assert.equal(reading.configured, true)
    assert.equal(reading.ok, false)
    assert.equal(reading.error, undefined)
    assert.deepEqual(selectGoogleModelWindows(reading), {})
  }
  respond = () => Response.json({ currentTier: { id: "free-tier" } })
  assert.equal((await googleUsage.fetchQuota(auth({ refresh: "fake-project-missing" }))).ok, false)
  const before = calls
  assert.equal((await googleUsage.fetchQuota(auth(), AbortSignal.abort())).ok, false)
  for (const methodID of ["oauth", "unknown"]) {
    const reading = await googleUsage.fetchQuota(auth({ methodID }))
    assert.equal(reading.configured, true)
    assert.equal(reading.ok, false)
  }
  assert.equal(calls, before, "unknown methods/aborted reads never refresh or query")
  assert.equal((await googleUsage.fetchQuota({})).configured, false)
})
