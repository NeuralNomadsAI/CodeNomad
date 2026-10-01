import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"

import type { ProviderUsageResponse, ProviderUsageWindow } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import { useConfig } from "../../stores/preferences"
import { serverEvents } from "../../lib/server-events"
import { createProviderUsageState, providerUsageKey, shouldShowProviderUsageWindow, type ProviderUsageSource } from "./provider-usage-state"

interface ProviderUsagePanelProps {
  instanceId: string
  sessionId: string
  directory: string
  active: boolean
  providerId: string
  modelId: string
}

const REFRESH_INTERVAL_MS = 60_000

const ProviderUsagePanel: Component<ProviderUsagePanelProps> = (props) => {
  const { t } = useI18n()
  const { preferences } = useConfig()
  const source = createMemo<ProviderUsageSource | null>(() => {
    if (!props.active) return null
    const providerId = props.providerId.trim()
    if (!providerId) return null
    const modelId = props.modelId.trim()
    return { instanceId: props.instanceId, sessionId: props.sessionId, directory: props.directory, providerId, modelId }
  }, null, { equals: (a, b) => a === b || Boolean(a && b && providerUsageKey(a) === providerUsageKey(b)) })
  const [usage, setUsage] = createSignal<ProviderUsageResponse | null | undefined>()
  const state = createProviderUsageState(current => serverApi.fetchProviderUsage(
    current.instanceId, current.sessionId, current.providerId, current.modelId,
  ), value => setUsage(value))

  createEffect(() => {
    state.select(source())
    void state.refresh()
  })

  const revalidate = () => { state.invalidate(); if (source()) void state.refresh() }
  const unsubscribeEvents = serverEvents.on("instance.event", event => {
    if (event.type !== "instance.event" || event.instanceId !== props.instanceId) return
    if (event.event.type === "provider.updated") {
      // Catalogue churn is not a credential switch. Revalidate in place only
      // for this native location; account/config/connection boundaries below
      // still revoke the display immediately and fence pending reads.
      if (source() && (!event.event.location || event.event.location.directory === props.directory)) void state.refresh()
    } else if (["credential.updated", "credential.switched", "integration.updated", "config.updated", "server.connected"].includes(event.event.type)) revalidate()
  })
  const unsubscribeStatus = serverEvents.on("instance.eventStatus", event => {
    if (event.type !== "instance.eventStatus" || event.instanceId !== props.instanceId) return
    state.invalidate()
    if (event.status === "connected" && source()) void state.refresh()
  })
  const unsubscribeTransport = serverEvents.onTransportStatus(status => {
    state.invalidate()
    if (status === "connected" && source()) void state.refresh()
  })
  const refreshTimer = setInterval(() => { if (source()) void state.refresh() }, REFRESH_INTERVAL_MS)
  onCleanup(() => {
    state.dispose()
    clearInterval(refreshTimer)
    unsubscribeEvents()
    unsubscribeStatus()
    unsubscribeTransport()
  })

  const entries = createMemo(() => Object.entries(usage()?.windows ?? {}))
  const displayedLabels = createMemo(() =>
    entries().map(([label]) => label).filter(label => shouldShowProviderUsageWindow(label, preferences().showProviderUsageCreditBalance)),
  )

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
      credits_balance: "credits",
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
      <Show when={usage() !== undefined} fallback={<div class="right-panel-empty-text">{t("providerUsage.loading")}</div>}>
        <Show when={usage()} fallback={<div class="right-panel-empty-text">{t("providerUsage.unavailable")}</div>}>
          {(data) => (
            <Show
              when={data().supported && data().configured && data().ok && entries().length > 0}
              fallback={
                <div class="right-panel-empty-text">
                  {t(
                    !data().supported
                      ? "providerUsage.unsupported"
                      : !data().configured
                        ? "providerUsage.notConfigured"
                        : data().unavailableReason === "native-credential-api-unavailable"
                          ? "providerUsage.nativeCredentialApiUnavailable"
                          : "providerUsage.unavailable",
                    { version: "2.0.20" },
                  )}
                </div>
              }
            >
              <div class="space-y-2">
                <For each={displayedLabels()}>
                  {(label) => {
                    // Retain this row's value until For reconciles a removed
                    // label; its effects must not read an absent window.
                    const window = createMemo<ProviderUsageWindow>(previous => usage()?.windows[label] ?? previous, usage()!.windows[label])
                    return (
                      <div>
                        <div class="mb-1 flex items-baseline justify-between gap-2 text-[11px] text-primary">
                          <span class="font-medium">{windowLabel(label)}</span>
                          <div class="flex min-w-0 items-baseline gap-1.5 text-right">
                            <span class="shrink-0 font-medium">{displayValue(window())}</span>
                            <Show when={resetLabel(window().resetAt)}>
                              {(reset) => (
                                <>
                                  <span class="text-tertiary" aria-hidden="true">·</span>
                                  <span class="truncate text-[10px] text-tertiary">{reset()}</span>
                                </>
                              )}
                            </Show>
                          </div>
                        </div>
                        <Show when={window().usedPercent !== null}>
                          <div class="h-2 overflow-hidden border border-base" style={{ "background-color": "var(--surface-base)" }}>
                            <div
                              class="h-full transition-[width] duration-300"
                              style={{ width: `${Math.max(0, Math.min(100, window().usedPercent ?? 0))}%`, "background-color": barColor(window().usedPercent) }}
                              role="progressbar"
                              aria-label={t("providerUsage.progressLabel", { window: windowLabel(label) })}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={Math.round(window().usedPercent ?? 0)}
                            />
                          </div>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </Show>
      <Show when={usage()?.supported && usage()?.configured && usage()?.ok && entries().length > 0}>
        <div class="mt-2 truncate text-right text-sm font-semibold text-secondary">{usage()?.providerName ?? props.providerId}</div>
      </Show>
    </div>
  )
}

export default ProviderUsagePanel
