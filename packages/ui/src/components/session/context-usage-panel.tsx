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

const chipClass = "inline-flex items-center gap-1 rounded-full border border-base px-2 py-0.5 text-xs text-primary"
const chipLabelClass = "uppercase text-[10px] tracking-wide text-muted"

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

  const costDisplay = createMemo(() => `$${costValue().toFixed(2)}`)

  return (
    <div class={`session-context-panel px-4 py-2 ${props.class ?? ""}`}>
      <div class="flex flex-wrap items-center gap-2 text-xs text-primary">
        <div class={chipClass}>
          <span class={chipLabelClass}>{t("contextUsagePanel.labels.input")}</span>
          <span class="font-semibold text-primary">{formatTokenTotal(inputTokens())}</span>
        </div>
        <div class={chipClass}>
          <span class={chipLabelClass}>{t("contextUsagePanel.labels.output")}</span>
          <span class="font-semibold text-primary">{formatTokenTotal(outputTokens())}</span>
        </div>
        <div class={chipClass}>
          <span class={chipLabelClass}>{t("contextUsagePanel.labels.cost")}</span>
          <span class="font-semibold text-primary">{costDisplay()}</span>
        </div>
        <Show when={hasChildren() && showUsage()}>
          <div class={chipClass}>
            <span class={chipLabelClass}>{t("contextUsagePanel.labels.totalInput")}</span>
            <span class="font-semibold text-primary">{formatTokenTotal(totalInputTokens())}</span>
          </div>
          <div class={chipClass}>
            <span class={chipLabelClass}>{t("contextUsagePanel.labels.totalOutput")}</span>
            <span class="font-semibold text-primary">{formatTokenTotal(totalOutputTokens())}</span>
          </div>
          <div class={chipClass}>
            <span class={chipLabelClass}>{t("contextUsagePanel.labels.totalCost")}</span>
            <span class="font-semibold text-primary">{totalCostDisplay()}</span>
          </div>
          <div class={chipClass}>
            <span class={chipLabelClass}>{t("contextUsagePanel.labels.totalReasoning")}</span>
            <span class="font-semibold text-primary">{formatTokenTotal(totalReasoningTokens())}</span>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default ContextUsagePanel
