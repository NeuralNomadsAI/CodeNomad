import { Component, For, createSignal, createEffect, Show, onMount, onCleanup, createMemo } from "solid-js"
import { instances, getInstanceLogs, isInstanceLogStreaming, setInstanceLogStreaming } from "../stores/instances"
import { ChevronDown } from "lucide-solid"
import { useI18n } from "../lib/i18n"

interface LogsViewProps {
  instanceId: string
}

const logsScrollState = new Map<string, { scrollTop: number; autoScroll: boolean }>()

const LogsView: Component<LogsViewProps> = (props) => {
  const { t } = useI18n()
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
      <div class="log-header">
        <h3 class="text-sm font-medium" style="color: var(--text-secondary)">{t("logsView.title")}</h3>
        <div class="flex items-center gap-2">
          <Show
            when={streamingEnabled()}
            fallback={
              <button type="button" class="button-tertiary" onClick={handleEnableLogs}>
                {t("logsView.actions.show")}
              </button>
            }
          >
            <button type="button" class="button-tertiary" onClick={handleDisableLogs}>
              {t("logsView.actions.hide")}
            </button>
          </Show>
        </div>
      </div>

      <Show when={instance()?.environmentVariables && Object.keys(instance()?.environmentVariables!).length > 0}>
        <div class="env-vars-container">
          <div class="env-vars-title">
            {t("logsView.envVars.title", { count: Object.keys(instance()?.environmentVariables!).length })}
          </div>
          <div class="space-y-1">
            <For each={Object.entries(instance()?.environmentVariables!)}>
              {([key, value]) => (
                <div class="env-var-item">
                  <span class="env-var-key">{key}</span>
                  <span class="env-var-separator">=</span>
                  <span class="env-var-value" title={value}>
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
        class="log-content"
      >
        <Show
          when={streamingEnabled()}
          fallback={
            <div class="log-paused-state">
              <p class="log-paused-title">{t("logsView.paused.title")}</p>
              <p class="log-paused-description">{t("logsView.paused.description")}</p>
              <button type="button" class="button-primary" onClick={handleEnableLogs}>
                {t("logsView.actions.show")}
              </button>
            </div>
          }
        >
          <Show
            when={logs().length > 0}
            fallback={<div class="log-empty-state">{t("logsView.empty.waiting")}</div>}
          >
            <For each={logs()}>
              {(entry) => (
                <div class="log-entry">
                  <span class="log-timestamp">{formatTime(entry.timestamp)}</span>
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
          {t("logsView.scrollToBottom")}
        </button>
      </Show>
    </div>

  )
}

export default LogsView
