import { Component } from "solid-js"
import type { Instance } from "../types/instance"
import { FolderOpen, X } from "lucide-solid"
import { getInstanceAggregateStatus, type InstanceAggregateStatus } from "../stores/session-status"

interface InstanceTabProps {
  instance: Instance
  active: boolean
  onSelect: () => void
  onClose: () => void
}

const InstanceTab: Component<InstanceTabProps> = (props) => {
  const folderName = () => props.instance.folder.split("/").pop() || props.instance.folder

  // Get status dot class based on aggregate session status
  const getStatusDotClass = () => {
    const status = getInstanceAggregateStatus(props.instance.id)
    if (status === "error") return "project-status-dot project-status-dot-error"
    if (status === "working") return "project-status-dot project-status-dot-working"
    return "project-status-dot project-status-dot-idle"
  }

  return (
    <button
      class={`project-tab ${props.active ? "project-tab-active" : "project-tab-inactive"} group`}
      onClick={props.onSelect}
      title={props.instance.folder}
      role="tab"
      aria-selected={props.active}
    >
      <span class="project-tab-icon-wrapper">
        <FolderOpen class="w-4 h-4 flex-shrink-0 opacity-70" />
        <span class={getStatusDotClass()} />
      </span>
      <span class="project-tab-label">{folderName()}</span>
      <span
        class="project-tab-close"
        onClick={(e) => {
          e.stopPropagation()
          props.onClose()
        }}
        role="button"
        tabIndex={0}
        aria-label={`Close ${folderName()}`}
      >
        <X class="w-3 h-3" />
      </span>
    </button>
  )
}

export default InstanceTab
