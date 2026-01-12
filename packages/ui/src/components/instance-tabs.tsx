import { Component, For, Show, createSignal, onMount, onCleanup } from "solid-js"
import type { Instance } from "../types/instance"
import InstanceTab from "./instance-tab"
import { Plus, X, ChevronLeft, ChevronRight, Settings } from "lucide-solid"

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
      case "healthy": return "bg-green-500"
      case "warning": return "bg-yellow-500"
      case "error": return "bg-red-500"
      default: return "bg-green-500"
    }
  }

  return (
    <div class="project-tab-bar">
      {/* Left scroll arrow */}
      <Show when={showLeftArrow()}>
        <button
          class="project-tab-scroll-arrow project-tab-scroll-left"
          onClick={scrollLeft}
          aria-label="Scroll tabs left"
        >
          <ChevronLeft class="w-4 h-4" />
        </button>
      </Show>

      {/* Scrollable tab container */}
      <div
        ref={scrollContainerRef}
        class="project-tab-scroll-container"
        onScroll={checkScrollArrows}
        role="tablist"
      >
        <div class="project-tab-list">
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
              class="project-tab project-tab-active group"
              role="tab"
              aria-selected="true"
            >
              <span class="project-tab-label">New Project</span>
              <span
                class="project-tab-close"
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
            class="project-tab-new"
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
          class="project-tab-scroll-arrow project-tab-scroll-right"
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
        class="project-tab-settings"
        onClick={() => props.onOpenSettings?.()}
        title="Settings"
        aria-label="Open settings"
      >
        <Settings class="w-4 h-4" />
        <span class={`project-tab-status-dot ${statusColor()}`} />
      </button>
    </div>
  )
}

export default InstanceTabs
