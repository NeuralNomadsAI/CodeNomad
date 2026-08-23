import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { oauthProviders, parseCodexUsage } from "./oauth"

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

test("refreshes expired Codex OAuth with the OpenCode form encoding", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-codex-"))
  const authFile = path.join(directory, "auth.json")
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousCodexHome = process.env.CODEX_HOME
  const previousFetch = globalThis.fetch
  fs.writeFileSync(authFile, JSON.stringify({
    openai: { type: "oauth", access: "expired", refresh: "refresh-token", expires: 1, accountId: "account" },
  }))
  process.env.OPENCODE_AUTH_FILE = authFile
  process.env.CODEX_HOME = path.join(directory, "missing-codex-home")
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith("/oauth/token")) {
      assert.equal(new Headers(init?.headers).get("content-type"), "application/x-www-form-urlencoded")
      assert.equal(String(init?.body), "grant_type=refresh_token&refresh_token=refresh-token&client_id=app_EMoamEEZ73f0CkXaXp7hrann")
      return Response.json({ access_token: "fresh", refresh_token: "next-refresh", expires_in: 3600 })
    }
    return Response.json({ rate_limit: { primary_window: { used_percent: 0, reset_at: 2_000_000_000 } } })
  }

  try {
    const usage = await oauthProviders.find((provider) => provider.id === "codex")!.fetchQuota()
    assert.equal(usage.ok, true)
    assert.equal((JSON.parse(fs.readFileSync(authFile, "utf8")).openai as Record<string, unknown>).refresh, "next-refresh")
  } finally {
    globalThis.fetch = previousFetch
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("uses a valid Codex CLI session before stale OpenCode OAuth", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-codex-cli-"))
  const openCodeAuthFile = path.join(directory, "opencode-auth.json")
  const codexHome = path.join(directory, "codex")
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousCodexHome = process.env.CODEX_HOME
  const previousFetch = globalThis.fetch
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
  fs.mkdirSync(codexHome)
  fs.writeFileSync(openCodeAuthFile, JSON.stringify({
    openai: { type: "oauth", access: "expired", refresh: "stale-refresh", expires: 1 },
  }))
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    tokens: { access_token: `header.${payload}.signature`, refresh_token: "codex-refresh", account_id: "account" },
  }))
  process.env.OPENCODE_AUTH_FILE = openCodeAuthFile
  process.env.CODEX_HOME = codexHome
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://chatgpt.com/backend-api/wham/usage")
    assert.equal(new Headers(init?.headers).get("authorization")?.endsWith(`header.${payload}.signature`), true)
    return Response.json({ rate_limit: { primary_window: { used_percent: 0, reset_at: 2_000_000_000 } } })
  }

  try {
    const usage = await oauthProviders.find((provider) => provider.id === "codex")!.fetchQuota()
    assert.equal(usage.ok, true)
  } finally {
    globalThis.fetch = previousFetch
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
