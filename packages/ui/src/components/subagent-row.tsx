import { Component, createMemo, Show } from "solid-js"
import { Bot } from "lucide-solid"
import type { ToolState } from "@opencode-ai/sdk"
import { readToolStatePayload } from "./tool-call/utils"
import { sessions, setActiveParentSession, setActiveSession } from "../stores/sessions"
import { setActiveInstanceId } from "../stores/instances"
import { cn } from "../lib/cn"
import { Badge } from "./ui"

type ToolCallPart = {
  type: "tool"
  id?: string
  tool?: string
  state?: ToolState
}

interface SubAgentRowProps {
  toolPart: ToolCallPart
  instanceId: string
  sessionId: string
  inGroup?: boolean
}

function extractTaskSessionId(state: ToolState | undefined): string {
  if (!state) return ""
  const metadata = (state as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}
  const directId = metadata?.sessionId ?? metadata?.sessionID
  return typeof directId === "string" ? directId : ""
}

function findTaskSessionLocation(sessionId: string): { sessionId: string; instanceId: string; parentId: string | null } | null {
  if (!sessionId) return null
  const allSessions = sessions()
  for (const [instanceId, sessionMap] of allSessions) {
    const session = sessionMap?.get(sessionId)
    if (session) {
      return {
        sessionId: session.id,
        instanceId,
        parentId: session.parentId ?? null,
      }
    }
  }
  return null
}

function navigateToTaskSession(location: { sessionId: string; instanceId: string; parentId: string | null }) {
  setActiveInstanceId(location.instanceId)
  const parentToActivate = location.parentId ?? location.sessionId
  setActiveParentSession(location.instanceId, parentToActivate)
  if (location.parentId) {
    setActiveSession(location.instanceId, location.sessionId)
  }
}

const SubAgentRow: Component<SubAgentRowProps> = (props) => {
  // Extract task info
  const taskInfo = createMemo(() => {
    const state = props.toolPart.state
    if (!state) return { title: "Sub-Agent", toolCount: 0, status: "pending" as const }

    const { input, metadata } = readToolStatePayload(state)

    // Build title
    const description = typeof input.description === "string" ? input.description : undefined
    const subagentType = typeof input.subagent_type === "string" ? input.subagent_type : undefined
    let title = "Sub-Agent"
    if (description && subagentType) {
      title = `${subagentType}: ${description}`
    } else if (description) {
      title = description
    }

    // Count tools from summary
    const summary = Array.isArray((metadata as any).summary) ? (metadata as any).summary : []
    const toolCount = summary.length

    // Check for approach evaluation
    const hasApproachEvaluation = Boolean((metadata as any).approachEvaluation)

    // Determine overall status
    const status = state.status ?? "pending"

    return { title, toolCount, status, hasApproachEvaluation }
  })

  // Session navigation
  const taskSessionId = createMemo(() => extractTaskSessionId(props.toolPart.state))
  const taskLocation = createMemo(() => taskSessionId() ? findTaskSessionLocation(taskSessionId()) : null)

  const handleGoToSession = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const location = taskLocation()
    if (location) {
      navigateToTaskSession(location)
    }
  }

  // Status indicator
  const statusIndicator = createMemo(() => {
    const status = taskInfo().status
    switch (status) {
      case "running":
        return { icon: "⏳", label: "Running" }
      case "completed":
        return { icon: "✓", label: "Completed" }
      case "error":
        return { icon: "✗", label: "Error" }
      default:
        return { icon: "⏸", label: "Pending" }
    }
  })

  const isNavigable = () => Boolean(taskLocation())

  const statusColor = () => {
    const status = taskInfo().status
    switch (status) {
      case "running": return "text-warning"
      case "completed": return "text-success"
      case "error": return "text-destructive"
      default: return "text-muted-foreground"
    }
  }

  const borderLeftColor = () => {
    const status = taskInfo().status
    switch (status) {
      case "running": return "border-l-warning"
      case "completed": return "border-l-success"
      case "error": return "border-l-destructive"
      default: return "border-l-violet-500"
    }
  }

  return (
    <div
      class={cn(
        "flex items-center gap-2 transition-colors duration-150",
        props.inGroup
          ? "border-none rounded-none bg-transparent m-0 pl-5 px-3 py-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border"
          : cn("rounded-r-md border-l-[3px] bg-secondary px-3 py-2", borderLeftColor()),
        isNavigable() && "cursor-pointer",
        "hover:bg-muted"
      )}
      onClick={isNavigable() ? handleGoToSession : undefined}
      role={isNavigable() ? "button" : undefined}
      title={isNavigable() ? `Go to ${taskInfo().title}` : taskInfo().title}
    >
      <Bot class="flex-shrink-0 text-violet-500" size={16} />
      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-foreground">{taskInfo().title}</span>
      <Show when={taskInfo().hasApproachEvaluation}>
        <Badge variant="info" class="px-1.5 py-0 text-[10px] font-semibold uppercase tracking-tight">
          Planned
        </Badge>
      </Show>
      <span class="flex-shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{taskInfo().toolCount} tools</span>
      <span
        class={cn("w-5 flex-shrink-0 text-center text-sm", statusColor(), taskInfo().status === "running" && "animate-pulse")}
        title={statusIndicator().label}
      >
        {statusIndicator().icon}
      </span>
    </div>
  )
}

export default SubAgentRow
