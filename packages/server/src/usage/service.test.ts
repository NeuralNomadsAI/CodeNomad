import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { clearProviderUsageCache, getProviderUsage, resolveUsageProvider, selectModelWindows } from "./service"
import type { ProviderReadContext, ProviderResult } from "./types"

const providerIds = [
  "codex",
  "github-copilot",
  "xai",
  "kimi-for-coding",
  "nano-gpt",
  "openrouter",
  "zai-coding-plan",
  "zhipuai-coding-plan",
  "minimax-coding-plan",
  "minimax-cn-coding-plan",
  "ollama-cloud",
  "wafer",
  "opencode-go",
  "cursor",
  "command-code",
  "deepseek",
  "neuralwatt",
  "claude",
  "cline-pass",
  "deepinfra",
  "hyper",
  "kilo",
  "zenmux",
  "exe-dev",
]

test("registers every supported usage provider", () => {
  for (const providerId of providerIds) {
    assert.equal(resolveUsageProvider(providerId)?.id, providerId)
  }
})

test("maps OpenCode provider aliases to their usage provider", () => {
  assert.equal(resolveUsageProvider("openai")?.id, "codex")
  assert.equal(resolveUsageProvider("copilot")?.id, "github-copilot")
  assert.equal(resolveUsageProvider("grok")?.id, "xai")
  for (const alias of ["kimi", "kimi-code-plan-cn", "kimi-code-plan-global"]) {
    assert.equal(resolveUsageProvider(alias)?.id, "kimi-for-coding")
  }
  for (const providerId of ["google", "google.oauth", "gemini", "antigravity"]) {
    assert.equal(resolveUsageProvider(providerId), null)
  }
  assert.equal(resolveUsageProvider("opencode")?.id, "opencode-go")
  assert.equal(resolveUsageProvider("github-copilot-addon"), null)
})

test("maps the Anthropic alias to Claude usage", () => {
  assert.equal(resolveUsageProvider("claude")?.id, "claude")
  assert.equal(resolveUsageProvider("anthropic")?.id, "claude")
  // Registered by opencode-claude and OpenCode's Claude Agent, which both run Claude Code's own login.
  assert.equal(resolveUsageProvider("claude-code")?.id, "claude-code")
  assert.equal(resolveUsageProvider("claude-agent")?.id, "claude-code")
})

test("each Claude provider uses only its session's login and fences Claude Code account switches", async () => {
  const previousFetch = globalThis.fetch
  const tokens: string[] = []
  const expires = Date.now() + 3_600_000
  const login = (access: string) => ({ type: "oauth", access, expires })
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    tokens.push(new Headers(init?.headers).get("Authorization") ?? "")
    return Response.json({ limits: [{ kind: "session", percent: tokens.length }] })
  }) as typeof fetch
  clearProviderUsageCache()
  try {
    const opencode = { anthropic: login("opencode-oauth") }
    assert.equal((await getProviderUsage("anthropic", { auth: { ...opencode, "claude-code": login("claude-code-first") } })).windows["5h"].usedPercent, 1)
    assert.equal((await getProviderUsage("anthropic", { auth: { anthropic: { type: "api", key: "console" } } })).configured, false)
    assert.equal((await getProviderUsage("claude-code", { auth: opencode })).configured, false)
    assert.equal((await getProviderUsage("claude-code", { auth: { "claude-code": login("claude-code-first") } })).windows["5h"].usedPercent, 2)
    assert.equal((await getProviderUsage("claude-code", { auth: { "claude-code": login("claude-code-first") } })).windows["5h"].usedPercent, 2)
    assert.equal((await getProviderUsage("claude-code", { auth: { "claude-code": login("claude-code-second") } })).windows["5h"].usedPercent, 3)
    assert.deepEqual(tokens, ["Bearer opencode-oauth", "Bearer claude-code-first", "Bearer claude-code-second"])
  } finally {
    globalThis.fetch = previousFetch
    clearProviderUsageCache()
  }
})

test("OpenCode's Claude Agent reads only Claude Code's login and shares its snapshot", async () => {
  const previousFetch = globalThis.fetch
  const tokens: string[] = []
  const expires = Date.now() + 3_600_000
  const login = (access: string) => ({ type: "oauth", access, expires })
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    tokens.push(new Headers(init?.headers).get("Authorization") ?? "")
    return Response.json({ limits: [{ kind: "session", percent: 40 + tokens.length }] })
  }) as typeof fetch
  clearProviderUsageCache()
  try {
    // Neither OpenCode's Anthropic OAuth nor a native `claude-agent` entry is its login.
    const foreign = await getProviderUsage("claude-agent", { auth: { anthropic: login("opencode-oauth"), "claude-agent": login("native-entry") } })
    assert.equal(foreign.supported, true)
    assert.equal(foreign.configured, false)
    const agent = await getProviderUsage("claude-agent", { auth: { "claude-code": login("claude-code-login") } })
    assert.equal(agent.requestedProviderId, "claude-agent")
    assert.equal(agent.providerName, "Claude")
    assert.equal(agent.windows["5h"].usedPercent, 41)
    // One login, one quota: the claude-code provider reuses the same snapshot.
    assert.equal((await getProviderUsage("claude-code", { auth: { "claude-code": login("claude-code-login") } })).windows["5h"].usedPercent, 41)
    assert.deepEqual(tokens, ["Bearer claude-code-login"])
  } finally {
    globalThis.fetch = previousFetch
    clearProviderUsageCache()
  }
})
test("adds a matched model's scoped limits to the plan windows", () => {
  const window = (usedPercent: number) => ({ usedPercent, remainingPercent: 100 - usedPercent, windowSeconds: 604_800, resetAt: null })
  const result: ProviderResult = {
    providerId: "claude", providerName: "Claude", ok: true, configured: true, fetchedAt: 1,
    usage: { windows: { "5h": window(4), "7d": window(1) }, models: { Opus: { windows: { "7d": window(60) } } } },
  }
  assert.deepEqual(Object.keys(selectModelWindows(result, "claude-opus-5-5")), ["5h", "7d", "7d:Opus"])
  assert.equal(selectModelWindows(result, "claude-opus-5-5")["7d:Opus"].usedPercent, 60)
  assert.deepEqual(Object.keys(selectModelWindows(result, "claude-sonnet-5-5")), ["5h", "7d"])
})

test("Kimi session integration priority participates in the display cache identity", async t => {
  const keys: string[] = []
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    keys.push(new Headers(init.headers).get("Authorization")!)
    return Response.json({ usages: { limit_month_total: { used_ratio: keys.length / 10 } } })
  })
  const auth = { "kimi-code-plan-cn": "synthetic-cn", "kimi-code-plan-global": "synthetic-global" }
  clearProviderUsageCache()
  try {
    assert.equal((await getProviderUsage("kimi-code-plan-cn", { auth })).windows.monthly.usedPercent, 10)
    assert.equal((await getProviderUsage("kimi-code-plan-cn", { auth })).windows.monthly.usedPercent, 10)
    assert.equal((await getProviderUsage(" KIMI-CODE-PLAN-GLOBAL ", { auth })).windows.monthly.usedPercent, 20)
    assert.equal((await getProviderUsage("kimi", { auth, context: { integrationID: "kimi-code-plan-cn" } })).windows.monthly.usedPercent, 30)
    assert.deepEqual(keys, ["Bearer synthetic-cn", "Bearer synthetic-global", "Bearer synthetic-cn"])
  } finally { clearProviderUsageCache() }
})

test("never serves a cached snapshot across a credential switch", async () => {
  const previousFetch = globalThis.fetch
  const keys: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("Authorization") ?? "")
    return Response.json({ balance: keys.length })
  }) as typeof fetch
  clearProviderUsageCache()
  try {
    const first = await getProviderUsage("hyper", { auth: { hyper: { type: "api", key: "first" } } })
    const cached = await getProviderUsage("hyper", { auth: { hyper: { type: "api", key: "first" }, other: { type: "api", key: "x" } } })
    const switched = await getProviderUsage("hyper", { auth: { hyper: { type: "api", key: "second" } } })
    assert.deepEqual(keys, ["Bearer first", "Bearer second"])
    assert.equal(first.windows.credits.valueLabel, "1")
    assert.equal(cached.windows.credits.valueLabel, "1")
    assert.equal(switched.windows.credits.valueLabel, "2")
  } finally {
    globalThis.fetch = previousFetch
    clearProviderUsageCache()
  }
})

test("selects model-specific windows by normalized model id", () => {
  const result: ProviderResult = {
    providerId: "codex",
    providerName: "Codex",
    ok: true,
    configured: true,
    fetchedAt: 1,
    usage: {
      windows: {},
      models: {
        "openai/gpt-5": {
          windows: {
            daily: { usedPercent: 25, remainingPercent: 75, windowSeconds: 86_400, resetAt: null },
          },
        },
      },
    },
  }

  assert.equal(selectModelWindows(result, "models/gpt-5").daily?.usedPercent, 25)
})

test("returns a stable unsupported response without making a provider request", async () => {
  const previousFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error("Unexpected provider request")
  }
  try {
    const auth = { "unknown-provider": { key: "synthetic-key" } }
    assert.equal(resolveUsageProvider("unknown-provider"), null)
    const response = await getProviderUsage("unknown-provider", { modelId: "model", auth })
    assert.equal(response.supported, false)
    assert.equal(response.configured, false)
    assert.equal(response.providerId, null)
    assert.deepEqual(response.windows, {})
    assert.deepEqual(auth, { "unknown-provider": { key: "synthetic-key" } })
    for (const providerId of ["google", "google.oauth", "gemini", "antigravity"]) {
      assert.equal((await getProviderUsage(providerId)).supported, false)
    }
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("Copilot publishes numeric consumption and plan while Enterprise metadata fences its display cache", async () => {
  const previousFetch = globalThis.fetch
  const endpoints: string[] = []
  clearProviderUsageCache()
  globalThis.fetch = async input => {
    endpoints.push(String(input))
    return Response.json({ copilot_plan: "enterprise", quota_snapshots: {
      premium_interactions: { entitlement: 100, quota_remaining: 74.25, percent_remaining: 74.25 },
    } })
  }
  try {
    const credential = { type: "oauth", access: "synthetic-copilot-cache" }
    const publicUsage = await getProviderUsage("github-copilot", { auth: { "github-copilot": credential } })
    assert.equal(publicUsage.copilotPlan, "enterprise")
    assert.deepEqual(publicUsage.windows.premium.consumption, { used: 25.75, limit: 100 })
    await getProviderUsage("github-copilot", { auth: { "github-copilot": { ...credential, enterpriseUrl: "company.ghe.com" } } })
    const invalid = await getProviderUsage("github-copilot", {
      auth: { "github-copilot": { ...credential, enterpriseUrl: "https://company.ghe.com:443" } },
    })
    assert.equal(invalid.unavailableReason, "invalid-base-url")
    assert.deepEqual(invalid.windows, {})
    assert.equal(invalid.copilotPlan, undefined)
    assert.deepEqual(endpoints, ["https://api.github.com/copilot_internal/user", "https://api.company.ghe.com/copilot_internal/user"])
    assert.equal(JSON.stringify(invalid).includes("synthetic-copilot-cache"), false)
    assert.equal(JSON.stringify(invalid).includes("company.ghe.com"), false)
  } finally { globalThis.fetch = previousFetch; clearProviderUsageCache() }
})

test("shows NeuralWatt allowance percentage instead of the key name", async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({
    key: { name: "production", allowance: { spent_usd: 25, limit_usd: 100, period: "daily" } },
  })
  clearProviderUsageCache()

  try {
    const response = await getProviderUsage("neuralwatt", { auth: { neuralwatt: { key: "token" } } })
    assert.equal(response.windows.daily?.usedPercent, 25)
    assert.equal(response.windows.daily?.valueLabel, undefined)
  } finally {
    clearProviderUsageCache()
    globalThis.fetch = previousFetch
  }
})

test("leaves expired Claude OAuth refresh to the owning OpenCode integration", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-claude-usage-"))
  const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR
  const previousFetch = globalThis.fetch
  let calls = 0
  process.env.CLAUDE_CONFIG_DIR = directory
  globalThis.fetch = async () => {
    calls += 1
    return Response.json({})
  }

  try {
    const response = await resolveUsageProvider("anthropic")!.fetchQuota({
      anthropic: { type: "oauth", access: "expired", refresh: "owner-managed", expires: 1 },
    })
    assert.equal(response.ok, false)
    assert.equal(response.error, "Claude session expired. Reconnect the Anthropic integration in OpenCode.")
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = previousFetch
    if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("briefly backs off after a failed provider call", async () => {
  const auth = { copilot: { type: "oauth", access: "token" } }
  const previousFetch = globalThis.fetch
  const previousNow = Date.now
  let now = 1_000
  let calls = 0
  Date.now = () => now
  globalThis.fetch = async () => {
    calls += 1
    return new Response(null, { status: 500 })
  }
  clearProviderUsageCache()

  try {
    assert.equal((await getProviderUsage("copilot", { auth })).ok, false)
    assert.equal((await getProviderUsage("copilot", { auth })).ok, false)
    assert.equal(calls, 1)
    now += 5_001
    assert.equal((await getProviderUsage("copilot", { auth })).ok, false)
    assert.equal(calls, 2)
  } finally {
    clearProviderUsageCache()
    Date.now = previousNow
    globalThis.fetch = previousFetch
  }
})

test("deduplicates simultaneous canonical and alias provider requests", async () => {
  const auth = { copilot: { type: "oauth", access: "token" } }
  const previousFetch = globalThis.fetch
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = async () => {
    calls += 1
    await gate
    return Response.json({ quota_snapshots: { chat: { entitlement: 100, quota_remaining: 50 } } })
  }
  clearProviderUsageCache()

  try {
    const canonical = getProviderUsage("github-copilot", { auth })
    const alias = getProviderUsage("copilot", { auth })
    await Promise.resolve()
    assert.equal(calls, 1)
    release()
    const responses = await Promise.all([canonical, alias])
    assert.equal(calls, 1)
    assert.equal(responses.every((response) => response.ok), true)
  } finally {
    release()
    clearProviderUsageCache()
    globalThis.fetch = previousFetch
  }
})

test("effective native settings fence snapshots while signals stay outside cache identity", async () => {
  const provider = resolveUsageProvider("openrouter")!
  const original = provider.fetchQuota
  const contexts: Array<ProviderReadContext | undefined> = []
  provider.fetchQuota = async (_auth, context) => {
    contexts.push(context)
    return { providerId: provider.id, providerName: provider.name, configured: true, ok: true, fetchedAt: 1,
      usage: { windows: { credits: { usedPercent: null, remainingPercent: null, resetAt: null, windowSeconds: null, valueLabel: String(contexts.length) } } } }
  }
  clearProviderUsageCache()
  try {
    const context: ProviderReadContext = { signal: new AbortController().signal, settingsStatus: "available",
      settings: { baseURL: "https://quota.example/v1", apiKey: "synthetic-setting" } }
    const read = (context?: ProviderReadContext) => getProviderUsage("openrouter", { auth: { openrouter: { key: "synthetic-stored" } }, context })
    assert.equal((await read(context)).windows.credits.valueLabel, "1")
    assert.equal(contexts[0], context)
    assert.equal((await read({ ...context, signal: new AbortController().signal })).windows.credits.valueLabel, "1")
    assert.equal((await read({ ...context, settings: { ...context.settings, baseURL: "https://other.example/prefix" } })).windows.credits.valueLabel, "2")
    assert.equal((await read({ ...context, settings: { ...context.settings, apiKey: "synthetic-other" } })).windows.credits.valueLabel, "3")
    assert.equal((await read({ ...context, settingsStatus: "unresolved", settings: {} })).windows.credits.valueLabel, "4")
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(read({ ...context, signal: aborted.signal }))
    assert.equal(contexts.length, 4)
    assert.equal(JSON.stringify(await read(context)).includes("synthetic"), false)
  } finally { provider.fetchQuota = original; clearProviderUsageCache() }
})

test("only enumerated public reasons, bounded numeric codes and associated fixed actions leave a reader", async () => {
  const provider = resolveUsageProvider("openrouter")!
  const original = provider.fetchQuota
  const base: ProviderResult = { providerId: provider.id, providerName: provider.name, configured: true, ok: false,
    fetchedAt: 1, error: "secret-token upstream body", status: 401,
    usage: { windows: { stale: { usedPercent: 99, remainingPercent: 1, windowSeconds: null, resetAt: null } } } }
  const read = async (extra: Partial<ProviderResult>) => {
    clearProviderUsageCache()
    provider.fetchQuota = async () => ({ ...base, ...extra })
    const response = await getProviderUsage("openrouter")
    assert.deepEqual(response.windows, {})
    assert.equal(JSON.stringify(response).includes("secret"), false)
    assert.equal("error" in response || "status" in response, false)
    return response
  }
  try {
    const valid = await read({ unavailableReason: "provider-error", providerErrorCode: "1001", unavailableAction: "chatgpt-usage" })
    assert.equal(valid.unavailableReason, "provider-error")
    assert.equal(valid.providerErrorCode, "1001")
    assert.equal(valid.unavailableAction, undefined)
    for (const code of ["secret-token", "1001\n", "123456789", "<script>"]) {
      assert.equal((await read({ unavailableReason: "provider-error", providerErrorCode: code })).providerErrorCode, undefined)
    }
    assert.equal((await read({ unavailableReason: "secret-token" as never })).unavailableReason, undefined)
    const linked = await read({ unavailableReason: "openai-token-sharing-unsupported", unavailableAction: "chatgpt-usage" })
    assert.equal(linked.unavailableAction, "chatgpt-usage")
    const expired = await read({ unavailableReason: "opencode-go-key-expired", unavailableAction: "opencode-go-new-key" })
    assert.equal(expired.unavailableReason, "opencode-go-key-expired")
    assert.equal(expired.unavailableAction, "opencode-go-new-key")
    assert.equal((await read({ unavailableReason: "opencode-go-key-expired", unavailableAction: "chatgpt-usage" })).unavailableAction, undefined)
    assert.equal((await read({ unavailableReason: "provider-error", unavailableAction: "opencode-go-new-key" })).unavailableAction, undefined)
    assert.equal((await read({ unavailableAction: "chatgpt-usage" })).unavailableAction, undefined)
    const minimax = await read({ unavailableReason: "minimax-limits-not-shared", unavailableAction: "chatgpt-usage", providerErrorCode: "1004" })
    assert.equal(minimax.unavailableReason, "minimax-limits-not-shared")
    assert.equal(minimax.unavailableAction, undefined)
    assert.equal(minimax.providerErrorCode, undefined)
    for (const reason of ["cursor-token-expired", "cursor-team-unavailable", "cursor-access-denied", "cursor-usage-unavailable"] as const) {
      const cursor = await read({ unavailableReason: reason, unavailableAction: "chatgpt-usage", providerErrorCode: "1004" })
      assert.equal(cursor.unavailableReason, reason)
      assert.equal(cursor.unavailableAction, undefined)
      assert.equal(cursor.providerErrorCode, undefined)
    }
  } finally { provider.fetchQuota = original; clearProviderUsageCache() }
})

test("cancellation during a reader prevents publication and warming its cache", async () => {
  const provider = resolveUsageProvider("openrouter")!
  const original = provider.fetchQuota
  const controller = new AbortController()
  let calls = 0
  provider.fetchQuota = async () => {
    if (++calls === 1) controller.abort()
    return { providerId: provider.id, providerName: provider.name, ok: true, configured: true, usage: null, fetchedAt: 1 }
  }
  clearProviderUsageCache()
  try {
    await assert.rejects(getProviderUsage("openrouter", { context: { signal: controller.signal } }))
    assert.equal((await getProviderUsage("openrouter")).ok, true)
    assert.equal(calls, 2)
  } finally { provider.fetchQuota = original; clearProviderUsageCache() }
})
