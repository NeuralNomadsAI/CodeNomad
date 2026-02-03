import { createMemo, type Component } from "solid-js"
import { getSessionInfo } from "../../stores/sessions"
import { formatTokenTotal } from "../../lib/formatters"
import { useI18n } from "../../lib/i18n"

interface ContextUsagePanelProps {
  instanceId: string
  sessionId: string
}

const chipClass = "inline-flex items-center gap-1 rounded-full border border-base px-2 py-0.5 text-xs text-primary"
const chipLabelClass = "uppercase text-[10px] tracking-wide text-muted"
const headingClass = "text-xs font-semibold text-muted uppercase tracking-wide"

const ContextUsagePanel: Component<ContextUsagePanelProps> = (props) => {
  const { t } = useI18n()
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

  const inputTokens = createMemo(() => info().inputTokens ?? 0)
  const outputTokens = createMemo(() => info().outputTokens ?? 0)
  const actualUsageTokens = createMemo(() => info().actualUsageTokens ?? 0)
  const availableTokens = createMemo(() => info().contextAvailableTokens)
  const outputLimit = createMemo(() => info().modelOutputLimit ?? 0)
  const costValue = createMemo(() => {
    const value = info().isSubscriptionModel ? 0 : info().cost
    return value > 0 ? value : 0
  })


  const formatTokenValue = (value: number | null | undefined) => {
    if (value === null || value === undefined) return t("contextUsagePanel.unavailable")
    return formatTokenTotal(value)
  }

  const costDisplay = createMemo(() => `$${costValue().toFixed(2)}`)

  return (
    <div class="session-context-panel border-r border-base border-b px-3 py-3 space-y-3">
      <div class="flex flex-wrap items-center gap-2 text-xs text-primary">
        <div class={headingClass}>{t("contextUsagePanel.headings.tokens")}</div>
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
      </div>

      <div class="flex flex-wrap items-center gap-2 text-xs text-primary">
        <div class={headingClass}>{t("contextUsagePanel.headings.context")}</div>
        <div class={chipClass}>
          <span class={chipLabelClass}>{t("contextUsagePanel.labels.used")}</span>
          <span class="font-semibold text-primary">{formatTokenTotal(actualUsageTokens())}</span>
        </div>
        <div class={chipClass}>
          <span class={chipLabelClass}>{t("contextUsagePanel.labels.available")}</span>
          <span class="font-semibold text-primary">{formatTokenValue(availableTokens())}</span>
        </div>
      </div>
    </div>
  )
}

export default ContextUsagePanel
