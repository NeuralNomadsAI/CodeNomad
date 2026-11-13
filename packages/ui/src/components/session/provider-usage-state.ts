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

export const isFreeUsageSource = (source: ProviderUsageSource | null) => {
  const model = source?.modelId.trim().toLowerCase()
  return source?.providerId.trim().toLowerCase() === "opencode" && Boolean(model && (model === "big-pickle" || model.endsWith("-free")))
}

export const nextUtcMidnight = (now: number) => {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}

// The display snapshot is local to the mounted panel. Do not restore a global
// browser cache before the server can revalidate the native selected account.
export function createProviderUsageState(
  fetchUsage: (source: ProviderUsageSource, signal?: AbortSignal) => Promise<ProviderUsageResponse>,
  publish: (value: ProviderUsageResponse | null | undefined) => void,
  now = Date.now,
  capture?: (source: ProviderUsageSource) => { signal: AbortSignal; current: () => boolean },
) {
  let current: ProviderUsageSource | null = null
  let generation = 0
  let controller: AbortController | undefined
  let running: { generation: number; again: boolean; promise: Promise<void> } | null = null
  const invalidate = () => { controller?.abort(); controller = undefined; generation++; running = null; publish(undefined) }
  let day = Math.floor(now() / 86_400_000)
  const expireUtcDay = () => {
    const today = Math.floor(now() / 86_400_000)
    if (day === today) return
    day = today
    if (isFreeUsageSource(current)) publish(undefined)
  }
  const refresh = (): Promise<void> => {
    const source = current
    if (!source) return Promise.resolve()
    expireUtcDay()
    if (running) {
      running.again = true
      return running.promise
    }
    const requestController = controller = new AbortController()
    const operation = capture?.(source)
    const signal = operation ? AbortSignal.any([requestController.signal, operation.signal]) : requestController.signal
    if (signal.aborted || operation && !operation.current()) return Promise.resolve()
    const request = { generation, again: false, promise: Promise.resolve() }
    running = request
    request.promise = (async () => {
      try {
        do {
          request.again = false
          const requestDay = day
          try {
            const value = await fetchUsage(source, signal)
            if (!signal.aborted && generation === request.generation && (!operation || operation.current())) {
              expireUtcDay()
              if (isFreeUsageSource(source) && requestDay !== day) request.again = true
              else if (!(value.freeEstimate && value.windows.daily?.resetAt && value.windows.daily.resetAt <= now())) publish(value)
            }
          } catch {
            if (!signal.aborted && generation === request.generation && (!operation || operation.current())) publish(null)
          }
        } while (request.again && !signal.aborted && generation === request.generation && (!operation || operation.current()))
      } finally {
        if (running === request) running = null
        if (controller === requestController) controller = undefined
      }
    })()
    return request.promise
  }
  return {
    select(source: ProviderUsageSource | null) {
      if (source && current && providerUsageKey(source) === providerUsageKey(current)) return
      current = source
      invalidate()
    },
    invalidate,
    expireUtcDay,
    refresh,
    dispose() { controller?.abort(); controller = undefined; current = null; generation++; running = null },
  }
}
