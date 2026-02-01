import { Component, createMemo, createSignal, For, Show } from "solid-js"
import { ChevronDown, ChevronRight } from "lucide-solid"
import PipelineStep, { extractReviewerVerdict } from "./pipeline-step"
import type { ToolDisplayItem } from "./inline-tool-call"
import { readToolStatePayload } from "./tool-call/utils"
import { cn } from "../lib/cn"
import { Badge } from "./ui"

const PIPELINE_NAMES: Record<string, string> = {
  "implementation-pipeline": "Implementation Pipeline",
  "code-review-pipeline": "Code & Review",
  "code-test-pipeline": "Code & Test",
}

interface PipelineGroupProps {
  tools: ToolDisplayItem[]
  patternName: string
  instanceId: string
  sessionId: string
}

const PipelineGroup: Component<PipelineGroupProps> = (props) => {
  const [expanded, setExpanded] = createSignal(true)

  const pipelineLabel = () => PIPELINE_NAMES[props.patternName] ?? "Pipeline"

  const overallStatus = createMemo(() => {
    const tools = props.tools
    const hasError = tools.some((t) => t.toolPart.state?.status === "error")
    if (hasError) return "error"
    const hasRunning = tools.some((t) => t.toolPart.state?.status === "running")
    if (hasRunning) return "running"
    const allCompleted = tools.every((t) => t.toolPart.state?.status === "completed")
    if (allCompleted) return "completed"
    return "pending"
  })

  const reviewerVerdict = createMemo(() => {
    const reviewerTool = props.tools.find((t) => {
      const state = t.toolPart.state
      if (!state) return false
      const { input } = readToolStatePayload(state)
      return input.subagent_type === "reviewer"
    })
    if (!reviewerTool) return null
    return extractReviewerVerdict(reviewerTool)
  })

  const statusIcon = createMemo(() => {
    switch (overallStatus()) {
      case "running": return "⏳"
      case "completed": return "✓"
      case "error": return "✗"
      default: return "⏸"
    }
  })

  const borderColor = () => {
    switch (overallStatus()) {
      case "completed": return "border-l-success"
      case "running": return "border-l-warning"
      case "error": return "border-l-destructive"
      default: return "border-l-info"
    }
  }

  return (
    <div
      class={cn(
        "my-2 flex flex-col overflow-hidden rounded-r-md border-l-[3px] bg-secondary",
        borderColor()
      )}
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 border-none bg-transparent px-3 py-2.5 text-left text-foreground transition-colors duration-150 cursor-pointer hover:bg-muted"
        onClick={() => setExpanded(!expanded())}
        aria-expanded={expanded()}
      >
        <span class="flex flex-shrink-0 items-center justify-center text-muted-foreground">
          {expanded() ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span class="flex-shrink-0 text-sm">⛓</span>
        <span class="text-[13px] font-semibold text-info">{pipelineLabel()}</span>
        <span
          class={cn(
            "w-5 flex-shrink-0 text-center text-sm",
            overallStatus() === "completed" && "text-success",
            overallStatus() === "running" && "text-warning animate-pulse",
            overallStatus() === "error" && "text-destructive",
            overallStatus() === "pending" && "text-muted-foreground"
          )}
        >
          {statusIcon()}
        </span>
        <Show when={reviewerVerdict()}>
          <Badge
            variant={reviewerVerdict()!.toLowerCase() === "approve" ? "success" : "destructive"}
            class="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
          >
            {reviewerVerdict()}
          </Badge>
        </Show>
        <span class="ml-auto font-mono text-xs text-muted-foreground">{props.tools.length} steps</span>
      </button>

      <Show when={expanded()}>
        <div class="flex flex-col py-1 pb-2">
          <For each={props.tools}>
            {(tool, index) => (
              <PipelineStep
                tool={tool}
                isLast={index() === props.tools.length - 1}
                instanceId={props.instanceId}
                sessionId={props.sessionId}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export default PipelineGroup
