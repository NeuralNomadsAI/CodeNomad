import type { CredentialEntry } from "@opencode/client"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { AuthEntry, AuthFile } from "./types"
import type { ProviderUsageUnavailableReason } from "../api-types-provider-usage"

// Server-only. The projection holds secrets: never log, cache or return it.
export function projectCredentials(entries: readonly CredentialEntry[]): AuthFile {
  const auth: AuthFile = {}
  for (const entry of entries) {
    if (!entry.active) continue
    const projected = projectCredential(entry)
    // Console can expose both methods as active: OAuth is authoritative even
    // when invalid/expired, so a rejected login never falls back to a key.
    if (projected && !(entry.integrationID === "opencode" &&
      (auth.opencode as AuthEntry | undefined)?.type === "oauth" && projected.type !== "oauth")) {
      auth[entry.integrationID] = projected
    }
  }
  return auth
}

/** One explicit (possibly inactive) credential in the legacy auth.json entry shape. Server-only. */
export function projectCredential(entry: CredentialEntry): AuthEntry | null {
  const value = entry.value
  if (value.type !== "key" && value.type !== "oauth") return null
  const accountId = value.metadata?.accountID
  // OpenCode Console credentials scope requests by organization and server.
  const orgId = value.metadata?.orgID
  const server = value.metadata?.server
  const enterprise = entry.integrationID === "github-copilot" && value.metadata && "enterpriseUrl" in value.metadata
    ? { enterpriseUrl: value.metadata.enterpriseUrl } : {}
  const scope = { ...(typeof orgId === "string" ? { orgId } : {}),
    ...(server !== undefined && entry.integrationID === "opencode" ? { server }
      : typeof server === "string" ? { server } : {}) }
  return value.type === "key"
    ? { type: "api", key: value.key, ...scope }
    : { type: "oauth", methodID: value.methodID, access: value.access, refresh: value.refresh, expires: value.expires,
      // Google refresh/cache identity includes the complete selected native OAuth value.
      ...(entry.integrationID === "google" ? { credentialID: entry.id, metadata: value.metadata } : {}),
      ...(typeof accountId === "string" ? { accountId } : {}), ...scope, ...enterprise }
}

/** Public Console only; never refresh, exchange or write a native credential. */
export function openCodeConsoleCredential(auth: AuthFile, now = Date.now()):
  { headers: Record<string, string> } | { reason: ProviderUsageUnavailableReason; configured: boolean } {
  const raw = auth.opencode
  const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as AuthEntry : null
  const missing = { reason: "opencode-console-missing-credential", configured: false } as const
  const invalid = { reason: "opencode-console-invalid-credential", configured: true } as const
  if (!entry) return missing
  if (entry.type === "oauth") {
    if (entry.server !== "https://opencode.ai/console" || typeof entry.orgId !== "string" ||
      !/^(?:org|wrk)_[A-Za-z0-9]+$/.test(entry.orgId) || typeof entry.access !== "string" || !entry.access.trim() ||
      typeof entry.expires !== "number" || !Number.isFinite(entry.expires) || entry.expires <= now) return invalid
    return { headers: { Authorization: `Bearer ${entry.access}`, "x-org-id": entry.orgId } }
  }
  if (entry.server !== undefined && entry.server !== "https://opencode.ai/console") return invalid
  if (entry.type !== "api" || typeof entry.key !== "string" || !entry.key.trim()) return missing
  return { headers: { Authorization: `Bearer ${entry.key}` } }
}

/** Each integration's selected credential, as the running OpenCode uses it. */
export async function readUsageCredentials(connection: ServiceConnection, signal: AbortSignal): Promise<AuthFile> {
  return projectCredentials(await connection.client.credential.list({ signal }))
}
