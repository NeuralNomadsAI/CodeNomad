import { For, Show, createMemo, createResource, onCleanup, type Component } from "solid-js"

import type { ProviderUsageWindow } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"

interface ProviderUsagePanelProps {
  providerId: string
  modelId: string
}

const REFRESH_INTERVAL_MS = 60_000

const ProviderUsagePanel: Component<ProviderUsagePanelProps> = (props) => {
  const { t } = useI18n()
  const source = createMemo(() => {
    const providerId = props.providerId.trim()
    if (!providerId) return null
    return { providerId, modelId: props.modelId.trim() }
  })
  const [usage, { refetch }] = createResource(source, ({ providerId, modelId }) => serverApi.fetchProviderUsage(providerId, modelId))

  const refreshTimer = setInterval(() => {
    if (source()) void refetch()
  }, REFRESH_INTERVAL_MS)
  onCleanup(() => clearInterval(refreshTimer))

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
      credits_balance: "creditsBalance",
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
      <div class="mb-2 flex justify-end text-xs">
        <Show when={usage()?.providerName} fallback={<span class="text-secondary">{props.providerId}</span>}>
          {(name) => <span class="truncate text-secondary">{name()}</span>}
        </Show>
      </div>

      <Show when={!usage.loading} fallback={<div class="text-xs text-tertiary">{t("providerUsage.loading")}</div>}>
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
              <div class="space-y-2.5">
                <For each={entries()}>
                  {([label, window]) => (
                    <div>
                      <div class="mb-1 flex items-start justify-between gap-2 text-xs">
                        <span class="font-medium text-primary">{windowLabel(label)}</span>
                        <div class="text-right">
                          <div class="font-semibold text-primary">{displayValue(window)}</div>
                          <Show when={resetLabel(window.resetAt)}>{(reset) => <div class="text-[10px] text-tertiary">{reset()}</div>}</Show>
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
    </div>
  )
}

export default ProviderUsagePanel
