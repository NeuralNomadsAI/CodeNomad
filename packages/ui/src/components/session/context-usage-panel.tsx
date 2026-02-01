import { createMemo, type Component } from "solid-js"
import { getSessionInfo } from "../../stores/sessions"
import { formatTokenTotal } from "../../lib/formatters"

interface ContextUsagePanelProps {
  instanceId: string
  sessionId: string
}

const chipClass = "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-primary"
const chipLabelClass = "uppercase text-[10px] tracking-wide text-primary/70"
const headingClass = "text-xs font-semibold text-primary/70 uppercase tracking-wide"

const ContextUsagePanel: Component<ContextUsagePanelProps> = (props) => {
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
  const costValue = createMemo(() => {
    const value = info().isSubscriptionModel ? 0 : info().cost
    return value > 0 ? value : 0
  })

  const costDisplay = createMemo(() => `$${costValue().toFixed(2)}`)

  return (
    <div class="flex flex-col gap-2 p-3 bg-background border-t border-border border-r border-border border-b">
      <div class="flex flex-wrap items-center gap-2 text-xs text-primary/90">
        <div class={headingClass}>Tokens</div>
        <div class={chipClass}>
          <span class={chipLabelClass}>Input</span>
          <span class="font-semibold text-primary">{formatTokenTotal(inputTokens())}</span>
        </div>
        <div class={chipClass}>
          <span class={chipLabelClass}>Output</span>
          <span class="font-semibold text-primary">{formatTokenTotal(outputTokens())}</span>
        </div>
        <div class={chipClass}>
          <span class={chipLabelClass}>Cost</span>
          <span class="font-semibold text-primary">{costDisplay()}</span>
        </div>
      </div>
    </div>
  )
}

export default ContextUsagePanel
