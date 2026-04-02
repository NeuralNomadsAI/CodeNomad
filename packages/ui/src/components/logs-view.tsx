/**
 * Server Logs 視圖
 * Server Logs View
 *
 * 顯示實例的伺服器日誌
 * Displays server logs for an instance
 */
import { Component, For, createSignal, createEffect, Show, onMount, onCleanup, createMemo } from "solid-js"
import {
  instances,
  getInstanceLogs,
  isInstanceLogStreaming,
  setInstanceLogStreaming,
  clearLogs,
} from "../stores/instances"
import { ChevronDown, ChevronUp, ArrowLeft, Trash2 } from "lucide-solid"
import { useI18n } from "../lib/i18n"

interface LogsViewProps {
  /** 實例 ID / Instance ID */
  instanceId: string;
  /** 返回對話回調（可選）/ Back to conversation callback (optional) */
  onBackToConversation?: () => void;
}

/** 滾動狀態緩存 / Scroll state cache */
const logsScrollState = new Map<string, { scrollTop: number; autoScroll: boolean }>()

const LogsView: Component<LogsViewProps> = (props) => {
  const { t } = useI18n()
  let scrollRef: HTMLDivElement | undefined
  const savedState = logsScrollState.get(props.instanceId)
  const [autoScroll, setAutoScroll] = createSignal(savedState?.autoScroll ?? true)
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)

  const instance = () => instances().get(props.instanceId)
  const logs = createMemo(() => getInstanceLogs(props.instanceId))
  const streamingEnabled = createMemo(() => isInstanceLogStreaming(props.instanceId))

  /** 處理啟用日誌 / Handle enable logs */
  const handleEnableLogs = () => setInstanceLogStreaming(props.instanceId, true)

  /** 處理停用日誌 / Handle disable logs */
  const handleDisableLogs = () => setInstanceLogStreaming(props.instanceId, false)

  /** 處理清除日誌 / Handle clear logs */
  const handleClearLogs = () => clearLogs(props.instanceId)

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

  /** 更新滾動按鈕顯示狀態 / Update scroll button visibility */
  const updateScrollButtons = () => {
    if (!scrollRef) return

    const scrollTop = scrollRef.scrollTop
    const scrollHeight = scrollRef.scrollHeight
    const clientHeight = scrollRef.clientHeight
    const hasItems = logs().length > 0

    const atBottom = scrollHeight - (scrollTop + clientHeight) <= 50
    const atTop = scrollTop <= 50

    setShowScrollBottomButton(hasItems && !atBottom)
    setShowScrollTopButton(hasItems && !atTop)
  }

  /** 處理滾動 / Handle scroll */
  const handleScroll = () => {
    if (!scrollRef) return

    const isAtBottom = scrollRef.scrollHeight - scrollRef.scrollTop <= scrollRef.clientHeight + 50

    setAutoScroll(isAtBottom)
    updateScrollButtons()
  }

  /** 滾動至底部 / Scroll to bottom */
  const scrollToBottom = () => {
    if (scrollRef) {
      scrollRef.scrollTop = scrollRef.scrollHeight
      setAutoScroll(true)
    }
  }

  /** 滾動至頂部 / Scroll to top */
  const scrollToTop = () => {
    if (scrollRef) {
      scrollRef.scrollTop = 0
      setAutoScroll(false)
    }
  }

  /** 格式化時間 / Format time */
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  }

  /** 獲取級別顏色 / Get level color */
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

  /** 是否顯示滾動按鈕 / Whether to show scroll buttons */
  const showScrollButtons = createMemo(() => {
    return streamingEnabled() && (showScrollTopButton() || showScrollBottomButton())
  })

  return (
    <div class="log-container">
      <div class="log-header">
        <div class="flex items-center gap-2">
          {/* 返回對話按鈕 / Back to conversation button */}
          <Show when={props.onBackToConversation}>
            <button
              type="button"
              class="button-tertiary"
              onClick={props.onBackToConversation}
              title={t("logsView.actions.back")}
            >
              <ArrowLeft class="w-4 h-4" />
            </button>
          </Show>
          <h3 class="text-sm font-medium" style="color: var(--text-secondary)">{t("logsView.title")}</h3>
        </div>
        <div class="flex items-center gap-2">
          <Show when={logs().length > 0}>
            <button
              type="button"
              class="button-tertiary"
              onClick={handleClearLogs}
              title={t("logsView.actions.clear")}
            >
              <Trash2 class="w-4 h-4" />
            </button>
          </Show>
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

      {/* 浮動滾動按鈕 / Floating scroll buttons */}
      <Show when={showScrollButtons()}>
        <div class="message-scroll-button-wrapper">
          <Show when={showScrollTopButton()}>
            <button
              type="button"
              class="message-scroll-button"
              onClick={scrollToTop}
              aria-label={t("logsView.scrollToTop")}
              title={t("logsView.scrollToTop")}
            >
              <span class="message-scroll-icon" aria-hidden="true">
                ↑
              </span>
            </button>
          </Show>
          <Show when={showScrollBottomButton()}>
            <button
              type="button"
              class="message-scroll-button"
              onClick={scrollToBottom}
              aria-label={t("logsView.scrollToBottom")}
              title={t("logsView.scrollToBottom")}
            >
              <span class="message-scroll-icon" aria-hidden="true">
                ↓
              </span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default LogsView
