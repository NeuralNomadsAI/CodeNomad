import { For, Show, createEffect, createMemo, createSignal, createUniqueId } from "solid-js"
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
  const contentId = createUniqueId()
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
  const tokenEntry = (label: string, value: number) => ({ label: t(`messageBlock.usage.${label}`), value: formatTokenTotal(value), full: String(value) })
  const entries = createMemo(() => {
    const values = usage()
    const cost = formatCostValue(values.cost)
    return [
      tokenEntry("input", values.input),
      tokenEntry("output", values.output),
      tokenEntry("reasoning", values.reasoning),
      tokenEntry("cacheRead", values.cacheRead),
      tokenEntry("cacheWrite", values.cacheWrite),
      { label: t("messageBlock.usage.cost"), value: cost, full: cost },
    ]
  })
  const summaryEntries = () => [entries()[0], entries()[1], entries()[5]]
  const summaryLabel = () => summaryEntries().map(entry => `${entry.label}: ${entry.full}`).join(", ")
  const renderEntries = (metrics: ReturnType<typeof entries>) => (
    <For each={metrics}>
      {(entry) => <span class="message-step-usage-chip" data-label={entry.label} title={`${entry.label}: ${entry.full}`}>{entry.value}</span>}
    </For>
  )
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
    <Show when={props.usageVisibility !== "hidden"}>
      <div class="delete-hover-scope message-step-card message-step-finish message-step-finish-flush relative" style={style()}>
        <button
          type="button"
          class="message-step-usage-toggle"
          aria-expanded={expanded()}
          aria-controls={expanded() ? contentId : undefined}
          aria-label={expanded() ? t("messageBlock.usage.collapseAriaLabel") : `${t("messageBlock.usage.expandAriaLabel")}. ${summaryLabel()}`}
          onClick={() => setExpandedOverride(!expanded())}
        >
          <ChevronRight class="message-step-usage-disclosure disclosure-chevron" aria-hidden="true" />
          <Show when={!expanded()} fallback={<span class="message-step-usage-label">{t("settings.behavior.usageMetrics.title")}</span>}>
            <span class="message-step-usage message-step-usage-summary" title={summaryLabel()}>{renderEntries(summaryEntries())}</span>
          </Show>
        </button>
        <Show when={expanded()}>
          <div id={contentId} class="message-step-usage message-step-usage-content">{renderEntries(entries())}</div>
        </Show>
      </div>
    </Show>
  )
}

function formatCostValue(value: number) {
  if (!value) return "$0.00"
  if (value < 0.01) return `$${value.toPrecision(2)}`
  return `$${value.toFixed(2)}`
}
