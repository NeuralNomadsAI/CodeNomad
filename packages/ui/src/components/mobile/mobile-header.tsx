import { Component, Show } from "solid-js"
import { MoreHorizontal } from "lucide-solid"
import { cn } from "../../lib/cn"

export type MobileHeaderStatus = "connected" | "working" | "warning" | "error" | "idle"

interface MobileHeaderProps {
  projectName: string
  sessionTitle?: string
  status: MobileHeaderStatus
  onOverflowClick: () => void
}

const statusDotClass = (status: MobileHeaderStatus) => {
  switch (status) {
    case "connected":
    case "idle":
      return "bg-success"
    case "working":
      return "bg-info animate-activity-dot-pulse"
    case "warning":
      return "bg-warning"
    case "error":
      return "bg-destructive"
  }
}

const MobileHeader: Component<MobileHeaderProps> = (props) => {
  return (
    <header
      data-mobile-header
      class="shrink-0 flex items-center gap-2 px-3 min-h-[44px] bg-card border-b border-border"
      style={{ "padding-top": "env(safe-area-inset-top, 0px)" }}
    >
      <span class="text-sm font-semibold text-foreground truncate min-w-0 shrink">
        {props.projectName}
      </span>
      <Show when={props.sessionTitle}>
        <span class="text-muted-foreground text-xs truncate flex-1 min-w-0">{props.sessionTitle}</span>
      </Show>
      <Show when={!props.sessionTitle}>
        <span class="flex-1 text-xs text-muted-foreground/50 truncate min-w-0">No active session</span>
      </Show>
      <span class={cn("w-2 h-2 rounded-full shrink-0", statusDotClass(props.status))} />
      <button
        type="button"
        class="inline-flex items-center justify-center w-11 h-11 -mr-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        onClick={props.onOverflowClick}
        aria-label="More options"
      >
        <MoreHorizontal class="w-5 h-5" />
      </button>
    </header>
  )
}

export default MobileHeader
