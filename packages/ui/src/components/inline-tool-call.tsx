import { Component, createMemo, createSignal, onMount, onCleanup, Show } from "solid-js"
import { getToolName, getToolArgsSummary, getToolSummary, readToolStatePayload, getRelativePath } from "./tool-call/utils"
import { openToolModal, type ToolModalItem } from "../stores/tool-modal"
import { requestModelSelector, requestInstanceInfo } from "../stores/ui-actions"
import { RefreshCw, Info } from "lucide-solid"
import type { ClientPart } from "../types/message"
import { cn } from "../lib/cn"

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

export interface ToolDisplayItem {
  type: "tool"
  key: string
  toolPart: ToolCallPart
  messageInfo?: unknown
  messageId: string
  messageVersion: number
  partVersion: number
}

interface InlineToolCallProps {
  toolPart: ToolCallPart
  toolKey: string
  messageId: string
  messageVersion: number
  partVersion: number
  instanceId: string
  sessionId: string
  siblingTools?: ToolDisplayItem[]
  siblingIndex?: number
}

const STALL_THRESHOLD_MS = 20000 // 20 seconds before showing stall warning

const InlineToolCall: Component<InlineToolCallProps> = (props) => {
  const toolName = () => props.toolPart.tool || "unknown"
  const state = () => props.toolPart.state
  const status = () => state()?.status

  // Track elapsed time for running tools
  const [elapsedMs, setElapsedMs] = createSignal(0)
  const [startTime] = createSignal(Date.now())
  let intervalId: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (status() === "running") {
      intervalId = setInterval(() => {
        setElapsedMs(Date.now() - startTime())
      }, 1000)
    }
  })

  onCleanup(() => {
    if (intervalId) clearInterval(intervalId)
  })

  // Check if tool appears stalled
  const isStalled = createMemo(() => {
    return status() === "running" && elapsedMs() > STALL_THRESHOLD_MS
  })

  const displayName = createMemo(() => getToolName(toolName()))
  const argsSummary = createMemo(() => getToolArgsSummary(toolName(), state()))
  const summary = createMemo(() => getToolSummary(toolName(), state()))

  // Get display path for the modal
  const displayPath = createMemo(() => {
    const st = state()
    if (!st) return toolName()

    const { input, metadata } = readToolStatePayload(st)
    const filePath =
      (typeof input.filePath === "string" ? input.filePath : undefined) ||
      (typeof input.file_path === "string" ? input.file_path : undefined) ||
      (typeof metadata.filePath === "string" ? metadata.filePath : undefined) ||
      (typeof input.path === "string" ? input.path : undefined)

    if (filePath) {
      return getRelativePath(filePath)
    }
    return toolName()
  })

  // Convert ToolDisplayItem to ToolModalItem for the modal
  const toModalItem = (item: ToolDisplayItem): ToolModalItem => {
    const st = item.toolPart.state
    let itemDisplayPath = item.toolPart.tool || "unknown"

    if (st) {
      const { input, metadata } = readToolStatePayload(st)
      const filePath =
        (typeof input.filePath === "string" ? input.filePath : undefined) ||
        (typeof input.file_path === "string" ? input.file_path : undefined) ||
        (typeof metadata.filePath === "string" ? metadata.filePath : undefined) ||
        (typeof input.path === "string" ? input.path : undefined)

      if (filePath) {
        itemDisplayPath = getRelativePath(filePath)
      }
    }

    return {
      key: item.key,
      toolPart: item.toolPart,
      messageId: item.messageId,
      messageVersion: item.messageVersion,
      partVersion: item.partVersion,
      displayPath: itemDisplayPath,
      toolName: item.toolPart.tool || "unknown",
    }
  }

  const handleClick = () => {
    const currentItem: ToolModalItem = {
      key: props.toolKey,
      toolPart: props.toolPart,
      messageId: props.messageId,
      messageVersion: props.messageVersion,
      partVersion: props.partVersion,
      displayPath: displayPath(),
      toolName: toolName(),
    }

    const siblings = props.siblingTools
      ? props.siblingTools.map(toModalItem)
      : [currentItem]

    const index = props.siblingIndex ?? 0

    openToolModal(
      currentItem,
      siblings,
      index,
      props.instanceId,
      props.sessionId
    )
  }

  const statusDotClass = () => {
    if (isStalled()) {
      return "bg-destructive animate-pulse shadow-[0_0_0_2px_var(--background),0_0_8px_var(--destructive)]"
    }
    switch (status()) {
      case "running":
        return "bg-warning animate-pulse shadow-[0_0_0_2px_var(--background),0_0_6px_var(--warning)]"
      case "completed":
        return "bg-success"
      case "error":
        return "bg-destructive"
      default:
        return "bg-muted-foreground opacity-50"
    }
  }

  const borderColor = () => {
    if (isStalled()) return "border-l-destructive"
    switch (status()) {
      case "running":
        return "border-l-warning"
      case "completed":
        return "border-l-success"
      case "error":
        return "border-l-destructive"
      default:
        return "border-l-border"
    }
  }

  // Format elapsed time
  const elapsedDisplay = () => {
    const ms = elapsedMs()
    if (ms < 1000) return ""
    const secs = Math.floor(ms / 1000)
    if (secs < 60) return `${secs}s`
    const mins = Math.floor(secs / 60)
    return `${mins}m ${secs % 60}s`
  }

  // Skip rendering for task tools - they render separately as sub-agents
  if (toolName() === "task") {
    return null
  }

  return (
    <button
      type="button"
      class={cn(
        "flex flex-col gap-1 px-3 py-2 my-2 bg-transparent border-none border-l-[3px] cursor-pointer text-left w-full transition-all duration-150 rounded-r-sm",
        borderColor(),
        "hover:bg-accent/10 hover:border-l-4",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        isStalled() && "bg-destructive/5",
      )}
      onClick={handleClick}
      data-status={isStalled() ? "stalled" : status()}
    >
      <div class="flex items-center gap-2 font-mono text-sm leading-[1.4]">
        <span class={cn("w-2.5 h-2.5 rounded-full shrink-0 shadow-[0_0_0_2px_var(--background)]", statusDotClass())} aria-hidden="true" />
        <span class="font-bold text-foreground tracking-tight">{displayName()}</span>
        <Show when={argsSummary()}>
          <span class="text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap max-w-[60%] opacity-85">{argsSummary()}</span>
        </Show>
        <Show when={status() === "running" && elapsedDisplay()}>
          <span class="text-muted-foreground text-xs ml-auto pl-2">{elapsedDisplay()}</span>
        </Show>
      </div>
      <Show when={isStalled()}>
        <div class="flex items-start gap-1 ml-[calc(10px+0.5rem)] text-xs py-1">
          <span class="text-muted-foreground opacity-40 text-[0.85em]">{"\u2514\u2500"}</span>
          <span class="text-destructive leading-[1.4]">
            Appears stalled — API may be unavailable.
          </span>
          <div class="flex items-center gap-2 ml-2 flex-wrap">
            <button
              type="button"
              class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-foreground bg-secondary border border-border rounded-sm cursor-pointer transition-all duration-150 shrink-0 hover:bg-info hover:text-info-foreground hover:border-info active:scale-[0.98]"
              onClick={(e) => {
                e.stopPropagation()
                console.log("[InlineToolCall] Switch Model clicked")
                requestModelSelector(true)
              }}
              title="Switch to a different model and continue"
            >
              <RefreshCw size={12} />
              Switch Model
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground bg-transparent border border-border rounded-sm cursor-pointer transition-all duration-150 shrink-0 hover:bg-accent/10 hover:text-foreground active:scale-[0.98]"
              onClick={(e) => {
                e.stopPropagation()
                console.log("[InlineToolCall] View Details clicked")
                requestInstanceInfo()
              }}
              title="View instance details and logs"
            >
              <Info size={12} />
              View Details
            </button>
          </div>
        </div>
      </Show>
      <Show when={!isStalled() && summary()}>
        <div class="flex items-center gap-1 ml-[calc(8px+0.5rem)] text-xs text-muted-foreground font-mono">
          <span class="text-muted-foreground opacity-40 text-[0.85em]">{"\u2514\u2500"}</span>
          <span class={cn(
            "text-muted-foreground",
            status() === "error" && "text-destructive",
            status() === "running" && "text-warning",
          )}>{summary()}</span>
        </div>
      </Show>
    </button>
  )
}

export default InlineToolCall
