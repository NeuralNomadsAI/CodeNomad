import { type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import type { DescendantActivity } from "../stores/session-tree"

// Dot-only summary of a collapsed parent's busy subsessions, distinct from the
// parent's own status badge. The most urgent state colours the dot.
const SessionChildActivity: Component<{ activity: DescendantActivity }> = (props) => {
  const { t } = useI18n()
  const kind = () => props.activity.permission ? "permission" : props.activity.working ? "working" : "compacting"
  const label = () => (["permission", "working", "compacting"] as const)
    .filter((state) => props.activity[state] > 0)
    .map((state) => {
      const count = props.activity[state]
      return t(`sessionList.childActivity.${state}.${count === 1 ? "one" : "other"}`, { count: String(count) })
    })
    .join(", ")

  return (
    <span
      class={`status-indicator session-status session-child-activity session-${kind()}`}
      role="img"
      aria-label={label()}
      title={label()}
      data-child-activity={kind()}
    >
      <span class="status-dot" />
    </span>
  )
}

export default SessionChildActivity
