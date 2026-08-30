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

test("rejects empty and malformed Codex usage payloads", () => {
  assert.throws(() => parseCodexUsage({}), /no quota data/)
  assert.throws(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent: "invalid" } } }), /no quota data/)
})

test("does not refresh or mutate expired OpenCode credentials", async () => {
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
  const before = fs.readFileSync(authFile, "utf8")
  globalThis.fetch = async () => { throw new Error("expired credentials must not make requests") }

  try {
    const usage = await oauthProviders.find((provider) => provider.id === "codex")!.fetchQuota()
    assert.equal(usage.ok, false)
    assert.match(usage.error ?? "", /Reconnect it in OpenCode or Codex CLI/)
    assert.equal(fs.readFileSync(authFile, "utf8"), before)
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

test("tries valid Codex CLI credentials after OpenCode authentication fails without mutating either store", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-codex-fallback-"))
  const openCodeAuthFile = path.join(directory, "opencode-auth.json")
  const codexHome = path.join(directory, "codex")
  const codexAuthFile = path.join(codexHome, "auth.json")
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousCodexHome = process.env.CODEX_HOME
  const previousFetch = globalThis.fetch
  const validPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
  fs.mkdirSync(codexHome)
  fs.writeFileSync(openCodeAuthFile, JSON.stringify({
    codex: { type: "oauth", access: "open-code-access", refresh: "open-code-refresh", expires: Date.now() + 3_600_000 },
  }))
  fs.writeFileSync(codexAuthFile, JSON.stringify({
    tokens: { access_token: `header.${validPayload}.signature`, refresh_token: "cli-refresh", account_id: "account" },
  }))
  process.env.OPENCODE_AUTH_FILE = openCodeAuthFile
  process.env.CODEX_HOME = codexHome
  globalThis.fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get("authorization")
    if (authorization === "Bearer open-code-access") return new Response(null, { status: 401 })
    assert.equal(authorization, `Bearer header.${validPayload}.signature`)
    return Response.json({ rate_limit: { primary_window: { used_percent: 0 } } })
  }

  try {
    const usage = await oauthProviders.find((provider) => provider.id === "codex")!.fetchQuota()
    assert.equal(usage.ok, true)
    assert.equal((JSON.parse(fs.readFileSync(openCodeAuthFile, "utf8")).codex as Record<string, unknown>).refresh, "open-code-refresh")
    assert.equal((JSON.parse(fs.readFileSync(codexAuthFile, "utf8")).tokens as Record<string, unknown>).refresh_token, "cli-refresh")
  } finally {
    globalThis.fetch = previousFetch
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("skips an API-key OpenAI alias for a valid Codex OAuth alias", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-codex-alias-"))
  const openCodeAuthFile = path.join(directory, "opencode-auth.json")
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousCodexHome = process.env.CODEX_HOME
  const previousFetch = globalThis.fetch
  fs.writeFileSync(openCodeAuthFile, JSON.stringify({
    openai: { type: "api", key: "api-key" },
    codex: { type: "oauth", access: "codex-access", expires: Date.now() + 3_600_000 },
  }))
  process.env.OPENCODE_AUTH_FILE = openCodeAuthFile
  process.env.CODEX_HOME = path.join(directory, "missing-codex-home")
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer codex-access")
    return Response.json({ rate_limit: { primary_window: { used_percent: 0 } } })
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

test("rejects empty and malformed Copilot usage payloads after OAuth alias fallback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-copilot-empty-"))
  const authFile = path.join(directory, "auth.json")
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousFetch = globalThis.fetch
  fs.writeFileSync(authFile, JSON.stringify({
    "github-copilot": { type: "api", key: "api-key" },
    copilot: { type: "oauth", access: "copilot-access" },
  }))
  process.env.OPENCODE_AUTH_FILE = authFile

  try {
    for (const payload of [{}, { quota_snapshots: { chat: { entitlement: "invalid", remaining: 1 } } }]) {
      globalThis.fetch = async (_input, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "token copilot-access")
        return Response.json(payload)
      }
      const usage = await oauthProviders.find((provider) => provider.id === "github-copilot")!.fetchQuota()
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
