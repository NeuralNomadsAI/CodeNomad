import { ClientError, type CredentialEntry } from "@opencode/client"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { AuthEntry, AuthFile } from "./types"
import { readOpenCodeAuth } from "./shared"

// Server-only. The projection holds secrets: never log, cache or return it.
export function projectCredentials(entries: readonly CredentialEntry[]): AuthFile {
  const auth: AuthFile = {}
  for (const entry of entries) {
    if (!entry.active) continue
    const projected = projectCredential(entry)
    if (projected) auth[entry.integrationID] = projected
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
  const scope = { ...(typeof orgId === "string" ? { orgId } : {}), ...(typeof server === "string" ? { server } : {}) }
  return value.type === "key"
    ? { type: "api", key: value.key, ...scope }
    : { type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires,
      ...(typeof accountId === "string" ? { accountId } : {}), ...scope }
}

/**
 * Each integration's selected credential, as the running OpenCode uses it.
 * Daemons before 2.0.20 lack `credential.list`; only then is the legacy
 * auth.json read, preserving the previous behaviour for them.
 */
export async function readUsageCredentials(connection: ServiceConnection, signal: AbortSignal): Promise<AuthFile> {
  try {
    return projectCredentials(await connection.client.credential.list({ signal }))
  } catch (error) {
    if (isCredentialApiMissing(error)) return readOpenCodeAuth()
    throw error
  }
}

export function isCredentialApiMissing(error: unknown): boolean {
  return error instanceof ClientError && error.reason === "UnexpectedStatus"
    && "cause" in error && typeof error.cause === "object" && error.cause !== null
    && "status" in error.cause && error.cause.status === 404
}
