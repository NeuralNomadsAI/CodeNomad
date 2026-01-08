import { Show, createMemo, type Component } from "solid-js"
import { ShieldAlert } from "lucide-solid"
import { getPermissionQueueLength } from "../stores/instances"

interface PermissionNotificationBannerProps {
  instanceId: string
  onClick: () => void
}

const PermissionNotificationBanner: Component<PermissionNotificationBannerProps> = (props) => {
  const queueLength = createMemo(() => getPermissionQueueLength(props.instanceId))
  const hasPermissions = createMemo(() => queueLength() > 0)
  const label = createMemo(() => {
    const count = queueLength()
    return `${count} permission${count === 1 ? "" : "s"} pending approval`
  })

  return (
    <Show when={hasPermissions()}>
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
