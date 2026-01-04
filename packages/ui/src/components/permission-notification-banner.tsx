import { Show, createMemo, type Component } from "solid-js"
import { getPermissionQueueLength } from "../stores/instances"
import { isElectronHost } from "../lib/runtime-env"

interface PermissionNotificationBannerProps {
  instanceId: string
  onClick: () => void
}

const PermissionNotificationBanner: Component<PermissionNotificationBannerProps> = (props) => {
  const queueLength = createMemo(() => getPermissionQueueLength(props.instanceId))
  const hasPermissions = createMemo(() => queueLength() > 0)
  const isElectron = isElectronHost()

  return (
    <Show when={hasPermissions()}>
      {/* Electron: Full banner with text */}
      <Show when={isElectron}>
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

      {/* Web: Compact indicator button */}
      <Show when={!isElectron}>
        <button
          type="button"
          class="permission-indicator-button"
          onClick={props.onClick}
          aria-label={`${queueLength()} permission${queueLength() > 1 ? "s" : ""} pending approval. Click to review.`}
          title={`${queueLength()} permission${queueLength() > 1 ? "s" : ""} pending approval`}
        >
          <span class="permission-indicator-badge">
            {queueLength() > 9 ? "9+" : queueLength()}
          </span>
        </button>
      </Show>
    </Show>
  )
}

export default PermissionNotificationBanner
