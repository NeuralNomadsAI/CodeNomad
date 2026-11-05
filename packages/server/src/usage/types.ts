import type { ProviderUsageResponse, ProviderUsageWindow } from "../api-types"

export interface ProviderUsage {
  copilotPlan?: ProviderUsageResponse["copilotPlan"]
  windows: Record<string, ProviderUsageWindow>
  models?: Record<string, { windows: Record<string, ProviderUsageWindow> }>
}

export interface ProviderResult extends Pick<ProviderUsageResponse, "unavailableReason" | "providerErrorCode" | "unavailableAction"> {
  providerId: string
  providerName: string
  ok: boolean
  configured: boolean
  usage: ProviderUsage | null
  fetchedAt: number
  error?: string
  /** Upstream HTTP status of a failed read; server-only, never serialized. */
  status?: number
}

export interface ProviderReadContext {
  signal?: AbortSignal
  /** Effective native settings, server-only; unresolved substitutions are omitted. */
  settings?: { baseURL?: string; apiKey?: string }
  settingsStatus?: "available" | "unavailable" | "unresolved"
}

export interface UsageProvider {
  id: string
  name: string
  aliases: readonly string[]
  /** `auth` holds each integration's selected credential in the legacy auth.json entry shape. */
  fetchQuota: (auth: AuthFile, context?: ProviderReadContext) => Promise<ProviderResult>
}

export type AuthEntry = Record<string, unknown>
export type AuthFile = Record<string, unknown>
