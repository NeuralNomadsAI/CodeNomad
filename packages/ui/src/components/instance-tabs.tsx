import { Component, For, Show, createSignal, onMount, onCleanup } from "solid-js"
import type { Instance } from "../types/instance"
import InstanceTab from "./instance-tab"
import { Plus, X, ChevronLeft, ChevronRight, Settings } from "lucide-solid"
import { cn } from "../lib/cn"

interface InstanceTabsProps {
  instances: Map<string, Instance>
  activeInstanceId: string | null
  onSelect: (instanceId: string) => void
  onClose: (instanceId: string) => void
  onNew: () => void
  onOpenRemoteAccess?: () => void
  onOpenSettings?: () => void
  showNewTab?: boolean
  onCloseNewTab?: () => void
  serverStatus?: "healthy" | "warning" | "error"
}

const InstanceTabs: Component<InstanceTabsProps> = (props) => {
  let scrollContainerRef: HTMLDivElement | undefined
  const [showLeftArrow, setShowLeftArrow] = createSignal(false)
  const [showRightArrow, setShowRightArrow] = createSignal(false)

  const checkScrollArrows = () => {
    if (!scrollContainerRef) return
    const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef
    setShowLeftArrow(scrollLeft > 0)
    setShowRightArrow(scrollLeft + clientWidth < scrollWidth - 1)
  }

  const scrollLeft = () => {
    if (!scrollContainerRef) return
    scrollContainerRef.scrollBy({ left: -200, behavior: "smooth" })
  }

  const scrollRight = () => {
    if (!scrollContainerRef) return
    scrollContainerRef.scrollBy({ left: 200, behavior: "smooth" })
  }

  onMount(() => {
    checkScrollArrows()
    const resizeObserver = new ResizeObserver(checkScrollArrows)
    if (scrollContainerRef) {
      resizeObserver.observe(scrollContainerRef)
    }
    onCleanup(() => resizeObserver.disconnect())
  })

  const handleInstanceSelect = (id: string) => {
    if (props.showNewTab && props.onCloseNewTab) {
      props.onCloseNewTab()
    }
    props.onSelect(id)
  }

  const statusColor = () => {
    switch (props.serverStatus) {
      case "healthy": return "bg-success"
      case "warning": return "bg-warning"
      case "error": return "bg-destructive"
      default: return "bg-success"
    }
  }

  return (
    <div
      class="flex items-center h-10 px-1 bg-secondary border-b border-border"
      style={{ "-webkit-app-region": "drag" }}
    >
      {/* Left scroll arrow */}
      <Show when={showLeftArrow()}>
        <button
          class="flex items-center justify-center w-6 h-6 rounded transition-colors flex-shrink-0 mr-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          style={{ "-webkit-app-region": "no-drag" }}
          onClick={scrollLeft}
          aria-label="Scroll tabs left"
        >
          <ChevronLeft class="w-4 h-4" />
        </button>
      </Show>

      {/* Scrollable tab container */}
      <div
        ref={scrollContainerRef}
        class="flex-1 overflow-x-auto scrollbar-none"
        style={{ "-webkit-app-region": "no-drag" }}
        onScroll={checkScrollArrows}
        role="tablist"
      >
        <div class="flex items-center gap-0.5 h-full">
          <For each={Array.from(props.instances.entries())}>
            {([id, instance]) => (
              <InstanceTab
                instance={instance}
                active={id === props.activeInstanceId && !props.showNewTab}
                onSelect={() => handleInstanceSelect(id)}
                onClose={() => props.onClose(id)}
              />
            )}
          </For>

          {/* New Tab - shown when showNewTab is true */}
          <Show when={props.showNewTab}>
            <button
              class={cn(
                "inline-flex items-center gap-2 px-3 h-8 rounded-md text-sm font-medium transition-colors cursor-pointer max-w-[180px] outline-none group",
                "bg-background text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.2),0_0_0_1px_rgba(255,255,255,0.05)] border-b-2 border-info"
              )}
              role="tab"
              aria-selected="true"
            >
              <span class="truncate">New Project</span>
              <span
                class="opacity-50 hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground rounded p-0.5 transition-all cursor-pointer ml-1 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-info"
                onClick={(e) => {
                  e.stopPropagation()
                  props.onCloseNewTab?.()
                }}
                role="button"
                tabIndex={0}
                aria-label="Close new tab"
              >
                <X class="w-3 h-3" />
              </span>
            </button>
          </Show>

          {/* New tab button */}
          <button
            class="inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors flex-shrink-0 ml-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-info focus-visible:ring-offset-secondary"
            onClick={props.onNew}
            title="New project (Cmd+N)"
            aria-label="New project"
          >
            <Plus class="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Right scroll arrow */}
      <Show when={showRightArrow()}>
        <button
          class="flex items-center justify-center w-6 h-6 rounded transition-colors flex-shrink-0 ml-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          style={{ "-webkit-app-region": "no-drag" }}
          onClick={scrollRight}
          aria-label="Scroll tabs right"
        >
          <ChevronRight class="w-4 h-4" />
        </button>
      </Show>

      {/* Spacer */}
      <div class="flex-1" />

      {/* Settings button with status indicator */}
      <button
        class="relative inline-flex items-center justify-center w-8 h-8 rounded-md transition-colors flex-shrink-0 mr-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-info focus-visible:ring-offset-secondary"
        style={{ "-webkit-app-region": "no-drag" }}
        onClick={() => props.onOpenSettings?.()}
        title="Settings"
        aria-label="Open settings"
      >
        <Settings class="w-4 h-4" />
        <span class={cn("absolute bottom-1 right-1 w-2 h-2 rounded-full", statusColor())} />
      </button>
    </div>
  )
}

export default InstanceTabs
