import { For } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import type { ToolRenderer } from "../types"
import { getRelativePath, getToolIcon, getToolName, readToolStatePayload } from "../utils"

interface TaskSummaryItem {
  id: string
  tool: string
  input: Record<string, any>
}

const taskSummaryCache = new Map<string, { signature: string; items: TaskSummaryItem[] }>()

function normalizeTaskSummary(state?: ToolState, toolCallId?: string): TaskSummaryItem[] {
  if (!state) return []
  const { metadata } = readToolStatePayload(state)
  const rawSummary = Array.isArray((metadata as any).summary) ? ((metadata as any).summary as any[]) : []
  if (rawSummary.length === 0) {
    if (toolCallId) taskSummaryCache.delete(toolCallId)
    return []
  }

  const signature = JSON.stringify(rawSummary)
  if (toolCallId) {
    const cached = taskSummaryCache.get(toolCallId)
    if (cached && cached.signature === signature) {
      return cached.items
    }
  }

  const normalized: TaskSummaryItem[] = rawSummary.map((entry, index) => {
    const tool = typeof entry?.tool === "string" ? (entry.tool as string) : "unknown"
    const input = typeof (entry as any)?.state?.input === "object" && entry.state?.input ? entry.state.input : {}
    const id = typeof entry?.id === "string" && entry.id.length > 0 ? entry.id : `${tool}-${index}`
    return { id, tool, input }
  })

  if (toolCallId) {
    taskSummaryCache.set(toolCallId, { signature, items: normalized })
  }

  return normalized
}

function describeTaskItem(item: TaskSummaryItem): string {
  const input = item.input || {}
  switch (item.tool) {
    case "bash":
      return typeof input.description === "string" ? input.description : input.command || "bash"
    case "edit":
    case "read":
    case "write":
      return `${item.tool} ${getRelativePath(typeof input.filePath === "string" ? input.filePath : "")}`.trim()
    default:
      return item.tool
  }
}

export const taskRenderer: ToolRenderer = {
  tools: ["task"],
  getAction: () => "Delegating...",
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    const description = input.description
    const subagent = input.subagent_type
    const base = getToolName("task")
    if (description && subagent) {
      return `${base}[${subagent}] ${description}`
    }
    if (description) {
      return `${base} ${description}`
    }
    return base
  },
  renderBody({ toolState, toolCall }) {
    const state = toolState()
    if (!state) return null

    const items = normalizeTaskSummary(state, toolCall().id || "__unknown__")
    if (items.length === 0) return null

    return (
      <div class="message-text tool-call-markdown tool-call-task-container">
        <div class="tool-call-task-summary">
          <For each={items}>
            {(item) => {
              const icon = getToolIcon(item.tool)
              const description = describeTaskItem(item)
              return (
                <div class="tool-call-task-item" data-task-id={item.id}>
                  <span class="tool-call-task-icon">{icon}</span>
                  <span class="tool-call-task-text">{description}</span>
                </div>
              )
            }}
          </For>
        </div>
      </div>
    )
  },
}
