import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { authClaudeCredential, claudeCodeCredential, claudeCodeSecureStorage, type ClaudeCodeHost } from "./claude-credential"

// A posix daemon host (e.g. a WSL distro) whose paths map into a temp directory.
async function withHost(run: (host: ClaudeCodeHost, root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-claude-host-"))
  const host: ClaudeCodeHost = {
    environment: { HOME: "/home/dev" },
    pathStyle: "posix",
    keychain: false,
    toHostPath: async servicePath => path.join(root, ...servicePath.split("/").filter(Boolean)),
  }
  try { await run(host, root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

function writeLogin(root: string, directory: string, accessToken: string) {
  const target = path.join(root, ...directory.split("/").filter(Boolean))
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: "claude-code-refresh", expiresAt: 1_900_000_000_000 },
    mcpOAuth: { other: { accessToken: "unrelated" } },
  }))
}

test("reads the daemon host's Claude Code login, not the backend's home", () => withHost(async (host, root) => {
  assert.equal(await claudeCodeCredential(host), null)
  writeLogin(root, "/home/dev/.claude", "distro-login")
  assert.deepEqual(await claudeCodeCredential(host), {
    access: "distro-login", refresh: "claude-code-refresh", expires: 1_900_000_000_000, source: "claude-code",
  })
}))

test("follows Claude Code's precedence and the host's profile variables", () => withHost(async (host, root) => {
  writeLogin(root, "/home/dev/.claude", "default-login")
  writeLogin(root, "/srv/claude", "configured-login")
  host.environment.CLAUDE_CONFIG_DIR = "/srv/claude"
  assert.equal((await claudeCodeCredential(host))?.access, "configured-login")
  // CLAUDE_CODE_OAUTH_TOKEN outranks the stored /login record, as in Claude Code.
  host.environment.CLAUDE_CODE_OAUTH_TOKEN = "env-token"
  assert.deepEqual(await claudeCodeCredential(host), { access: "env-token", refresh: null, expires: null, source: "env" })
}))

test("names the macOS Keychain item like Claude Code for custom config directories", () => withHost(async (host) => {
  assert.deepEqual(claudeCodeSecureStorage(host), { directory: "/home/dev/.claude", keychainService: "Claude Code-credentials" })
  host.environment.CLAUDE_CONFIG_DIR = "/srv/claude"
  const digest = createHash("sha256").update("/srv/claude").digest("hex").slice(0, 8)
  assert.deepEqual(claudeCodeSecureStorage(host), { directory: "/srv/claude", keychainService: `Claude Code-credentials-${digest}` })
  host.environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = ""
  assert.deepEqual(claudeCodeSecureStorage(host), { directory: "/home/dev/.claude", keychainService: "Claude Code-credentials" })
}))

test("Anthropic sessions use only OpenCode's Anthropic OAuth login", () => {
  assert.deepEqual(authClaudeCredential({ anthropic: { type: "oauth", access: "opencode-access", refresh: "r", expires: 1_900_000_000_000 } }, ["anthropic"]), {
    access: "opencode-access", refresh: "r", expires: 1_900_000_000_000, source: "opencode",
  })
  // An API-key session has no subscription quota.
  assert.equal(authClaudeCredential({ anthropic: { type: "api", key: "console-key" } }, ["anthropic"]), null)
})
