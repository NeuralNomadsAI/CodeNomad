import { createMemo, Show, type Component } from "solid-js"
import { getChildSessions, getSessionInfo, getThreadTotals } from "../../stores/sessions"
import { formatTokenTotal } from "../../lib/formatters"
import { useI18n } from "../../lib/i18n"
import { UsageMetricChips } from "../usage-metric-chips"

interface ContextUsagePanelProps {
  instanceId: string
  sessionId: string
  class?: string
  summary?: boolean
  expanded?: boolean
}

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
  const metrics = () => props.expanded ? [sessionMetrics()[0], sessionMetrics()[1],
    { label: t("messageBlock.usage.reasoning"), value: formatTokenTotal(info()?.reasoningTokens ?? 0), full: String(info()?.reasoningTokens ?? 0) },
    sessionMetrics()[2]] : sessionMetrics()
  const summaryLabel = () => metrics().map(metric => `${metric.label}: ${metric.full}`).join(" · ")

  return (
    <Show when={props.summary} fallback={
      <Show when={hasChildren()}><div class={`session-context-panel status-token-group ${props.class ?? ""}`} data-token-group="thread">
        <UsageMetricChips metrics={totalMetrics()} />
      </div></Show>
    }>
      <span class="status-token-summary" data-expanded={props.expanded || undefined} title={summaryLabel()} aria-label={summaryLabel()}>
        <UsageMetricChips metrics={metrics()} />
      </span>
    </Show>
  )
}

export default ContextUsagePanel
