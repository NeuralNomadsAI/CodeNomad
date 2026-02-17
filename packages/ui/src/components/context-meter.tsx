import type { Component } from "solid-js"

interface ContextMeterProps {
  usedTokens: number
  availableTokens: number | null
  formatTokens: (value: number) => string
  usedLabel: string
  availableLabel: string
  class?: string
}

const LABEL_CLASS = "uppercase text-[10px] tracking-wide text-muted"

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function resolveFillColor(percent: number): string {
  if (percent >= 0.8) return "var(--status-error)"
  if (percent >= 0.6) return "var(--status-warning)"
  return "var(--status-success)"
}

export const ContextMeter: Component<ContextMeterProps> = (props) => {
  const hasAvailable = () => typeof props.availableTokens === "number" && props.availableTokens > 0
  const used = () => (typeof props.usedTokens === "number" && props.usedTokens > 0 ? props.usedTokens : 0)
  const available = () => (hasAvailable() ? (props.availableTokens as number) : null)

  const percent = () => {
    const usedValue = used()
    const availableValue = available()
    if (availableValue === null || availableValue <= 0) return null

    // Heuristic: if available >= used, treat it like a capacity/limit.
    // Otherwise treat it like remaining tokens.
    const ratio = availableValue >= usedValue ? usedValue / availableValue : usedValue / (usedValue + availableValue)
    return clamp(ratio, 0, 1)
  }

  const fillColor = () => {
    const value = percent()
    if (value === null) return "var(--border-base)"
    return resolveFillColor(value)
  }

  const percentLabel = () => {
    const value = percent()
    if (value === null) return "--"
    return `${Math.round(value * 100)}%`
  }

  const containerClass =
    `inline-flex items-center gap-2 rounded-full border border-base px-2 py-0.5 text-xs text-primary ${props.class ?? ""}`

  function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
    const rad = (angleDeg * Math.PI) / 180
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad),
    }
  }

  function describeSectorPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
    const start = polarToCartesian(cx, cy, r, startAngle)
    const end = polarToCartesian(cx, cy, r, endAngle)
    const delta = ((endAngle - startAngle) % 360 + 360) % 360
    const largeArc = delta > 180 ? 1 : 0

    return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`
  }

  const circle = () => {
    const value = percent()
    const size = 22
    const r = 9
    const cx = 11
    const cy = 11
    const progress = value === null ? 0 : value
    const startAngle = -90
    const endAngle = startAngle + progress * 360
    const isFull = progress >= 0.999
    const hasFill = progress > 0.001

    const sectorPath = hasFill && !isFull ? describeSectorPath(cx, cy, r, startAngle, endAngle) : null

    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 22 22"
        aria-hidden="true"
        style={{ flex: "0 0 auto" }}
      >
        <circle cx={String(cx)} cy={String(cy)} r={String(r)} fill="var(--surface-secondary)" />
        <circle cx={String(cx)} cy={String(cy)} r={String(r)} fill="none" stroke="var(--border-base)" stroke-width="1" />
        {isFull ? (
          <circle cx={String(cx)} cy={String(cy)} r={String(r)} fill={fillColor()} opacity="0.95" />
        ) : sectorPath ? (
          <path d={sectorPath} fill={fillColor()} opacity="0.95" />
        ) : null}
      </svg>
    )
  }

  const tooltipText = () => `Context Used: ${percentLabel()}`

  return (
    <div class="inline-flex items-center gap-2" title={tooltipText()}>
      {circle()}
      <div class={containerClass}>
        <span class={LABEL_CLASS}>{props.usedLabel}</span>
        <span class="font-semibold text-primary tabular-nums">{props.formatTokens(used())}</span>
        <span class="text-muted">/</span>
        <span class={LABEL_CLASS}>{props.availableLabel}</span>
        <span class="font-semibold text-primary tabular-nums">
          {available() !== null ? props.formatTokens(available() as number) : "--"}
        </span>
      </div>
    </div>
  )
}

export default ContextMeter
