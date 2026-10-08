import type { ProviderUsageWindow } from "../api-types"

export interface ProviderUsage {
  windows: Record<string, ProviderUsageWindow>
  models?: Record<string, { windows: Record<string, ProviderUsageWindow> }>
}

export interface ProviderResult {
  providerId: string
  providerName: string
  ok: boolean
  configured: boolean
  usage: ProviderUsage | null
  fetchedAt: number
  error?: string
}

export interface UsageProvider {
  id: string
  name: string
  aliases: readonly string[]
  /** `auth` holds each integration's selected credential in the legacy auth.json entry shape. */
  fetchQuota: (auth: AuthFile) => Promise<ProviderResult>
  /** Digest of credentials read outside OpenCode, joined to the snapshot cache identity. */
  identity?: () => string | null
}

export type AuthEntry = Record<string, unknown>
export type AuthFile = Record<string, unknown>
