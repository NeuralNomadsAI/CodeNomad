import { Show, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { useLiveClock } from "../lib/live-clock"
import { formatElapsedClock } from "../lib/message-timing"

/** Elapsed time of a reasoning or tool part, from OpenCode's own timestamps.
 * While running it ticks from the start; once ended it shows the final duration. */
export const PartDuration: Component<{ startedAt?: number; endedAt?: number; running: boolean }> = (props) => {
  const { locale } = useI18n()
  const live = () => props.running && !props.endedAt && Boolean(props.startedAt)
  const now = useLiveClock(live)
  const elapsed = () => {
    if (!props.startedAt) return ""
    const end = props.endedAt ?? (live() ? now() : undefined)
    // Server and client clocks may differ slightly: never show a negative time.
    return end ? formatElapsedClock(Math.max(0, end - props.startedAt), locale()) : ""
  }
  return (
    <Show when={elapsed()}>
      {(value) => <span class="part-duration" data-live={live() ? "true" : undefined}>{value()}</span>}
    </Show>
  )
}
