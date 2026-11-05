import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"

import type { ProviderUsageResponse, ProviderUsageWindow } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import { openExternalUrl } from "../../lib/external-url"
import { useConfig } from "../../stores/preferences"
import { openSettings } from "../../stores/settings-screen"
import { InfoPopoverButton } from "../info-popover-button"
import { ProviderUsageConsole } from "./provider-usage-console"
import { serverEvents } from "../../lib/server-events"
import { createProviderUsageState, isFreeUsageSource, nextUtcMidnight, providerUsageKey, shouldShowProviderUsageWindow, type ProviderUsageSource } from "./provider-usage-state"

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
  const { t, locale } = useI18n()
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
    } else if (event.event.type === "session.step.failed" && isFreeUsageSource(source()) &&
      (!event.event.location || event.event.location.directory === props.directory) &&
      (event.event.data as { error?: { type?: string } } | undefined)?.error?.type === "provider.quota") {
      void state.refresh()
    } else if (["credential.updated", "credential.switched", "integration.updated", "config.updated", "server.connected"].includes(event.event.type)) revalidate()
  })
  let lastInstanceStatus: string | undefined
  let lastTransportStatus: string | undefined
  const unsubscribeStatus = serverEvents.on("instance.eventStatus", event => {
    if (event.type !== "instance.eventStatus" || event.instanceId !== props.instanceId) return
    // Repeated status snapshots are not reconnects. Include the native stream
    // generation so a new connection still fences quotas if its loss was missed.
    const key = JSON.stringify([event.instanceId, event.status, event.generation])
    if (key === lastInstanceStatus) return
    lastInstanceStatus = key
    state.invalidate()
    if (event.status === "connected" && source()) void state.refresh()
  })
  const unsubscribeTransport = serverEvents.onTransportStatus(status => {
    if (status === lastTransportStatus) return
    lastTransportStatus = status
    state.invalidate()
    if (status === "connected" && source()) void state.refresh()
  })
  const refreshTimer = setInterval(() => { if (source()) void state.refresh() }, REFRESH_INTERVAL_MS)
  createEffect(() => {
    if (!isFreeUsageSource(source())) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      timer = setTimeout(() => { state.expireUtcDay(); void state.refresh(); schedule() }, nextUtcMidnight(Date.now()) - Date.now())
    }
    schedule()
    onCleanup(() => clearTimeout(timer))
  })
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
  const hasReadings = createMemo(() => displayedLabels().length > 0 || Boolean(usage()?.console))
  const unavailableMessage = createMemo(() => {
    const data = usage()
    const consoleMessage = data ? consoleError(data) : undefined
    if (consoleMessage) return t(consoleMessage)
    if (data?.unavailableReason === "openai-token-sharing-unsupported") return t("providerUsage.openaiTokenSharingUnsupported")
    if (data?.unavailableReason === "opencode-go-key-expired") return t("providerUsage.openCodeGoKeyExpired")
    if (data?.unavailableReason === "minimax-limits-not-shared") return t("providerUsage.minimaxLimitsNotShared")
    if (data?.unavailableReason === "invalid-base-url") return t("providerUsage.invalidBaseURL")
    if (data?.unavailableReason === "cursor-token-expired") return t("providerUsage.cursorTokenExpired")
    if (data?.unavailableReason === "cursor-team-unavailable") return t("providerUsage.cursorTeamUnavailable")
    if (data?.unavailableReason === "cursor-access-denied") return t("providerUsage.cursorAccessDenied")
    if (data?.unavailableReason === "cursor-usage-unavailable") return t("providerUsage.cursorUsageUnavailable")
    if (data?.unavailableReason === "provider-error") return data.providerErrorCode && /^\d{1,8}$/.test(data.providerErrorCode) && data.providerErrorCode.trim() === data.providerErrorCode
      ? t("providerUsage.providerErrorCode", { code: data.providerErrorCode }) : t("providerUsage.unavailable")
    return null
  })
  // Destinations and labels belong to the UI, never to upstream response text.
  const unavailableLink = createMemo(() => usage()?.unavailableReason === "openai-token-sharing-unsupported"
    && usage()?.unavailableAction === "chatgpt-usage"
    ? { href: "https://chatgpt.com/settings/usage", label: t("providerUsage.viewChatGPTUsage") }
    : usage()?.unavailableReason === "opencode-go-key-expired" && usage()?.unavailableAction === "opencode-go-new-key"
      ? { href: "https://opencode.ai/console/login", label: t("providerUsage.createOpenCodeGoKey") } : null)

  const windowLabel = (label: string): string => {
    // Model-scoped limits arrive as `window:Model`, e.g. `requests:gemini-2.5-pro` or `7d:Opus`.
    const scope = label.indexOf(":")
    if (scope > 0) return `${windowLabel(label.slice(0, scope))} · ${label.slice(scope + 1)}`
    const key = ({
      "5h": "fiveHours",
      "7d": "sevenDays",
      "7d-sonnet": "sevenDaysSonnet",
      "7d-opus": "sevenDaysOpus",
      weekly: "weekly",
      daily: "daily",
      monthly: "monthly",
      tokens: "tokens",
      input_tokens: "inputTokens",
      output_tokens: "outputTokens",
      usage: "usage",
      "monthly-code": "monthlyCode",
      credits: "credits",
      key_limit: "keyLimit",
      per_user_limit: "perUserLimit",
      team_limit: "teamLimit",
      requests: "requests",
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

  const usedValue = (key: string, value: string) => {
    const [before, after] = t(key).split("{used}")
    return <>{before}<bdi dir="ltr">{value}</bdi>{after}</>
  }

  const displayValue = (window: ProviderUsageWindow) => {
    const consumption = window.consumption
    const number = new Intl.NumberFormat(locale(), { maximumFractionDigits: 8 })
    const estimate = usage()?.freeEstimate
    if (estimate) return estimate.requests === null ? t("providerUsage.unavailableValue")
      : <bdi dir="ltr">{number.format(estimate.requests)} / {number.format(estimate.reference)}</bdi>
    if (consumption && "used" in consumption) return usedValue("providerUsage.usedCountOnly", consumption.limit === undefined
      ? number.format(consumption.used) : `${number.format(consumption.used)} / ${number.format(consumption.limit)}`)
    if (consumption && "creditsUsed" in consumption) return usedValue("providerUsage.creditsUsed", number.format(consumption.creditsUsed))
    if (consumption && "unlimited" in consumption) return t("providerUsage.unlimited")
    if (window.limitUSD !== undefined) return <bdi dir="ltr">{new Intl.NumberFormat(locale(), { style: "currency", currency: "USD" }).format(window.limitUSD)}</bdi>
    if (window.balanceUSD) {
      const money = new Intl.NumberFormat(locale(), { style: "currency", currency: "USD" })
      // Currency formatters may include RTL marks; isolate each amount as well as the ratio.
      return <bdi dir="ltr"><bdi dir="ltr">{money.format(window.balanceUSD.remaining)}</bdi>
        <Show when={window.balanceUSD.total !== undefined}>{" / "}<bdi dir="ltr">{money.format(window.balanceUSD.total!)}</bdi></Show>
      </bdi>
    }
    if (window.valueLabel) return <bdi dir="ltr">{window.valueLabel}</bdi>
    if (window.usedPercent === null) return t("providerUsage.unavailableValue")
    return t("providerUsage.usedPercent", { percent: new Intl.NumberFormat(locale()).format(Math.round(window.usedPercent)) })
  }

  const resetLabel = (resetAt: number | null) => {
    if (!resetAt) return null
    const date = new Date(resetAt)
    if (!Number.isFinite(date.getTime())) return null
    const estimated = usage()?.estimated
    const time = date.toLocaleString(locale(), { dateStyle: "short", timeStyle: "short", ...(estimated ? { timeZone: "UTC" } : {}) })
    return t(estimated ? "providerUsage.estimatedReset" : "providerUsage.resets", { time: estimated ? `${time} UTC` : time })
  }

  const barColor = (percent: number | null) => {
    if (percent !== null && percent >= 80) return "var(--status-error)"
    if (percent !== null && percent >= 50) return "var(--status-warning)"
    return "var(--status-success)"
  }

  return (
    <div>
      <Show when={usage() !== undefined} fallback={<div role="status" class="right-panel-empty-text">{t("providerUsage.loading")}</div>}>
        <Show when={usage()} fallback={<div role="status" class="right-panel-empty-text">{t("providerUsage.unavailable")}</div>}>
          {(data) => (
            <Show
              when={data().supported && data().configured && data().ok && !unavailableMessage() && hasReadings()}
              fallback={
                <Show when={unavailableMessage()} fallback={<div role="status" class="right-panel-empty-text">
                  {t(
                    !data().supported
                      ? "providerUsage.unsupported"
                      : !data().configured
                        ? "providerUsage.notConfigured"
                        : "providerUsage.unavailable",
                  )}
                </div>}>
                  {message => <div role="status" class="space-y-2 border border-base bg-surface-inset p-2 text-xs text-primary">
                    <div>{message()}</div>
                    <Show when={unavailableLink()}>{link => <a href={link().href} target="_blank" rel="noopener noreferrer"
                      class="text-accent underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]"
                      onClick={event => { event.preventDefault(); void openExternalUrl(link().href, "provider-usage") }}>
                      {link().label}
                    </a>}</Show>
                    <Show when={["opencode-console-missing-credential", "opencode-console-access-denied", "opencode-console-invalid-credential"].includes(data().unavailableReason ?? "")}>
                      <button type="button" class="window-action mt-1" onClick={() => void openSettings("providers")}>{t("providerUsage.console.settings")}</button>
                    </Show>
                  </div>}
                </Show>
              }
            >
              <div class="space-y-2">
                <Show when={data().console}>{console => <ProviderUsageConsole usage={console()} />}</Show>
                <Show when={data().estimated}>
                  <div class="flex items-center gap-1 text-[10px] text-tertiary">
                    <span>{t("providerUsage.estimated")}</span>
                    <InfoPopoverButton label={t("providerUsage.estimated")}>{t("providerUsage.estimateInfo")}</InfoPopoverButton>
                    <Show when={data().freeEstimate?.exhausted}><span role="status" class="font-medium text-primary">{t("providerUsage.exhausted")}</span></Show>
                  </div>
                </Show>
                <For each={displayedLabels()}>
                  {(label) => {
                    // Retain this row's value until For reconciles a removed
                    // label; its effects must not read an absent window.
                    const window = createMemo<ProviderUsageWindow>(previous => usage()?.windows[label] ?? previous, usage()!.windows[label])
                    const usedPercent = () => label === "daily" && usage()?.freeEstimate?.exhausted ? 100 : window().usedPercent
                    return (
                      <div>
                        <div class="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-[11px] text-primary">
                          <span class="max-w-full shrink-0 font-medium">{windowLabel(label)}</span>
                          <div class="ms-auto flex min-w-0 max-w-full flex-wrap items-baseline justify-end gap-1.5 text-end">
                            <span class="min-w-0 font-medium [overflow-wrap:anywhere]">{displayValue(window())}</span>
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
                        <Show when={usedPercent() !== null}>
                          <div class="h-2 overflow-hidden border border-base" style={{ "background-color": "var(--surface-inset)" }}>
                            <div
                              class="h-full transition-[width] duration-300"
                              style={{ width: `${Math.max(0, Math.min(100, usedPercent() ?? 0))}%`, "background-color": barColor(usedPercent()) }}
                              role="progressbar"
                              aria-label={t("providerUsage.progressLabel", { window: windowLabel(label) })}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={Math.round(usedPercent() ?? 0)}
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
      <Show when={usage()?.supported && usage()?.configured && usage()?.ok && !unavailableMessage() && hasReadings()}>
        <div class="mt-2 truncate text-right text-sm font-semibold text-secondary">
          {["opencode-free", "opencode-console"].includes(usage()?.providerId ?? "")
            ? t("providerUsage.console.name") : usage()?.providerName ?? props.providerId}
          <Show when={usage()?.copilotPlan}>{plan => ` · ${t(`providerUsage.copilotPlans.${plan()}`)}`}</Show>
        </div>
      </Show>
    </div>
  )
}

export default ProviderUsagePanel

function consoleError(data: ProviderUsageResponse) {
  return ({
    "opencode-console-missing-credential": "providerUsage.console.missingCredential",
    "opencode-console-access-denied": "providerUsage.console.accessDenied",
    "opencode-console-invalid-credential": "providerUsage.console.invalidCredential",
    "opencode-console-invalid-response": "providerUsage.console.malformed",
    "opencode-console-network-error": "providerUsage.console.network",
  } as Record<string, string>)[data.unavailableReason ?? ""]
}
