import { Component, For, createSignal, createEffect, Show, onMount, onCleanup } from "solid-js"
import { instances } from "../stores/instances"
import { Trash2, ChevronDown } from "lucide-solid"
import type { LogEntry } from "../types/instance"

interface LogsViewProps {
  instanceId: string
}

const logsScrollState = new Map<string, { scrollTop: number; autoScroll: boolean }>()

const LogsView: Component<LogsViewProps> = (props) => {
  let scrollRef: HTMLDivElement | undefined
  const savedState = logsScrollState.get(props.instanceId)
  const [autoScroll, setAutoScroll] = createSignal(savedState?.autoScroll ?? false)

  const instance = () => instances().get(props.instanceId)
  const logs = () => instance()?.logs ?? []

  onMount(() => {
    if (scrollRef && savedState) {
      scrollRef.scrollTop = savedState.scrollTop
    }
  })

  onCleanup(() => {
    if (scrollRef) {
      logsScrollState.set(props.instanceId, {
        scrollTop: scrollRef.scrollTop,
        autoScroll: autoScroll(),
      })
    }
  })

  createEffect(() => {
    if (autoScroll() && scrollRef && logs().length > 0) {
      scrollRef.scrollTop = scrollRef.scrollHeight
    }
  })

  const handleScroll = () => {
    if (!scrollRef) return

    const isAtBottom = scrollRef.scrollHeight - scrollRef.scrollTop <= scrollRef.clientHeight + 50

    setAutoScroll(isAtBottom)
  }

  const scrollToBottom = () => {
    if (scrollRef) {
      scrollRef.scrollTop = scrollRef.scrollHeight
      setAutoScroll(true)
    }
  }

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  }

  const getLevelColor = (level: string) => {
    switch (level) {
      case "error":
        return "text-red-600 dark:text-red-400"
      case "warn":
        return "text-yellow-600 dark:text-yellow-400"
      case "debug":
        return "text-gray-500 dark:text-gray-500"
      default:
        return "text-gray-900 dark:text-gray-100"
    }
  }

  return (
    <div class="flex flex-col h-full bg-white dark:bg-gray-900">
      <div class="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">Server Logs</h3>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        class="flex-1 overflow-y-auto p-4 bg-gray-50 dark:bg-gray-900 font-mono text-xs leading-relaxed"
      >
        <Show
          when={logs().length > 0}
          fallback={<div class="text-gray-500 dark:text-gray-500 text-center py-8">Waiting for server output...</div>}
        >
          <For each={logs()}>
            {(entry) => (
              <div class="flex gap-3 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 px-2 -mx-2 rounded">
                <span class="text-gray-500 dark:text-gray-500 select-none shrink-0">{formatTime(entry.timestamp)}</span>
                <span class={`${getLevelColor(entry.level)} break-all`}>{entry.message}</span>
              </div>
            )}
          </For>
        </Show>
      </div>

      <Show when={!autoScroll()}>
        <button
          onClick={scrollToBottom}
          class="absolute bottom-6 right-6 px-3 py-2 bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-700 flex items-center gap-1 text-sm"
        >
          <ChevronDown class="w-4 h-4" />
          Scroll to bottom
        </button>
      </Show>
    </div>
  )
}

export default LogsView
