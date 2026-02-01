import { Component } from "solid-js"
import type { Instance } from "../types/instance"
import { FolderOpen, X } from "lucide-solid"
import { getInstanceAggregateStatus, type InstanceAggregateStatus } from "../stores/session-status"
import { cn } from "../lib/cn"

interface InstanceTabProps {
  instance: Instance
  active: boolean
  onSelect: () => void
  onClose: () => void
}

const InstanceTab: Component<InstanceTabProps> = (props) => {
  const folderName = () => {
    const folder = props.instance.folder
    // Handle various path formats:
    // - POSIX: /Users/alex/project
    // - macOS alias: alias Macintosh HD:Users:alex/project/
    // - Windows: C:\Users\alex\project

    // Remove trailing slashes/colons
    const cleaned = folder.replace(/[/:\\]+$/, "")

    // Split by common separators and get the last non-empty part
    const parts = cleaned.split(/[/:\\]/).filter(Boolean)
    return parts[parts.length - 1] || folder
  }

  // Get status dot styling based on aggregate session status
  const getStatusDotClass = () => {
    const status = getInstanceAggregateStatus(props.instance.id)
    const base = "absolute rounded-full w-[7px] h-[7px] -bottom-0.5 -right-0.5"
    const shadow = props.active
      ? "shadow-[0_0_0_1.5px_hsl(var(--background))]"
      : "shadow-[0_0_0_1.5px_hsl(var(--secondary))]"

    if (status === "error") return cn(base, shadow, "bg-destructive animate-pulse")
    if (status === "working") return cn(base, shadow, "bg-info animate-pulse")
    if (status === "completed") return cn(base, shadow, "bg-success animate-[status-dot-glow_2s_ease-in-out_infinite]")
    return cn(base, shadow, "bg-muted-foreground")
  }

  return (
    <button
      class={cn(
        "inline-flex items-center gap-2 px-3 h-8 rounded-md text-sm font-medium transition-colors cursor-pointer max-w-[180px] outline-none group",
        "focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-info focus-visible:ring-offset-secondary",
        props.active
          ? "bg-background text-foreground font-semibold shadow-[0_1px_3px_rgba(0,0,0,0.2),0_0_0_1px_rgba(255,255,255,0.05)] border-b-2 border-info"
          : "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
      onClick={props.onSelect}
      title={props.instance.folder}
      role="tab"
      aria-selected={props.active}
    >
      <span class="relative flex-shrink-0 w-4 h-4">
        <FolderOpen class="w-full h-full flex-shrink-0 opacity-70" />
        <span class={getStatusDotClass()} />
      </span>
      <span class="truncate">{folderName()}</span>
      <span
        class={cn(
          "opacity-40 hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground rounded p-0.5 transition-all cursor-pointer ml-1",
          "group-hover:opacity-70",
          props.active && "opacity-50",
          "focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-info"
        )}
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
