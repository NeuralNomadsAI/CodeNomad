export type ProviderUsageUnavailableReason = "openai-token-sharing-unsupported"
  | "opencode-console-missing-credential"
  | "opencode-console-access-denied"
  | "opencode-console-invalid-credential"
  | "opencode-console-invalid-response"
  | "opencode-console-network-error"

export interface OpenCodeConsoleUsage {
  requests: Record<"24h" | "7d" | "30d", number>
  models: Array<{ provider: string; model: string; requests: number }>
  budgets: {
    status: "available" | "unavailable"
    items: Array<{ id: string; name: string; spentUsd: number; limitUsd: number; resetAt: number }>
  }
}
