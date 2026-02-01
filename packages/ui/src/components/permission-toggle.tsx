import { Component, Show, createMemo } from "solid-js"
import { ShieldCheck, ShieldOff, RotateCcw } from "lucide-solid"
import { cn } from "../lib/cn"
import {
  getEffectivePermissionState,
  hasSessionPermissionOverride,
  toggleSessionPermission,
  clearSessionPermissionOverride,
} from "../stores/session-permissions"

interface PermissionToggleProps {
  instanceId: string
  sessionId: string
}

const PermissionToggle: Component<PermissionToggleProps> = (props) => {
  const isAutoApprove = createMemo(() =>
    getEffectivePermissionState(props.instanceId, props.sessionId)
  )

  const hasOverride = createMemo(() =>
    hasSessionPermissionOverride(props.instanceId, props.sessionId)
  )

  const handleToggle = () => {
    toggleSessionPermission(props.instanceId, props.sessionId)
  }

  const handleReset = (e: Event) => {
    e.stopPropagation()
    clearSessionPermissionOverride(props.instanceId, props.sessionId)
  }

  return (
    <div class="flex flex-col gap-1.5 w-full">
      <label class="text-xs font-semibold uppercase tracking-wide block text-muted-foreground">Permissions</label>
      <div class="flex items-center gap-2">
        <button
        type="button"
        class={cn(
          "flex-1 flex items-center gap-2.5 px-2.5 py-1.5 rounded border transition-colors cursor-pointer",
          isAutoApprove()
            ? "border-success/50 bg-success/10 text-success hover:bg-success/15"
            : "border-border bg-background text-muted-foreground hover:bg-accent"
        )}
        onClick={handleToggle}
        title={isAutoApprove() ? "Auto-approve enabled - click to disable" : "Manual approval - click to enable auto-approve"}
      >
        <div class="flex-shrink-0">
          {isAutoApprove() ? (
            <ShieldCheck class="w-4 h-4" />
          ) : (
            <ShieldOff class="w-4 h-4" />
          )}
        </div>
        <div class="flex items-center gap-1.5 text-sm font-medium">
          <span>{isAutoApprove() ? "Auto-approve" : "Manual"}</span>
          <Show when={hasOverride()}>
            <span class="text-xs font-normal text-muted-foreground">(override)</span>
          </Show>
        </div>
      </button>
      <Show when={hasOverride()}>
        <button
          type="button"
          class="p-1.5 rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          onClick={handleReset}
          title="Reset to inherited setting"
        >
          <RotateCcw class="w-3.5 h-3.5" />
        </button>
      </Show>
      </div>
    </div>
  )
}

export default PermissionToggle
