import { Component, For, Show, createResource } from "solid-js"
import {
  CheckCircle,
  Circle,
  Loader2,
  XCircle,
  RefreshCw,
  ShieldCheck,
  Clock,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Progress } from "./ui"

const log = getLogger("verification-pipeline-status")

interface PipelinePhase {
  name: string
  status: "idle" | "running" | "passed" | "failed" | "skipped"
  duration: number | null
}

interface PipelineData {
  phases: PipelinePhase[]
  overall: string
  lastRun: string | null
}

interface VerificationPipelineStatusProps {
  folder?: string
  compact?: boolean
}

const PHASE_ICONS: Record<string, Component<{ class?: string }>> = {
  idle: (p) => <Circle class={p.class} />,
  running: (p) => <Loader2 class={cn(p.class, "animate-spin")} />,
  passed: (p) => <CheckCircle class={p.class} />,
  failed: (p) => <XCircle class={p.class} />,
  skipped: (p) => <Circle class={cn(p.class, "opacity-40")} />,
}

const PHASE_COLORS: Record<string, string> = {
  idle: "text-muted-foreground",
  running: "text-info",
  passed: "text-success",
  failed: "text-destructive",
  skipped: "text-muted-foreground/50",
}

const PHASE_LABELS: Record<string, string> = {
  analyze: "Analyze",
  preview: "Preview",
  verify: "Verify",
  apply: "Apply",
}

const VerificationPipelineStatus: Component<VerificationPipelineStatusProps> = (props) => {
  const [pipeline, { refetch }] = createResource<PipelineData | null>(async () => {
    try {
      const params = props.folder ? `?folder=${encodeURIComponent(props.folder)}` : ""
      const res = await fetch(`/api/era/verification/status${params}`)
      if (!res.ok) return null
      return await res.json()
    } catch (err) {
      log.log("Failed to fetch verification status", err)
      return null
    }
  })

  const completedCount = () => {
    const phases = pipeline()?.phases ?? []
    return phases.filter((p) => p.status === "passed" || p.status === "skipped").length
  }

  const totalPhases = () => pipeline()?.phases?.length ?? 0

  const progress = () => {
    if (totalPhases() === 0) return 0
    return Math.round((completedCount() / totalPhases()) * 100)
  }

  const isRunning = () => pipeline()?.phases?.some((p) => p.status === "running") ?? false

  const overallBadge = () => {
    const overall = pipeline()?.overall ?? "idle"
    switch (overall) {
      case "passed":
        return { label: "Verified", color: "text-success border-success/20" }
      case "failed":
        return { label: "Failed", color: "text-destructive border-destructive/20" }
      case "running":
        return { label: "Running", color: "text-info border-info/20" }
      default:
        return { label: "Idle", color: "text-muted-foreground border-border" }
    }
  }

  return (
    <Card>
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <ShieldCheck class="h-4 w-4 text-muted-foreground" />
            <CardTitle class="text-sm font-medium">Verification Pipeline</CardTitle>
            <Show when={pipeline()}>
              {(_data) => {
                const badge = overallBadge()
                return (
                  <Badge variant="outline" class={cn("text-[10px]", badge.color)}>
                    {badge.label}
                  </Badge>
                )
              }}
            </Show>
          </div>
          <Button variant="ghost" size="icon" class="h-6 w-6" onClick={() => refetch()} aria-label="Refresh verification status">
            <RefreshCw class={cn("h-3.5 w-3.5", pipeline.loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent class="space-y-3">
        <Show when={pipeline.loading && !pipeline()}>
          <div class="flex items-center gap-2 text-xs text-muted-foreground py-2 justify-center">
            <RefreshCw class="h-3 w-3 animate-spin" />
            Loading status...
          </div>
        </Show>

        <Show when={pipeline()}>
          {(data) => (
            <>
              {/* Progress bar */}
              <Show when={isRunning()}>
                <Progress value={progress()} class="h-1.5" />
              </Show>

              {/* Pipeline phases */}
              <div class="space-y-1">
                <For each={data().phases}>
                  {(phase, i) => {
                    const Icon = PHASE_ICONS[phase.status] ?? PHASE_ICONS.idle
                    const color = PHASE_COLORS[phase.status] ?? PHASE_COLORS.idle
                    const label = PHASE_LABELS[phase.name] ?? phase.name

                    return (
                      <div
                        class={cn(
                          "flex items-center justify-between rounded-md px-3 py-1.5",
                          phase.status === "running" && "bg-info/5 border border-info/20",
                          phase.status === "failed" && "bg-destructive/5 border border-destructive/20",
                          phase.status === "passed" && "bg-success/5",
                          (phase.status === "idle" || phase.status === "skipped") && "opacity-60"
                        )}
                      >
                        <div class="flex items-center gap-2">
                          <div class="flex items-center justify-center w-5 h-5">
                            <span class="text-[10px] text-muted-foreground font-mono">{i() + 1}</span>
                          </div>
                          <Icon class={cn("h-3.5 w-3.5", color)} />
                          <span class={cn("text-xs font-medium", color)}>
                            {label}
                          </span>
                        </div>
                        <Show when={phase.duration !== null}>
                          <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Clock class="h-2.5 w-2.5" />
                            {phase.duration}ms
                          </div>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>

              {/* Last run info */}
              <Show when={data().lastRun && !props.compact}>
                <p class="text-[10px] text-muted-foreground">
                  Last run: {new Date(data().lastRun!).toLocaleString()}
                </p>
              </Show>
            </>
          )}
        </Show>

        <Show when={!pipeline.loading && !pipeline()}>
          <div class="text-center py-4">
            <ShieldCheck class="h-6 w-6 text-muted-foreground mx-auto mb-2" />
            <p class="text-xs text-muted-foreground">
              No verification pipeline status available.
            </p>
          </div>
        </Show>
      </CardContent>
    </Card>
  )
}

export default VerificationPipelineStatus
