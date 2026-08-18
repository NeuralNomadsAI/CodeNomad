import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"

import type { ProviderUsageResponse, ProviderUsageWindow } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"

interface ProviderUsagePanelProps {
  providerId: string
  modelId: string
}

const REFRESH_INTERVAL_MS = 60_000
const usageCache = new Map<string, { value: ProviderUsageResponse | null; updatedAt: number }>()

const ProviderUsagePanel: Component<ProviderUsagePanelProps> = (props) => {
  const { t } = useI18n()
  const source = createMemo(() => {
    const providerId = props.providerId.trim()
    if (!providerId) return null
    const modelId = props.modelId.trim()
    return { providerId, modelId, key: `${providerId}\0${modelId}` }
  })
  const initialSource = source()
  const [usage, setUsage] = createSignal<ProviderUsageResponse | null | undefined>(
    initialSource ? usageCache.get(initialSource.key)?.value : undefined,
  )
  let requestId = 0

  const refreshUsage = async (providerId: string, modelId: string, key: string, clear: boolean) => {
    const currentRequestId = ++requestId
    if (clear) setUsage(undefined)
    try {
      const response = await serverApi.fetchProviderUsage(providerId, modelId)
      usageCache.set(key, { value: response, updatedAt: Date.now() })
      if (currentRequestId === requestId) setUsage(response)
    } catch {
      if (currentRequestId === requestId && usage() === undefined) {
        usageCache.set(key, { value: null, updatedAt: Date.now() })
        setUsage(null)
      }
    }
  }

  createEffect(() => {
    const current = source()
    if (!current) {
      requestId += 1
      setUsage(undefined)
      return
    }
    const cached = usageCache.get(current.key)
    setUsage(cached?.value)
    if (!cached || Date.now() - cached.updatedAt >= REFRESH_INTERVAL_MS) {
      void refreshUsage(current.providerId, current.modelId, current.key, cached === undefined)
    }
  })

  const refreshTimer = setInterval(() => {
    const current = source()
    if (current) void refreshUsage(current.providerId, current.modelId, current.key, false)
  }, REFRESH_INTERVAL_MS)
  onCleanup(() => {
    requestId += 1
    clearInterval(refreshTimer)
  })

  const entries = createMemo(() => Object.entries(usage()?.windows ?? {}))

  const windowLabel = (label: string) => {
    const key = ({
      "5h": "fiveHours",
      "7d": "sevenDays",
      "7d-sonnet": "sevenDaysSonnet",
      "7d-opus": "sevenDaysOpus",
      weekly: "weekly",
      daily: "daily",
      monthly: "monthly",
      credits: "credits",
      billing_cycle: "billingCycle",
      session: "session",
      premium: "premium",
      chat: "chat",
      completions: "completions",
      "mcp-tools": "mcpTools",
    } as Record<string, string>)[label]
    return key ? t(`providerUsage.windows.${key}`) : label
  }

  const displayValue = (window: ProviderUsageWindow) => {
    if (window.valueLabel) return window.valueLabel
    if (window.usedPercent === null) return t("providerUsage.unavailableValue")
    return t("providerUsage.usedPercent", { percent: Math.round(window.usedPercent) })
  }

  const resetLabel = (resetAt: number | null) => {
    if (!resetAt) return null
    const date = new Date(resetAt)
    if (!Number.isFinite(date.getTime())) return null
    return t("providerUsage.resets", { time: date.toLocaleString([], { dateStyle: "short", timeStyle: "short" }) })
  }

  const barColor = (percent: number | null) => {
    if (percent !== null && percent >= 80) return "var(--status-error)"
    if (percent !== null && percent >= 50) return "var(--status-warning)"
    return "var(--status-success)"
  }

  return (
    <div>
      <Show when={usage() !== undefined} fallback={<div class="text-xs text-tertiary">{t("providerUsage.loading")}</div>}>
        <Show when={usage()} fallback={<div class="text-xs text-tertiary">{t("providerUsage.unavailable")}</div>}>
          {(data) => (
            <Show
              when={data().supported && data().configured && data().ok && entries().length > 0}
              fallback={
                <div class="text-xs text-tertiary">
                  {t(
                    !data().supported
                      ? "providerUsage.unsupported"
                      : !data().configured
                        ? "providerUsage.notConfigured"
                        : "providerUsage.unavailable",
                  )}
                </div>
              }
            >
              <div class="space-y-2">
                <For each={entries()}>
                  {([label, window]) => (
                    <div>
                      <div class="mb-1 flex items-baseline justify-between gap-2 text-[11px] text-primary">
                        <span class="font-medium">{windowLabel(label)}</span>
                        <div class="flex min-w-0 items-baseline gap-1.5 text-right">
                          <span class="shrink-0 font-medium">{displayValue(window)}</span>
                          <Show when={resetLabel(window.resetAt)}>
                            {(reset) => (
                              <>
                                <span class="text-tertiary" aria-hidden="true">·</span>
                                <span class="truncate text-[10px] text-tertiary">{reset()}</span>
                              </>
                            )}
                          </Show>
                        </div>
                      </div>
                      <Show when={window.usedPercent !== null}>
                        <div class="h-2 overflow-hidden border border-base" style={{ "background-color": "var(--surface-base)" }}>
                          <div
                            class="h-full transition-[width] duration-300"
                            style={{ width: `${Math.max(0, Math.min(100, window.usedPercent ?? 0))}%`, "background-color": barColor(window.usedPercent) }}
                            role="progressbar"
                            aria-label={t("providerUsage.progressLabel", { window: windowLabel(label) })}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(window.usedPercent ?? 0)}
                          />
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </Show>
      <div class="mt-2 truncate text-right text-sm font-semibold text-secondary">{usage()?.providerName ?? props.providerId}</div>
    </div>
  )
}

export default ProviderUsagePanel
