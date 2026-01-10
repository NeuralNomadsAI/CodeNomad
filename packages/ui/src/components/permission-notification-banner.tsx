import { Show, createMemo, type Component } from "solid-js"
import { ShieldAlert } from "lucide-solid"
import { getPermissionQueueLength, getQuestionQueueLength } from "../stores/instances"

interface PermissionNotificationBannerProps {
  instanceId: string
  onClick: () => void
}

const PermissionNotificationBanner: Component<PermissionNotificationBannerProps> = (props) => {
  const permissionCount = createMemo(() => getPermissionQueueLength(props.instanceId))
  const questionCount = createMemo(() => getQuestionQueueLength(props.instanceId))
  const queueLength = createMemo(() => permissionCount() + questionCount())
  const hasRequests = createMemo(() => queueLength() > 0)
  const label = createMemo(() => {
    const total = queueLength()
    const parts: string[] = []
    if (permissionCount() > 0) parts.push(`${permissionCount()} permission${permissionCount() === 1 ? "" : "s"}`)
    if (questionCount() > 0) parts.push(`${questionCount()} question${questionCount() === 1 ? "" : "s"}`)
    const detail = parts.length ? ` (${parts.join(", ")})` : ""
    return `${total} pending request${total === 1 ? "" : "s"}${detail}`
  })

  return (
    <Show when={hasRequests()}>
      <button
        type="button"
        class="permission-center-trigger"
        onClick={props.onClick}
        aria-label={label()}
        title={label()}
      >
        <ShieldAlert class="permission-center-icon" aria-hidden="true" />
        <span class="permission-center-count" aria-hidden="true">
          {queueLength() > 9 ? "9+" : queueLength()}
        </span>
      </button>
    </Show>
  )
}

export default PermissionNotificationBanner
