import { For, Show, createMemo, createSignal } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import type { ToolRenderer, ToolRendererContext } from "../types"
import { getDefaultToolAction, getToolIcon, getToolName, readToolStatePayload, ensureMarkdownContent } from "../utils"
import { getTodoTitle } from "./todo"
import { resolveTitleForTool } from "../tool-title"
import { ChevronDown, ChevronRight } from "lucide-solid"
import { cn } from "../../../lib/cn"

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
      return "\u23F8"
    case "running":
      return "\u23F3"
    case "completed":
      return "\u2713"
    case "error":
      return "\u2717"
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

function getTaskItemBorderClass(status?: string): string {
  switch (status) {
    case "completed":
      return "border-l-success"
    case "running":
      return "border-l-warning"
    case "pending":
      return "border-l-info"
    case "error":
      return "border-l-destructive"
    default:
      return "border-l-border"
  }
}

/** Collapsible pane header component */
function TaskPaneHeader(props: {
  title: string
  isExpanded: boolean
  onToggle: () => void
  count?: number
}) {
  return (
    <button
      type="button"
      class="flex items-center gap-2 w-full px-3 py-2 bg-secondary border-none cursor-pointer text-left font-mono text-xs font-semibold text-muted-foreground uppercase tracking-[0.05em] transition-colors duration-150 hover:bg-accent/10"
      onClick={props.onToggle}
      aria-expanded={props.isExpanded}
    >
      <span class="inline-flex items-center justify-center text-muted-foreground shrink-0">
        {props.isExpanded ? <ChevronDown class="w-3.5 h-3.5" /> : <ChevronRight class="w-3.5 h-3.5" />}
      </span>
      <span class="flex-1">{props.title}</span>
      <Show when={typeof props.count === "number"}>
        <span class="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 text-[0.65rem] font-semibold bg-muted border border-border rounded-xl text-muted-foreground">{props.count}</span>
      </Show>
    </button>
  )
}

/** Renders the list of task steps */
function TaskStepsList(props: { items: TaskSummaryItem[] }) {
  return (
    <div class="flex flex-col gap-0.5">
      <For each={props.items}>
        {(item) => {
          const icon = getToolIcon(item.tool)
          const description = describeToolTitle(item)
          const toolLabel = getToolName(item.tool)
          const status = normalizeStatus(item.status ?? item.state?.status)
          const statusIcon = summarizeStatusIcon(status)
          const statusLabel = summarizeStatusLabel(status)
          const statusAttr = status ?? "pending"
          return (
            <div
              class={cn(
                "flex items-center gap-1.5 px-2 py-1.5 pl-3 border-l-2 font-mono text-sm leading-[1.35] bg-muted transition-colors duration-200 hover:bg-accent/10 mt-0.5 first:mt-0",
                getTaskItemBorderClass(statusAttr),
              )}
              data-task-id={item.id}
              data-task-status={statusAttr}
            >
              <span class="text-[0.9rem] leading-none text-muted-foreground">{icon}</span>
              <span class="font-semibold text-muted-foreground">{toolLabel}</span>
              <span class="text-muted-foreground" aria-hidden="true">{"\u2014"}</span>
              <span class="flex-1 min-w-0 text-foreground whitespace-nowrap overflow-hidden text-ellipsis">{description}</span>
              <Show when={statusIcon}>
                <span class="font-semibold text-muted-foreground text-[0.9rem]" aria-label={statusLabel} title={statusLabel}>
                  {statusIcon}
                </span>
              </Show>
            </div>
          )
        }}
      </For>
    </div>
  )
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
    // Track pane expansion states
    const [promptExpanded, setPromptExpanded] = createSignal(false)
    const [approachesExpanded, setApproachesExpanded] = createSignal(false)
    const [stepsExpanded, setStepsExpanded] = createSignal(true)
    const [outputExpanded, setOutputExpanded] = createSignal(false)

    // Extract prompt from input
    const prompt = createMemo(() => {
      messageVersion?.()
      partVersion?.()
      const state = toolState()
      if (!state) return null
      const { input, metadata } = readToolStatePayload(state)
      // Try input.prompt first, then metadata.prompt
      const promptText = typeof input.prompt === "string" ? input.prompt :
                         typeof (metadata as any).prompt === "string" ? (metadata as any).prompt : null
      return promptText
    })

    // Extract approach evaluation from metadata
    const approaches = createMemo(() => {
      messageVersion?.()
      partVersion?.()
      const state = toolState()
      if (!state) return null
      const { metadata } = readToolStatePayload(state)
      const evalData = (metadata as any).approachEvaluation
      if (!evalData || !Array.isArray(evalData.approaches)) return null
      return evalData as {
        requirement?: string
        approaches: Array<{
          name: string
          description?: string
          selected?: boolean
          complexity?: string
          risk?: string
          alignment?: string
          testability?: string
        }>
        rationale?: string
      }
    })

    // Extract output from metadata or state
    const output = createMemo(() => {
      messageVersion?.()
      partVersion?.()
      const state = toolState()
      if (!state) return null
      const { metadata } = readToolStatePayload(state)
      // Try metadata.output first, then state.output for completed tasks
      if (typeof (metadata as any).output === "string" && (metadata as any).output.length > 0) {
        return (metadata as any).output
      }
      if (state.status === "completed" && typeof state.output === "string" && state.output.length > 0) {
        return state.output
      }
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

    // Check if we have any content to show
    const hasPrompt = () => prompt() !== null && prompt()!.length > 0
    const hasApproaches = () => approaches() !== null
    const hasSteps = () => items().length > 0
    const hasOutput = () => output() !== null && output()!.length > 0
    const hasAnyContent = () => hasPrompt() || hasApproaches() || hasSteps() || hasOutput()

    if (!hasAnyContent()) return null

    return (
      <div
        class="message-text bg-muted text-foreground text-xs leading-tight p-3 flex flex-col"
        ref={(element) => scrollHelpers?.registerContainer(element)}
        onScroll={scrollHelpers ? (event) => scrollHelpers.handleScroll(event as Event & { currentTarget: HTMLDivElement }) : undefined}
      >
        {/* Prompt Pane */}
        <Show when={hasPrompt()}>
          <div class="border-b border-border last:border-b-0">
            <TaskPaneHeader
              title="Prompt"
              isExpanded={promptExpanded()}
              onToggle={() => setPromptExpanded(!promptExpanded())}
            />
            <Show when={promptExpanded()}>
              <div class="bg-muted max-h-[calc(20*1.4em)] overflow-y-auto scrollbar-thin px-3 py-3 text-sm leading-normal">
                {renderMarkdown({
                  content: ensureMarkdownContent(prompt()!, undefined, true) || prompt()!,
                  disableHighlight: false
                })}
              </div>
            </Show>
          </div>
        </Show>

        {/* Approaches Pane */}
        <Show when={hasApproaches()}>
          <div class="border-b border-border last:border-b-0">
            <TaskPaneHeader
              title="Approaches"
              isExpanded={approachesExpanded()}
              onToggle={() => setApproachesExpanded(!approachesExpanded())}
              count={approaches()!.approaches.length}
            />
            <Show when={approachesExpanded()}>
              <div class="bg-muted max-h-[calc(20*1.4em)] overflow-y-auto scrollbar-thin px-3 py-3 flex flex-col gap-2">
                <Show when={approaches()!.requirement}>
                  <div class="text-sm text-muted-foreground pb-2 border-b border-border mb-1">{approaches()!.requirement}</div>
                </Show>
                <For each={approaches()!.approaches}>
                  {(approach) => (
                    <div class={cn(
                      "p-3 rounded-md border border-border bg-secondary",
                      approach.selected && "border-info bg-info/5",
                    )}>
                      <div class="flex items-center gap-2 mb-1">
                        <span class="text-sm font-semibold text-foreground">{approach.name}</span>
                        <Show when={approach.selected}>
                          <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[0.65rem] font-semibold font-mono uppercase tracking-[0.03em] bg-info text-info-foreground">SELECTED</span>
                        </Show>
                      </div>
                      <Show when={approach.description}>
                        <div class="text-xs text-muted-foreground leading-[1.4] mb-2">{approach.description}</div>
                      </Show>
                      <div class="flex gap-1.5 flex-wrap">
                        <Show when={approach.complexity}>
                          <span class={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded text-[0.65rem] font-semibold font-mono uppercase tracking-[0.03em]",
                            approach.complexity?.toLowerCase() === "low" && "bg-success/15 text-success",
                            (approach.complexity?.toLowerCase() === "med" || approach.complexity?.toLowerCase() === "medium") && "bg-warning/15 text-warning",
                            approach.complexity?.toLowerCase() === "high" && "bg-destructive/15 text-destructive",
                          )}>
                            {approach.complexity}
                          </span>
                        </Show>
                        <Show when={approach.risk}>
                          <span class={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded text-[0.65rem] font-semibold font-mono uppercase tracking-[0.03em]",
                            approach.risk?.toLowerCase() === "low" && "bg-success/15 text-success",
                            (approach.risk?.toLowerCase() === "med" || approach.risk?.toLowerCase() === "medium") && "bg-warning/15 text-warning",
                            approach.risk?.toLowerCase() === "high" && "bg-destructive/15 text-destructive",
                          )}>
                            {approach.risk}
                          </span>
                        </Show>
                        <Show when={approach.alignment}>
                          <span class={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded text-[0.65rem] font-semibold font-mono uppercase tracking-[0.03em]",
                            approach.alignment?.toLowerCase() === "low" && "bg-success/15 text-success",
                            (approach.alignment?.toLowerCase() === "med" || approach.alignment?.toLowerCase() === "medium") && "bg-warning/15 text-warning",
                            approach.alignment?.toLowerCase() === "high" && "bg-destructive/15 text-destructive",
                          )}>
                            {approach.alignment}
                          </span>
                        </Show>
                        <Show when={approach.testability}>
                          <span class={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded text-[0.65rem] font-semibold font-mono uppercase tracking-[0.03em]",
                            approach.testability?.toLowerCase() === "low" && "bg-success/15 text-success",
                            (approach.testability?.toLowerCase() === "med" || approach.testability?.toLowerCase() === "medium") && "bg-warning/15 text-warning",
                            approach.testability?.toLowerCase() === "high" && "bg-destructive/15 text-destructive",
                          )}>
                            {approach.testability}
                          </span>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
                <Show when={approaches()!.rationale}>
                  <div class="text-xs text-muted-foreground italic pt-2 border-t border-border">{approaches()!.rationale}</div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

        {/* Steps Pane */}
        <Show when={hasSteps()}>
          <div class="border-b border-border last:border-b-0">
            <TaskPaneHeader
              title="Steps"
              isExpanded={stepsExpanded()}
              onToggle={() => setStepsExpanded(!stepsExpanded())}
              count={items().length}
            />
            <Show when={stepsExpanded()}>
              <div class="bg-muted max-h-[calc(20*1.4em)] overflow-y-auto scrollbar-thin p-2">
                <TaskStepsList items={items()} />
              </div>
            </Show>
          </div>
        </Show>

        {/* Output Pane */}
        <Show when={hasOutput()}>
          <div class="border-b border-border last:border-b-0">
            <TaskPaneHeader
              title="Output"
              isExpanded={outputExpanded()}
              onToggle={() => setOutputExpanded(!outputExpanded())}
            />
            <Show when={outputExpanded()}>
              <div class="bg-muted max-h-[calc(20*1.4em)] overflow-y-auto scrollbar-thin px-3 py-3 text-sm leading-normal">
                {renderMarkdown({
                  content: ensureMarkdownContent(output()!, undefined, true) || output()!,
                  disableHighlight: false
                })}
              </div>
            </Show>
          </div>
        </Show>

        {scrollHelpers?.renderSentinel?.()}
      </div>
    )
  },
}
