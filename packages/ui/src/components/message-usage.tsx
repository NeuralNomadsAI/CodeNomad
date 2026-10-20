import { For, createEffect, createSignal } from "solid-js"
import { ChevronRight } from "lucide-solid"
import type { MessageInfo } from "../types/message"
import type { VisibilityPreference } from "../stores/preferences"
import { formatTokenTotal } from "../lib/formatters"
import { useI18n } from "../lib/i18n"

/** Marks a usage line that follows tools, which draw no message border. */
export const NO_STEP_BORDER = "none"

interface MessageUsageProps {
  /** A settled native assistant step: one model call with its own usage. */
  messageInfo: MessageInfo
  usageVisibility: VisibilityPreference
  borderColor?: string
  onContentRendered?: () => void
}

/** The compact token and cost line closing one assistant step. */
export function MessageUsage(props: MessageUsageProps) {
  const { t } = useI18n()
  const [expandedOverride, setExpandedOverride] = createSignal<boolean | null>(null)
  const expanded = () => expandedOverride() ?? props.usageVisibility === "expanded"
  const usage = () => {
    const tokens = props.messageInfo.tokens ?? {}
    return {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cacheRead: tokens.cache?.read ?? 0,
      cacheWrite: tokens.cache?.write ?? 0,
      cost: props.messageInfo.cost ?? 0,
    }
  }
  const entries = () => [
    { label: t("messageBlock.usage.input"), value: formatTokenTotal(usage().input) },
    { label: t("messageBlock.usage.output"), value: formatTokenTotal(usage().output) },
    ...(expanded()
      ? [
          { label: t("messageBlock.usage.reasoning"), value: formatTokenTotal(usage().reasoning) },
          { label: t("messageBlock.usage.cacheRead"), value: formatTokenTotal(usage().cacheRead) },
          { label: t("messageBlock.usage.cacheWrite"), value: formatTokenTotal(usage().cacheWrite) },
        ]
      : []),
    { label: t("messageBlock.usage.cost"), value: formatCostValue(usage().cost) },
  ]
  const style = () => props.borderColor === NO_STEP_BORDER
    ? { "border-inline-start": "none" }
    : props.borderColor ? { "border-left-color": props.borderColor } : undefined

  let reported = false
  createEffect(() => {
    if (reported) return
    reported = true
    props.onContentRendered?.()
  })

  return (
    <div class="delete-hover-scope message-step-card message-step-finish message-step-finish-flush relative" style={style()}>
      <button
        type="button"
        class="message-step-usage-toggle"
        aria-expanded={expanded()}
        aria-label={`${t(expanded() ? "messageBlock.usage.collapseAriaLabel" : "messageBlock.usage.expandAriaLabel")}. ${entries().map((entry) => `${entry.label}: ${entry.value}`).join(", ")}`}
        onClick={() => setExpandedOverride(!expanded())}
      >
        <ChevronRight class="message-step-usage-disclosure disclosure-chevron" aria-hidden="true" />
        <div class="message-step-usage">
          <For each={entries()}>
            {(entry) => <span class="message-step-usage-chip" data-label={entry.label}>{entry.value}</span>}
          </For>
        </div>
      </button>
    </div>
  )
}

function formatCostValue(value: number) {
  if (!value) return "$0.00"
  if (value < 0.01) return `$${value.toPrecision(2)}`
  return `$${value.toFixed(2)}`
}
