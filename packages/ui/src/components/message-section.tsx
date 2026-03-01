import { Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { CheckSquare, Trash, X } from "lucide-solid"
import Kbd from "./kbd"
import MessageBlock from "./message-block"
import { getMessageAnchorId, getMessageIdFromAnchorId } from "./message-anchors"
import MessageTimeline, { buildTimelineSegments, type TimelineSegment } from "./message-timeline"
import VirtualFollowList, { type VirtualFollowListApi, type VirtualFollowListState } from "./virtual-follow-list"
import { useConfig } from "../stores/preferences"
import { getSessionInfo } from "../stores/sessions"
import { messageStoreBus } from "../stores/message-v2/bus"
import { useI18n } from "../lib/i18n"
import { copyToClipboard } from "../lib/clipboard"
import { showToastNotification } from "../lib/notifications"
import { showAlertDialog } from "../stores/alerts"
import { deleteMessage } from "../stores/session-actions"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { DeleteHoverState } from "../types/delete-hover"

const SCROLL_SENTINEL_MARGIN_PX = 48
const QUOTE_SELECTION_MAX_LENGTH = 2000
const codeNomadLogo = new URL("../images/CodeNomad-Icon.png", import.meta.url).href

export interface MessageSectionProps {
  instanceId: string
  sessionId: string
  loading?: boolean
  onRevert?: (messageId: string) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  onFork?: (messageId?: string) => void
  registerScrollToBottom?: (fn: () => void) => void
  showSidebarToggle?: boolean
  onSidebarToggle?: () => void
  forceCompactStatusLayout?: boolean
  onQuoteSelection?: (text: string, mode: "quote" | "code") => void
  isActive?: boolean
}

export default function MessageSection(props: MessageSectionProps) {
  const { preferences } = useConfig()
  const { t } = useI18n()
  const showUsagePreference = () => preferences().showUsageMetrics ?? true
  const showTimelineToolsPreference = () => preferences().showTimelineTools ?? true
  const store = createMemo<InstanceMessageStore>(() => messageStoreBus.getOrCreate(props.instanceId))
  const messageIds = createMemo(() => store().getSessionMessageIds(props.sessionId))

  const sessionRevision = createMemo(() => store().getSessionRevision(props.sessionId))
  const usageSnapshot = createMemo(() => store().getSessionUsage(props.sessionId))
  const sessionInfo = createMemo(() =>
    getSessionInfo(props.instanceId, props.sessionId) ?? {
      cost: 0,
      contextWindow: 0,
      isSubscriptionModel: false,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      actualUsageTokens: 0,
      modelOutputLimit: 0,
      contextAvailableTokens: null,
    },
  )

  const tokenStats = createMemo(() => {
    const usage = usageSnapshot()
    const info = sessionInfo()
    return {
      used: usage?.actualUsageTokens ?? info.actualUsageTokens ?? 0,
      avail: info.contextAvailableTokens,
    }
  })

  const preferenceSignature = createMemo(() => {
    const pref = preferences()
    const showThinking = pref.showThinkingBlocks ? 1 : 0
    const thinkingExpansion = pref.thinkingBlocksExpansion ?? "expanded"
    const showUsage = (pref.showUsageMetrics ?? true) ? 1 : 0
    return `${showThinking}|${thinkingExpansion}|${showUsage}`
  })

  const handleTimelineSegmentClick = (segment: TimelineSegment) => {
    const api = listApi()
    if (api) {
      api.scrollToKey(segment.messageId, { behavior: "smooth", block: "start" })
      return
    }
    if (typeof document === "undefined") return
    const anchor = document.getElementById(getMessageAnchorId(segment.messageId))
    anchor?.scrollIntoView({ block: "start", behavior: "smooth" })
  }
 
  const lastAssistantIndex = createMemo(() => {
    const ids = messageIds()
    const resolvedStore = store()
    for (let index = ids.length - 1; index >= 0; index--) {
      const record = resolvedStore.getMessage(ids[index])
      if (record?.role === "assistant") {
        return index
      }
    }
    return -1
  })
 
  const [timelineSegments, setTimelineSegments] = createSignal<TimelineSegment[]>([])
  const hasTimelineSegments = () => timelineSegments().length > 0

  const seenTimelineMessageIds = new Set<string>()
  const seenTimelineSegmentKeys = new Set<string>()
  const timelinePartCountsByMessageId = new Map<string, number>()
  let pendingTimelineMessagePartUpdates = new Set<string>()
  let pendingTimelinePartUpdateFrame: number | null = null

  function makeTimelineKey(segment: TimelineSegment) {
    return `${segment.messageId}:${segment.id}:${segment.type}`
  }

  function seedTimeline() {
    seenTimelineMessageIds.clear()
    seenTimelineSegmentKeys.clear()
    timelinePartCountsByMessageId.clear()
    const ids = untrack(messageIds)
    const resolvedStore = untrack(store)
    const segments: TimelineSegment[] = []
    ids.forEach((messageId) => {
      const record = resolvedStore.getMessage(messageId)
      if (!record) return
      seenTimelineMessageIds.add(messageId)
      timelinePartCountsByMessageId.set(messageId, record.partIds.length)
      const built = buildTimelineSegments(props.instanceId, record, t)
      built.forEach((segment) => {
        const key = makeTimelineKey(segment)
        if (seenTimelineSegmentKeys.has(key)) return
        seenTimelineSegmentKeys.add(key)
        segments.push(segment)
      })
    })
    setTimelineSegments(segments)
  }

  function appendTimelineForMessage(messageId: string) {
    const record = untrack(() => store().getMessage(messageId))
    if (!record) return
    timelinePartCountsByMessageId.set(messageId, record.partIds.length)
    const built = buildTimelineSegments(props.instanceId, record, t)
    if (built.length === 0) return
    const newSegments: TimelineSegment[] = []
    built.forEach((segment) => {
      const key = makeTimelineKey(segment)
      if (seenTimelineSegmentKeys.has(key)) return
      seenTimelineSegmentKeys.add(key)
      newSegments.push(segment)
    })
    if (newSegments.length > 0) {
      setTimelineSegments((prev) => [...prev, ...newSegments])
    }
  }
  const [activeMessageId, setActiveMessageId] = createSignal<string | null>(null)

  const [deleteHover, setDeleteHover] = createSignal<DeleteHoverState>({ kind: "none" })

  const [selectedForDeletion, setSelectedForDeletion] = createSignal<Set<string>>(new Set<string>())
  const isDeleteMode = createMemo(() => selectedForDeletion().size > 0)
  const selectedDeleteCount = createMemo(() => selectedForDeletion().size)

  const isMessageSelectedForDeletion = (messageId: string) => selectedForDeletion().has(messageId)

  const setMessageSelectedForDeletion = (messageId: string, selected: boolean) => {
    if (!messageId) return
    setSelectedForDeletion((prev) => {
      const next = new Set(prev)
      if (selected) {
        next.add(messageId)
      } else {
        next.delete(messageId)
      }
      return next
    })
  }

  const clearDeleteMode = () => {
    setSelectedForDeletion(new Set<string>())
    setDeleteHover({ kind: "none" })
  }

  const selectAllForDeletion = () => {
    setSelectedForDeletion(new Set<string>(messageIds()))
  }

  const deleteSelectedMessages = async () => {
    const selected = selectedForDeletion()
    if (selected.size === 0) return

    const idsInSessionOrder = messageIds()
    const toDelete: string[] = []
    for (let idx = idsInSessionOrder.length - 1; idx >= 0; idx -= 1) {
      const id = idsInSessionOrder[idx]
      if (selected.has(id)) {
        toDelete.push(id)
      }
    }

    try {
      for (const messageId of toDelete) {
        await deleteMessage(props.instanceId, props.sessionId, messageId)
      }
      clearDeleteMode()
    } catch (error) {
      showAlertDialog(t("messageSection.bulkDelete.failedMessage"), {
        title: t("messageSection.bulkDelete.failedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }
 
  const isActive = createMemo(() => props.isActive !== false)
  const [listApi, setListApi] = createSignal<VirtualFollowListApi | null>(null)
  const [listState, setListState] = createSignal<VirtualFollowListState | null>(null)
  const scrollButtonsCount = createMemo(() => listState()?.scrollButtonsCount() ?? 0)

  const [streamElement, setStreamElement] = createSignal<HTMLDivElement | undefined>()
  const [streamShellElement, setStreamShellElement] = createSignal<HTMLDivElement | undefined>()

  const followToken = createMemo(() => `${sessionRevision()}|${preferenceSignature()}`)

  const [quoteSelection, setQuoteSelection] = createSignal<{ text: string; top: number; left: number } | null>(null)

  createEffect(() => {
    const api = listApi()
    if (!api) return
    if (props.registerScrollToBottom) {
      props.registerScrollToBottom(() => api.scrollToBottom({ immediate: true }))
    }
  })

  function clearQuoteSelection() {
    setQuoteSelection(null)
  }

  function isSelectionWithinStream(range: Range | null) {
    const container = streamElement()
    if (!range || !container) return false
    const node = range.commonAncestorContainer
    if (!node) return false
    return container.contains(node)
  }

  function updateQuoteSelectionFromSelection() {
    if (!props.onQuoteSelection || typeof window === "undefined") {
      clearQuoteSelection()
      return
    }
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      clearQuoteSelection()
      return
    }
    const range = selection.getRangeAt(0)
    if (!isSelectionWithinStream(range)) {
      clearQuoteSelection()
      return
    }
    const shell = streamShellElement()
    if (!shell) {
      clearQuoteSelection()
      return
    }
    const rawText = selection.toString().trim()
    if (!rawText) {
      clearQuoteSelection()
      return
    }
    const limited =
      rawText.length > QUOTE_SELECTION_MAX_LENGTH ? rawText.slice(0, QUOTE_SELECTION_MAX_LENGTH).trimEnd() : rawText
    if (!limited) {
      clearQuoteSelection()
      return
    }
    const rects = range.getClientRects()
    const anchorRect = rects.length > 0 ? rects[0] : range.getBoundingClientRect()
    const shellRect = shell.getBoundingClientRect()
    const relativeTop = Math.max(anchorRect.top - shellRect.top - 40, 8)
    // Keep the popover within the stream shell. The quote popover currently
    // renders 3 actions; keep enough horizontal room for the pill.
    const maxLeft = Math.max(shell.clientWidth - 260, 8)
    const relativeLeft = Math.min(Math.max(anchorRect.left - shellRect.left, 8), maxLeft)
    setQuoteSelection({ text: limited, top: relativeTop, left: relativeLeft })
  }

  function handleStreamMouseUp() {
    updateQuoteSelectionFromSelection()
  }

  function handleQuoteSelectionRequest(mode: "quote" | "code") {
    const info = quoteSelection()
    if (!info || !props.onQuoteSelection) return
    props.onQuoteSelection(info.text, mode)
    clearQuoteSelection()
    if (typeof window !== "undefined") {
      const selection = window.getSelection()
      selection?.removeAllRanges()
    }
  }

  async function handleCopySelectionRequest() {
    const info = quoteSelection()
    if (!info) return

    const success = await copyToClipboard(info.text)
    showToastNotification({
      message: success ? t("messageSection.quote.copied") : t("messageSection.quote.copyFailed"),
      variant: success ? "success" : "error",
      duration: success ? 2000 : 6000,
    })

    clearQuoteSelection()
    if (typeof window !== "undefined") {
      const selection = window.getSelection()
      selection?.removeAllRanges()
    }
  }
 
  function handleContentRendered() {
    if (props.loading) return
    listApi()?.notifyContentRendered()
  }

  let previousTimelineIds: string[] = []

  createEffect(() => {
    const loading = Boolean(props.loading)
    const ids = messageIds()

    if (loading) {
      previousTimelineIds = []
      setTimelineSegments([])
      seenTimelineMessageIds.clear()
      seenTimelineSegmentKeys.clear()
      timelinePartCountsByMessageId.clear()
      pendingTimelineMessagePartUpdates.clear()
      if (pendingTimelinePartUpdateFrame !== null) {
        cancelAnimationFrame(pendingTimelinePartUpdateFrame)
        pendingTimelinePartUpdateFrame = null
      }
      return
    }

    if (previousTimelineIds.length === 0 && ids.length > 0) {
      seedTimeline()
      previousTimelineIds = ids.slice()
      return
    }

    if (ids.length < previousTimelineIds.length) {
      seedTimeline()
      previousTimelineIds = ids.slice()
      return
    }

    if (ids.length === previousTimelineIds.length) {
      let changedIndex = -1
      let changeCount = 0
      for (let index = 0; index < ids.length; index++) {
        if (ids[index] !== previousTimelineIds[index]) {
          changedIndex = index
          changeCount += 1
          if (changeCount > 1) break
        }
      }
      if (changeCount === 1 && changedIndex >= 0) {
        const oldId = previousTimelineIds[changedIndex]
        const newId = ids[changedIndex]
        if (seenTimelineMessageIds.has(oldId) && !seenTimelineMessageIds.has(newId)) {
          seenTimelineMessageIds.delete(oldId)
          seenTimelineMessageIds.add(newId)
          setTimelineSegments((prev) => {
            const next = prev.map((segment) => {
              if (segment.messageId !== oldId) return segment
              const updatedId = segment.id.replace(oldId, newId)
              return { ...segment, messageId: newId, id: updatedId }
            })
            seenTimelineSegmentKeys.clear()
            next.forEach((segment) => seenTimelineSegmentKeys.add(makeTimelineKey(segment)))
            return next
          })

          // Keep part count tracking in sync with id replacement.
          const existingPartCount = timelinePartCountsByMessageId.get(oldId)
          if (existingPartCount !== undefined) {
            timelinePartCountsByMessageId.delete(oldId)
            timelinePartCountsByMessageId.set(newId, existingPartCount)
          }

          previousTimelineIds = ids.slice()
          return
        }
      }
    }

    const newIds: string[] = []
    ids.forEach((id) => {
      if (!seenTimelineMessageIds.has(id)) {
        newIds.push(id)
      }
    })

    if (newIds.length > 0) {
      newIds.forEach((id) => {
        seenTimelineMessageIds.add(id)
        appendTimelineForMessage(id)
      })
    }

    previousTimelineIds = ids.slice()
  })

  function clearPendingTimelinePartUpdateFrame() {
    if (pendingTimelinePartUpdateFrame !== null) {
      cancelAnimationFrame(pendingTimelinePartUpdateFrame)
      pendingTimelinePartUpdateFrame = null
    }
  }

  function scheduleTimelinePartUpdateFlush() {
    if (pendingTimelinePartUpdateFrame !== null) return
    pendingTimelinePartUpdateFrame = requestAnimationFrame(() => {
      pendingTimelinePartUpdateFrame = null
      if (pendingTimelineMessagePartUpdates.size === 0) return
      const changedIds = Array.from(pendingTimelineMessagePartUpdates)
      pendingTimelineMessagePartUpdates = new Set<string>()

      const ids = messageIds()
      const resolvedStore = store()

      setTimelineSegments((prev) => {
        let next = prev

        for (const changedId of changedIds) {
          // Remove old segments for this message.
          next = next.filter((segment) => segment.messageId !== changedId)

          const record = resolvedStore.getMessage(changedId)
          const rebuilt = record ? buildTimelineSegments(props.instanceId, record, t) : []

          // Insert rebuilt segments in the correct place based on session message order.
          if (rebuilt.length > 0) {
            let insertAt = next.length
            const changedIndex = ids.indexOf(changedId)
            if (changedIndex >= 0) {
              for (let i = changedIndex + 1; i < ids.length; i++) {
                const followingId = ids[i]
                const existingIndex = next.findIndex((segment) => segment.messageId === followingId)
                if (existingIndex >= 0) {
                  insertAt = existingIndex
                  break
                }
              }
            }
            next = [...next.slice(0, insertAt), ...rebuilt, ...next.slice(insertAt)]
          }
        }

        // Rebuild the segment key set since we may have removed/replaced segments.
        seenTimelineSegmentKeys.clear()
        next.forEach((segment) => seenTimelineSegmentKeys.add(makeTimelineKey(segment)))
        return next
      })
    })
  }

  // Keep timeline segments in sync when message parts are added/removed.
  // Part deletion does not remove message ids from the session, so we must
  // explicitly replace segments for messages whose part count changed.
  createEffect(() => {
    if (props.loading) return
    const ids = messageIds()
    const resolvedStore = store()

    let hasChanges = false
    for (const messageId of ids) {
      const record = resolvedStore.getMessage(messageId)
      const partCount = record?.partIds.length ?? 0
      const previousCount = timelinePartCountsByMessageId.get(messageId)

      if (previousCount === undefined) {
        timelinePartCountsByMessageId.set(messageId, partCount)
        continue
      }

      if (previousCount !== partCount) {
        timelinePartCountsByMessageId.set(messageId, partCount)
        pendingTimelineMessagePartUpdates.add(messageId)
        hasChanges = true
      }
    }

    // Drop tracking for ids that are no longer present.
    for (const trackedId of Array.from(timelinePartCountsByMessageId.keys())) {
      if (!ids.includes(trackedId)) {
        timelinePartCountsByMessageId.delete(trackedId)
      }
    }

    if (hasChanges) {
      scheduleTimelinePartUpdateFlush()
    }
  })

  createEffect(() => {
    if (!props.onQuoteSelection) {
      clearQuoteSelection()
    }
  })


  createEffect(() => {
    if (typeof document === "undefined") return
    const handleSelectionChange = () => updateQuoteSelectionFromSelection()
    const handlePointerDown = (event: PointerEvent) => {
      const shell = streamShellElement()
      if (!shell) return
      if (!shell.contains(event.target as Node)) {
        clearQuoteSelection()
      }
    }
    document.addEventListener("selectionchange", handleSelectionChange)
    document.addEventListener("pointerdown", handlePointerDown)
    onCleanup(() => {
      document.removeEventListener("selectionchange", handleSelectionChange)
      document.removeEventListener("pointerdown", handlePointerDown)
    })
  })
 
  createEffect(() => {
    if (props.loading) {
      clearQuoteSelection()
    }
  })

  onCleanup(() => {
    clearPendingTimelinePartUpdateFrame()
    clearQuoteSelection()
  })

  return (
    <div
      class="message-stream-container"
      data-instance-id={props.instanceId}
      data-session-id={props.sessionId}
      data-stream-active={isActive() ? "true" : "false"}
    >
      <div
        class={`message-layout${hasTimelineSegments() ? " message-layout--with-timeline" : ""}`}
        data-scroll-buttons={scrollButtonsCount()}
      >
        <VirtualFollowList
          items={messageIds}
          getKey={(messageId) => messageId}
          getAnchorId={getMessageAnchorId}
          getKeyFromAnchorId={getMessageIdFromAnchorId}
          overscanPx={800}
          scrollSentinelMarginPx={SCROLL_SENTINEL_MARGIN_PX}
          virtualizationEnabled={() => !props.loading}
          suspendMeasurements={() => !isActive()}
          loading={() => Boolean(props.loading)}
          isActive={isActive}
          followToken={followToken}
          onScroll={() => clearQuoteSelection()}
          onMouseUp={() => handleStreamMouseUp()}
          onActiveKeyChange={setActiveMessageId}
          onScrollElementChange={(element) => {
            setStreamElement(element)
            if (!element) clearQuoteSelection()
          }}
          onShellElementChange={(element) => {
            setStreamShellElement(element)
            if (!element) clearQuoteSelection()
          }}
          scrollToTopAriaLabel={() => t("messageSection.scroll.toFirstAriaLabel")}
          scrollToBottomAriaLabel={() => t("messageSection.scroll.toLatestAriaLabel")}
          registerApi={(api) => setListApi(api)}
          registerState={(state) => setListState(state)}
          renderBeforeItems={() => (
            <>
              <Show when={!props.loading && messageIds().length === 0}>
                <div class="empty-state">
                  <div class="empty-state-content">
                    <div class="flex flex-col items-center gap-3 mb-6">
                      <img
                        src={codeNomadLogo}
                        alt={t("messageSection.empty.logoAlt")}
                        class="h-48 w-auto"
                        loading="lazy"
                      />
                      <h1 class="text-3xl font-semibold text-primary">{t("messageSection.empty.brandTitle")}</h1>
                    </div>
                    <h3>{t("messageSection.empty.title")}</h3>
                    <p>{t("messageSection.empty.description")}</p>
                    <ul>
                      <li>
                        <span>{t("messageSection.empty.tips.commandPalette")}</span>
                        <Kbd shortcut="cmd+shift+p" class="ml-2 kbd-hint" />
                      </li>
                      <li>{t("messageSection.empty.tips.askAboutCodebase")}</li>
                      <li>
                        {t("messageSection.empty.tips.attachFilesPrefix")} <code>@</code>
                      </li>
                    </ul>
                  </div>
                </div>
              </Show>

              <Show when={props.loading}>
                <div class="loading-state">
                  <div class="spinner" />
                  <p>{t("messageSection.loading.messages")}</p>
                </div>
              </Show>
            </>
          )}
          renderItem={(messageId, index) => (
            <MessageBlock
              messageId={messageId}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              store={store}
              messageIndex={index}
              lastAssistantIndex={lastAssistantIndex}
              showThinking={() => preferences().showThinkingBlocks}
              thinkingDefaultExpanded={() => (preferences().thinkingBlocksExpansion ?? "expanded") === "expanded"}
              showUsageMetrics={showUsagePreference}
              deleteHover={deleteHover}
              onDeleteHoverChange={setDeleteHover}
              selectedMessageIds={selectedForDeletion}
              onToggleSelectedMessage={setMessageSelectedForDeletion}
              onRevert={props.onRevert}
              onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
              onFork={props.onFork}
              onContentRendered={handleContentRendered}
            />
          )}
          renderOverlay={() => (
            <Show when={quoteSelection()}>
              {(selection) => (
                <div class="message-quote-popover" style={{ top: `${selection().top}px`, left: `${selection().left}px` }}>
                  <div class="message-quote-button-group">
                    <button type="button" class="message-quote-button" onClick={() => handleQuoteSelectionRequest("quote")}>
                      {t("messageSection.quote.addAsQuote")}
                    </button>
                    <button type="button" class="message-quote-button" onClick={() => handleQuoteSelectionRequest("code")}>
                      {t("messageSection.quote.addAsCode")}
                    </button>
                    <button type="button" class="message-quote-button" onClick={() => void handleCopySelectionRequest()}>
                      {t("messageSection.quote.copy")}
                    </button>
                  </div>
                </div>
              )}
            </Show>
          )}
        />

        <Show when={hasTimelineSegments()}>
          <div class="message-timeline-sidebar">
            <MessageTimeline
              segments={timelineSegments()}
              onSegmentClick={handleTimelineSegmentClick}
              activeMessageId={activeMessageId()}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              showToolSegments={showTimelineToolsPreference()}
              deleteHover={deleteHover}
              onDeleteHoverChange={setDeleteHover}
              onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
              selectedMessageIds={selectedForDeletion}
              onToggleSelectedMessage={setMessageSelectedForDeletion}
            />
          </div>
        </Show>

        <Show when={isDeleteMode()}>
          <div
            class="message-delete-mode-toolbar"
            role="toolbar"
            aria-label={t("messageSection.bulkDelete.toolbarAriaLabel", { count: selectedDeleteCount() })}
          >
            <span class="message-delete-mode-count" aria-hidden="true">
              {selectedDeleteCount()}
            </span>

            <button
              type="button"
              class="message-delete-mode-button"
              onClick={() => void deleteSelectedMessages()}
              title={t("messageSection.bulkDelete.deleteSelectedTitle")}
              aria-label={t("messageSection.bulkDelete.deleteSelectedTitle")}
            >
              <Trash class="w-4 h-4" aria-hidden="true" />
            </button>

            <button
              type="button"
              class="message-delete-mode-button"
              onClick={selectAllForDeletion}
              title={t("messageSection.bulkDelete.selectAllTitle")}
              aria-label={t("messageSection.bulkDelete.selectAllTitle")}
            >
              <CheckSquare class="w-4 h-4" aria-hidden="true" />
            </button>

            <button
              type="button"
              class="message-delete-mode-button"
              onClick={clearDeleteMode}
              title={t("messageSection.bulkDelete.cancelTitle")}
              aria-label={t("messageSection.bulkDelete.cancelTitle")}
            >
              <X class="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}
