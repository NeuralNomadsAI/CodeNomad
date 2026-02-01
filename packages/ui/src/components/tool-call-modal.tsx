import { createEffect, createMemo, onCleanup, Show, type Component } from "solid-js"
import { Portal } from "solid-js/web"
import {
  useToolModal,
  closeToolModal,
  navigateNext,
  navigatePrev,
  setModalDiffViewMode,
} from "../stores/tool-modal"
import { getToolIcon, getToolName, readToolStatePayload, diffCapableTools } from "./tool-call/utils"
import ToolCall from "./tool-call"
import { X, ChevronLeft, ChevronRight, Columns, AlignJustify, Copy, Check } from "lucide-solid"
import { createSignal } from "solid-js"
import { cn } from "../lib/cn"

// Tools that produce diffs
const DIFF_TOOLS = new Set(["edit", "patch", "write"])

export const ToolCallModal: Component = () => {
  const modal = useToolModal()
  let modalRef: HTMLDivElement | undefined
  let previousActiveElement: HTMLElement | null = null
  const [copied, setCopied] = createSignal(false)

  // Handle keyboard navigation
  const handleKeyDown = (event: KeyboardEvent) => {
    if (!modal.isOpen()) return

    switch (event.key) {
      case "Escape":
        event.preventDefault()
        closeToolModal()
        break
      case "ArrowLeft":
        event.preventDefault()
        if (modal.hasPrev()) navigatePrev()
        break
      case "ArrowRight":
        event.preventDefault()
        if (modal.hasNext()) navigateNext()
        break
    }
  }

  // Focus trap and restoration
  createEffect(() => {
    if (modal.isOpen()) {
      previousActiveElement = document.activeElement as HTMLElement
      requestAnimationFrame(() => {
        modalRef?.focus()
      })
      document.addEventListener("keydown", handleKeyDown)
      document.body.style.overflow = "hidden"
    } else {
      document.removeEventListener("keydown", handleKeyDown)
      document.body.style.overflow = ""
      previousActiveElement?.focus()
    }
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
    document.body.style.overflow = ""
  })

  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) {
      closeToolModal()
    }
  }

  const currentItem = () => modal.currentItem()
  const toolName = () => currentItem()?.toolName || "unknown"
  const displayPath = () => currentItem()?.displayPath || toolName()

  // Check if current tool supports diff view
  const isDiffTool = createMemo(() => DIFF_TOOLS.has(toolName()))

  // Extract change stats from tool state
  const changeStats = createMemo(() => {
    const item = currentItem()
    if (!item?.toolPart.state) return null

    const { metadata, output } = readToolStatePayload(item.toolPart.state)

    // Try to extract diff stats
    const diffText = metadata.diff || output
    if (typeof diffText !== "string") return null

    // Count additions and deletions from diff
    const lines = diffText.split("\n")
    let additions = 0
    let deletions = 0

    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        additions++
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions++
      }
    }

    if (additions === 0 && deletions === 0) return null

    return { additions, deletions, total: additions + deletions }
  })

  // Copy content to clipboard
  const handleCopy = async () => {
    const item = currentItem()
    if (!item?.toolPart.state) return

    const { metadata, output } = readToolStatePayload(item.toolPart.state)
    const content = metadata.diff || metadata.preview || output

    if (typeof content === "string") {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <Portal>
      <Show when={modal.isOpen() && currentItem()}>
        <div
          class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={handleBackdropClick}
          role="dialog"
          aria-modal="true"
          aria-labelledby="tool-modal-title"
        >
          <div
            ref={modalRef}
            class="relative flex flex-col w-[90vw] max-w-[1200px] h-[85vh] max-h-[900px] bg-background border border-border rounded-xl shadow-2xl animate-in slide-in-from-bottom-5 duration-200 outline-none md:max-w-none md:max-h-none"
            tabIndex={-1}
          >
            {/* Header */}
            <div class="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary rounded-t-xl">
              <div class="flex items-center gap-2 text-base font-medium text-foreground overflow-hidden" id="tool-modal-title">
                <span class="text-lg shrink-0">{getToolIcon(toolName())}</span>
                <span class="text-muted-foreground">{getToolName(toolName())}</span>
                <span class="text-muted-foreground/50">:</span>
                <span class="font-mono text-sm text-foreground overflow-hidden text-ellipsis whitespace-nowrap">{displayPath()}</span>
              </div>
              <div class="flex items-center gap-3">
                {/* Diff view mode toggle - only for diff-capable tools */}
                <Show when={isDiffTool()}>
                  <div class="flex items-center bg-muted rounded-md p-0.5" role="group" aria-label="View mode">
                    <button
                      type="button"
                      class={cn(
                        "flex items-center gap-1 px-2 py-1 bg-transparent border-none rounded-sm text-muted-foreground text-xs cursor-pointer transition-all duration-150 hover:text-foreground",
                        modal.diffViewMode() === "split" && "bg-background text-foreground shadow-sm",
                      )}
                      onClick={() => setModalDiffViewMode("split")}
                      aria-pressed={modal.diffViewMode() === "split"}
                      title="Split view"
                    >
                      <Columns size={16} />
                      <span>Split</span>
                    </button>
                    <button
                      type="button"
                      class={cn(
                        "flex items-center gap-1 px-2 py-1 bg-transparent border-none rounded-sm text-muted-foreground text-xs cursor-pointer transition-all duration-150 hover:text-foreground",
                        modal.diffViewMode() === "unified" && "bg-background text-foreground shadow-sm",
                      )}
                      onClick={() => setModalDiffViewMode("unified")}
                      aria-pressed={modal.diffViewMode() === "unified"}
                      title="Unified view"
                    >
                      <AlignJustify size={16} />
                      <span>Unified</span>
                    </button>
                  </div>
                </Show>

                {/* Copy button */}
                <button
                  type="button"
                  class={cn(
                    "flex items-center justify-center w-8 h-8 p-0 bg-transparent border border-border rounded-md text-muted-foreground cursor-pointer transition-all duration-150 hover:bg-muted hover:text-foreground",
                    copied() && "bg-success/10 text-success border-success",
                  )}
                  onClick={handleCopy}
                  aria-label={copied() ? "Copied!" : "Copy content"}
                  title={copied() ? "Copied!" : "Copy content"}
                >
                  <Show when={copied()} fallback={<Copy size={18} />}>
                    <Check size={18} />
                  </Show>
                </button>

                <button
                  type="button"
                  class="flex items-center justify-center w-8 h-8 p-0 bg-transparent border-none rounded-md text-muted-foreground cursor-pointer transition-all duration-150 hover:bg-muted hover:text-foreground"
                  onClick={() => closeToolModal()}
                  aria-label="Close modal"
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Content */}
            <div class="flex-1 overflow-auto p-4 text-foreground" data-tool-type={toolName()}>
              <Show
                when={currentItem()?.toolPart.state?.status !== "running"}
                fallback={
                  <div class="flex flex-col gap-3 p-4">
                    <div class="h-4 rounded-sm bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] animate-shimmer" />
                    <div class="h-4 rounded-sm bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] animate-shimmer w-4/5" />
                    <div class="h-4 rounded-sm bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] animate-shimmer w-3/5" />
                    <div class="h-[120px] rounded-sm bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] animate-shimmer" />
                    <div class="h-4 rounded-sm bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] animate-shimmer" />
                    <div class="h-4 rounded-sm bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] animate-shimmer w-4/5" />
                  </div>
                }
              >
                <Show
                  when={currentItem()}
                  fallback={
                    <div class="flex flex-col items-center justify-center p-8 text-muted-foreground text-center">
                      <span class="text-5xl mb-4 opacity-50">{"\uD83D\uDCED"}</span>
                      <span class="text-sm">No content available</span>
                    </div>
                  }
                >
                  {(item) => (
                    <ToolCall
                      toolCall={item().toolPart}
                      toolCallId={item().key}
                      messageId={item().messageId}
                      messageVersion={item().messageVersion}
                      partVersion={item().partVersion}
                      instanceId={modal.instanceId()}
                      sessionId={modal.sessionId()}
                    />
                  )}
                </Show>
              </Show>
            </div>

            {/* Footer with navigation and stats */}
            <div class="flex items-center justify-between px-4 py-3 border-t border-border bg-secondary rounded-b-xl">
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  class="flex items-center gap-1 px-2 py-1 bg-transparent border border-border rounded-md text-muted-foreground text-sm cursor-pointer transition-all duration-150 hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => navigatePrev()}
                  disabled={!modal.hasPrev()}
                  aria-label="Previous file"
                >
                  <ChevronLeft size={16} />
                  <span>Previous</span>
                </button>

                <span class="text-sm text-muted-foreground min-w-[60px] text-center">
                  {modal.currentIndex() + 1} of {modal.siblingItems().length}
                </span>

                <button
                  type="button"
                  class="flex items-center gap-1 px-2 py-1 bg-transparent border border-border rounded-md text-muted-foreground text-sm cursor-pointer transition-all duration-150 hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => navigateNext()}
                  disabled={!modal.hasNext()}
                  aria-label="Next file"
                >
                  <span>Next</span>
                  <ChevronRight size={16} />
                </button>
              </div>

              <div class="flex items-center gap-3">
                {/* Change stats for diffs */}
                <Show when={changeStats()}>
                  {(stats) => (
                    <div class="flex items-center gap-2 text-sm font-mono">
                      <span class="font-medium text-success">+{stats().additions}</span>
                      <span class="font-medium text-destructive">-{stats().deletions}</span>
                      <span class="text-muted-foreground font-sans">{stats().total} lines</span>
                    </div>
                  )}
                </Show>

                {/* Status badge */}
                <Show when={currentItem()?.toolPart.state?.status === "completed"}>
                  <span class="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full bg-success/10 text-success">Completed</span>
                </Show>
                <Show when={currentItem()?.toolPart.state?.status === "running"}>
                  <span class="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full bg-warning/10 text-warning animate-pulse">Running...</span>
                </Show>
                <Show when={currentItem()?.toolPart.state?.status === "error"}>
                  <span class="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full bg-destructive/10 text-destructive">Error</span>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </Portal>
  )
}

export default ToolCallModal
