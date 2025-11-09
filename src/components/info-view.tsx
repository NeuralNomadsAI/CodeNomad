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

  const getLevelColor = (level: string) => {
    switch (level) {
      case "error":
        return "log-level-error"
      case "warn":
        return "log-level-warn"
      case "debug":
        return "log-level-debug"
      default:
        return "log-level-default"
    }
  }

  return (
    <div class="log-container">
      <div class="flex-1 flex flex-col lg:flex-row gap-4 p-4 overflow-hidden">
        <div class="lg:w-80 flex-shrink-0 overflow-y-auto">
          <Show when={instance()}>{(inst) => <InstanceInfo instance={inst()} />}</Show>
        </div>

        <div class="panel flex-1 flex flex-col min-h-0 overflow-hidden">
          <div class="log-header">
            <h2 class="panel-title">Server Logs</h2>
            <div class="flex items-center gap-2">
              <Show
                when={streamingEnabled()}
                fallback={
                  <button type="button" class="button-tertiary" onClick={handleEnableLogs}>
                    Show server logs
                  </button>
                }
              >
                <button type="button" class="button-tertiary" onClick={handleDisableLogs}>
                  Hide server logs
                </button>
              </Show>
            </div>
          </div>
 
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            class="log-content"
          >
            <Show
              when={streamingEnabled()}
              fallback={
                <div class="log-paused-state">
                  <p class="log-paused-title">Server logs are paused</p>
                  <p class="log-paused-description">Enable streaming to watch your OpenCode server activity.</p>
                  <button type="button" class="button-primary" onClick={handleEnableLogs}>
                    Show server logs
                  </button>
                </div>
              }
            >
              <Show
                when={logs().length > 0}
                fallback={<div class="log-empty-state">Waiting for server output...</div>}
              >
                <For each={logs()}>
                  {(entry) => (
                    <div class="log-entry">
                      <span class="log-timestamp">
                        {formatTime(entry.timestamp)}
                      </span>
                      <span class={`log-message ${getLevelColor(entry.level)}`}>{entry.message}</span>
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
