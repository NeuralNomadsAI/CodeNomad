import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

import type { AuthFile } from "./types"
import { asObject, getOAuthEntry, getString, toTimestamp } from "./shared"

// Server-only. Never log, cache or return this object over HTTP.
export interface ClaudeCredential {
  access: string
  refresh: string | null
  expires: number | null
  source: "keychain" | "claude-code" | "opencode" | "env"
}

const KEYCHAIN_SERVICE = "Claude Code-credentials"

// Claude Code stores its own OAuth tokens beside unrelated MCP tokens; only
// `claudeAiOauth` is read.
function parseClaudeCode(blob: unknown, source: ClaudeCredential["source"]): ClaudeCredential | null {
  const oauth = asObject(asObject(blob)?.claudeAiOauth)
  const access = getString(oauth?.accessToken)
  if (!access) return null
  return { access, refresh: getString(oauth?.refreshToken), expires: toTimestamp(oauth?.expiresAt), source }
}

function readKeychain(): ClaudeCredential | null {
  // The default Keychain item belongs to the default configuration directory;
  // an explicit CLAUDE_CONFIG_DIR is read from its own credentials file.
  if (process.platform !== "darwin" || getString(process.env.CLAUDE_CONFIG_DIR)) return null
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
    })
    return parseClaudeCode(JSON.parse(raw.trim()), "keychain")
  } catch {
    return null
  }
}

function readClaudeCodeFile(): ClaudeCredential | null {
  const directory = getString(process.env.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), ".claude")
  try {
    return parseClaudeCode(JSON.parse(fs.readFileSync(path.join(directory, ".credentials.json"), "utf8")), "claude-code")
  } catch {
    return null
  }
}

/**
 * Read-only, fresh on every call: Claude Code rotates these records whenever it
 * refreshes. The macOS Keychain wins because the file there is a stale leftover.
 * OpenCode's own Anthropic OAuth login is the fallback.
 */
export function findClaudeCredential(auth: AuthFile): ClaudeCredential | null {
  const fromClaudeCode = readKeychain() ?? readClaudeCodeFile()
  if (fromClaudeCode) return fromClaudeCode
  const entry = getOAuthEntry(auth, ["anthropic", "claude", "claude-code"])
  const access = getString(entry?.access) ?? getString(entry?.token)
  if (access) return { access, refresh: getString(entry?.refresh), expires: toTimestamp(entry?.expires), source: "opencode" }
  const env = getString(process.env.CLAUDE_CODE_OAUTH_TOKEN)
  return env ? { access: env, refresh: null, expires: null, source: "env" } : null
}
