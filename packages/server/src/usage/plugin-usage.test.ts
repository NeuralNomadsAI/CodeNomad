import assert from "node:assert/strict"
import test from "node:test"
import { OpenCode } from "@opencode/client"
import {
  PLUGIN_USAGE_MAX_WINDOWS,
  isRegisteredPluginUsageError,
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

test("parsePluginUsageOutput validates, clamps, derives complementary percents and drops unknown fields", () => {
  const parsed = parsePluginUsageOutput(
    {
      providerName: "Antigravity Agent",
      configured: true,
      ok: true,
      fetchedAt: 1_700_000_000_000,
      extraField: "ignored",
      windows: {
        "5h": { remainingPercent: 90.58, windowSeconds: 18_000, resetAt: 1_700_018_000_000 },
        weekly: { usedPercent: 120, resetAt: null },
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
    usedPercent: 100,
    remainingPercent: 0,
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

test("parsePluginUsageOutput clears windows on failure and rejects malformed or oversized payloads", () => {
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
})

test("isRegisteredPluginUsageError distinguishes registered plugin failures from missing RPCs or 404s", () => {
  assert.equal(isRegisteredPluginUsageError({ _tag: "RpcError", type: "rpc.unavailable", message: "missing" }), false)
  assert.equal(isRegisteredPluginUsageError({ _tag: "RpcError", type: "rpc.method_not_found", message: "missing" }), false)
  assert.equal(isRegisteredPluginUsageError({ type: "rpc.unavailable", message: "missing" }), false)
  assert.equal(isRegisteredPluginUsageError(new Error("")), false)
  assert.equal(isRegisteredPluginUsageError({ _tag: "RpcInternalError", type: "rpc.internal", message: "boom" }), true)
  assert.equal(isRegisteredPluginUsageError({ _tag: "RpcError", type: "rpc.invalid_output", message: "bad" }), true)
  assert.equal(isRegisteredPluginUsageError({ _tag: "RpcError", type: "quota.failed", message: "custom" }), true)
})

test("readPluginProviderUsage maps RPC outcomes and respects outer vs quota abort signals", async () => {
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

  // Older OpenCode without /api/rpc (404 JSON or plain text) also degrades to null.
  for (const response of [() => Response.json({}, { status: 404 }), () => new Response("Not Found", { status: 404 })]) {
    const older = await readPluginProviderUsage(
      makeConnection(async () => response()),
      { providerId: "unknown-plugin", location: { directory: "/repo" } },
      new AbortController().signal,
    )
    assert.equal(older, null)
  }

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

  // Quota deadline abort (while outer signal stays live) yields unavailable so publication can still fence.
  const outer = new AbortController()
  const quota = new AbortController()
  quota.abort()
  const timedOut = await readPluginProviderUsage(
    makeConnection(async (_url, init) => {
      init?.signal?.throwIfAborted()
      return Response.json({ output: {} })
    }),
    { providerId: "agy-agent", location: { directory: "/repo" } },
    outer.signal,
    quota.signal,
  )
  assert.ok(timedOut)
  assert.equal(timedOut.supported, true)
  assert.equal(timedOut.ok, false)

  // Outer request abort propagates cleanly.
  outer.abort()
  await assert.rejects(
    readPluginProviderUsage(
      makeConnection(async (_url, init) => {
        init?.signal?.throwIfAborted()
        return Response.json({ output: {} })
      }),
      { providerId: "agy-agent", location: { directory: "/repo" } },
      outer.signal,
      outer.signal,
    ),
  )
})
