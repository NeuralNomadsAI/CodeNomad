import { Component, For, Show, createSignal, createResource, createMemo } from "solid-js"
import {
  CheckCircle,
  Circle,
  XCircle,
  Loader2,
  MinusCircle,
  Undo2,
  ChevronDown,
  ChevronRight,
  Clock,
  GitCommit,
  FileText,
  TestTube,
  LayoutList,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Separator } from "./ui"

const log = getLogger("plan-execution-tracker")

// ============================================================================
// Types
// ============================================================================

interface PlanStep {
  id: string
  stepId: string
  name: string
  action: string
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "rolled-back"
  dependsOn: string[]
  parallelGroup?: number
  gateType?: string
  loopIndex?: number
  loopTotal?: number
}

interface PlanCheckpoint {
  stepId: string
  type: "test" | "build" | "lint"
  passed?: number
  failed?: number
  warnings?: number
}

interface StepDetail {
  stepId: string
  commits?: string[]
  filesChanged?: string[]
  timeElapsedMs?: number
  decision?: { rationale: string; alternatives: string[] }
}

interface PlanData {
  id: string
  formulaName: string
  status: "pending" | "running" | "completed" | "failed" | "rolled-back"
  steps: PlanStep[]
  checkpoints?: PlanCheckpoint[]
  details?: StepDetail[]
  createdAt: string
}

interface PlanExecutionTrackerProps {
  planId?: string
  folder?: string
  compact?: boolean
}

// ============================================================================
// Constants
// ============================================================================

const STEP_STATUS_CONFIG = {
  pending: {
    icon: Circle,
    color: "text-muted-foreground",
    bg: "bg-muted/50",
    label: "Pending",
  },
  running: {
    icon: Loader2,
    color: "text-primary",
    bg: "bg-primary/10",
    label: "Running",
    animate: "animate-spin",
  },
  completed: {
    icon: CheckCircle,
    color: "text-success",
    bg: "bg-success/10",
    label: "Done",
  },
  failed: {
    icon: XCircle,
    color: "text-destructive",
    bg: "bg-destructive/10",
    label: "Failed",
  },
  skipped: {
    icon: MinusCircle,
    color: "text-muted-foreground",
    bg: "bg-muted/30",
    label: "Skipped",
  },
  "rolled-back": {
    icon: Undo2,
    color: "text-warning",
    bg: "bg-warning/10",
    label: "Rolled Back",
  },
} as const

// ============================================================================
// Component
// ============================================================================

const PlanExecutionTracker: Component<PlanExecutionTrackerProps> = (props) => {
  const [expandedSteps, setExpandedSteps] = createSignal<Set<string>>(new Set())

  const fetchPlan = async (): Promise<PlanData | null> => {
    try {
      if (!props.planId) return null
      const params = new URLSearchParams()
      if (props.folder) params.set("folder", props.folder)
      params.set("planId", props.planId)
      const resp = await fetch(`/api/era/plans/status?${params}`)
      if (!resp.ok) return null
      const data = await resp.json()
      return data.plan ?? null
    } catch (err) {
      log.error("Failed to fetch plan:", err)
      return null
    }
  }

  const [plan] = createResource(() => props.planId, fetchPlan)

  const progress = createMemo(() => {
    const p = plan()
    if (!p) return { completed: 0, total: 0, percent: 0 }
    const total = p.steps.filter((s) => s.status !== "skipped").length
    const completed = p.steps.filter((s) => s.status === "completed").length
    return { completed, total, percent: total > 0 ? Math.round((completed / total) * 100) : 0 }
  })

  const currentStepId = createMemo(() => {
    const p = plan()
    if (!p) return null
    const running = p.steps.find((s) => s.status === "running")
    return running?.stepId ?? null
  })

  const toggleExpand = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(stepId)) next.delete(stepId)
      else next.add(stepId)
      return next
    })
  }

  const getCheckpoint = (stepId: string): PlanCheckpoint | undefined => {
    return plan()?.checkpoints?.find((c) => c.stepId === stepId)
  }

  const getDetail = (stepId: string): StepDetail | undefined => {
    return plan()?.details?.find((d) => d.stepId === stepId)
  }

  return (
    <Card class="flex flex-col gap-0">
      <CardHeader class="flex flex-row items-center justify-between pb-2">
        <CardTitle class="flex items-center gap-2 text-sm font-semibold">
          <LayoutList class="h-4 w-4 text-primary" />
          Plan Execution
        </CardTitle>
        <Show when={plan()}>
          <Badge
            class={cn(
              "text-[10px]",
              plan()!.status === "completed" && "bg-success/10 text-success",
              plan()!.status === "running" && "bg-primary/10 text-primary",
              plan()!.status === "failed" && "bg-destructive/10 text-destructive",
              plan()!.status === "pending" && "bg-muted text-muted-foreground"
            )}
          >
            {plan()!.status}
          </Badge>
        </Show>
      </CardHeader>

      <CardContent class="flex flex-col gap-3 pt-0">
        <Show
          when={!plan.loading && plan()}
          fallback={
            <p class="text-xs text-muted-foreground">
              {plan.loading ? "Loading plan..." : "No active plan."}
            </p>
          }
        >
          {(_data) => {
            const p = plan()!
            return (
              <>
                {/* Progress Bar */}
                <div class="flex flex-col gap-1">
                  <div class="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{p.formulaName}</span>
                    <span>
                      {progress().completed}/{progress().total} steps ({progress().percent}%)
                    </span>
                  </div>
                  <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      class={cn(
                        "h-full rounded-full transition-all duration-500",
                        p.status === "failed" ? "bg-destructive" : "bg-primary"
                      )}
                      style={{ width: `${progress().percent}%` }}
                    />
                  </div>
                </div>

                <Separator />

                {/* Step Checklist */}
                <div class="flex flex-col gap-0.5">
                  <For each={p.steps}>
                    {(step) => {
                      const config = STEP_STATUS_CONFIG[step.status]
                      const Icon = config.icon
                      const isCurrent = () => currentStepId() === step.stepId
                      const isExpanded = () => expandedSteps().has(step.stepId)
                      const checkpoint = () => getCheckpoint(step.stepId)
                      const detail = () => getDetail(step.stepId)

                      return (
                        <div
                          class={cn(
                            "rounded-md transition-colors",
                            isCurrent() && "bg-primary/5 border border-primary/20"
                          )}
                        >
                          <button
                            class="flex w-full items-center gap-2 px-2 py-1.5 text-left"
                            onClick={() => toggleExpand(step.stepId)}
                          >
                            <Icon
                              class={cn(
                                "h-4 w-4 shrink-0",
                                config.color,
                                "animate" in config && config.animate
                              )}
                            />
                            <span
                              class={cn(
                                "flex-1 text-xs",
                                step.status === "skipped" && "line-through text-muted-foreground",
                                step.status === "completed" && "text-muted-foreground"
                              )}
                            >
                              {step.name}
                              <Show when={step.loopTotal && step.loopTotal > 1}>
                                <span class="text-muted-foreground ml-1">
                                  [{(step.loopIndex ?? 0) + 1}/{step.loopTotal}]
                                </span>
                              </Show>
                            </span>
                            <Show when={step.gateType}>
                              <Badge class="text-[10px] bg-warning/10 text-warning px-1.5 py-0">
                                {step.gateType}
                              </Badge>
                            </Show>
                            {isExpanded() ? (
                              <ChevronDown class="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight class="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </button>

                          {/* Expanded Detail */}
                          <Show when={isExpanded()}>
                            <div class="px-8 pb-2 flex flex-col gap-1.5">
                              <Show when={checkpoint()}>
                                {(_cp) => {
                                  const cp = checkpoint()!
                                  return (
                                    <div class="flex items-center gap-2 text-[10px]">
                                      <TestTube class="h-3 w-3 text-muted-foreground" />
                                      <span class="text-muted-foreground">{cp.type}:</span>
                                      <Show when={cp.passed !== undefined}>
                                        <span class="text-success">{cp.passed} passed</span>
                                      </Show>
                                      <Show when={cp.failed !== undefined && cp.failed > 0}>
                                        <span class="text-destructive">{cp.failed} failed</span>
                                      </Show>
                                      <Show when={cp.warnings !== undefined && cp.warnings > 0}>
                                        <span class="text-warning">{cp.warnings} warnings</span>
                                      </Show>
                                    </div>
                                  )
                                }}
                              </Show>
                              <Show when={detail()}>
                                {(_dt) => {
                                  const dt = detail()!
                                  return (
                                    <>
                                      <Show when={dt.commits && dt.commits.length > 0}>
                                        <div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                          <GitCommit class="h-3 w-3" />
                                          {dt.commits!.length} commit(s)
                                        </div>
                                      </Show>
                                      <Show when={dt.filesChanged && dt.filesChanged.length > 0}>
                                        <div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                          <FileText class="h-3 w-3" />
                                          {dt.filesChanged!.length} file(s) changed
                                        </div>
                                      </Show>
                                      <Show when={dt.timeElapsedMs !== undefined}>
                                        <div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                          <Clock class="h-3 w-3" />
                                          {Math.round(dt.timeElapsedMs! / 1000)}s elapsed
                                        </div>
                                      </Show>
                                      <Show when={dt.decision}>
                                        <div class="mt-1 rounded border border-border bg-muted/30 p-2">
                                          <span class="text-[10px] font-medium">Decision:</span>
                                          <p class="text-[10px] text-muted-foreground mt-0.5">
                                            {dt.decision!.rationale}
                                          </p>
                                        </div>
                                      </Show>
                                    </>
                                  )
                                }}
                              </Show>
                              <Show when={!checkpoint() && !detail()}>
                                <p class="text-[10px] text-muted-foreground italic">
                                  No details available yet.
                                </p>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </>
            )
          }}
        </Show>
      </CardContent>
    </Card>
  )
}

export default PlanExecutionTracker
