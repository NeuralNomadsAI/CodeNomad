import { Component, For, createSignal, createEffect, Show, onMount, onCleanup, createMemo } from "solid-js"
import { instances, getInstanceLogs, isInstanceLogStreaming, setInstanceLogStreaming } from "../stores/instances"
import { ChevronDown } from "lucide-solid"
import { cn } from "../lib/cn"

interface LogsViewProps {
  instanceId: string
}

const logsScrollState = new Map<string, { scrollTop: number; autoScroll: boolean }>()

const LogsView: Component<LogsViewProps> = (props) => {
  let scrollRef: HTMLDivElement | undefined
  const savedState = logsScrollState.get(props.instanceId)
  const [autoScroll, setAutoScroll] = createSignal(savedState?.autoScroll ?? false)

  const instance = () => instances().get(props.instanceId)
  const logs = createMemo(() => getInstanceLogs(props.instanceId))
  const streamingEnabled = createMemo(() => isInstanceLogStreaming(props.instanceId))

  const handleEnableLogs = () => setInstanceLogStreaming(props.instanceId, true)
  const handleDisableLogs = () => setInstanceLogStreaming(props.instanceId, false)

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

  const getLevelClass = (level: string) => {
    switch (level) {
      case "error":
        return "text-destructive"
      case "warn":
        return "text-warning"
      case "debug":
        return "text-muted-foreground"
      default:
        return "text-foreground"
    }
  }

  return (
    <div class="flex flex-col h-full bg-background">
      <div class="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary">
        <h3 class="text-sm font-medium text-muted-foreground">Server Logs</h3>
        <div class="flex items-center gap-2">
          <Show
            when={streamingEnabled()}
            fallback={
              <button type="button" class="inline-flex items-center justify-center gap-2 font-medium px-3 py-1.5 rounded-md text-sm transition-colors text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed" onClick={handleEnableLogs}>
                Show server logs
              </button>
            }
          >
            <button type="button" class="inline-flex items-center justify-center gap-2 font-medium px-3 py-1.5 rounded-md text-sm transition-colors text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed" onClick={handleDisableLogs}>
              Hide server logs
            </button>
          </Show>
        </div>
      </div>

      <Show when={instance()?.environmentVariables && Object.keys(instance()?.environmentVariables!).length > 0}>
        <div class="px-4 py-3 border-b bg-info/10 border-info/20">
          <div class="text-xs font-medium mb-2 text-info">
            Environment Variables ({Object.keys(instance()?.environmentVariables!).length})
          </div>
          <div class="space-y-1">
            <For each={Object.entries(instance()?.environmentVariables!)}>
              {([key, value]) => (
                <div class="flex items-center gap-2 text-xs">
                  <span class="font-mono font-medium min-w-0 flex-1 text-info">{key}</span>
                  <span class="text-info">=</span>
                  <span class="font-mono min-w-0 flex-1 text-info" title={value}>
                    {value}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        class="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed bg-secondary text-foreground"
      >
        <Show
          when={streamingEnabled()}
          fallback={
            <div class="flex flex-col items-center justify-center gap-3 text-center py-10 px-6 border border-dashed border-border rounded-xl bg-background">
              <p class="text-base font-semibold text-foreground">Server logs are paused</p>
              <p class="text-sm text-muted-foreground max-w-xs">Enable streaming to watch your OpenCode server activity.</p>
              <button type="button" class="inline-flex items-center justify-center gap-2 font-medium px-4 py-2 rounded-md transition-colors bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed" onClick={handleEnableLogs}>
                Show server logs
              </button>
            </div>
          }
        >
          <Show
            when={logs().length > 0}
            fallback={<div class="text-center py-8 text-muted-foreground">Waiting for server output...</div>}
          >
            <For each={logs()}>
              {(entry) => (
                <div class="flex gap-3 py-0.5 px-2 -mx-2 rounded transition-colors hover:bg-accent">
                  <span class="select-none shrink-0 text-muted-foreground">{formatTime(entry.timestamp)}</span>
                  <span class={cn("break-all", getLevelClass(entry.level))}>{entry.message}</span>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>

      <Show when={!autoScroll() && streamingEnabled()}>
        <button
          onClick={scrollToBottom}
          class="scroll-to-bottom"
        >
          <ChevronDown class="w-4 h-4" />
          Scroll to bottom
        </button>
      </Show>
    </div>

  )
}

export default LogsView
