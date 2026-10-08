import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { findClaudeCredential } from "./claude-credential"

async function withClaudeDir(run: (directory: string) => void | Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-claude-credential-"))
  const previousDir = process.env.CLAUDE_CONFIG_DIR
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  process.env.CLAUDE_CONFIG_DIR = directory
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  try {
    await run(directory)
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousDir
    if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const opencodeAuth = { anthropic: { type: "oauth", access: "opencode-access", refresh: "opencode-refresh", expires: 5 } }

test("prefers the Claude Code login used by the opencode-claude provider", () => withClaudeDir((directory) => {
  fs.writeFileSync(path.join(directory, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "claude-code-access", refreshToken: "claude-code-refresh", expiresAt: 1_900_000_000_000 },
    mcpOAuth: { other: { accessToken: "unrelated" } },
  }))
  assert.deepEqual(findClaudeCredential(opencodeAuth), {
    access: "claude-code-access", refresh: "claude-code-refresh", expires: 1_900_000_000_000, source: "claude-code",
  })
}))

test("falls back to OpenCode's Anthropic login, then CLAUDE_CODE_OAUTH_TOKEN", () => withClaudeDir((directory) => {
  fs.writeFileSync(path.join(directory, ".credentials.json"), "{ not json")
  assert.equal(findClaudeCredential(opencodeAuth)?.source, "opencode")
  assert.equal(findClaudeCredential({ anthropic: { type: "api", key: "console-key" } }), null)
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token"
  assert.deepEqual(findClaudeCredential({}), { access: "env-token", refresh: null, expires: null, source: "env" })
}))
