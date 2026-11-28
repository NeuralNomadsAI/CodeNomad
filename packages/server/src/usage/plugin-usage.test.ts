import assert from "node:assert/strict"
import test from "node:test"
import { createRuntimeTransport } from "../opencode/compatibility/transport"
import { RECOMMENDED } from "../opencode/runtime-version-fixture"
import {
  PLUGIN_USAGE_MAX_RESPONSE_BYTES,
  PLUGIN_USAGE_MAX_WINDOWS,
  parsePluginUsageOutput,
  pluginUsageRpcId,
  readPluginProviderUsage,
} from "./plugin-usage"

test("pluginUsageRpcId accepts safe provider IDs and rejects traversal or invalid characters", () => {
  assert.equal(pluginUsageRpcId("agy-agent"), "provider-usage.agy-agent")
  assert.equal(pluginUsageRpcId("  acme.provider_1  "), "provider-usage.acme.provider_1")
  assert.equal(pluginUsageRpcId("x".repeat(100)), `provider-usage.${"x".repeat(100)}`)
  for (const invalid of ["", "   ", "a/b", "a..b", "a b", "a\nb", "x".repeat(101)]) {
    assert.equal(pluginUsageRpcId(invalid), null, invalid)
  }
})

test("parsePluginUsageOutput validates, derives complementary percents and handles boundary hundredths", () => {
  const parsed = parsePluginUsageOutput(
    {
      providerName: "Antigravity Agent",
      configured: true,
      ok: true,
      fetchedAt: 1_700_000_000_000,
      extraField: "ignored",
      windows: {
        "5h": { remainingPercent: 90.58, windowSeconds: 18_000, resetAt: 1_700_018_000_000 },
        weekly: { usedPercent: 0.12, remainingPercent: 99.93, resetAt: null },
        daily: { usedPercent: 25, remainingPercent: 75.05, resetAt: null },
        credits: { usedPercent: null, remainingPercent: null, valueLabel: "500 left", consumption: { used: 10, limit: 510 } },
      },
    },
    { requestedProviderId: "agy-agent", providerId: "agy-agent", modelId: "gemini-4-neon" },
  )
  assert.ok(parsed)
  assert.equal(parsed.supported, true)
  assert.equal(parsed.configured, true)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.providerName, "Antigravity Agent")
  assert.deepEqual(parsed.windows["5h"], {
    usedPercent: 9.42,
    remainingPercent: 90.58,
    windowSeconds: 18_000,
    resetAt: 1_700_018_000_000,
  })
  assert.deepEqual(parsed.windows.weekly, {
    usedPercent: 0.12,
    remainingPercent: 99.88,
    windowSeconds: null,
    resetAt: null,
  })
  assert.deepEqual(parsed.windows.daily, {
    usedPercent: 25,
    remainingPercent: 75,
    windowSeconds: null,
    resetAt: null,
  })
  assert.deepEqual(parsed.windows.credits, {
    usedPercent: null,
    remainingPercent: null,
    windowSeconds: null,
    resetAt: null,
    valueLabel: "500 left",
    consumption: { used: 10, limit: 510 },
  })
  assert.equal("extraField" in parsed, false)
})

test("parsePluginUsageOutput clears windows on failure and rejects malformed, prototype or contradictory payloads", () => {
  const failed = parsePluginUsageOutput(
    {
      providerName: "Custom",
      configured: false,
      ok: false,
      unavailableReason: "provider-error",
      windows: { "5h": { usedPercent: 50 } },
    },
    { requestedProviderId: "custom", providerId: "custom", now: () => 42 },
  )
  assert.deepEqual(failed, {
    requestedProviderId: "custom",
    providerId: "custom",
    providerName: "Custom",
    modelId: undefined,
    supported: true,
    configured: false,
    ok: false,
    windows: {},
    fetchedAt: 42,
  })

  const tooMany: Record<string, { usedPercent: number }> = {}
  for (let i = 0; i <= PLUGIN_USAGE_MAX_WINDOWS; i++) tooMany[`w${i}`] = { usedPercent: i }
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: tooMany }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ providerName: "bad\nname", configured: true, ok: true, windows: {} }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ providerName: "\tDisplay", configured: true, ok: true, windows: {} }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ providerName: "bad\u0085name", configured: true, ok: true, windows: {} }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { "weekly:\u0085scope": { usedPercent: 1 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { "5h": { usedPercent: Number.NaN } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { "5h": { unknownProp: 1 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  // Non-canonical window keys (whitespace around edges or `:`) and Object.prototype keys (bare or scoped) are rejected.
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 1 }, " weekly ": { usedPercent: 2 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { " 5h": { usedPercent: 1 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  for (const key of ["credits_balance :Team", "credits_balance: Team", ":Team", "5h:"]) {
    assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { [key]: { usedPercent: 1 } } }, { requestedProviderId: "x", providerId: "x" }), null, key)
  }
  for (const key of ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "hasOwnProperty:Scope", "toString:Model"]) {
    const raw = JSON.parse(`{"configured":true,"ok":true,"windows":${JSON.stringify({ [key]: { usedPercent: 1 } })}}`)
    assert.equal(parsePluginUsageOutput(raw, { requestedProviderId: "x", providerId: "x" }), null, key)
  }
  // Out-of-range or contradictory percentages are rejected consistently in decimal hundredths.
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 120 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: -1 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 120, remainingPercent: 90 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 40, remainingPercent: 40 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 0.12, remainingPercent: 99.94 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 1.005, remainingPercent: 99.0549 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 1.01, remainingPercent: 99.0549 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.ok(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 1.005, remainingPercent: 99.0449 } } }, { requestedProviderId: "x", providerId: "x" }))
  // Single-pass decimal rounding avoids double-rounding 99.9949999 -> 99.995 -> 100.
  const noDoubleRound = parsePluginUsageOutput(
    { configured: true, ok: true, windows: { weekly: { usedPercent: 99.9949999 }, daily: { usedPercent: 1, remainingPercent: 99.0549999 } } },
    { requestedProviderId: "x", providerId: "x" },
  )
  assert.ok(noDoubleRound)
  assert.equal(noDoubleRound.windows.weekly?.usedPercent, 99.99)
  assert.equal(noDoubleRound.windows.weekly?.remainingPercent, 0.01)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { credits: { balanceUSD: { remaining: 5, total: -1 } } } }, { requestedProviderId: "x", providerId: "x" }), null)
  // An unconfigured provider never publishes windows, even when it claims ok.
  const unconfigured = parsePluginUsageOutput({ configured: false, ok: true, windows: { weekly: { usedPercent: 15 } } }, { requestedProviderId: "x", providerId: "x" })
  assert.equal(unconfigured?.configured, false)
  assert.equal(unconfigured?.ok, false)
  assert.deepEqual(unconfigured?.windows, {})
  // A window carries at most one display value among consumption, limitUSD and balanceUSD.
  for (const window of [
    { consumption: { unlimited: true }, limitUSD: 20 },
    { limitUSD: 20, balanceUSD: { remaining: 5 } },
    { consumption: { used: 1 }, balanceUSD: { remaining: 5 } },
  ]) {
    assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { pro: window } }, { requestedProviderId: "x", providerId: "x" }), null, JSON.stringify(window))
  }
  // An unlimited window cannot also declare a percentage.
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { pro: { usedPercent: 100, consumption: { unlimited: true } } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { pro: { remainingPercent: 0, consumption: { unlimited: true } } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.ok(parsePluginUsageOutput({ configured: true, ok: true, windows: { pro: { consumption: { unlimited: true } } } }, { requestedProviderId: "x", providerId: "x" })?.windows.pro)
  // Out-of-range JS Date timestamps (> 8.64e15 ms) are rejected for resetAt and fetchedAt.
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { "5h": { usedPercent: 10, resetAt: 1e30 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, fetchedAt: 8_640_000_000_000_001, windows: {} }, { requestedProviderId: "x", providerId: "x" }), null)
})

test("readPluginProviderUsage preserves HTTP status, bounds ignored signals and caps response size", async () => {
  const makeConnection = (handler: (url: URL, init?: RequestInit) => Promise<Response>) => ({
    endpoint: { url: "http://isolated-native.invalid" },
    fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      handler(new URL(input instanceof Request ? input.url : String(input)), init),
  })

  // Missing RPC returns null so the caller reports unsupported.
  for (const type of ["rpc.unavailable", "rpc.method_not_found"]) {
    const absent = await readPluginProviderUsage(
      makeConnection(async () => Response.json({ _tag: "RpcError", type, message: "missing" }, { status: 400 })),
      { providerId: "unknown-plugin", location: { directory: "/repo" }, modelId: "m1" },
      new AbortController().signal,
    )
    assert.equal(absent, null, type)
  }

  // Older OpenCode without /api/rpc (any generic 404, JSON or plain text) degrades to null.
  for (const response of [
    () => Response.json({}, { status: 404 }),
    () => Response.json({ type: "not_found", message: "Not found" }, { status: 404 }),
    () => Response.json({ _tag: "NotFound", message: "Not found" }, { status: 404 }),
    () => Response.json({ _tag: "OpenCodeContractError", status: 404 }, { status: 404 }),
    () => new Response("Not Found", { status: 404 }),
  ]) {
    const older = await readPluginProviderUsage(
      makeConnection(async () => response()),
      { providerId: "unknown-plugin", location: { directory: "/repo" } },
      new AbortController().signal,
    )
    assert.equal(older, null)
  }

  // Invalid UTF-8 in a 200 body is rejected instead of being published with replacement characters.
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"output":{"providerName":"Sample'), Buffer.from([0xff]),
    Buffer.from('","configured":true,"ok":true,"windows":{"5h":{"usedPercent":1}}}}'),
  ])
  const decoded = await readPluginProviderUsage(
    makeConnection(async () => new Response(invalidUtf8, { headers: { "content-type": "application/json" } })),
    { providerId: "agy-agent", location: { directory: "/repo" } },
    new AbortController().signal,
  )
  assert.equal(decoded?.supported, true)
  assert.equal(decoded?.ok, false)
  assert.deepEqual(decoded?.windows, {})

  // Non-route failures (plain-text 500, untagged 400 {}, LocationNotFoundError 404, 502, fetch rejection) propagate -> 503.
  for (const [label, responder] of [
    ["plain-text 500", async () => new Response("Internal Server Error", { status: 500 })],
    ["untagged 400 {}", async () => Response.json({}, { status: 400 })],
    ["RpcError 400 missing message", async () => Response.json({ _tag: "RpcError", type: "rpc.unavailable" }, { status: 400 })],
    ["RpcError 400 extra field", async () => Response.json({ _tag: "RpcError", type: "rpc.unavailable", message: "missing", extra: true }, { status: 400 })],
    ["LocationNotFoundError 404", async () => Response.json({ _tag: "LocationNotFoundError", message: "gone" }, { status: 404 })],
    ["oversized LocationNotFoundError 404", async () => Response.json({ _tag: "LocationNotFoundError", message: "x".repeat(PLUGIN_USAGE_MAX_RESPONSE_BYTES + 16) }, { status: 404 })],
    ["malformed JSON 404", async () => new Response("{bad", { status: 404, headers: { "content-type": "application/json" } })],
    ["whitespace-only JSON 404", async () => new Response("   ", { status: 404, headers: { "content-type": "application/json" } })],
    ["SessionNotFoundError 404", async () => Response.json({ _tag: "SessionNotFoundError", message: "gone" }, { status: 404 })],
    ["incomplete RpcInternalError 500", async () => Response.json({ _tag: "RpcInternalError" }, { status: 500 })],
    ["RpcError envelope on 404", async () => Response.json({ _tag: "RpcError", type: "rpc.invalid_input", message: "Bad input" }, { status: 404 })],
    ["RpcInternalError envelope on 404", async () => Response.json({ _tag: "RpcInternalError", type: "rpc.internal", message: "x" }, { status: 404 })],
    ["unknown reserved RpcError type 400", async () => Response.json({ _tag: "RpcError", type: "rpc.unknown", message: "unexpected" }, { status: 400 })],
    ["unknown RpcInternalError type 500", async () => Response.json({ _tag: "RpcInternalError", type: "quota.unknown", message: "x" }, { status: 500 })],
    ["contract error 500", async () => Response.json({ _tag: "OpenCodeContractError", status: 500 }, { status: 500 })],
    ["bad gateway 502", async () => new Response("Bad Gateway", { status: 502 })],
    ["transport error", async () => { throw new TypeError("fetch failed") }],
  ] as const) {
    await assert.rejects(
      readPluginProviderUsage(
        makeConnection(responder),
        { providerId: "agy-agent", location: { directory: "/repo" } },
        new AbortController().signal,
      ),
      Error,
      label,
    )
  }

  // Internal/invalid output from a registered plugin reports supported + unavailable without leaking text.
  for (const response of [
    () => Response.json({ _tag: "RpcInternalError", type: "rpc.internal", message: "secret-token-leak" }, { status: 500 }),
    () => Response.json({ _tag: "RpcInternalError", type: "rpc.invalid_output", message: "secret-token-leak", data: { detail: "secret-token-leak" } }, { status: 500 }),
    () => Response.json({ _tag: "RpcError", type: "rpc.invalid_output", message: "secret-token-leak" }, { status: 400 }),
    () => Response.json({ _tag: "RpcError", type: "quota.failed", message: "" }, { status: 400 }),
    () => Response.json({ _tag: "RpcError", type: "", message: "Quota is currently unavailable", data: null }, { status: 400 }),
    () => Response.json({ _tag: "RpcError", type: "quota.failed", message: "secret-token-leak" + "x".repeat(17_000) }, { status: 400 }),
  ]) {
    const broken = await readPluginProviderUsage(
      makeConnection(async () => response()),
      { providerId: "agy-agent", location: { directory: "/repo" }, modelId: "gemini-4-neon" },
      new AbortController().signal,
    )
    assert.ok(broken)
    assert.equal(broken.supported, true)
    assert.equal(broken.ok, false)
    assert.equal(JSON.stringify(broken).includes("secret-token-leak"), false)
  }

  // Oversized 200 JSON responses are bounded and return unavailable immediately even if stream cancel never settles.
  {
    let cancelCalled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(PLUGIN_USAGE_MAX_RESPONSE_BYTES + 1))
      },
      cancel() {
        cancelCalled = true
        return new Promise<void>(() => {})
      },
    })
    const oversized = await readPluginProviderUsage(
      makeConnection(async () => new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
      { providerId: "agy-agent", location: { directory: "/repo" } },
      new AbortController().signal,
    )
    assert.ok(oversized)
    assert.equal(oversized.supported, true)
    assert.equal(oversized.ok, false)
    assert.equal(cancelCalled, true)
  }

  // Quota deadline abort bounds an RPC whose transport ignores the abort signal and cancels any late response body.
  {
    const outer = new AbortController()
    const quota = new AbortController()
    let release!: () => void
    let lateCancelled = false
    const lateStream = new ReadableStream<Uint8Array>({
      cancel() { lateCancelled = true },
    })
    const hanging = new Promise<Response>(resolve => {
      release = () => resolve(new Response(lateStream, {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
    })
    const pending = readPluginProviderUsage(
      makeConnection(() => hanging),
      { providerId: "agy-agent", location: { directory: "/repo" } },
      outer.signal,
      quota.signal,
    )
    quota.abort()
    const timedOut = await pending
    release()
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(timedOut)
    assert.equal(timedOut.supported, true)
    assert.equal(timedOut.ok, false)
    assert.deepEqual(timedOut.windows, {})
    assert.equal(lateCancelled, true)
  }

  // Same-turn quota abort + fetch resolution also cancels the response body.
  {
    const outer = new AbortController()
    const quota = new AbortController()
    let release!: () => void
    let sameTurnCancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel() { sameTurnCancelled = true },
    })
    const hanging = new Promise<Response>(resolve => {
      release = () => resolve(new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
    })
    const pending = readPluginProviderUsage(
      makeConnection(() => hanging),
      { providerId: "agy-agent", location: { directory: "/repo" } },
      outer.signal,
      quota.signal,
    )
    quota.abort()
    release()
    const timedOut = await pending
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(timedOut)
    assert.equal(timedOut.supported, true)
    assert.equal(timedOut.ok, false)
    assert.equal(sameTurnCancelled, true)
  }

  // Already-aborted quota signal rejects even if fetch would return a valid response.
  {
    const outer = new AbortController()
    const quota = new AbortController()
    quota.abort()
    const timedOut = await readPluginProviderUsage(
      makeConnection(async () => Response.json({
        output: { configured: true, ok: true, windows: { "5h": { usedPercent: 5 } } },
      })),
      { providerId: "agy-agent", location: { directory: "/repo" } },
      outer.signal,
      quota.signal,
    )
    assert.ok(timedOut)
    assert.equal(timedOut.supported, true)
    assert.equal(timedOut.ok, false)
  }

  // Outer request abort propagates cleanly.
  const outer = new AbortController()
  outer.abort()
  await assert.rejects(
    readPluginProviderUsage(
      makeConnection(async () => Response.json({ output: {} })),
      { providerId: "agy-agent", location: { directory: "/repo" } },
      outer.signal,
      outer.signal,
    ),
  )

  // A quota deadline that expires right after an absent-RPC body is read never reads as "absent",
  // so no fallback starts past the deadline.
  for (const status of [400, 404]) {
    const quota = new AbortController()
    const bytes = new TextEncoder().encode(JSON.stringify({ _tag: "RpcError", type: "rpc.unavailable", message: "missing" }))
    let sent = false
    // The deadline fires once the body is fully read (on releaseLock), before classification.
    const reader = {
      read: async () => sent ? { done: true, value: undefined } : (sent = true, { done: false, value: bytes }),
      cancel: async () => {},
      releaseLock: () => quota.abort(),
    }
    const response = { status, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => reader, cancel: async () => {} } } as unknown as Response
    const late = await readPluginProviderUsage(
      makeConnection(async () => response),
      { providerId: "agy-agent", location: { directory: "/repo" } },
      new AbortController().signal,
      quota.signal,
    )
    assert.equal(late?.supported, true, String(status))
    assert.equal(late?.ok, false, String(status))
  }

  // An outer abort independent of the quota deadline stops dispatch and a stalled RPC.
  let outerDispatched = 0
  await assert.rejects(readPluginProviderUsage(
    makeConnection(async () => { outerDispatched++; return Response.json({ output: {} }) }),
    { providerId: "agy-agent", location: { directory: "/repo" } },
    outer.signal,
    new AbortController().signal,
  ))
  assert.equal(outerDispatched, 0)
  const stalledOuter = new AbortController()
  const stalled = readPluginProviderUsage(
    makeConnection(() => new Promise<Response>(() => {})),
    { providerId: "agy-agent", location: { directory: "/repo" } },
    stalledOuter.signal,
    new AbortController().signal,
  )
  stalledOuter.abort()
  await assert.rejects(stalled)

  // Through the real createRuntimeTransport adapter, non-`application/json` error bodies stay replaced by a
  // generic contract error (a 404 then reads as an absent RPC; the route re-verifies ownership before any
  // fallback), and a plain-text 502 with a never-settling body cancel rejects immediately rather than timing out.
  {
    const endpoint = { url: "http://127.0.0.1:4321" }
    const transportProblem = createRuntimeTransport(endpoint, async (input) => {
      const target = new URL(input instanceof Request ? input.url : String(input))
      if (target.pathname === "/api/info") return Response.json({ version: RECOMMENDED })
      return new Response(JSON.stringify({ _tag: "LocationNotFoundError", detail: "private diagnostic" }), {
        status: target.pathname === "/api/location" ? 502 : 404,
        headers: { "content-type": "application/problem+json" },
      })
    })
    const proxied = await transportProblem.fetch(new URL("/api/location", endpoint.url))
    assert.equal(proxied.status, 502)
    assert.equal((await proxied.json())._tag, "OpenCodeContractError")
    assert.equal(
      await readPluginProviderUsage(
        { endpoint, fetch: transportProblem.fetch },
        { providerId: "agy-agent", location: { directory: "/repo" } },
        new AbortController().signal,
      ),
      null,
    )

    const transport502 = createRuntimeTransport(endpoint, async (input) => {
      const target = new URL(input instanceof Request ? input.url : String(input))
      if (target.pathname === "/api/info") return Response.json({ version: RECOMMENDED })
      const hungCancel = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("Bad Gateway")) },
        cancel() { return new Promise<void>(() => {}) },
      })
      return new Response(hungCancel, { status: 502, headers: { "content-type": "text/plain" } })
    })
    await assert.rejects(
      readPluginProviderUsage(
        { endpoint, fetch: transport502.fetch },
        { providerId: "agy-agent", location: { directory: "/repo" } },
        new AbortController().signal,
        AbortSignal.timeout(500),
      ),
      Error,
    )
  }
})
