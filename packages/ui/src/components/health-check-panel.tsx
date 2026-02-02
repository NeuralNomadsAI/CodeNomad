import { Component, For, Show, createResource } from "solid-js"
import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  HelpCircle,
  RefreshCw,
  Stethoscope,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Separator } from "./ui"

const log = getLogger("health-check-panel")

interface HealthCheck {
  name: string
  status: "healthy" | "warning" | "error" | "unknown"
  message: string
}

interface HealthData {
  checks: HealthCheck[]
  overall: string
  timestamp: string
}

interface HealthCheckPanelProps {
  folder?: string
  compact?: boolean
}

const STATUS_CONFIG = {
  healthy: {
    icon: CheckCircle,
    color: "text-success",
    bg: "bg-success/10",
    border: "border-success/20",
    label: "Healthy",
  },
  warning: {
    icon: AlertTriangle,
    color: "text-warning",
    bg: "bg-warning/10",
    border: "border-warning/20",
    label: "Warning",
  },
  error: {
    icon: XCircle,
    color: "text-destructive",
    bg: "bg-destructive/10",
    border: "border-destructive/20",
    label: "Error",
  },
  unknown: {
    icon: HelpCircle,
    color: "text-muted-foreground",
    bg: "bg-muted",
    border: "border-border",
    label: "Unknown",
  },
}

const HealthCheckPanel: Component<HealthCheckPanelProps> = (props) => {
  const [health, { refetch }] = createResource<HealthData | null>(async () => {
    try {
      const params = props.folder ? `?folder=${encodeURIComponent(props.folder)}` : ""
      const res = await fetch(`/api/era/health${params}`)
      if (!res.ok) return null
      return await res.json()
    } catch (err) {
      log.error("Failed to fetch health data", err)
      return null
    }
  })

  const overallConfig = () => {
    const overall = health()?.overall ?? "unknown"
    return STATUS_CONFIG[overall as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.unknown
  }

  return (
    <Card>
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Stethoscope class="h-4 w-4 text-muted-foreground" />
            <CardTitle class="text-sm font-medium">System Health</CardTitle>
          </div>
          <div class="flex items-center gap-2">
            <Show when={health()}>
              {(() => {
                const cfg = overallConfig()
                const Icon = cfg.icon
                return (
                  <Badge variant="outline" class={cn("text-[10px]", cfg.color, cfg.border)}>
                    <Icon class="h-3 w-3 mr-1" />
                    {cfg.label}
                  </Badge>
                )
              })()}
            </Show>
            <Button variant="ghost" size="icon" class="h-6 w-6" onClick={() => refetch()} aria-label="Refresh health checks">
              <RefreshCw class={cn("h-3.5 w-3.5", health.loading && "animate-spin")} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent class="space-y-2">
        <Show when={health.loading && !health()}>
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw class="h-3 w-3 animate-spin" />
            Running health checks...
          </div>
        </Show>

        <Show when={health()}>
          {(data) => (
            <div class="space-y-1.5">
              <For each={data().checks}>
                {(check) => {
                  const cfg = STATUS_CONFIG[check.status] ?? STATUS_CONFIG.unknown
                  const Icon = cfg.icon

                  return (
                    <div
                      class={cn(
                        "flex items-center justify-between rounded-md border px-3 py-2",
                        cfg.bg,
                        cfg.border
                      )}
                    >
                      <div class="flex items-center gap-2">
                        <Icon class={cn("h-3.5 w-3.5", cfg.color)} />
                        <span class="text-xs font-medium capitalize">{check.name}</span>
                      </div>
                      <span class={cn("text-xs", cfg.color)}>{check.message}</span>
                    </div>
                  )
                }}
              </For>

              <Show when={!props.compact}>
                <Separator class="my-2" />
                <p class="text-[10px] text-muted-foreground">
                  Last checked: {new Date(data().timestamp).toLocaleTimeString()}
                </p>
              </Show>
            </div>
          )}
        </Show>

        <Show when={!health.loading && !health()}>
          <p class="text-xs text-muted-foreground">Health check unavailable. Is era-code installed?</p>
        </Show>
      </CardContent>
    </Card>
  )
}

export default HealthCheckPanel
