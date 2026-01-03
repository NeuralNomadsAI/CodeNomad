import { Show, createMemo, type Component } from "solid-js"
import { getPermissionQueueLength } from "../stores/instances"

interface PermissionNotificationBannerProps {
  instanceId: string
  onClick: () => void
}

const PermissionNotificationBanner: Component<PermissionNotificationBannerProps> = (props) => {
  const queueLength = createMemo(() => getPermissionQueueLength(props.instanceId))
  const hasPermissions = createMemo(() => queueLength() > 0)

  return (
    <Show when={hasPermissions()}>
      <button
        type="button"
        class="permission-notification-banner"
        onClick={props.onClick}
        aria-label={`${queueLength()} permission${queueLength() > 1 ? "s" : ""} pending approval`}
      >
        <span class="permission-notification-icon" aria-hidden="true">
          ⚠️
        </span>
        <span class="permission-notification-text">
          Approval Required
        </span>
        <Show when={queueLength() > 1}>
          <span class="permission-notification-count" aria-label={`${queueLength()} permissions`}>
            {queueLength()}
          </span>
        </Show>
      </button>
    </Show>
  )
}

export default PermissionNotificationBanner
