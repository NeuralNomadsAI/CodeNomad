import { Component, createMemo } from "solid-js"
import { formatTokenTotal } from "../lib/formatters"

interface ContextProgressBarProps {
  used: number
  available: number | null
  showLabels?: boolean
  size?: "sm" | "md" | "lg"
  class?: string
}

const ContextProgressBar: Component<ContextProgressBarProps> = (props) => {
  const total = createMemo(() => {
    if (props.available === null) return null
    return props.used + props.available
  })

  const percentage = createMemo(() => {
    const t = total()
    if (t === null || t === 0) return 0
    return Math.min((props.used / t) * 100, 100)
  })

  const usageLevel = createMemo(() => {
    const pct = percentage()
    if (pct >= 90) return "critical"
    if (pct >= 75) return "warning"
    return "normal"
  })

  const sizeClass = createMemo(() => {
    switch (props.size) {
      case "sm":
        return "context-progress-bar--sm"
      case "lg":
        return "context-progress-bar--lg"
      default:
        return "context-progress-bar--md"
    }
  })

  return (
    <div class={`context-progress-bar ${sizeClass()} ${props.class ?? ""}`}>
      {props.showLabels !== false && (
        <span class="context-progress-label context-progress-label--used">
          {formatTokenTotal(props.used)}
        </span>
      )}
      <div class="context-progress-track">
        <div
          class={`context-progress-fill context-progress-fill--${usageLevel()}`}
          style={{ width: `${percentage()}%` }}
        />
      </div>
      {props.showLabels !== false && (
        <span class="context-progress-label context-progress-label--total">
          {total() !== null ? formatTokenTotal(total()!) : "--"}
        </span>
      )}
    </div>
  )
}

export default ContextProgressBar
