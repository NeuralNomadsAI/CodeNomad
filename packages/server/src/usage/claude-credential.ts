import { execFile } from "child_process"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { promisify } from "util"

import type { AuthEntry, AuthFile } from "./types"
import { asObject, getOAuthEntry, getString, toTimestamp } from "./shared"

const execute = promisify(execFile)

// Server-only. Never log, cache or return this object over HTTP.
export interface ClaudeCredential {
  access: string
  refresh: string | null
  expires: number | null
  source: "keychain" | "claude-code" | "opencode" | "env"
}

/** The host the OpenCode daemon, and therefore opencode-claude's Claude Code, runs on. */
export interface ClaudeCodeHost {
  /** The daemon host's environment, including CodeNomad profile variables. */
  environment: Record<string, string | undefined>
  /** Path style of that host; WSL daemons are posix even on a Windows backend. */
  pathStyle: "posix" | "win32"
  /** Only a local macOS daemon shares the backend's login Keychain. */
  keychain: boolean
  /** Translates a daemon-host path for local filesystem access. */
  toHostPath(servicePath: string): Promise<string | undefined>
}

// Claude Code stores its own OAuth tokens beside unrelated MCP tokens; only
// `claudeAiOauth` is read.
function parseClaudeCode(blob: unknown, source: ClaudeCredential["source"]): ClaudeCredential | null {
  const oauth = asObject(asObject(blob)?.claudeAiOauth)
  const access = getString(oauth?.accessToken)
  if (!access) return null
  return { access, refresh: getString(oauth?.refreshToken), expires: toTimestamp(oauth?.expiresAt), source }
}

/**
 * Claude Code's secure-storage directory and Keychain item, mirroring Claude
 * Code 2.1: CLAUDE_SECURESTORAGE_CONFIG_DIR wins over CLAUDE_CONFIG_DIR, and a
 * non-default directory suffixes the Keychain item with its digest.
 */
export function claudeCodeSecureStorage(host: ClaudeCodeHost): { directory: string; keychainService: string } | null {
  const env = host.environment
  const join = host.pathStyle === "posix" ? path.posix.join : path.win32.join
  const home = getString(host.pathStyle === "posix" ? env.HOME : env.USERPROFILE ?? env.HOME)
  const fallback = home ? join(home, ".claude") : null
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  const configured = secure !== undefined ? secure : env.CLAUDE_CONFIG_DIR
  const directory = (secure !== undefined ? secure || fallback : configured || fallback)?.normalize("NFC")
  if (!directory) return null
  const isDefault = secure !== undefined ? !secure : !env.CLAUDE_CONFIG_DIR
  const suffix = isDefault ? "" : `-${createHash("sha256").update(directory).digest("hex").slice(0, 8)}`
  return { directory, keychainService: `Claude Code-credentials${suffix}` }
}

async function readKeychain(service: string, signal?: AbortSignal): Promise<ClaudeCredential | null> {
  try {
    const { stdout } = await execute("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8", timeout: 10_000, signal,
    })
    return parseClaudeCode(JSON.parse(stdout.trim()), "keychain")
  } catch {
    return null
  }
}

async function readCredentialsFile(host: ClaudeCodeHost, directory: string): Promise<ClaudeCredential | null> {
  const join = host.pathStyle === "posix" ? path.posix.join : path.win32.join
  try {
    const file = await host.toHostPath(join(directory, ".credentials.json"))
    return file ? parseClaudeCode(JSON.parse(await fs.readFile(file, "utf8")), "claude-code") : null
  } catch {
    return null
  }
}

/**
 * The login opencode-claude's Claude Code uses on the daemon host, in Claude
 * Code's own order: CLAUDE_CODE_OAUTH_TOKEN, then its stored /login record.
 * Read-only and fresh on every call, since Claude Code rotates the record.
 */
export async function claudeCodeCredential(host: ClaudeCodeHost, signal?: AbortSignal): Promise<ClaudeCredential | null> {
  const env = getString(host.environment.CLAUDE_CODE_OAUTH_TOKEN)
  if (env) return { access: env, refresh: null, expires: null, source: "env" }
  const storage = claudeCodeSecureStorage(host)
  if (!storage) return null
  return (host.keychain ? await readKeychain(storage.keychainService, signal) : null)
    ?? await readCredentialsFile(host, storage.directory)
}

/** The auth entry the `claude-code` usage provider reads; the route supplies it. */
export function claudeCodeAuthEntry(credential: ClaudeCredential | null): AuthEntry | undefined {
  return credential ? { type: "oauth", access: credential.access, refresh: credential.refresh, expires: credential.expires } : undefined
}

/** A Claude OAuth entry from the projected credentials: OpenCode's Anthropic login, or the route-supplied `claude-code` entry. */
export function authClaudeCredential(auth: AuthFile, aliases: readonly string[]): ClaudeCredential | null {
  const entry = getOAuthEntry(auth, aliases)
  const access = getString(entry?.access) ?? getString(entry?.token)
  return access ? { access, refresh: getString(entry?.refresh), expires: toTimestamp(entry?.expires), source: "opencode" } : null
}
