import { Component, For, createSignal, createEffect, Show, onMount, onCleanup, createMemo } from "solid-js"
import { getInstanceLogs, instances, isInstanceLogStreaming, setInstanceLogStreaming, clearLogs } from "../stores/instances"
import { ArrowLeft, Trash2 } from "lucide-solid"
import InstanceInfo from "./instance-info"
import { useI18n } from "../lib/i18n"

interface InfoViewProps {
  instanceId: string
  onBackToConversation?: () => void
}

const logsScrollState = new Map<string, { scrollTop: number; autoScroll: boolean }>()

const InfoView: Component<InfoViewProps> = (props) => {
  const { t } = useI18n()
  let scrollRef: HTMLDivElement | undefined
  const savedState = logsScrollState.get(props.instanceId)
  const [autoScroll, setAutoScroll] = createSignal(savedState?.autoScroll ?? false)
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)

  const instance = () => instances().get(props.instanceId)
  const logs = createMemo(() => getInstanceLogs(props.instanceId))
  const streamingEnabled = createMemo(() => isInstanceLogStreaming(props.instanceId))

  const handleEnableLogs = () => setInstanceLogStreaming(props.instanceId, true)
  const handleDisableLogs = () => setInstanceLogStreaming(props.instanceId, false)
  const handleClearLogs = () => {
    clearLogs(props.instanceId)
    updateScrollButtons()
  }
 
  onMount(() => {

    if (scrollRef && savedState) {
      scrollRef.scrollTop = savedState.scrollTop
    }
    // 初始化滾動按鈕可見性 / Initialize scroll button visibility
    updateScrollButtons()
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

  // 監聽日誌變化並更新滾動按鈕 / Listen for log changes and update scroll buttons
  createEffect(() => {
    logs()  // 追蹤 logs 變化
    updateScrollButtons()
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

  /** 滾動至頂部 / Scroll to top */
  const scrollToTop = () => {
    if (scrollRef) {
      scrollRef.scrollTop = 0
      setAutoScroll(false)
      updateScrollButtons()
    }
  }

  const handleScroll = () => {
    if (!scrollRef) return

    const isAtBottom = scrollRef.scrollHeight - scrollRef.scrollTop <= scrollRef.clientHeight + 50

    setAutoScroll(isAtBottom)
    updateScrollButtons()
  }

  const scrollToBottom = () => {
    if (scrollRef) {
      scrollRef.scrollTop = scrollRef.scrollHeight
      setAutoScroll(true)
      updateScrollButtons()
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

  /** 是否顯示浮動滾動按鈕 / Whether to show floating scroll buttons */
  const showScrollButtons = createMemo(() => {
    return streamingEnabled() && (showScrollTopButton() || showScrollBottomButton())
  })

  return (
    <div class="log-container">
      <div class="flex-1 flex flex-col lg:flex-row gap-4 p-4 overflow-hidden">
        <div class="lg:w-80 flex-shrink-0 min-h-0 overflow-y-auto max-h-[40vh] lg:max-h-none">
          <Show when={instance()}>{(inst) => <InstanceInfo instance={inst()} showDisposeButton />}</Show>
        </div>

        <div class="panel flex-1 flex flex-col min-h-0 overflow-hidden">
          <div class="log-header">
            <h2 class="panel-title">{t("infoView.logs.title")}</h2>
            <div class="flex items-center gap-2">
              <Show when={props.onBackToConversation}>
                {(onBack) => (
                  <button
                    type="button"
                    class="button-tertiary"
                    onClick={onBack}
                    title={t("infoView.logs.actions.back")}
                  >
                    <ArrowLeft class="w-4 h-4" />
                  </button>
                )}
              </Show>
              <Show when={logs().length > 0}>
                <button
                  type="button"
                  class="button-tertiary"
                  onClick={handleClearLogs}
                  title={t("infoView.logs.actions.clear")}
                >
                  <Trash2 class="w-4 h-4" />
                </button>
              </Show>
              <Show
                when={streamingEnabled()}
                fallback={
                  <button type="button" class="button-tertiary" onClick={handleEnableLogs}>
                    {t("infoView.logs.actions.show")}
                  </button>
                }
              >
                <button type="button" class="button-tertiary" onClick={handleDisableLogs}>
                  {t("infoView.logs.actions.hide")}
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
                  <p class="log-paused-title">{t("infoView.logs.paused.title")}</p>
                  <p class="log-paused-description">{t("infoView.logs.paused.description")}</p>
                  <button type="button" class="button-primary" onClick={handleEnableLogs}>
                    {t("infoView.logs.actions.show")}
                  </button>
                </div>
              }
            >
              <Show
                when={logs().length > 0}
                fallback={<div class="log-empty-state">{t("infoView.logs.empty.waiting")}</div>}
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

          {/* 浮動滾動按鈕 / Floating scroll buttons */}
          <Show when={showScrollButtons()}>
            <div class="message-scroll-button-wrapper">
              <Show when={showScrollTopButton()}>
                <button
                  type="button"
                  class="message-scroll-button"
                  onClick={scrollToTop}
                  aria-label={t("infoView.logs.scrollToTop")}
                  title={t("infoView.logs.scrollToTop")}
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
                  aria-label={t("infoView.logs.scrollToBottom")}
                  title={t("infoView.logs.scrollToBottom")}
                >
                  <span class="message-scroll-icon" aria-hidden="true">
                    ↓
                  </span>
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}


export default InfoView
