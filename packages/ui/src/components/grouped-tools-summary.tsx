import { createEffect, createMemo, createSignal, For, on, Show, type Accessor, type Component } from "solid-js"
import { getToolIcon, getToolName, readToolStatePayload, getRelativePath } from "./tool-call/utils"
import type { ToolState } from "@opencode-ai/sdk"
import type { ClientPart } from "../types/message"
import { openToolModal, type ToolModalItem } from "../stores/tool-modal"
import ToolCall from "./tool-call"
import { cn } from "../lib/cn"

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

interface ToolDisplayItem {
  type: "tool"
  key: string
  toolPart: ToolCallPart
  messageInfo?: unknown
  messageId: string
  messageVersion: number
  partVersion: number
}

interface GroupedToolsSummaryProps {
  items: ToolDisplayItem[]
  instanceId: string
  sessionId: string
  onContentRendered?: () => void
  collapseGeneration?: Accessor<number>
  defaultCollapsed?: boolean
}

interface ToolGroup {
  toolName: string
  icon: string
  displayName: string
  items: ToolDisplayItem[]
  files: { path: string; relativePath: string; item: ToolDisplayItem }[]
}

const TOOL_ICON = "🔧"

export const GroupedToolsSummary: Component<GroupedToolsSummaryProps> = (props) => {
  const [expanded, setExpanded] = createSignal(!props.defaultCollapsed)
  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(new Set())

  // Auto-collapse when collapseGeneration changes (user submitted a new message)
  createEffect(
    on(
      () => props.collapseGeneration?.(),
      (gen, prevGen) => {
        if (prevGen !== undefined && gen !== prevGen) {
          setExpanded(false)
          setExpandedGroups(new Set<string>())
        }
      }
    )
  )

  // Group tools by type
  const toolGroups = createMemo<ToolGroup[]>(() => {
    const groups = new Map<string, ToolGroup>()

    for (const item of props.items) {
      const toolName = item.toolPart.tool || "unknown"

      // Skip task tools - they're sub-agents and should render separately
      if (toolName === "task") continue

      if (!groups.has(toolName)) {
        groups.set(toolName, {
          toolName,
          icon: getToolIcon(toolName),
          displayName: getToolName(toolName),
          items: [],
          files: [],
        })
      }

      const group = groups.get(toolName)!
      group.items.push(item)

      // Extract file path if available
      const state = item.toolPart.state
      if (state) {
        const { input, metadata } = readToolStatePayload(state)
        const filePath =
          (typeof input.filePath === "string" ? input.filePath : undefined) ||
          (typeof input.file_path === "string" ? input.file_path : undefined) ||
          (typeof metadata.filePath === "string" ? metadata.filePath : undefined) ||
          (typeof input.path === "string" ? input.path : undefined) ||
          (typeof input.command === "string" ? input.command : undefined) ||
          (typeof input.pattern === "string" ? input.pattern : undefined)

        if (filePath) {
          group.files.push({
            path: filePath,
            relativePath: getRelativePath(filePath),
            item,
          })
        }
      }
    }

    // Sort groups by count (descending)
    return Array.from(groups.values()).sort((a, b) => b.items.length - a.items.length)
  })

  // Count of task tools (sub-agents) - these render separately
  const taskItems = createMemo(() => props.items.filter((item) => item.toolPart.tool === "task"))

  // Total tool count (excluding tasks)
  const totalToolCount = createMemo(() => {
    return toolGroups().reduce((sum, group) => sum + group.items.length, 0)
  })

  // Summary string for collapsed view
  const summaryText = createMemo(() => {
    return toolGroups()
      .map((group) => `${group.icon} ${group.displayName} (${group.items.length})`)
      .join(" • ")
  })

  const toggleExpanded = () => setExpanded((prev) => !prev)

  const toggleGroup = (toolName: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(toolName)) {
        next.delete(toolName)
      } else {
        next.add(toolName)
      }
      return next
    })
  }

  // Convert ToolDisplayItem to ToolModalItem for the modal
  const toModalItem = (item: ToolDisplayItem, displayPath?: string): ToolModalItem => ({
    key: item.key,
    toolPart: item.toolPart,
    messageId: item.messageId,
    messageVersion: item.messageVersion,
    partVersion: item.partVersion,
    displayPath,
    toolName: item.toolPart.tool || "unknown",
  })

  // Open modal for a specific item within a group
  const handleItemClick = (item: ToolDisplayItem, displayPath: string, group: ToolGroup) => {
    const siblings = group.files.length > 0
      ? group.files.map((f) => toModalItem(f.item, f.relativePath))
      : group.items.map((i) => toModalItem(i, i.toolPart.tool))

    const index = siblings.findIndex((s) => s.key === item.key)

    openToolModal(
      toModalItem(item, displayPath),
      siblings,
      index >= 0 ? index : 0,
      props.instanceId,
      props.sessionId
    )
  }

  // Don't render if no tools
  if (totalToolCount() === 0 && taskItems().length === 0) {
    return null
  }

  return (
    <div class="mt-3 ml-2 flex flex-col gap-2 rounded-lg border-l-[3px] border-l-violet-500 bg-secondary px-3 py-2">
      {/* Collapsed summary bar */}
      <Show when={totalToolCount() > 0}>
        <button
          type="button"
          class={cn(
            "flex w-full items-center gap-2 rounded-sm bg-transparent px-2 py-1 text-left text-sm text-muted-foreground transition-all duration-150",
            "hover:bg-muted hover:text-foreground"
          )}
          onClick={toggleExpanded}
          aria-expanded={expanded()}
        >
          <span
            class={cn(
              "flex-shrink-0 text-xs text-muted-foreground transition-transform duration-150",
              expanded() && "rotate-90"
            )}
          >
            ▸
          </span>
          <span class="flex-shrink-0 font-semibold text-foreground">{totalToolCount()} tools:</span>
          <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">{summaryText()}</span>
        </button>
      </Show>

      {/* Expanded view - grouped by tool type */}
      <Show when={expanded()}>
        <div class="flex flex-col gap-1 border-t border-border pt-2 mt-1">
          <For each={toolGroups()}>
            {(group) => (
              <div class="flex flex-col gap-1">
                <button
                  type="button"
                  class={cn(
                    "flex items-center gap-2 rounded-sm bg-transparent border-none px-2 py-1 text-left text-sm text-muted-foreground transition-all duration-150 cursor-pointer",
                    "hover:bg-secondary hover:text-foreground"
                  )}
                  onClick={() => toggleGroup(group.toolName)}
                  aria-expanded={expandedGroups().has(group.toolName)}
                >
                  <span
                    class={cn(
                      "flex-shrink-0 text-xs transition-transform duration-150",
                      expandedGroups().has(group.toolName) && "rotate-90"
                    )}
                  >
                    ▸
                  </span>
                  <span class="text-base">{group.icon}</span>
                  <span class="font-medium text-foreground">{group.displayName}</span>
                  <span class="text-xs text-muted-foreground">({group.items.length})</span>
                </button>

                <Show when={expandedGroups().has(group.toolName)}>
                  <div class="flex flex-col gap-1 pl-4 animate-in slide-in-from-top-1 duration-150">
                    <For each={group.files.length > 0 ? group.files : group.items.map((item) => ({ item, path: "", relativePath: "" }))}>
                      {(fileOrItem) => {
                        const item = "item" in fileOrItem ? fileOrItem.item : fileOrItem
                        const displayPath = "relativePath" in fileOrItem && fileOrItem.relativePath ? fileOrItem.relativePath : item.toolPart.tool
                        const status = item.toolPart.state?.status

                        return (
                          <button
                            type="button"
                            class={cn(
                              "group flex w-full items-center gap-2 rounded-sm bg-transparent border-none px-2 py-1 text-left text-sm text-muted-foreground transition-all duration-150 cursor-pointer",
                              "hover:bg-secondary hover:text-foreground"
                            )}
                            onClick={() => handleItemClick(item, displayPath, group)}
                          >
                            <span
                              class={cn(
                                "w-4 flex-shrink-0 text-center text-xs",
                                status === "completed" && "text-success",
                                status === "running" && "animate-pulse",
                                status === "error" && "text-destructive"
                              )}
                            >
                              {status === "completed" && "✓"}
                              {status === "running" && "⏳"}
                              {status === "error" && "✗"}
                              {!status && "○"}
                            </span>
                            <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs">{displayPath}</span>
                            <span class="flex-shrink-0 text-sm text-info opacity-0 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0.5">→</span>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Task tools (sub-agents) render separately with full details */}
      <For each={taskItems()}>
        {(taskItem) => (
          <div class="tool-call-message tool-call-subagent" data-key={taskItem.key}>
            <div class="tool-call-header-label">
              <div class="tool-call-header-meta">
                <span class="tool-call-icon">🤖</span>
                <span>Sub-Agent</span>
              </div>
            </div>
            <ToolCall
              toolCall={taskItem.toolPart}
              toolCallId={taskItem.key}
              messageId={taskItem.messageId}
              messageVersion={taskItem.messageVersion}
              partVersion={taskItem.partVersion}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              onContentRendered={props.onContentRendered}
            />
          </div>
        )}
      </For>
    </div>
  )
}

export default GroupedToolsSummary
