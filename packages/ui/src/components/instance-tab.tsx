import { Component, createMemo } from "solid-js"
import type { Instance } from "../types/instance"
import { getInstanceSessionIndicatorStatus } from "../stores/session-status"
import { FolderOpen, ShieldAlert, X } from "lucide-solid"
import { useI18n } from "../lib/i18n"

interface InstanceTabProps {
  instance: Instance
  active: boolean
  onSelect: () => void
  onClose: () => void
}

function getPathBasename(path: string): string {
  // Instance folders can be POSIX-like (/Users/...) on macOS/Linux or Windows-like (C:\Users\...).
  // Normalize by trimming trailing separators and then splitting on both '/' and '\\'.
  const normalized = path.replace(/[\\/]+$/, "")
  return normalized.split(/[\\/]/).pop() || path
}

const InstanceTab: Component<InstanceTabProps> = (props) => {
  const { t } = useI18n()
  const aggregatedStatus = createMemo(() => getInstanceSessionIndicatorStatus(props.instance.id))
  const statusClassName = createMemo(() => {
    const status = aggregatedStatus()
    return status === "permission" ? "session-permission" : `session-${status}`
  })
  const statusTitle = createMemo(() => {
    switch (aggregatedStatus()) {
      case "permission":
        return t("instanceTab.status.permission")
      case "compacting":
        return t("instanceTab.status.compacting")
      case "working":
        return t("instanceTab.status.working")
      default:
        return t("instanceTab.status.idle")
    }
  })

  return (
    <div class="group">
      <button
        class={`tab-base ${props.active ? "tab-active" : "tab-inactive"}`}
        onClick={props.onSelect}
        title={props.instance.folder}
        role="tab"
        aria-selected={props.active}
      >
        <FolderOpen class="w-4 h-4 flex-shrink-0" />
        <span class="tab-label">
          {getPathBasename(props.instance.folder)}
        </span>
        <span
          class={`status-indicator session-status ml-auto ${statusClassName()}`}
          title={statusTitle()}
          aria-label={t("instanceTab.status.ariaLabel", { status: statusTitle() })}
        >
          {aggregatedStatus() === "permission" ? (
            <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" />
          ) : (
            <span class="status-dot" />
          )}
        </span>
        <span
          class="tab-close"
          onClick={(e) => {
            e.stopPropagation()
            props.onClose()
          }}
          role="button"
          tabIndex={0}
          aria-label={t("instanceTab.actions.close.ariaLabel")}
        >
          <X class="w-3 h-3" />
        </span>
      </button>
    </div>
  )
}

export default InstanceTab
