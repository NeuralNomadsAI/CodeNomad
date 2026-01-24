import { For, Show, createMemo } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, getDefaultToolAction, getToolIcon, getToolName, readToolStatePayload } from "../utils"
import { resolveTitleForTool } from "../tool-title"

interface TaskSummaryItem {
  id: string
  tool: string
  input: Record<string, any>
  metadata: Record<string, any>
  state?: ToolState
  status?: ToolState["status"]
  title?: string
}

function normalizeStatus(status?: string | null): ToolState["status"] | undefined {
  if (status === "pending" || status === "running" || status === "completed" || status === "error") {
    return status
  }
  return undefined
}

function summarizeStatusIcon(status?: ToolState["status"]) {
  switch (status) {
    case "pending":
      return "⏸"
    case "running":
      return "⏳"
    case "completed":
      return "✓"
    case "error":
      return "✗"
    default:
      return ""
  }
}

function summarizeStatusLabel(status?: ToolState["status"]) {
  switch (status) {
    case "pending":
      return "Pending"
    case "running":
      return "Running"
    case "completed":
      return "Completed"
    case "error":
      return "Error"
    default:
      return "Unknown"
  }
}

function describeTaskTitle(input: Record<string, any>) {
  const description = typeof input.description === "string" ? input.description : undefined
  const subagent = typeof input.subagent_type === "string" ? input.subagent_type : undefined
  const base = getToolName("task")
  if (description && subagent) {
    return `${base}[${subagent}] ${description}`
  }
  if (description) {
    return `${base} ${description}`
  }
  return base
}

function describeToolTitle(item: TaskSummaryItem): string {
  if (item.title && item.title.length > 0) {
    return item.title
  }

  if (item.tool === "task") {
    return describeTaskTitle({ ...item.metadata, ...item.input })
  }

  if (item.state) {
    return resolveTitleForTool({ toolName: item.tool, state: item.state })
  }

  return getDefaultToolAction(item.tool)
}

export const taskRenderer: ToolRenderer = {
  tools: ["task"],
  getAction: () => "Delegating...",
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    return describeTaskTitle(input)
  },
  renderBody({ toolState, messageVersion, partVersion, scrollHelpers, renderMarkdown }) {
    const promptContent = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const { input } = readToolStatePayload(state)
      const prompt = typeof input.prompt === "string" ? input.prompt : null
      return ensureMarkdownContent(prompt, undefined, false)
    })

    const outputContent = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const output = typeof (state as { output?: unknown }).output === "string" ? ((state as { output?: string }).output as string) : null
      return ensureMarkdownContent(output, undefined, false)
    })

    const agentLabel = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const { input } = readToolStatePayload(state)
      return typeof input.subagent_type === "string" ? input.subagent_type : null
    })

    const modelLabel = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const { metadata } = readToolStatePayload(state)
      const model = (metadata as any).model
      if (!model || typeof model !== "object") return null
      const providerId = typeof model.providerID === "string" ? model.providerID : null
      const modelId = typeof model.modelID === "string" ? model.modelID : null
      if (!providerId && !modelId) return null
      if (providerId && modelId) return `${providerId}/${modelId}`
      return providerId ?? modelId
    })

    const headerMeta = createMemo(() => {
      const agent = agentLabel()
      const model = modelLabel()
      if (agent && model) return `Agent: ${agent} • Model: ${model}`
      if (agent) return `Agent: ${agent}`
      if (model) return `Model: ${model}`
      return null
    })

    const items = createMemo(() => {
      // Track the reactive change points so we only recompute when the part/message changes
      messageVersion?.()
      partVersion?.()

      const state = toolState()
      if (!state) return []

      const { metadata } = readToolStatePayload(state)
      const summary = Array.isArray((metadata as any).summary) ? ((metadata as any).summary as any[]) : []

      return summary.map((entry, index) => {
        const tool = typeof entry?.tool === "string" ? (entry.tool as string) : "unknown"
        const stateValue = typeof entry?.state === "object" ? (entry.state as ToolState) : undefined
        const metadataFromEntry = typeof entry?.metadata === "object" && entry.metadata ? entry.metadata : {}
        const fallbackInput = typeof entry?.input === "object" && entry.input ? entry.input : {}
        const id = typeof entry?.id === "string" && entry.id.length > 0 ? entry.id : `${tool}-${index}`
        const statusValue = normalizeStatus((entry?.status as string | undefined) ?? stateValue?.status)
        const title = typeof entry?.title === "string" ? entry.title : undefined
        return { id, tool, input: fallbackInput, metadata: metadataFromEntry, state: stateValue, status: statusValue, title }
      })
    })

    return (
      <div class="tool-call-task-sections">
        <Show when={promptContent()}>
          <section class="tool-call-task-section">
            <header class="tool-call-task-section-header">
              <span class="tool-call-task-section-title">Prompt</span>
              <Show when={headerMeta()}>
                <span class="tool-call-task-section-meta">{headerMeta()}</span>
              </Show>
            </header>
            <div class="tool-call-task-section-body">
              {renderMarkdown({
                content: promptContent()!,
                cacheKey: "task:prompt",
                disableScrollTracking: true,
                disableHighlight: true,
              })}
            </div>
          </section>
        </Show>

        <Show when={items().length > 0}>
          <section class="tool-call-task-section">
            <header class="tool-call-task-section-header">
              <span class="tool-call-task-section-title">Steps</span>
              <span class="tool-call-task-section-meta">{items().length} steps</span>
            </header>
            <div class="tool-call-task-section-body">
              <div
                class="message-text tool-call-markdown tool-call-task-container"
                ref={(element) => scrollHelpers?.registerContainer(element)}
                onScroll={
                  scrollHelpers ? (event) => scrollHelpers.handleScroll(event as Event & { currentTarget: HTMLDivElement }) : undefined
                }
              >
                <div class="tool-call-task-summary">
                  <For each={items()}>
                    {(item) => {
                      const icon = getToolIcon(item.tool)
                      const description = describeToolTitle(item)
                      const toolLabel = getToolName(item.tool)
                      const status = normalizeStatus(item.status ?? item.state?.status)
                      const statusIcon = summarizeStatusIcon(status)
                      const statusLabel = summarizeStatusLabel(status)
                      const statusAttr = status ?? "pending"
                      return (
                        <div class="tool-call-task-item" data-task-id={item.id} data-task-status={statusAttr}>
                          <span class="tool-call-task-icon">{icon}</span>
                          <span class="tool-call-task-label">{toolLabel}</span>
                          <span class="tool-call-task-separator" aria-hidden="true">—</span>
                          <span class="tool-call-task-text">{description}</span>
                          <Show when={statusIcon}>
                            <span class="tool-call-task-status" aria-label={statusLabel} title={statusLabel}>
                              {statusIcon}
                            </span>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
                {scrollHelpers?.renderSentinel?.()}
              </div>
            </div>
          </section>
        </Show>

        <Show when={outputContent()}>
          <section class="tool-call-task-section">
            <header class="tool-call-task-section-header">
              <span class="tool-call-task-section-title">Output</span>
              <Show when={headerMeta()}>
                <span class="tool-call-task-section-meta">{headerMeta()}</span>
              </Show>
            </header>
            <div class="tool-call-task-section-body">
              {renderMarkdown({
                content: outputContent()!,
                cacheKey: "task:output",
                disableScrollTracking: true,
              })}
            </div>
          </section>
        </Show>
      </div>
    )
  },
}
