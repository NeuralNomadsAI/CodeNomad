import assert from "node:assert/strict"
import test from "node:test"
import { OpenCode } from "@opencode/client"
import {
  PLUGIN_USAGE_MAX_WINDOWS,
  classifyPluginUsageError,
  parsePluginUsageOutput,
  pluginUsageRpcId,
  readPluginProviderUsage,
} from "./plugin-usage"

test("pluginUsageRpcId accepts safe provider IDs and rejects traversal or invalid characters", () => {
  assert.equal(pluginUsageRpcId("agy-agent"), "provider-usage.agy-agent")
  assert.equal(pluginUsageRpcId("  acme.provider_1  "), "provider-usage.acme.provider_1")
  for (const invalid of ["", "   ", "a/b", "a..b", "a b", "a\nb", "x".repeat(129)]) {
    assert.equal(pluginUsageRpcId(invalid), null, invalid)
  }
})

test("parsePluginUsageOutput validates, derives complementary percents and drops unknown top-level fields", () => {
  const parsed = parsePluginUsageOutput(
    {
      providerName: "Antigravity Agent",
      configured: true,
      ok: true,
      fetchedAt: 1_700_000_000_000,
      extraField: "ignored",
      windows: {
        "5h": { remainingPercent: 90.58, windowSeconds: 18_000, resetAt: 1_700_018_000_000 },
        weekly: { usedPercent: 25, remainingPercent: 75, resetAt: null },
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

test("parsePluginUsageOutput clears windows on failure and rejects malformed, non-canonical or contradictory payloads", () => {
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
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { "5h": { usedPercent: Number.NaN } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { "5h": { unknownProp: 1 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  // Non-canonical window keys (including whitespace collisions) and prototype keys are rejected.
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 1 }, " weekly ": { usedPercent: 2 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { " 5h": { usedPercent: 1 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: JSON.parse("{\"__proto__\":{\"usedPercent\":1}}") }, { requestedProviderId: "x", providerId: "x" }), null)
  // Out-of-range or contradictory percentages are rejected.
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 120 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: -1 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 120, remainingPercent: 90 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { weekly: { usedPercent: 40, remainingPercent: 40 } } }, { requestedProviderId: "x", providerId: "x" }), null)
  assert.equal(parsePluginUsageOutput({ configured: true, ok: true, windows: { credits: { balanceUSD: { remaining: 5, total: -1 } } } }, { requestedProviderId: "x", providerId: "x" }), null)
})

test("classifyPluginUsageError distinguishes absent RPCs, registered failures and transport/unknown errors", () => {
  assert.equal(classifyPluginUsageError({ _tag: "RpcError", type: "rpc.unavailable", message: "missing" }), "absent")
  assert.equal(classifyPluginUsageError({ _tag: "RpcError", type: "rpc.method_not_found", message: "missing" }), "absent")
  assert.equal(classifyPluginUsageError(new Error("")), "absent")
  assert.equal(classifyPluginUsageError(Object.assign(new Error("Not found"), { type: "not_found" })), "absent")
  assert.equal(classifyPluginUsageError({ _tag: "RpcInternalError", type: "rpc.internal", message: "boom" }), "registered")
  assert.equal(classifyPluginUsageError({ _tag: "RpcError", type: "rpc.invalid_output", message: "bad" }), "registered")
  assert.equal(classifyPluginUsageError({ _tag: "RpcError", type: "quota.failed", message: "custom" }), "registered")
  assert.equal(classifyPluginUsageError({ _tag: "LocationNotFoundError", message: "gone" }), "failure")
  assert.equal(classifyPluginUsageError(Object.assign(new Error("Transport: fetch failed"), { name: "ClientError", reason: "Transport" })), "failure")
  assert.equal(classifyPluginUsageError(Object.assign(new Error("Internal Server Error"), { error: "Internal Server Error" })), "failure")
})

test("readPluginProviderUsage maps RPC outcomes, bounds ignored signals and propagates transport errors", async () => {
  const makeConnection = (handler: (url: URL, init?: RequestInit) => Promise<Response>) => ({
    client: OpenCode.make({ baseUrl: "http://isolated-native.invalid", fetch: (input, init) => handler(new URL(String(input)), init) }),
  })

  // Missing RPC returns null so the caller reports unsupported.
  const absent = await readPluginProviderUsage(
    makeConnection(async () => Response.json({ _tag: "RpcError", type: "rpc.unavailable", message: "RPC is unavailable" }, { status: 400 })),
    { providerId: "unknown-plugin", location: { directory: "/repo" }, modelId: "m1" },
    new AbortController().signal,
  )
  assert.equal(absent, null)

  // Older OpenCode without /api/rpc (404 JSON including `{ type: "not_found" }` or plain text) degrades to null.
  for (const response of [
    () => Response.json({}, { status: 404 }),
    () => Response.json({ type: "not_found", message: "Not found" }, { status: 404 }),
    () => new Response("Not Found", { status: 404 }),
  ]) {
    const older = await readPluginProviderUsage(
      makeConnection(async () => response()),
      { providerId: "unknown-plugin", location: { directory: "/repo" } },
      new AbortController().signal,
    )
    assert.equal(older, null)
  }

  // Transport failures propagate so callers return 503 instead of claiming unsupported.
  await assert.rejects(
    readPluginProviderUsage(
      makeConnection(async () => { throw new TypeError("fetch failed") }),
      { providerId: "agy-agent", location: { directory: "/repo" } },
      new AbortController().signal,
    ),
  )

  // Internal/invalid output from a registered plugin reports supported + unavailable without leaking text.
  const broken = await readPluginProviderUsage(
    makeConnection(async () => Response.json({ _tag: "RpcInternalError", type: "rpc.internal", message: "secret-token-leak" }, { status: 500 })),
    { providerId: "agy-agent", location: { directory: "/repo" }, modelId: "gemini-4-neon" },
    new AbortController().signal,
  )
  assert.ok(broken)
  assert.equal(broken.supported, true)
  assert.equal(broken.ok, false)
  assert.equal(JSON.stringify(broken).includes("secret-token-leak"), false)

  // Quota deadline abort bounds an RPC whose transport ignores the abort signal and resolves late or never settles.
  {
    const outer = new AbortController()
    const quota = new AbortController()
    let release!: () => void
    const hanging = new Promise<Response>(resolve => {
      release = () => resolve(Response.json({
        output: { configured: true, ok: true, windows: { "5h": { usedPercent: 5 } } },
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
    assert.ok(timedOut)
    assert.equal(timedOut.supported, true)
    assert.equal(timedOut.ok, false)
    assert.deepEqual(timedOut.windows, {})
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
})
