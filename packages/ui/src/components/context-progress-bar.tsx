import { Component, createMemo } from "solid-js"
import { cn } from "../lib/cn"
import { Progress } from "./ui"
import { formatTokenTotal } from "../lib/formatters"

export type ContextUsageLevel = "low" | "moderate" | "elevated" | "critical"

interface ContextProgressBarProps {
  used: number
  available: number | null
  showLabels?: boolean
  size?: "sm" | "md" | "lg"
  class?: string
  /** Called when usage level changes */
  onLevelChange?: (level: ContextUsageLevel, percentage: number) => void
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

  const usageLevel = createMemo<ContextUsageLevel>((prev) => {
    const pct = percentage()
    let level: ContextUsageLevel
    if (pct >= 85) level = "critical"
    else if (pct >= 70) level = "elevated"
    else if (pct >= 50) level = "moderate"
    else level = "low"

    if (prev !== undefined && level !== prev && props.onLevelChange) {
      props.onLevelChange(level, pct)
    }
    return level
  })

  const indicatorColor = createMemo(() => {
    switch (usageLevel()) {
      case "critical":
        return "bg-[hsl(var(--context-progress-critical))]"
      case "elevated":
        return "bg-[hsl(var(--context-progress-warning))]"
      case "moderate":
        return "bg-[hsl(var(--context-progress-moderate))]"
      default:
        return "bg-[hsl(var(--context-progress-low))]"
    }
  })

  const trackSize = createMemo(() => {
    switch (props.size) {
      case "sm":
        return "h-[3px] min-w-[40px]"
      case "lg":
        return "h-2 min-w-[120px] max-w-[300px]"
      default:
        return "h-1.5 min-w-[80px] max-w-[200px]"
    }
  })

  const labelSize = createMemo(() => {
    switch (props.size) {
      case "sm":
        return "text-[9px]"
      default:
        return "text-[10px]"
    }
  })

  const gapSize = createMemo(() => {
    switch (props.size) {
      case "sm":
        return "gap-1"
      default:
        return "gap-2"
    }
  })

  const levelTextColor = createMemo(() => {
    switch (usageLevel()) {
      case "critical": return "text-destructive"
      case "elevated": return "text-warning"
      default: return "text-muted-foreground"
    }
  })

  return (
    <div class={cn("flex items-center", gapSize(), props.class)}>
      {props.showLabels !== false && (
        <span class={cn("font-mono font-semibold whitespace-nowrap", labelSize(), levelTextColor())}>
          {formatTokenTotal(props.used)}
        </span>
      )}
      <Progress
        value={percentage()}
        max={100}
        class={cn("flex-1 bg-[hsl(var(--context-progress-track))]", trackSize())}
        indicatorClass={indicatorColor()}
      />
      {props.showLabels !== false && (
        <span class={cn("font-mono font-semibold whitespace-nowrap text-muted-foreground", labelSize())}>
          {total() !== null ? formatTokenTotal(total()!) : "--"}
        </span>
      )}
    </div>
  )
}

export default ContextProgressBar
