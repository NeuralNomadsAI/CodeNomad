import { Show, createMemo, type Component } from "solid-js"
import { ShieldAlert } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { getPermissionQueueLength, getQuestionQueueLength } from "../stores/instances"

interface PermissionNotificationBannerProps {
  instanceId: string
  onClick: () => void
}

const PermissionNotificationBanner: Component<PermissionNotificationBannerProps> = (props) => {
  const { t } = useI18n()
  const permissionCount = createMemo(() => getPermissionQueueLength(props.instanceId))
  const questionCount = createMemo(() => getQuestionQueueLength(props.instanceId))
  const queueLength = createMemo(() => permissionCount() + questionCount())
  const hasRequests = createMemo(() => queueLength() > 0)
  const label = createMemo(() => {
    const total = queueLength()

    const pendingLabel = total === 1
      ? t("permissionBanner.pendingRequests.one", { count: total })
      : t("permissionBanner.pendingRequests.other", { count: total })

    const parts: string[] = []

    if (permissionCount() > 0) {
      parts.push(
        permissionCount() === 1
          ? t("permissionBanner.detail.permission.one", { count: permissionCount() })
          : t("permissionBanner.detail.permission.other", { count: permissionCount() }),
      )
    }

    if (questionCount() > 0) {
      parts.push(
        questionCount() === 1
          ? t("permissionBanner.detail.question.one", { count: questionCount() })
          : t("permissionBanner.detail.question.other", { count: questionCount() }),
      )
    }

    const detail = parts.length ? t("permissionBanner.detail.wrapper", { detail: parts.join(", ") }) : ""
    return `${pendingLabel}${detail}`
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
