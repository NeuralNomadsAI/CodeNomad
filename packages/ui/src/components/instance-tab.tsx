import { Component, createMemo } from "solid-js"
import type { Instance } from "../types/instance"
import { getInstanceSessionIndicatorStatus } from "../stores/session-status"
import { FolderOpen, ShieldAlert, X } from "lucide-solid"

interface InstanceTabProps {
  instance: Instance
  active: boolean
  onSelect: () => void
  onClose: () => void
}

function formatFolderName(path: string, instances: Instance[], currentInstance: Instance): string {
  const name = path.split("/").pop() || path

  const duplicates = instances.filter((i) => {
    const iName = i.folder.split("/").pop() || i.folder
    return iName === name
  })

  if (duplicates.length > 1) {
    const index = duplicates.findIndex((i) => i.id === currentInstance.id)
    return `~/${name} (${index + 1})`
  }

  return `~/${name}`
}

const InstanceTab: Component<InstanceTabProps> = (props) => {
  const aggregatedStatus = createMemo(() => getInstanceSessionIndicatorStatus(props.instance.id))
  const statusClassName = createMemo(() => {
    const status = aggregatedStatus()
    return status === "permission" ? "session-permission" : `session-${status}`
  })
  const statusTitle = createMemo(() => {
    switch (aggregatedStatus()) {
      case "permission":
        return "Waiting on permission"
      case "compacting":
        return "Compacting"
      case "working":
        return "Working"
      default:
        return "Idle"
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
          {props.instance.folder.split("/").pop() || props.instance.folder}
        </span>
        <span
          class={`status-indicator session-status ml-auto ${statusClassName()}`}
          title={statusTitle()}
          aria-label={`Instance status: ${statusTitle()}`}
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
          aria-label="Close instance"
        >
          <X class="w-3 h-3" />
        </span>
      </button>
    </div>
  )
}

export default InstanceTab
