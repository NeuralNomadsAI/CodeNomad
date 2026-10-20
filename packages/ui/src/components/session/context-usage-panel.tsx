import { createMemo, For, Show, type Component } from "solid-js"
import { getChildSessions, getSessionInfo, getThreadTotals } from "../../stores/sessions"
import { formatTokenTotal } from "../../lib/formatters"
import { useI18n } from "../../lib/i18n"

interface ContextUsagePanelProps {
  instanceId: string
  sessionId: string
  class?: string
  summary?: boolean
}

const chipClass = "badge-shape inline-flex items-center gap-1 border border-base px-2 py-0.5 text-xs text-primary"
const chipLabelClass = "uppercase text-[10px] tracking-wide text-muted"

const ContextUsagePanel: Component<ContextUsagePanelProps> = (props) => {
  const { t } = useI18n()
  const info = createMemo(() => getSessionInfo(props.instanceId, props.sessionId))
  const hasChildren = createMemo(() => getChildSessions(props.instanceId, props.sessionId).length > 0)
  const threadTotals = createMemo(() => getThreadTotals(props.instanceId, props.sessionId))
  const tokenMetric = (label: string, value = 0) => ({ label: t(`contextUsagePanel.labels.${label}`), value: formatTokenTotal(value), full: String(value) })
  const costMetric = (label: string, value: string) => ({ label: t(`contextUsagePanel.labels.${label}`), value, full: value })
  const sessionMetrics = createMemo(() => {
    const session = info()
    const cost = session?.cost ?? 0
    return [
      tokenMetric("input", session?.inputTokens),
      tokenMetric("output", session?.outputTokens),
      costMetric("cost", session?.isSubscriptionModel ? t("contextUsagePanel.included") : `$${(cost > 0 ? cost : 0).toFixed(2)}`),
    ]
  })
  const totalMetrics = createMemo(() => [
    tokenMetric("totalInput", threadTotals()?.inputTokens),
    tokenMetric("totalOutput", threadTotals()?.outputTokens),
    costMetric("totalCost", `$${(threadTotals()?.cost ?? 0).toFixed(2)}`),
    tokenMetric("totalReasoning", threadTotals()?.reasoningTokens),
  ])
  const summaryLabel = createMemo(() => sessionMetrics().map(metric => `${metric.label}: ${metric.full}`).join(" · "))
  const renderMetrics = (metrics: ReturnType<typeof sessionMetrics>) => (
    <For each={metrics}>
      {(metric) => (
        <span class={props.summary ? "status-token-metric" : chipClass} title={`${metric.label}: ${metric.full}`}>
          <span class={props.summary ? "status-token-label" : chipLabelClass}>{metric.label}</span>
          <span class={props.summary ? "" : "font-semibold text-primary"}>{metric.value}</span>
        </span>
      )}
    </For>
  )

  return (
    <Show when={props.summary} fallback={
      <div class={`session-context-panel status-token-groups py-2 text-xs text-primary opacity-50 ${props.class ?? ""}`}>
        <div class="status-token-group" data-token-group="session">{renderMetrics(sessionMetrics())}</div>
        <Show when={hasChildren()}>
          <div class="status-token-group" data-token-group="thread">{renderMetrics(totalMetrics())}</div>
        </Show>
      </div>
    }>
      <span class="status-token-summary" title={summaryLabel()} aria-label={summaryLabel()}>{renderMetrics(sessionMetrics())}</span>
    </Show>
  )
}

export default ContextUsagePanel
