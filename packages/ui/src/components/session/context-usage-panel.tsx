import { createMemo, Show, type Component } from "solid-js"
import { getChildSessions, getSessionInfo, getThreadTotals } from "../../stores/sessions"
import { formatTokenTotal } from "../../lib/formatters"
import { useI18n } from "../../lib/i18n"
import { useConfig } from "../../stores/preferences"

interface ContextUsagePanelProps {
  instanceId: string
  sessionId: string
  class?: string
}

const metricClass = "min-w-0"
const metricLabelClass = "block truncate text-[10px] uppercase tracking-wide text-muted"
const metricValueClass = "block truncate text-xs font-semibold tabular-nums text-primary"

const ContextUsagePanel: Component<ContextUsagePanelProps> = (props) => {
  const { t } = useI18n()
  const { preferences } = useConfig()
  const showUsage = createMemo(() => preferences().showUsageMetrics ?? true)
  const info = createMemo(
    () =>
      getSessionInfo(props.instanceId, props.sessionId) ?? {
        cost: 0,
        contextWindow: 0,
        isSubscriptionModel: false,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        actualUsageTokens: 0,
        modelOutputLimit: 0,
        contextAvailableTokens: null,
      },
  )

  const children = createMemo(() => getChildSessions(props.instanceId, props.sessionId))
  const hasChildren = createMemo(() => children().length > 0)

  const threadTotals = createMemo(() => {
    if (!hasChildren()) return { cost: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    return getThreadTotals(props.instanceId, props.sessionId) ?? { cost: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  })

  const totalCostDisplay = createMemo(() => `$${threadTotals().cost.toFixed(2)}`)

  const totalInputTokens = createMemo(() => threadTotals().inputTokens)
  const totalOutputTokens = createMemo(() => threadTotals().outputTokens)
  const totalReasoningTokens = createMemo(() => threadTotals().reasoningTokens)

  const inputTokens = createMemo(() => info().inputTokens ?? 0)
  const outputTokens = createMemo(() => info().outputTokens ?? 0)
  const costValue = createMemo(() => {
    const value = info().isSubscriptionModel ? 0 : info().cost
    return value > 0 ? value : 0
  })

  const costDisplay = createMemo(() => info().isSubscriptionModel ? t("contextUsagePanel.included") : `$${costValue().toFixed(2)}`)

  return (
    <div class={`session-context-panel ${props.class ?? ""}`}>
      <div class="grid grid-cols-3 gap-x-3 gap-y-2">
        <div class={metricClass}>
          <span class={metricLabelClass}>{t("contextUsagePanel.labels.input")}</span>
          <span class={metricValueClass}>{formatTokenTotal(inputTokens())}</span>
        </div>
        <div class={metricClass}>
          <span class={metricLabelClass}>{t("contextUsagePanel.labels.output")}</span>
          <span class={metricValueClass}>{formatTokenTotal(outputTokens())}</span>
        </div>
        <div class={metricClass}>
          <span class={metricLabelClass}>{t("contextUsagePanel.labels.cost")}</span>
          <span class={metricValueClass}>{costDisplay()}</span>
        </div>
      </div>
      <Show when={hasChildren() && showUsage()}>
        <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-base pt-2">
          <div class={metricClass}>
            <span class={metricLabelClass}>{t("contextUsagePanel.labels.totalInput")}</span>
            <span class={metricValueClass}>{formatTokenTotal(totalInputTokens())}</span>
          </div>
          <div class={metricClass}>
            <span class={metricLabelClass}>{t("contextUsagePanel.labels.totalOutput")}</span>
            <span class={metricValueClass}>{formatTokenTotal(totalOutputTokens())}</span>
          </div>
          <div class={metricClass}>
            <span class={metricLabelClass}>{t("contextUsagePanel.labels.totalCost")}</span>
            <span class={metricValueClass}>{totalCostDisplay()}</span>
          </div>
          <div class={metricClass}>
            <span class={metricLabelClass}>{t("contextUsagePanel.labels.totalReasoning")}</span>
            <span class={metricValueClass}>{formatTokenTotal(totalReasoningTokens())}</span>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default ContextUsagePanel
