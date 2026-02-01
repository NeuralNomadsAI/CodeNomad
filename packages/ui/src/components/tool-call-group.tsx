import { Component, createMemo, createSignal, For, Show } from "solid-js"
import { ChevronDown, ChevronRight, FileText, Search, Terminal, Edit3, Globe, FolderSearch } from "lucide-solid"
import { getToolName, getToolArgsSummary, getToolSummary, readToolStatePayload, getRelativePath } from "./tool-call/utils"
import { openToolModal, type ToolModalItem } from "../stores/tool-modal"
import type { ToolDisplayItem } from "./inline-tool-call"
import { cn } from "../lib/cn"

interface ToolGroup {
  toolName: string
  displayName: string
  items: ToolDisplayItem[]
  icon: typeof FileText
  colorClass: string
  accentColor: string
}

interface ToolCallGroupProps {
  tools: ToolDisplayItem[]
  allToolsInMessage?: ToolDisplayItem[]  // All tools in the message for modal navigation
  instanceId: string
  sessionId: string
}

// Get icon and color for tool type
function getToolVisuals(toolName: string): { icon: typeof FileText; colorClass: string; accentColor: string } {
  const name = toolName.toLowerCase()

  if (name.includes("read")) {
    return { icon: FileText, colorClass: "text-info", accentColor: "border-l-info" }
  }
  if (name.includes("write") || name.includes("edit") || name.includes("patch")) {
    return { icon: Edit3, colorClass: "text-warning", accentColor: "border-l-warning" }
  }
  if (name.includes("glob") || name.includes("grep") || name.includes("search")) {
    return { icon: Search, colorClass: "text-violet-400", accentColor: "border-l-violet-400" }
  }
  if (name.includes("bash") || name.includes("shell") || name.includes("exec")) {
    return { icon: Terminal, colorClass: "text-success", accentColor: "border-l-success" }
  }
  if (name.includes("web") || name.includes("fetch") || name.includes("http")) {
    return { icon: Globe, colorClass: "text-info", accentColor: "border-l-info" }
  }
  if (name.includes("list") || name.includes("ls") || name.includes("dir")) {
    return { icon: FolderSearch, colorClass: "text-violet-500", accentColor: "border-l-violet-500" }
  }

  return { icon: FileText, colorClass: "text-muted-foreground", accentColor: "border-l-muted-foreground" }
}

// Group all tools by type (regardless of order)
function groupTools(tools: ToolDisplayItem[]): ToolGroup[] {
  const groupMap = new Map<string, ToolGroup>()
  const order: string[] = []

  for (const tool of tools) {
    const toolName = tool.toolPart.tool || "unknown"

    let group = groupMap.get(toolName)
    if (!group) {
      const displayName = getToolName(toolName)
      const { icon, colorClass, accentColor } = getToolVisuals(toolName)
      group = { toolName, displayName, items: [], icon, colorClass, accentColor }
      groupMap.set(toolName, group)
      order.push(toolName)
    }
    group.items.push(tool)
  }

  return order.map(name => groupMap.get(name)!)
}

// Get a summary for a single tool item
function getItemSummary(item: ToolDisplayItem): string {
  const state = item.toolPart.state
  if (!state) return ""

  const { input } = readToolStatePayload(state)

  // Get file path or pattern
  const filePath =
    (typeof input.filePath === "string" ? input.filePath : undefined) ||
    (typeof input.file_path === "string" ? input.file_path : undefined) ||
    (typeof input.path === "string" ? input.path : undefined) ||
    (typeof input.pattern === "string" ? input.pattern : undefined) ||
    (typeof input.command === "string" ? input.command : undefined)

  if (filePath) {
    return getRelativePath(filePath)
  }

  return getToolSummary(item.toolPart.tool || "", state) || ""
}

// Single tool chip (for grouped display)
const ToolChip: Component<{
  item: ToolDisplayItem
  colorClass: string
  onClick: () => void
}> = (props) => {
  const summary = createMemo(() => getItemSummary(props.item))
  const status = () => props.item.toolPart.state?.status

  return (
    <button
      type="button"
      class={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 bg-background border border-border rounded text-xs cursor-pointer transition-all duration-150 text-muted-foreground max-w-[200px] hover:bg-accent/10",
        status() === "running" && "border-warning bg-warning/10",
        status() === "error" && "border-destructive bg-destructive/10",
      )}
      onClick={props.onClick}
      title={summary()}
    >
      <span class="overflow-hidden text-ellipsis whitespace-nowrap">{summary() || "..."}</span>
    </button>
  )
}

// Expandable tool group
const ToolGroupDisplay: Component<{
  group: ToolGroup
  instanceId: string
  sessionId: string
  allTools: ToolDisplayItem[]
}> = (props) => {
  const [expanded, setExpanded] = createSignal(false)

  const Icon = props.group.icon
  const count = () => props.group.items.length
  const isMultiple = () => count() > 1

  // Get aggregate summary for multiple items
  const aggregateSummary = createMemo(() => {
    if (!isMultiple()) {
      return getItemSummary(props.group.items[0])
    }

    // For multiple items, show count and maybe a pattern
    const summaries = props.group.items.map(getItemSummary).filter(Boolean)
    if (summaries.length === 0) return `${count()} calls`

    // If all summaries are similar (same pattern), show it
    const unique = [...new Set(summaries)]
    if (unique.length === 1) {
      return `${unique[0]} \u00D7 ${count()}`
    }

    return `${count()} files`
  })

  // Get result summary
  const resultSummary = createMemo(() => {
    const items = props.group.items
    const completed = items.filter(i => i.toolPart.state?.status === "completed").length
    const running = items.filter(i => i.toolPart.state?.status === "running").length
    const errors = items.filter(i => i.toolPart.state?.status === "error").length

    if (running > 0) return `${running} running...`
    if (errors > 0) return `${errors} error${errors > 1 ? "s" : ""}`
    if (completed === items.length) {
      // Sum up results
      let totalLines = 0
      let totalFiles = 0
      let totalMatches = 0

      for (const item of items) {
        const summary = getToolSummary(item.toolPart.tool || "", item.toolPart.state)
        if (!summary) continue

        const linesMatch = summary.match(/(\d+)\s*lines?/i)
        const filesMatch = summary.match(/(\d+)\s*files?/i)
        const matchesMatch = summary.match(/(\d+)\s*match/i)

        if (linesMatch) totalLines += parseInt(linesMatch[1], 10)
        if (filesMatch) totalFiles += parseInt(filesMatch[1], 10)
        if (matchesMatch) totalMatches += parseInt(matchesMatch[1], 10)
      }

      if (totalFiles > 0) return `${totalFiles} file${totalFiles !== 1 ? "s" : ""}`
      if (totalLines > 0) return `${totalLines} line${totalLines !== 1 ? "s" : ""}`
      if (totalMatches > 0) return `${totalMatches} match${totalMatches !== 1 ? "es" : ""}`
      return "done"
    }

    return ""
  })

  const openModal = (item: ToolDisplayItem, index: number) => {
    const toModalItem = (t: ToolDisplayItem): ToolModalItem => ({
      key: t.key,
      toolPart: t.toolPart,
      messageId: t.messageId,
      messageVersion: t.messageVersion,
      partVersion: t.partVersion,
      displayPath: getItemSummary(t) || t.toolPart.tool || "unknown",
      toolName: t.toolPart.tool || "unknown",
    })

    const allModalItems = props.allTools.map(toModalItem)
    const globalIndex = props.allTools.findIndex(t => t.key === item.key)

    openToolModal(
      toModalItem(item),
      allModalItems,
      globalIndex >= 0 ? globalIndex : index,
      props.instanceId,
      props.sessionId
    )
  }

  // For single items, just show a simple row
  if (!isMultiple()) {
    const item = props.group.items[0]
    const status = () => item.toolPart.state?.status

    return (
      <button
        type="button"
        class={cn(
          "flex items-center gap-2 px-2.5 py-1.5 bg-transparent border-none border-l-2 rounded-r cursor-pointer transition-colors duration-150 text-left w-full text-foreground hover:bg-accent/10",
          props.group.accentColor,
          status() === "running" && "border-l-warning",
          status() === "error" && "border-l-destructive",
        )}
        onClick={() => openModal(item, 0)}
      >
        <Icon class={cn("shrink-0", props.group.colorClass)} size={14} />
        <span class="font-semibold text-foreground whitespace-nowrap">{props.group.displayName}</span>
        <span class="text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0">{aggregateSummary()}</span>
        <Show when={resultSummary()}>
          <span class="shrink-0 text-muted-foreground text-xs px-1.5 py-0.5 bg-secondary rounded">{resultSummary()}</span>
        </Show>
      </button>
    )
  }

  // For multiple items, show expandable group
  return (
    <div class={cn("flex flex-col border-l-2 rounded-r", props.group.accentColor)}>
      <button
        type="button"
        class="flex items-center gap-1.5 px-2.5 py-1.5 bg-transparent border-none cursor-pointer transition-colors duration-150 text-left w-full text-foreground hover:bg-accent/10"
        onClick={() => setExpanded(!expanded())}
      >
        <span class="shrink-0 text-muted-foreground flex items-center justify-center w-4">
          {expanded() ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <Icon class={cn("shrink-0", props.group.colorClass)} size={14} />
        <span class="font-semibold text-foreground whitespace-nowrap">{props.group.displayName}</span>
        <span class={cn("font-medium text-xs", props.group.colorClass)}>{"\u00D7"} {count()}</span>
        <Show when={aggregateSummary()}>
          <span class="text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0">{"\u00B7"} {aggregateSummary()}</span>
        </Show>
        <Show when={resultSummary()}>
          <span class="shrink-0 text-muted-foreground text-xs px-1.5 py-0.5 bg-secondary rounded">{resultSummary()}</span>
        </Show>
      </button>

      <Show when={expanded()}>
        <div class="flex flex-wrap gap-1 px-2.5 py-1.5 pb-2 pl-8 bg-secondary rounded-br">
          <For each={props.group.items}>
            {(item, index) => (
              <ToolChip
                item={item}
                colorClass={props.group.colorClass}
                onClick={() => openModal(item, index())}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

const ToolCallGroup: Component<ToolCallGroupProps> = (props) => {
  const groups = createMemo(() => groupTools(props.tools))
  // Use allToolsInMessage for modal navigation if provided, otherwise fall back to tools in this group
  const allTools = createMemo(() => props.allToolsInMessage ?? props.tools)

  // If no tools, render nothing
  if (props.tools.length === 0) {
    return null
  }

  return (
    <div class="flex flex-col gap-0.5 my-2 font-mono text-xs">
      <For each={groups()}>
        {(group) => (
          <ToolGroupDisplay
            group={group}
            instanceId={props.instanceId}
            sessionId={props.sessionId}
            allTools={allTools()}
          />
        )}
      </For>
    </div>
  )
}

export default ToolCallGroup
