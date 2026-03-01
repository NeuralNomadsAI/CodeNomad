import { Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { CheckSquare, Trash, X } from "lucide-solid"
import Kbd from "./kbd"
import MessageBlockList, { getMessageAnchorId } from "./message-block-list"
import MessageTimeline, { buildTimelineSegments, type TimelineSegment } from "./message-timeline"
import { useConfig } from "../stores/preferences"
import { getSessionInfo } from "../stores/sessions"
import { messageStoreBus } from "../stores/message-v2/bus"
import { useScrollCache } from "../lib/hooks/use-scroll-cache"
import { useI18n } from "../lib/i18n"
import { copyToClipboard } from "../lib/clipboard"
import { showToastNotification } from "../lib/notifications"
import { showAlertDialog } from "../stores/alerts"
import { deleteMessage } from "../stores/session-actions"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { DeleteHoverState } from "../types/delete-hover"

const SCROLL_SCOPE = "session"
const SCROLL_SENTINEL_MARGIN_PX = 48
const QUOTE_SELECTION_MAX_LENGTH = 2000
const codeNomadLogo = new URL("../images/CodeNomad-Icon.png", import.meta.url).href

const SCROLL_CHASE_CHECK_FRAMES = 10

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
 
  const changeToken = createMemo(() => String(sessionRevision()))
  const isActive = createMemo(() => props.isActive !== false)


  const scrollCache = useScrollCache({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    scope: SCROLL_SCOPE,
  })

  const [scrollElement, setScrollElement] = createSignal<HTMLDivElement | undefined>()
  const [oldestSentinel, setOldestSentinel] = createSignal<HTMLDivElement | null>(null)
  const [newestSentinelSignal, setNewestSentinelSignal] = createSignal<HTMLDivElement | null>(null)
  const newestSentinel = () => newestSentinelSignal()
  const setNewestSentinel = (element: HTMLDivElement | null) => {
    setNewestSentinelSignal(element)
  }
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  const scrollButtonsCount = createMemo(() => (showScrollTopButton() ? 1 : 0) + (showScrollBottomButton() ? 1 : 0))
  const [oldestSentinelVisible, setOldestSentinelVisible] = createSignal(true)
  const [newestSentinelVisible, setNewestSentinelVisible] = createSignal(true)
  const [quoteSelection, setQuoteSelection] = createSignal<{ text: string; top: number; left: number } | null>(null)

  let containerRef: HTMLDivElement | undefined
  let shellRef: HTMLDivElement | undefined
  let pendingScrollFrame: number | null = null

  let pendingScrollPersist: number | null = null
  let hasRestoredScroll = false

  let chaseFrame: number | null = null
  let chaseMode: "newest" | "oldest" | null = null
  let detachChaseIntent: (() => void) | undefined

  function clearScrollChase() {
    if (chaseFrame !== null) {
      cancelAnimationFrame(chaseFrame)
      chaseFrame = null
    }
    chaseMode = null
    if (detachChaseIntent) {
      detachChaseIntent()
      detachChaseIntent = undefined
    }
  }

  function performEdgeScroll(mode: "newest" | "oldest", behavior: ScrollBehavior) {
    if (!containerRef) return
    if (mode === "newest") {
      const sentinel = newestSentinel()
      if (sentinel) {
        sentinel.scrollIntoView({ block: "end", inline: "nearest", behavior })
      } else {
        // With the reversed scroll container, newest corresponds to scrollTop=0.
        containerRef.scrollTo({ top: 0, behavior })
      }
      return
    }

    // Oldest
    const sentinel = oldestSentinel()
    if (sentinel) {
      sentinel.scrollIntoView({ block: "start", inline: "nearest", behavior })
    } else {
      // Best-effort: jump to far edge.
      containerRef.scrollTo({ top: containerRef.scrollHeight, behavior })
    }
  }

  function isEdgeVisible(mode: "newest" | "oldest") {
    return mode === "newest" ? newestSentinelVisible() : oldestSentinelVisible()
  }

  function startScrollChase(mode: "newest" | "oldest") {
    if (!containerRef) return
    clearScrollChase()
    chaseMode = mode

    // If the user starts interacting, stop chasing.
    const element = containerRef
    const cancel = () => clearScrollChase()
    element.addEventListener("wheel", cancel, { passive: true })
    element.addEventListener("pointerdown", cancel)
    element.addEventListener("touchstart", cancel, { passive: true })
    detachChaseIntent = () => {
      element.removeEventListener("wheel", cancel)
      element.removeEventListener("pointerdown", cancel)
      element.removeEventListener("touchstart", cancel)
    }

    // Always use instant scroll.
    performEdgeScroll(mode, "auto")

    // After the click-triggered scroll, give layout a few frames to settle.
    // If the sentinel still isn't visible, request another scrollIntoView.
    let framesRemaining = SCROLL_CHASE_CHECK_FRAMES
    const tick = () => {
      chaseFrame = null
      if (!containerRef || !chaseMode) return

      framesRemaining -= 1
      if (framesRemaining > 0) {
        chaseFrame = requestAnimationFrame(tick)
        return
      }

      if (isEdgeVisible(chaseMode)) {
        clearScrollChase()
        return
      }

      // Retry with instant behavior.
      performEdgeScroll(chaseMode, "auto")
      framesRemaining = SCROLL_CHASE_CHECK_FRAMES
      chaseFrame = requestAnimationFrame(tick)
    }

    chaseFrame = requestAnimationFrame(tick)
  }


  function setContainerRef(element: HTMLDivElement | null) {
    containerRef = element || undefined
    setScrollElement(containerRef)
    if (!containerRef) {
      clearQuoteSelection()
      return
    }
  }

  function setShellElement(element: HTMLDivElement | null) {
    shellRef = element || undefined
    if (!shellRef) {
      clearQuoteSelection()
    }
  }
 
  function updateScrollIndicatorsFromVisibility() {

    const hasItems = messageIds().length > 0
    const latestVisible = newestSentinelVisible()
    const oldestVisible = oldestSentinelVisible()
    setShowScrollBottomButton(hasItems && !latestVisible)
    setShowScrollTopButton(hasItems && !oldestVisible)
  }

  function scheduleScrollPersist() {
    if (pendingScrollPersist !== null) return
    pendingScrollPersist = requestAnimationFrame(() => {
      pendingScrollPersist = null
      if (!containerRef) return
      // scrollCache.persist(containerRef, { atBottomOffset: SCROLL_SENTINEL_MARGIN_PX })
    })
  }
 
  function scrollToBottom(immediate = false) {
    // In reversed mode, the visual "latest" position is scrollTop=0.
    if (!containerRef) return
    startScrollChase("newest")
    scheduleScrollPersist()
  }

 
  function scrollToTop(immediate = false) {
    if (!containerRef) return
    startScrollChase("oldest")
    scheduleScrollPersist()
  }

  function clearQuoteSelection() {
    setQuoteSelection(null)
  }

  function isSelectionWithinStream(range: Range | null) {
    if (!range || !containerRef) return false
    const node = range.commonAncestorContainer
    if (!node) return false
    return containerRef.contains(node)
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
    const shell = shellRef
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
    // No-op: scroll behavior is handled by explicit jumps + chase.
  }

  function handleScroll() {

    if (!containerRef) return
    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame)
    }
    pendingScrollFrame = requestAnimationFrame(() => {
      pendingScrollFrame = null
      if (!containerRef) return
      clearQuoteSelection()
      scheduleScrollPersist()
    })

  }


  createEffect(() => {
    if (props.registerScrollToBottom) {
      props.registerScrollToBottom(() => scrollToBottom(true))
    }
  })

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
      if (!shellRef) return
      if (!shellRef.contains(event.target as Node)) {
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

  createEffect(() => {
    const target = containerRef
    const loading = props.loading
    if (!target || loading || hasRestoredScroll) return


    // scrollCache.restore(target, {
    //   onApplied: (snapshot) => {
    //     if (snapshot) {
    //       setAutoScroll(snapshot.atBottom)
    //     } else {
    //       setAutoScroll(bottomSentinelVisible())
    //     }
    //     updateScrollIndicatorsFromVisibility()
    //   },
    // })

    hasRestoredScroll = true
  })

  createEffect(() => {
    if (messageIds().length === 0) {
      setShowScrollTopButton(false)
      setShowScrollBottomButton(false)
      return
    }
    updateScrollIndicatorsFromVisibility()
  })
  createEffect(() => {
    const container = scrollElement()
    const topTarget = oldestSentinel()
    const bottomTarget = newestSentinel()
    if (!container || !topTarget || !bottomTarget) return
    const observer = new IntersectionObserver(
      (entries) => {
        let visibilityChanged = false
        for (const entry of entries) {
          if (entry.target === topTarget) {
            setOldestSentinelVisible(entry.isIntersecting)
            visibilityChanged = true
          } else if (entry.target === bottomTarget) {
            setNewestSentinelVisible(entry.isIntersecting)
            visibilityChanged = true
          }
        }
        if (visibilityChanged) {
          updateScrollIndicatorsFromVisibility()
        }
      },
      { root: container, threshold: 0, rootMargin: `${SCROLL_SENTINEL_MARGIN_PX}px 0px ${SCROLL_SENTINEL_MARGIN_PX}px 0px` },
    )
    observer.observe(topTarget)
    observer.observe(bottomTarget)
    onCleanup(() => observer.disconnect())
  })
 
  createEffect(() => {
    const container = scrollElement()
    const ids = messageIds()
    if (!container || ids.length === 0) return
    if (typeof document === "undefined") return
 
    const observer = new IntersectionObserver(
      (entries) => {
        let best: IntersectionObserverEntry | null = null
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          if (!best || entry.boundingClientRect.top < best.boundingClientRect.top) {
            best = entry
          }
        }
        if (best) {
          const anchorId = (best.target as HTMLElement).id
          const messageId = anchorId.startsWith("message-anchor-") ? anchorId.slice("message-anchor-".length) : anchorId
          setActiveMessageId((current) => (current === messageId ? current : messageId))
        }
      },
      { root: container, rootMargin: "-10% 0px -80% 0px", threshold: 0 },
    )
 
    ids.forEach((messageId) => {
      const anchor = document.getElementById(getMessageAnchorId(messageId))
      if (anchor) {
        observer.observe(anchor)
      }
    })
 
    onCleanup(() => observer.disconnect())
  })
 
  onCleanup(() => {


    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame)
    }
    if (pendingScrollPersist !== null) {
      cancelAnimationFrame(pendingScrollPersist)
    }
    clearScrollChase()
    clearPendingTimelinePartUpdateFrame()
    if (containerRef) {
      // scrollCache.persist(containerRef, { atBottomOffset: SCROLL_SENTINEL_MARGIN_PX })
    }
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
        <div
          class="message-stream-shell"
          ref={setShellElement}
          data-instance-id={props.instanceId}
          data-session-id={props.sessionId}
        >
          <div
            class="message-stream"
            ref={setContainerRef}
            onScroll={handleScroll}
            onMouseUp={handleStreamMouseUp}
            data-instance-id={props.instanceId}
            data-session-id={props.sessionId}
          >
            <MessageBlockList
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              store={store}
              messageIds={messageIds}
              lastAssistantIndex={lastAssistantIndex}
              showThinking={() => preferences().showThinkingBlocks}
              thinkingDefaultExpanded={() => (preferences().thinkingBlocksExpansion ?? "expanded") === "expanded"}
              showUsageMetrics={showUsagePreference}
              scrollContainer={scrollElement}
              onRevert={props.onRevert}
              onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
              onFork={props.onFork}
              onContentRendered={handleContentRendered}
              deleteHover={deleteHover}
              onDeleteHoverChange={setDeleteHover}
              selectedMessageIds={selectedForDeletion}
              onToggleSelectedMessage={setMessageSelectedForDeletion}
              setNewestSentinel={setNewestSentinel}
              setOldestSentinel={setOldestSentinel}
              suspendMeasurements={() => !isActive()}
            />


          </div>

          <Show when={!props.loading && messageIds().length === 0}>
            <div class="message-stream-overlay">
              <div class="empty-state">
                <div class="empty-state-content">
                  <div class="flex flex-col items-center gap-3 mb-6">
                    <img src={codeNomadLogo} alt={t("messageSection.empty.logoAlt")} class="h-48 w-auto" loading="lazy" />
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
            </div>
          </Show>

          <Show when={props.loading}>
            <div class="message-stream-overlay">
              <div class="loading-state">
                <div class="spinner" />
                <p>{t("messageSection.loading.messages")}</p>
              </div>
            </div>
          </Show>
 
          <Show when={showScrollTopButton() || showScrollBottomButton()}>
            <div class="message-scroll-button-wrapper">
              <Show when={showScrollTopButton()}>
                <button type="button" class="message-scroll-button" onClick={() => scrollToTop()} aria-label={t("messageSection.scroll.toFirstAriaLabel")}>
                  <span class="message-scroll-icon" aria-hidden="true">↑</span>
                </button>
              </Show>
              <Show when={showScrollBottomButton()}>
                <button
                  type="button"
                  class="message-scroll-button"
                  onClick={() => scrollToBottom(false)}
                  aria-label={t("messageSection.scroll.toLatestAriaLabel")}
                >
                  <span class="message-scroll-icon" aria-hidden="true">↓</span>
                </button>
              </Show>
            </div>
          </Show>

          <Show when={quoteSelection()}>
            {(selection) => (
              <div
                class="message-quote-popover"
                style={{ top: `${selection().top}px`, left: `${selection().left}px` }}
              >
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
        </div>
 
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
