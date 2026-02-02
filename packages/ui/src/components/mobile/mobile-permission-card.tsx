import { Component, Show, createMemo } from "solid-js"
import { ShieldAlert } from "lucide-solid"
import { getPermissionQueue, sendPermissionResponse } from "../../stores/instances"
import { getLogger } from "../../lib/logger"

const log = getLogger("mobile-permission")

interface MobilePermissionCardProps {
  instanceId: string
  sessionId: string
}

const MobilePermissionCard: Component<MobilePermissionCardProps> = (props) => {
  const queue = createMemo(() => getPermissionQueue(props.instanceId))
  const pendingCount = createMemo(() => queue().length)
  const currentPermission = createMemo(() => queue()[0] ?? null)

  const permissionType = createMemo(() => {
    const p = currentPermission()
    if (!p) return ""
    return (p as any).permission ?? p.type ?? "unknown"
  })

  const permissionPath = createMemo(() => {
    const p = currentPermission()
    if (!p) return ""
    return (p as any).params?.path ?? (p as any).input?.path ?? ""
  })

  const handleAllow = async () => {
    const p = currentPermission()
    if (!p) return
    try {
      await sendPermissionResponse(props.instanceId, props.sessionId, p.id, "once")
    } catch (error) {
      log.error("Failed to allow permission", error)
    }
  }

  const handleAllowAlways = async () => {
    const p = currentPermission()
    if (!p) return
    try {
      await sendPermissionResponse(props.instanceId, props.sessionId, p.id, "always")
    } catch (error) {
      log.error("Failed to allow-all permission", error)
    }
  }

  const handleDeny = async () => {
    const p = currentPermission()
    if (!p) return
    try {
      await sendPermissionResponse(props.instanceId, props.sessionId, p.id, "reject")
    } catch (error) {
      log.error("Failed to deny permission", error)
    }
  }

  return (
    <Show when={currentPermission()}>
      <div
        class="shrink-0 border-t border-warning/30 bg-card px-3 py-3 animate-in slide-in-from-bottom-2 duration-200"
        data-testid="mobile-permission-card"
      >
        <div class="flex items-center gap-2 mb-2">
          <ShieldAlert class="w-4 h-4 text-warning shrink-0" />
          <span class="text-sm font-medium text-warning">Permission Required</span>
          <Show when={pendingCount() > 1}>
            <span class="text-xs bg-destructive text-destructive-foreground px-1.5 py-0.5 rounded-full font-bold">
              {pendingCount()} pending
            </span>
          </Show>
        </div>

        {/* Show type and path separately for better readability */}
        <div class="mb-3 space-y-0.5">
          <div class="text-xs font-medium text-foreground">{permissionType()}</div>
          <Show when={permissionPath()}>
            <div class="text-xs text-muted-foreground truncate" title={permissionPath()}>
              {permissionPath()}
            </div>
          </Show>
        </div>

        <div class="flex flex-col gap-2">
          <div class="flex gap-2">
            <button
              type="button"
              class="flex-1 min-h-[48px] px-4 py-2 rounded-md text-sm font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/70 transition-colors"
              onClick={handleDeny}
            >
              Deny
            </button>
            <button
              type="button"
              class="flex-1 min-h-[48px] px-4 py-2 rounded-md text-sm font-semibold bg-success text-success-foreground hover:bg-success/90 active:bg-success/80 transition-colors"
              onClick={handleAllow}
            >
              Allow
            </button>
          </div>
          <button
            type="button"
            class="w-full min-h-[48px] px-4 py-2 rounded-md text-sm font-medium bg-accent text-accent-foreground hover:bg-accent/80 active:bg-accent/70 transition-colors"
            onClick={handleAllowAlways}
          >
            Allow All for Session
          </button>
        </div>
      </div>
    </Show>
  )
}

export default MobilePermissionCard
