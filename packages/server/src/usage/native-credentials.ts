import { ClientError, type CredentialEntry } from "@opencode/client"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { AuthFile } from "./types"
import { readOpenCodeAuth } from "./shared"

// Server-only. The projection holds secrets: never log, cache or return it.
export function projectCredentials(entries: readonly CredentialEntry[]): AuthFile {
  const auth: AuthFile = {}
  for (const entry of entries) {
    if (!entry.active) continue
    const value = entry.value
    const accountId = value.metadata?.accountID
    auth[entry.integrationID] = value.type === "key"
      ? { type: "api", key: value.key }
      : { type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires,
        ...(typeof accountId === "string" ? { accountId } : {}) }
  }
  return auth
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
