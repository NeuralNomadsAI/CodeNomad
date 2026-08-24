import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { clearProviderUsageCache, getProviderUsage, resolveUsageProvider, selectModelWindows } from "./service"
import type { ProviderResult } from "./types"

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
  "crof",
  "deepseek",
  "neuralwatt",
  "claude",
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
  for (const providerId of ["google", "google.oauth", "gemini", "antigravity"]) {
    assert.equal(resolveUsageProvider(providerId), null)
  }
  assert.equal(resolveUsageProvider("opencode")?.id, "opencode-go")
  assert.equal(resolveUsageProvider("github-copilot-addon"), null)
})

test("maps the Anthropic alias to Claude usage", () => {
  assert.equal(resolveUsageProvider("claude")?.id, "claude")
  assert.equal(resolveUsageProvider("anthropic")?.id, "claude")
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
  const response = await getProviderUsage("unknown-provider", { modelId: "model" })
  assert.equal(response.supported, false)
  assert.equal(response.configured, false)
  assert.equal(response.providerId, null)
  assert.deepEqual(response.windows, {})
  for (const providerId of ["google", "google.oauth", "gemini", "antigravity"]) {
    assert.equal((await getProviderUsage(providerId)).supported, false)
  }
})

test("shows NeuralWatt allowance percentage instead of the key name", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-neuralwatt-usage-"))
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousFetch = globalThis.fetch
  process.env.OPENCODE_AUTH_FILE = path.join(directory, "auth.json")
  fs.writeFileSync(process.env.OPENCODE_AUTH_FILE, JSON.stringify({ neuralwatt: { key: "token" } }))
  globalThis.fetch = async () => Response.json({
    key: { name: "production", allowance: { spent_usd: 25, limit_usd: 100, period: "daily" } },
  })
  clearProviderUsageCache()

  try {
    const response = await getProviderUsage("neuralwatt")
    assert.equal(response.windows.daily?.usedPercent, 25)
    assert.equal(response.windows.daily?.valueLabel, undefined)
  } finally {
    clearProviderUsageCache()
    globalThis.fetch = previousFetch
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("leaves expired Claude OAuth refresh to the owning OpenCode integration", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-claude-usage-"))
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousFetch = globalThis.fetch
  let calls = 0
  process.env.OPENCODE_AUTH_FILE = path.join(directory, "auth.json")
  fs.writeFileSync(process.env.OPENCODE_AUTH_FILE, JSON.stringify({
    anthropic: { type: "oauth", access: "expired", refresh: "owner-managed", expires: 1 },
  }))
  globalThis.fetch = async () => {
    calls += 1
    return Response.json({})
  }

  try {
    const response = await resolveUsageProvider("anthropic")!.fetchQuota()
    assert.equal(response.ok, false)
    assert.equal(response.error, "Claude session expired. Reconnect the Anthropic integration in OpenCode.")
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = previousFetch
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("briefly backs off after a failed provider call", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-usage-backoff-"))
  const authFile = path.join(directory, "auth.json")
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousFetch = globalThis.fetch
  const previousNow = Date.now
  let now = 1_000
  let calls = 0
  fs.writeFileSync(authFile, JSON.stringify({ copilot: { type: "oauth", access: "token" } }))
  process.env.OPENCODE_AUTH_FILE = authFile
  Date.now = () => now
  globalThis.fetch = async () => {
    calls += 1
    return new Response(null, { status: 500 })
  }
  clearProviderUsageCache()

  try {
    assert.equal((await getProviderUsage("copilot")).ok, false)
    assert.equal((await getProviderUsage("copilot")).ok, false)
    assert.equal(calls, 1)
    now += 5_001
    assert.equal((await getProviderUsage("copilot")).ok, false)
    assert.equal(calls, 2)
  } finally {
    clearProviderUsageCache()
    Date.now = previousNow
    globalThis.fetch = previousFetch
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("deduplicates simultaneous canonical and alias provider requests", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-usage-dedup-"))
  const authFile = path.join(directory, "auth.json")
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousFetch = globalThis.fetch
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  fs.writeFileSync(authFile, JSON.stringify({ copilot: { type: "oauth", access: "token" } }))
  process.env.OPENCODE_AUTH_FILE = authFile
  globalThis.fetch = async () => {
    calls += 1
    await gate
    return Response.json({ quota_snapshots: { chat: { entitlement: 100, remaining: 50 } } })
  }
  clearProviderUsageCache()

  try {
    const canonical = getProviderUsage("github-copilot")
    const alias = getProviderUsage("copilot")
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
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
