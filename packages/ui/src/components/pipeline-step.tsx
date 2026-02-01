import { Component, createMemo, Show } from "solid-js"
import type { ToolDisplayItem } from "./inline-tool-call"
import { readToolStatePayload } from "./tool-call/utils"
import { cn } from "../lib/cn"
import { Badge } from "./ui"

/** Known pipeline agent types and their display metadata */
const PIPELINE_AGENT_META: Record<string, { label: string; icon: string }> = {
  coder: { label: "Code", icon: "🔨" },
  "test-writer": { label: "Test", icon: "🧪" },
  reviewer: { label: "Review", icon: "📋" },
}

export type ReviewVerdict = "APPROVE" | "REJECT" | null

/**
 * Extract the reviewer verdict from a task tool's output metadata.
 *
 * Uses a 3-tier priority system to avoid false positives:
 *  1. Structured "VERDICT: APPROVE/REJECT" format (most reliable)
 *  2. Line-start standalone verdict (e.g., "## APPROVE" on its own line)
 *  3. Markdown bold verdict markers (e.g., "**APPROVE**")
 *
 * Bare word matching (e.g., /\bAPPROVE\b/) is intentionally excluded
 * because it produces false positives on casual mentions like
 * "I approve of the general direction."
 */
export function extractReviewerVerdict(tool: ToolDisplayItem): ReviewVerdict {
  const state = tool.toolPart.state
  if (!state) return null
  const { metadata } = readToolStatePayload(state)
  const output = typeof (metadata as any).output === "string" ? (metadata as any).output : ""
  const stateOutput = typeof (state as any).output === "string" ? (state as any).output : ""
  const text = output || stateOutput
  if (!text) return null

  // Priority 1: Structured VERDICT: format (most reliable)
  if (/\bVERDICT:\s*APPROVE\b/i.test(text)) return "APPROVE"
  if (/\bVERDICT:\s*REJECT\b/i.test(text)) return "REJECT"

  // Priority 2: Line-start verdict (standalone on its own line, optional markdown heading)
  if (/^#{0,3}\s*APPROVE[D]?\s*$/mi.test(text)) return "APPROVE"
  if (/^#{0,3}\s*REJECT(?:ED)?\s*$/mi.test(text)) return "REJECT"

  // Priority 3: Markdown bold verdict markers
  if (/\*\*APPROVE[D]?\*\*/i.test(text)) return "APPROVE"
  if (/\*\*REJECT(?:ED)?\*\*/i.test(text)) return "REJECT"

  return null
}

/** Detect if a sequence of sub-agent tools forms a known pipeline pattern */
export function detectPipelinePattern(tools: ToolDisplayItem[]): string | null {
  if (tools.length < 2) return null
  const agentTypes = tools.map((t) => {
    const state = t.toolPart.state
    if (!state) return null
    const { input } = readToolStatePayload(state)
    return typeof input.subagent_type === "string" ? input.subagent_type : null
  })

  // Check for coder -> test-writer -> reviewer (full pipeline)
  if (agentTypes.length >= 3) {
    for (let i = 0; i <= agentTypes.length - 3; i++) {
      if (agentTypes[i] === "coder" && agentTypes[i + 1] === "test-writer" && agentTypes[i + 2] === "reviewer") {
        return "implementation-pipeline"
      }
    }
  }
  // Check for coder -> reviewer (no test writer)
  if (agentTypes.length >= 2) {
    for (let i = 0; i <= agentTypes.length - 2; i++) {
      if (agentTypes[i] === "coder" && agentTypes[i + 1] === "reviewer") {
        return "code-review-pipeline"
      }
    }
  }
  // Check for coder -> test-writer (no reviewer)
  if (agentTypes.length >= 2) {
    for (let i = 0; i <= agentTypes.length - 2; i++) {
      if (agentTypes[i] === "coder" && agentTypes[i + 1] === "test-writer") {
        return "code-test-pipeline"
      }
    }
  }
  return null
}

interface PipelineStepProps {
  tool: ToolDisplayItem
  isLast: boolean
  instanceId: string
  sessionId: string
}

const PipelineStep: Component<PipelineStepProps> = (props) => {
  const agentType = createMemo(() => {
    const state = props.tool.toolPart.state
    if (!state) return null
    const { input } = readToolStatePayload(state)
    return typeof input.subagent_type === "string" ? input.subagent_type : null
  })

  const meta = createMemo(() => {
    const type = agentType()
    return type && PIPELINE_AGENT_META[type] ? PIPELINE_AGENT_META[type] : { label: type || "Agent", icon: "⚙" }
  })

  const description = createMemo(() => {
    const state = props.tool.toolPart.state
    if (!state) return ""
    const { input } = readToolStatePayload(state)
    return typeof input.description === "string" ? input.description : ""
  })

  const status = createMemo(() => {
    return props.tool.toolPart.state?.status ?? "pending"
  })

  const statusIcon = createMemo(() => {
    switch (status()) {
      case "running": return "⏳"
      case "completed": return "✓"
      case "error": return "✗"
      default: return "⏸"
    }
  })

  const verdict = createMemo<ReviewVerdict>(() => {
    const type = agentType()
    if (type !== "reviewer") return null
    return extractReviewerVerdict(props.tool)
  })

  const connectorColor = () => {
    switch (status()) {
      case "completed": return "bg-success"
      case "running": return "bg-warning"
      case "error": return "bg-destructive"
      default: return "bg-border"
    }
  }

  return (
    <div class="flex gap-3 px-3 py-1 pl-4">
      <div class="flex w-6 flex-shrink-0 flex-col items-center">
        <span class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-center text-sm leading-6">
          {meta().icon}
        </span>
        <Show when={!props.isLast}>
          <div class={cn("mt-0.5 min-h-[8px] w-0.5 flex-1", connectorColor())} />
        </Show>
      </div>
      <div class="min-w-0 flex-1 pb-2">
        <div class="flex items-center gap-2">
          <span class="text-[13px] font-semibold text-foreground">{meta().label}</span>
          <span
            class={cn(
              "flex-shrink-0 text-[13px]",
              status() === "completed" && "text-success",
              status() === "running" && "text-warning animate-pulse",
              status() === "error" && "text-destructive",
              status() === "pending" && "text-muted-foreground"
            )}
          >
            {statusIcon()}
          </span>
          <Show when={verdict()}>
            <Badge
              variant={verdict()!.toLowerCase() === "approve" ? "success" : "destructive"}
              class="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
            >
              {verdict()}
            </Badge>
          </Show>
        </div>
        <Show when={description()}>
          <div class="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">{description()}</div>
        </Show>
      </div>
    </div>
  )
}

export default PipelineStep
