import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { oauthProviders, parseCodexUsage } from "./oauth"
import { readOpenCodeAuth } from "../shared"

test("parses Codex rate limits, credits, and business spend limits", () => {
  const usage = parseCodexUsage({
    rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 25, reset_at: 2_000_000_000 } },
    credits: { balance: 12.5, unlimited: false },
    spend_control: { individual_limit: { used: 10, limit: 100, used_percent: 10 } },
  })
  assert.equal(usage.windows["5h"].usedPercent, 25)
  assert.equal(usage.windows.credits_balance.valueLabel, "$12.50")
  assert.equal(usage.windows.credits.valueLabel, "10 / 100 used")
})

test("rejects empty and malformed Codex usage payloads", () => {
  assert.throws(() => parseCodexUsage({}), /no quota data/)
  assert.throws(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent: "invalid" } } }), /no quota data/)
})

test("unscoped Codex requests never read or fall back to host legacy/CLI credentials", async () => {
  const previousRead = fs.readFileSync
  const previousFetch = globalThis.fetch
  let reads = 0
  let calls = 0
  fs.readFileSync = (() => {
    reads++
    return JSON.stringify({ openai: { type: "oauth", access: "legacy", expires: Date.now() + 3600000 },
      tokens: { access_token: "cli" } })
  }) as unknown as typeof fs.readFileSync
  globalThis.fetch = async () => { calls++; return Response.json({ rate_limit: { primary_window: { used_percent: 5 } } }) }
  try {
    const usage = await oauthProviders.find(provider => provider.id === "codex")!.fetchQuota({
      openai: { type: "oauth", access: "projected", expires: Date.now() + 3600000 },
    })
    assert.equal(usage.ok, false)
    assert.equal(reads, 0)
    assert.equal(calls, 0)
  } finally { fs.readFileSync = previousRead; globalThis.fetch = previousFetch }
})

test("rejects empty and malformed Copilot usage payloads after OAuth alias fallback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-copilot-empty-"))
  const authFile = path.join(directory, "auth.json")
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousFetch = globalThis.fetch
  fs.writeFileSync(authFile, JSON.stringify({ "github-copilot": { type: "api", key: "api-key" }, copilot: { type: "oauth", access: "copilot-access" } }))
  process.env.OPENCODE_AUTH_FILE = authFile
  try {
    for (const payload of [{}, { quota_snapshots: { chat: { entitlement: "invalid", remaining: 1 } } }]) {
      globalThis.fetch = async (_input, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "token copilot-access")
        return Response.json(payload)
      }
      const usage = await oauthProviders.find(provider => provider.id === "github-copilot")!.fetchQuota(readOpenCodeAuth())
      assert.equal(usage.ok, false)
      assert.match(usage.error ?? "", /no quota data/)
    }
  } finally {
    globalThis.fetch = previousFetch
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
