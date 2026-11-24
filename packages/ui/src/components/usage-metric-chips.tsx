import { For } from "solid-js"

/** The same compact metric chips in message token rows and Status. */
export function UsageMetricChips(props: {
  metrics: readonly { label: string; value: string; full: string }[]
  class?: string
}) {
  return <For each={props.metrics}>{metric =>
    <span class={`usage-metric-chip ${props.class ?? ""}`} data-label={metric.label} title={`${metric.label}: ${metric.full}`}>
      {metric.value}
    </span>
  }</For>
}
