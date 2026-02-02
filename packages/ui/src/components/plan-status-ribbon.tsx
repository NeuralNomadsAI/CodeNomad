import { Component, createMemo, Show } from "solid-js"
import { cn } from "../lib/cn"
import { messageStoreBus } from "../stores/message-v2/bus"
import { readToolStatePayload } from "./tool-call/utils"

export type PlanPhase = "planning" | "reviewing" | "executing" | null

interface PlanStatusRibbonProps {
  instanceId: string
  sessionId: string
}

const PHASES: { key: PlanPhase; label: string; icon: string }[] = [
  { key: "planning", label: "Planning", icon: "\u{1F4DD}" },
  { key: "reviewing", label: "Reviewing", icon: "\u{1F50D}" },
  { key: "executing", label: "Executing", icon: "\u26A1" },
]

/**
 * Detect the active plan phase by scanning session tool calls for agent types.
 * - If a "plan" agent task is running -> "planning"
 * - If a "reviewer" agent task is running -> "reviewing"
 * - If a "coder"/"test-writer" task is running after a plan -> "executing"
 * Returns null if no plan workflow is detected.
 */
function detectPlanPhase(instanceId: string, sessionId: string): PlanPhase {
  const store = messageStoreBus.getOrCreate(instanceId)
  const messageIds = store.getSessionMessageIds(sessionId)

  let hasPlanAgent = false
  let hasReviewerRunning = false
  let hasExecutorRunning = false
  let hasPlanCompleted = false

  for (const msgId of messageIds) {
    const msg = store.getMessage(msgId)
    if (!msg) continue

    for (const partId of msg.partIds) {
      const part = msg.parts[partId]?.data
      if (!part || part.type !== "tool") continue

      const toolPart = part as any
      if (toolPart.tool !== "task") continue

      const state = toolPart.state
      if (!state) continue

      const { input } = readToolStatePayload(state)
      const agentType = input.subagent_type || input.agent_type || ""
      const status = state.status

      if (agentType === "plan") {
        hasPlanAgent = true
        if (status === "completed") hasPlanCompleted = true
        if (status === "running") return "planning"
      }
      if (agentType === "reviewer" && status === "running") {
        hasReviewerRunning = true
      }
      if (
        (agentType === "coder" || agentType === "test-writer") &&
        status === "running"
      ) {
        hasExecutorRunning = true
      }
    }
  }

  if (hasReviewerRunning) return "reviewing"
  if (hasExecutorRunning && hasPlanAgent) return "executing"
  if (hasPlanCompleted && !hasExecutorRunning && !hasReviewerRunning) return null

  return null
}

const PlanStatusRibbon: Component<PlanStatusRibbonProps> = (props) => {
  const phase = createMemo(() => detectPlanPhase(props.instanceId, props.sessionId))

  return (
    <Show when={phase()}>
      <div class="flex items-center gap-0 px-4 py-1 bg-secondary border-b border-border text-xs">
        {PHASES.map((p, i) => {
          const isActive = () => phase() === p.key
          const isPast = () => {
            const current = PHASES.findIndex((x) => x.key === phase())
            return i < current
          }

          return (
            <>
              {i > 0 && (
                <span
                  class={cn(
                    "mx-1.5 text-[10px]",
                    isPast() || isActive()
                      ? "text-info"
                      : "text-muted-foreground/40",
                  )}
                >
                  {"\u2192"}
                </span>
              )}
              <span
                class={cn(
                  "inline-flex items-center gap-1 px-2 py-0.5 rounded-full transition-all duration-300",
                  isActive() &&
                    "bg-info/15 text-info font-semibold ring-1 ring-info/30",
                  isPast() && "text-success",
                  !isActive() && !isPast() && "text-muted-foreground/50",
                )}
              >
                <span class="text-[11px]">{p.icon}</span>
                <span>{p.label}</span>
                {isActive() && (
                  <span class="inline-block w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
                )}
              </span>
            </>
          )
        })}
      </div>
    </Show>
  )
}

export default PlanStatusRibbon
