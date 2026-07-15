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
  fetchQuota: () => Promise<ProviderResult>
}

export type AuthEntry = Record<string, unknown>
export type AuthFile = Record<string, unknown>
