import { Component, createMemo } from "solid-js"
import { cn } from "../lib/cn"
import { Progress } from "./ui"
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

  const indicatorColor = createMemo(() => {
    switch (usageLevel()) {
      case "critical":
        return "bg-destructive"
      case "warning":
        return "bg-warning"
      default:
        return "bg-success"
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

  return (
    <div class={cn("flex items-center", gapSize(), props.class)}>
      {props.showLabels !== false && (
        <span class={cn("font-mono font-semibold whitespace-nowrap text-muted-foreground", labelSize())}>
          {formatTokenTotal(props.used)}
        </span>
      )}
      <Progress
        value={percentage()}
        max={100}
        class={cn("flex-1 bg-primary/20", trackSize())}
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
