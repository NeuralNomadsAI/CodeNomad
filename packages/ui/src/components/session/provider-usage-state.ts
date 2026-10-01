import type { ProviderUsageResponse } from "../../../../server/src/api-types"

export interface ProviderUsageSource {
  instanceId: string
  sessionId: string
  directory: string
  providerId: string
  modelId: string
}

export const providerUsageKey = (source: ProviderUsageSource) => JSON.stringify([
  source.instanceId, source.sessionId, source.directory, source.providerId, source.modelId,
])

export const shouldShowProviderUsageWindow = (label: string, showCreditBalance: boolean) =>
  label !== "credits_balance" || showCreditBalance

// The display snapshot is local to the mounted panel. Do not restore a global
// browser cache before the server can revalidate the native selected account.
export function createProviderUsageState(
  fetchUsage: (source: ProviderUsageSource) => Promise<ProviderUsageResponse>,
  publish: (value: ProviderUsageResponse | null | undefined) => void,
) {
  let current: ProviderUsageSource | null = null
  let generation = 0
  const invalidate = () => { generation++; publish(undefined) }
  return {
    select(source: ProviderUsageSource | null) {
      if (source && current && providerUsageKey(source) === providerUsageKey(current)) return
      current = source
      invalidate()
    },
    invalidate,
    async refresh() {
      const source = current
      if (!source) return
      const request = ++generation
      try {
        const value = await fetchUsage(source)
        if (generation === request) publish(value)
      } catch {
        if (generation === request) publish(null)
      }
    },
    dispose() { current = null; generation++ },
  }
}
