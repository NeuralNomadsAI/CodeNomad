import { Component, For, Show, createSignal, createRoot } from "solid-js"
import {
  RefreshCw,
  AlertTriangle,
  Shield,
  Gauge,
  X,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Button, Badge } from "./ui"

const log = getLogger("governance-toast")

export type GovernanceNotificationType = "directive-sync" | "audit-issue" | "constitution-update" | "context-warning"

export interface GovernanceNotification {
  id: string
  type: GovernanceNotificationType
  title: string
  message: string
  severity: "info" | "warning" | "critical"
  timestamp: string
  autoDismissMs?: number
  actionLabel?: string
  onAction?: () => void
}

interface GovernanceToastProps {
  maxVisible?: number
}

const NOTIFICATION_CONFIG = {
  "directive-sync": { icon: RefreshCw, color: "border-primary/30 bg-primary/5", iconColor: "text-primary" },
  "audit-issue": { icon: AlertTriangle, color: "border-warning/30 bg-warning/5", iconColor: "text-warning" },
  "constitution-update": { icon: Shield, color: "border-purple-400/30 bg-purple-400/5", iconColor: "text-purple-400" },
  "context-warning": { icon: Gauge, color: "border-warning/30 bg-warning/5", iconColor: "text-warning" },
} as const

// ============================================================================
// Store (module-level for cross-component access)
// ============================================================================

let notifications: () => GovernanceNotification[]
let setNotifications: (fn: GovernanceNotification[] | ((prev: GovernanceNotification[]) => GovernanceNotification[])) => void

createRoot(() => {
  const [_n, _sn] = createSignal<GovernanceNotification[]>([])
  notifications = _n
  setNotifications = _sn
})

const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function pushNotification(notification: GovernanceNotification): void {
  setNotifications((prev) => {
    // De-duplicate: replace existing notification of same type
    const filtered = prev.filter((n) => n.type !== notification.type)
    return [...filtered, notification].slice(-10) // keep max 10 in queue
  })

  // Auto-dismiss
  if (notification.autoDismissMs && notification.severity !== "critical") {
    // Clear existing timer for same id
    const existing = autoDismissTimers.get(notification.id)
    if (existing) clearTimeout(existing)
    const timerId = setTimeout(() => dismissNotification(notification.id), notification.autoDismissMs)
    autoDismissTimers.set(notification.id, timerId)
  }
}

export function dismissNotification(id: string): void {
  const timer = autoDismissTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    autoDismissTimers.delete(id)
  }
  setNotifications((prev) => prev.filter((n) => n.id !== id))
}

export function clearNotifications(): void {
  for (const timer of autoDismissTimers.values()) clearTimeout(timer)
  autoDismissTimers.clear()
  setNotifications([])
}

// ============================================================================
// Component
// ============================================================================

const GovernanceToast: Component<GovernanceToastProps> = (props) => {
  const maxVisible = () => props.maxVisible ?? 3
  const visible = () => notifications().slice(-maxVisible())

  return (
    <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80">
      <For each={visible()}>
        {(notif) => {
          const config = NOTIFICATION_CONFIG[notif.type]
          const Icon = config.icon
          return (
            <div
              class={cn(
                "flex items-start gap-2.5 rounded-lg border p-3 shadow-lg animate-in slide-in-from-right",
                config.color
              )}
            >
              <Icon class={cn("h-4 w-4 shrink-0 mt-0.5", config.iconColor)} />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-semibold">{notif.title}</span>
                  <Show when={notif.severity === "critical"}>
                    <Badge class="text-[9px] bg-destructive/10 text-destructive px-1 py-0">critical</Badge>
                  </Show>
                </div>
                <p class="text-[11px] text-muted-foreground mt-0.5">{notif.message}</p>
                <Show when={notif.actionLabel && notif.onAction}>
                  <Button
                    variant="outline"
                    size="sm"
                    class="mt-1.5 h-6 text-[10px] px-2"
                    onClick={() => notif.onAction?.()}
                  >
                    {notif.actionLabel}
                  </Button>
                </Show>
              </div>
              <button
                class="shrink-0 rounded p-0.5 hover:bg-muted/50 transition-colors"
                onClick={() => dismissNotification(notif.id)}
                aria-label="Dismiss notification"
              >
                <X class="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          )
        }}
      </For>
    </div>
  )
}

export default GovernanceToast
