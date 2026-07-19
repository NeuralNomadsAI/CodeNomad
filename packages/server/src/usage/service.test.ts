import assert from "node:assert/strict"
import test from "node:test"

import { getProviderUsage, resolveUsageProvider, selectModelWindows } from "./service"
import type { ProviderResult } from "./types"

const providerIds = [
  "codex",
  "github-copilot",
  "google",
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
]

test("registers every supported usage provider", () => {
  for (const providerId of providerIds) {
    assert.equal(resolveUsageProvider(providerId)?.id, providerId)
  }
})

test("maps OpenCode provider aliases to their usage provider", () => {
  assert.equal(resolveUsageProvider("openai")?.id, "codex")
  assert.equal(resolveUsageProvider("copilot")?.id, "github-copilot")
  assert.equal(resolveUsageProvider("gemini")?.id, "google")
  assert.equal(resolveUsageProvider("opencode")?.id, "opencode-go")
})

test("does not use Claude subscription OAuth credentials", () => {
  assert.equal(resolveUsageProvider("anthropic"), null)
  assert.equal(resolveUsageProvider("claude"), null)
})

test("selects model-specific windows by normalized model id", () => {
  const result: ProviderResult = {
    providerId: "google",
    providerName: "Google",
    ok: true,
    configured: true,
    fetchedAt: 1,
    usage: {
      windows: {},
      models: {
        "gemini/gemini-2.5-flash": {
          windows: {
            daily: { usedPercent: 25, remainingPercent: 75, windowSeconds: 86_400, resetAt: null },
          },
        },
      },
    },
  }

  assert.equal(selectModelWindows(result, "models/gemini-2.5-flash").daily?.usedPercent, 25)
})

test("returns a stable unsupported response without making a provider request", async () => {
  const response = await getProviderUsage("unknown-provider", { modelId: "model" })
  assert.equal(response.supported, false)
  assert.equal(response.configured, false)
  assert.equal(response.providerId, null)
  assert.deepEqual(response.windows, {})
})
