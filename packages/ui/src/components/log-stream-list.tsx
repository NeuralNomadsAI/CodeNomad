import { ChevronDown } from "lucide-solid"
import { Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import VirtualItem from "./virtual-item"
import type { LogEntry } from "../types/instance"

const LOG_AUTOSCROLL_TOLERANCE_PX = 50
const LOG_VIRTUALIZATION_THRESHOLD = 120
const LOG_VISIBLE_TAIL_COUNT = 80
const LOG_OVERSCAN_PX = 800
const LOG_PLACEHOLDER_HEIGHT_PX = 28

const logsScrollState = new Map<string, { scrollTop: number; autoScroll: boolean }>()

interface LogStreamListProps {
  scrollStateKey: string
  logs: Accessor<LogEntry[]>
  streamingEnabled: Accessor<boolean>
  onEnableLogs: () => void
  emptyLabel: string
  pausedTitle: string
  pausedDescription: string
  showLogsLabel: string
  scrollToBottomLabel: string
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function getLevelColor(level: string) {
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

export default function LogStreamList(props: LogStreamListProps) {
  let scrollRef: HTMLDivElement | undefined
  const savedState = logsScrollState.get(props.scrollStateKey)
  const [autoScroll, setAutoScroll] = createSignal(savedState?.autoScroll ?? false)

  const logCount = createMemo(() => props.logs().length)
  const virtualizationEnabled = createMemo(() => logCount() >= LOG_VIRTUALIZATION_THRESHOLD)

  onMount(() => {
    if (scrollRef && savedState) {
      scrollRef.scrollTop = savedState.scrollTop
    }
  })

  onCleanup(() => {
    if (!scrollRef) {
      return
    }

    logsScrollState.set(props.scrollStateKey, {
      scrollTop: scrollRef.scrollTop,
      autoScroll: autoScroll(),
    })
  })

  createEffect(() => {
    if (!autoScroll() || !scrollRef || logCount() === 0) {
      return
    }

    requestAnimationFrame(() => {
      if (!scrollRef) {
        return
      }
      scrollRef.scrollTop = scrollRef.scrollHeight
    })
  })

  const handleScroll = () => {
    if (!scrollRef) {
      return
    }

    const isAtBottom = scrollRef.scrollHeight - scrollRef.scrollTop <= scrollRef.clientHeight + LOG_AUTOSCROLL_TOLERANCE_PX
    setAutoScroll(isAtBottom)
  }

  const scrollToBottom = () => {
    if (!scrollRef) {
      return
    }

    scrollRef.scrollTop = scrollRef.scrollHeight
    setAutoScroll(true)
  }

  return (
    <>
      <div ref={scrollRef} onScroll={handleScroll} class="log-content">
        <Show
          when={props.streamingEnabled()}
          fallback={
            <div class="log-paused-state">
              <p class="log-paused-title">{props.pausedTitle}</p>
              <p class="log-paused-description">{props.pausedDescription}</p>
              <button type="button" class="button-primary" onClick={props.onEnableLogs}>
                {props.showLogsLabel}
              </button>
            </div>
          }
        >
          <Show when={logCount() > 0} fallback={<div class="log-empty-state">{props.emptyLabel}</div>}>
            <Index each={props.logs()}>
              {(entry, index) => {
                const key = () => `${entry().timestamp}:${entry().level}:${index}`
                const forceVisible = () => index >= Math.max(0, logCount() - LOG_VISIBLE_TAIL_COUNT)

                return (
                  <VirtualItem
                    cacheKey={key()}
                    scrollContainer={() => scrollRef}
                    threshold={LOG_OVERSCAN_PX}
                    minPlaceholderHeight={LOG_PLACEHOLDER_HEIGHT_PX}
                    placeholderClass="log-entry-placeholder"
                    virtualizationEnabled={virtualizationEnabled}
                    forceVisible={forceVisible}
                  >
                    <div class="log-entry">
                      <span class="log-timestamp">{formatTime(entry().timestamp)}</span>
                      <span class={`log-message ${getLevelColor(entry().level)}`}>{entry().message}</span>
                    </div>
                  </VirtualItem>
                )
              }}
            </Index>
          </Show>
        </Show>
      </div>

      <Show when={!autoScroll() && props.streamingEnabled()}>
        <button onClick={scrollToBottom} class="scroll-to-bottom">
          <ChevronDown class="w-4 h-4" />
          {props.scrollToBottomLabel}
        </button>
      </Show>
    </>
  )
}
