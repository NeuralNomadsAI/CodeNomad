import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { claudeCodeCredential, claudeCodeCredentialIdentity, openCodeClaudeCredential } from "./claude-credential"

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

const writeLogin = (directory: string, accessToken: string) => fs.writeFileSync(path.join(directory, ".credentials.json"), JSON.stringify({
  claudeAiOauth: { accessToken, refreshToken: "claude-code-refresh", expiresAt: 1_900_000_000_000 },
  mcpOAuth: { other: { accessToken: "unrelated" } },
}))

test("reads the Claude Code login used by opencode-claude, then CLAUDE_CODE_OAUTH_TOKEN", () => withClaudeDir((directory) => {
  assert.equal(claudeCodeCredential(), null)
  assert.equal(claudeCodeCredentialIdentity(), null)
  writeLogin(directory, "claude-code-access")
  assert.deepEqual(claudeCodeCredential(), {
    access: "claude-code-access", refresh: "claude-code-refresh", expires: 1_900_000_000_000, source: "claude-code",
  })
  const first = claudeCodeCredentialIdentity()
  writeLogin(directory, "other-account")
  assert.notEqual(claudeCodeCredentialIdentity(), first)
  fs.writeFileSync(path.join(directory, ".credentials.json"), "{ not json")
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token"
  assert.deepEqual(claudeCodeCredential(), { access: "env-token", refresh: null, expires: null, source: "env" })
}))

test("Anthropic sessions use only OpenCode's Anthropic OAuth login", () => withClaudeDir((directory) => {
  writeLogin(directory, "claude-code-access")
  assert.deepEqual(openCodeClaudeCredential({ anthropic: { type: "oauth", access: "opencode-access", refresh: "r", expires: 1_900_000_000_000 } }), {
    access: "opencode-access", refresh: "r", expires: 1_900_000_000_000, source: "opencode",
  })
  // An API-key session has no subscription quota, even with Claude Code signed in.
  assert.equal(openCodeClaudeCredential({ anthropic: { type: "api", key: "console-key" } }), null)
}))
