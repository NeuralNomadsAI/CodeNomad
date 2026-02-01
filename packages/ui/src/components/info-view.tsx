import { Component, For, createSignal, createEffect, Show, onMount, onCleanup, createMemo } from "solid-js"
import { instances, getInstanceLogs, isInstanceLogStreaming, setInstanceLogStreaming } from "../stores/instances"
import { ChevronDown } from "lucide-solid"
import InstanceInfo from "./instance-info"

interface InfoViewProps {
  instanceId: string
}

const logsScrollState = new Map<string, { scrollTop: number; autoScroll: boolean }>()

const InfoView: Component<InfoViewProps> = (props) => {
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
      <div class="flex-1 flex flex-col lg:flex-row gap-4 p-4 overflow-hidden">
        <div class="lg:w-80 flex-shrink-0 overflow-y-auto">
          <Show when={instance()}>{(inst) => <InstanceInfo instance={inst()} />}</Show>
        </div>

        <div class="rounded-lg shadow-sm border border-border overflow-hidden min-w-0 bg-background text-foreground flex-1 flex flex-col min-h-0">
          <div class="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary">
            <h2 class="text-base font-semibold text-foreground">Server Logs</h2>
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
                  <p class="text-sm text-muted-foreground max-w-[320px]">Enable streaming to watch your OpenCode server activity.</p>
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
                      <span class="select-none shrink-0 text-muted-foreground">
                        {formatTime(entry.timestamp)}
                      </span>
                      <span class={`break-all ${getLevelClass(entry.level)}`}>{entry.message}</span>
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
      </div>
    </div>
  )
}


export default InfoView
