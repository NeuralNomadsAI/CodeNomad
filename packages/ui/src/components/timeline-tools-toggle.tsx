import type { Component } from "solid-js"
import { useI18n } from "../lib/i18n"

interface TimelineToolsToggleProps {
  controls: string
  shown: boolean
  onToggle: () => void
}

const TimelineToolsToggle: Component<TimelineToolsToggleProps> = (props) => {
  const { t } = useI18n()
  const label = () => t(props.shown
    ? "commands.timelineToolCalls.label.hide"
    : "commands.timelineToolCalls.label.show")

  return (
    <div class="message-timeline-tools-control">
      <label class="message-timeline-tools-toggle" title={label()}>
        <input
          type="checkbox"
          class="message-timeline-tools-toggle-input"
          aria-controls={props.controls}
          aria-label={label()}
          checked={props.shown}
          onChange={(event) => {
            if (event.currentTarget.checked !== props.shown) props.onToggle()
          }}
        />
        <span class="message-timeline-tools-toggle-box" aria-hidden="true" />
      </label>
    </div>
  )
}

export default TimelineToolsToggle
