import assert from "node:assert/strict"
import test from "node:test"
import { googleUsage, selectGoogleModelWindows } from "./google"

const auth = (changes: Record<string, unknown> = {}) => ({ google: { type: "oauth", methodID: "antigravity",
  access: "fake-antigravity-native", refresh: "fake-antigravity-refresh|fake-project|fake-managed", expires: Date.now() + 3600_000, ...changes } })
const quota = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
const bucket = (changes: Record<string, unknown> = {}) => ({ window: "5h", remainingFraction: 0.75, ...changes })
const summary = (buckets: unknown[], displayName: unknown = "Gemini Models") => ({ groups: [{ displayName, buckets }] })

test("Antigravity explicit 5h and weekly windows preserve separate family pools and redact prose", async t => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), quota)
    assert.equal(init?.method, "POST")
    assert.equal(init?.redirect, "error")
    assert.equal(init?.body, '{"project":"fake-managed"}')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get("authorization"), "Bearer fake-antigravity-native")
    assert.equal(headers.get("user-agent"), "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)")
    assert.equal(headers.get("x-goog-api-client"), null)
    assert.equal(headers.get("client-metadata"), null)
    return Response.json({ groups: [
      { displayName: "Gemini Models", description: "fake-private-description", buckets: [
        bucket({ bucketId: "fake-private-id", displayName: "fake-private-name", resetTime: "2026-11-06T00:00:00Z" }),
        bucket({ window: "weekly", remainingFraction: 0.5 }),
      ] },
      { displayName: "Claude and GPT models", buckets: [bucket({ remainingFraction: 0 }), bucket({ window: "weekly", remainingFraction: 1 })] },
      { displayName: "fake-private-family", buckets: [bucket()] },
    ], access_token: "fake-private-token", error: "fake-private-error" })
  })
  const reading = await googleUsage.fetchQuota(auth())
  assert.equal(reading.ok, true)
  assert.equal(reading.providerName, "Antigravity")
  const windows = selectGoogleModelWindows(reading, "antigravity-gemini-3-pro")
  assert.deepEqual(Object.keys(windows), ["5h:Gemini", "weekly:Gemini", "5h:Claude and GPT", "weekly:Claude and GPT"])
  assert.equal(windows["5h:Gemini"].usedPercent, 25)
  assert.equal(windows["weekly:Gemini"].usedPercent, 50)
  assert.equal(windows["5h:Claude and GPT"].usedPercent, 100)
  assert.equal(windows["weekly:Claude and GPT"].usedPercent, 0)
  assert.equal(windows["5h:Gemini"].resetAt, Date.parse("2026-11-06T00:00:00Z"))
  assert.equal(windows["weekly:Gemini"].resetAt, null)
  assert.equal(windows["5h:Gemini"].windowSeconds, 18_000)
  assert.equal(windows["weekly:Gemini"].windowSeconds, 604_800)
  assert.equal(JSON.stringify(reading).includes("fake-private"), false)
})

test("only declared windows are mapped; absent fractions and absent windows never become zero or invented buckets", async t => {
  let payload: unknown
  t.mock.method(globalThis, "fetch", async () => Response.json(payload))
  payload = summary([bucket({ window: "weekly", remainingFraction: 0.6 })])
  assert.deepEqual(Object.keys(selectGoogleModelWindows(await googleUsage.fetchQuota(auth()))), ["weekly:Gemini"])
  payload = summary([bucket({ remainingFraction: undefined }), bucket({ window: "weekly", remainingFraction: 0.5 }),
    bucket({ window: "daily", bucketId: "gemini-5h", resetTime: "2026-11-12T00:00:00Z" }),
    bucket({ window: undefined, bucketId: "gemini-weekly", resetTime: "2026-11-06T00:00:00Z" })])
  const windows = selectGoogleModelWindows(await googleUsage.fetchQuota(auth()))
  assert.deepEqual(Object.keys(windows), ["5h:Gemini", "weekly:Gemini"])
  assert.equal(windows["5h:Gemini"].usedPercent, null)
  assert.equal(windows["5h:Gemini"].remainingPercent, null)
  // Explicitly omit the name to represent a single plan-wide group.
  payload = { groups: [{ buckets: [bucket()] }] }
  assert.deepEqual(Object.keys(selectGoogleModelWindows(await googleUsage.fetchQuota(auth()))), ["5h"])
})

test("malformed, ambiguous or unknown summaries and transport failures are unknown quota without upstream detail", async t => {
  let respond: () => Response = () => Response.json({})
  t.mock.method(globalThis, "fetch", async () => respond())
  for (const payload of [
    {}, { groups: [] }, { groups: {} }, { groups: [null] }, { groups: [{ buckets: {} }] }, summary([null]),
    summary([bucket({ remainingFraction: undefined })]),
    ...[-1, 2, "0.5", null, {}].map(remainingFraction => summary([bucket({ remainingFraction })])),
    ...["daily", "monthly", "18000", "unknown", undefined, 18_000, {}].map(window => summary([bucket({ window, bucketId: "gemini-weekly" })])),
    ...[null, 1, "not-a-date", "2026-99-99T00:00:00Z"].map(resetTime => summary([bucket({ resetTime })])),
    summary([bucket(), bucket()]), summary([bucket()], "fake-secret-family"), summary([bucket()], 1), summary([bucket()], null),
    { groups: [{ buckets: [bucket()] }, { buckets: [bucket({ window: "weekly" })] }] },
    { groups: [{ displayName: "Gemini", buckets: [bucket()] }, { displayName: "Gemini Models", buckets: [bucket()] }] },
  ]) {
    respond = () => Response.json(payload)
    const reading = await googleUsage.fetchQuota(auth())
    assert.equal(reading.configured, true)
    assert.equal(reading.ok, false, JSON.stringify(payload))
    assert.equal(reading.error, undefined)
    assert.deepEqual(selectGoogleModelWindows(reading), {})
  }
  for (const next of [
    ...[401, 403, 429, 500].map(status => () => new Response("fake-secret-upstream", { status })),
    () => new Response(null, { status: 302, headers: { location: "https://never-follow.invalid" } }),
    () => new Response("not-json-fake-secret"), () => new Response("x".repeat(65_537)),
    () => { throw new DOMException("fake-secret-timeout", "TimeoutError") },
  ]) {
    respond = next
    const reading = await googleUsage.fetchQuota(auth())
    assert.equal(reading.ok, false)
    assert.equal(reading.error, undefined)
    assert.deepEqual(selectGoogleModelWindows(reading), {})
  }
})

test("saved project priority is managed then ordinary; missing context and abort never onboard or query", async t => {
  const bodies: unknown[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), quota)
    bodies.push(init?.body)
    return Response.json(summary([bucket()]))
  })
  assert.equal((await googleUsage.fetchQuota(auth())).ok, true)
  assert.equal((await googleUsage.fetchQuota(auth({ refresh: "fake-refresh|fake-project" }))).ok, true)
  assert.equal((await googleUsage.fetchQuota(auth({ refresh: "fake-refresh||fake-managed" }))).ok, true)
  assert.deepEqual(bodies, ['{"project":"fake-managed"}', '{"project":"fake-project"}', '{"project":"fake-managed"}'])
  for (const changes of [{ refresh: "fake-refresh" }, { refresh: "fake-refresh", access: "" }, { refresh: "" }]) {
    const reading = await googleUsage.fetchQuota(auth(changes))
    assert.equal(reading.configured, true)
    assert.equal(reading.ok, false)
  }
  assert.equal((await googleUsage.fetchQuota(auth(), AbortSignal.abort())).ok, false)
  assert.equal(bodies.length, 3)
})
