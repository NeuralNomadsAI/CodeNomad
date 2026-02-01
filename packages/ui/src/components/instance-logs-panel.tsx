import { Component, For, createSignal, createEffect, Show, createMemo } from "solid-js"
import { getInstanceLogs, isInstanceLogStreaming, setInstanceLogStreaming } from "../stores/instances"
import { ChevronDown } from "lucide-solid"
import { cn } from "../lib/cn"

interface InstanceLogsPanelProps {
  instanceId: string
}

const InstanceLogsPanel: Component<InstanceLogsPanelProps> = (props) => {
  let scrollRef: HTMLDivElement | undefined
  const [autoScroll, setAutoScroll] = createSignal(true)

  const logs = createMemo(() => getInstanceLogs(props.instanceId))
  const streamingEnabled = createMemo(() => isInstanceLogStreaming(props.instanceId))

  const handleEnableLogs = () => setInstanceLogStreaming(props.instanceId, true)
  const handleDisableLogs = () => setInstanceLogStreaming(props.instanceId, false)

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
    <div class="flex flex-col h-full relative bg-background">
      <div class="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary">
        <Show
          when={streamingEnabled()}
          fallback={
            <button type="button" class="inline-flex items-center justify-center gap-2 font-medium px-3 py-1.5 rounded-md text-sm transition-colors text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed" onClick={handleEnableLogs}>
              Enable log streaming
            </button>
          }
        >
          <button type="button" class="inline-flex items-center justify-center gap-2 font-medium px-3 py-1.5 rounded-md text-sm transition-colors text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed" onClick={handleDisableLogs}>
            Disable log streaming
          </button>
        </Show>
      </div>

      <div ref={scrollRef} onScroll={handleScroll} class="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed bg-secondary text-foreground">
        <Show
          when={streamingEnabled()}
          fallback={
            <div class="flex flex-col items-center justify-center gap-3 text-center py-10 px-6 border border-dashed border-border rounded-xl bg-background">
              <p class="text-sm text-foreground">Log streaming is paused</p>
              <p class="text-xs text-muted-foreground">Enable streaming to view server activity</p>
              <button type="button" class="inline-flex items-center justify-center gap-2 font-medium px-4 py-2 rounded-md transition-colors bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed" onClick={handleEnableLogs}>
                Enable streaming
              </button>
            </div>
          }
        >
          <Show
            when={logs().length > 0}
            fallback={<div class="text-center py-8 text-muted-foreground">Waiting for logs...</div>}
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
        <button onClick={scrollToBottom} class="scroll-to-bottom">
          <ChevronDown class="w-4 h-4" />
          Scroll to bottom
        </button>
      </Show>
    </div>
  )
}

export default InstanceLogsPanel
