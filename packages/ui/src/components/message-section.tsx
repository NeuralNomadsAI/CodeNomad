import { Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
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
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"

const SCROLL_SCOPE = "session"
const SCROLL_SENTINEL_MARGIN_PX = 48
const USER_SCROLL_INTENT_WINDOW_MS = 600
const SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])
const QUOTE_SELECTION_MAX_LENGTH = 2000
const codeNomadLogo = new URL("../images/CodeNomad-Icon.png", import.meta.url).href

export interface MessageSectionProps {
  instanceId: string
  sessionId: string
  loading?: boolean
  onRevert?: (messageId: string) => void
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
 
  const changeToken = createMemo(() => String(sessionRevision()))
  const isActive = createMemo(() => props.isActive !== false)


  const scrollCache = useScrollCache({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    scope: SCROLL_SCOPE,
  })

  const [scrollElement, setScrollElement] = createSignal<HTMLDivElement | undefined>()
  const [topSentinel, setTopSentinel] = createSignal<HTMLDivElement | null>(null)
  const [bottomSentinelSignal, setBottomSentinelSignal] = createSignal<HTMLDivElement | null>(null)
  const bottomSentinel = () => bottomSentinelSignal()
  const setBottomSentinel = (element: HTMLDivElement | null) => {
    setBottomSentinelSignal(element)
    resolvePendingActiveScroll()
  }
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  const [topSentinelVisible, setTopSentinelVisible] = createSignal(true)
  const [bottomSentinelVisible, setBottomSentinelVisible] = createSignal(true)
  const [quoteSelection, setQuoteSelection] = createSignal<{ text: string; top: number; left: number } | null>(null)

  let containerRef: HTMLDivElement | undefined
  let shellRef: HTMLDivElement | undefined
  let pendingScrollFrame: number | null = null

  let pendingAnchorScroll: number | null = null

  let pendingScrollPersist: number | null = null
  let userScrollIntentUntil = 0
  let detachScrollIntentListeners: (() => void) | undefined
  let hasRestoredScroll = false
  let suppressAutoScrollOnce = false
  let pendingActiveScroll = false
  let scrollToBottomFrame: number | null = null
  let scrollToBottomDelayedFrame: number | null = null
  let pendingInitialScroll = true

  function markUserScrollIntent() {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    userScrollIntentUntil = now + USER_SCROLL_INTENT_WINDOW_MS
  }

  function hasUserScrollIntent() {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    return now <= userScrollIntentUntil
  }

  function attachScrollIntentListeners(element: HTMLDivElement | undefined) {
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
      detachScrollIntentListeners = undefined
    }
    if (!element) return
    const handlePointerIntent = () => markUserScrollIntent()
    const handleKeyIntent = (event: KeyboardEvent) => {
      if (SCROLL_INTENT_KEYS.has(event.key)) {
        markUserScrollIntent()
      }
    }
    element.addEventListener("wheel", handlePointerIntent, { passive: true })
    element.addEventListener("pointerdown", handlePointerIntent)
    element.addEventListener("touchstart", handlePointerIntent, { passive: true })
    element.addEventListener("keydown", handleKeyIntent)
    detachScrollIntentListeners = () => {
      element.removeEventListener("wheel", handlePointerIntent)
      element.removeEventListener("pointerdown", handlePointerIntent)
      element.removeEventListener("touchstart", handlePointerIntent)
      element.removeEventListener("keydown", handleKeyIntent)
    }
  }

  function setContainerRef(element: HTMLDivElement | null) {
    containerRef = element || undefined
    setScrollElement(containerRef)
    attachScrollIntentListeners(containerRef)
    if (!containerRef) {
      clearQuoteSelection()
      return
    }
    resolvePendingActiveScroll()
  }

  function setShellElement(element: HTMLDivElement | null) {
    shellRef = element || undefined
    if (!shellRef) {
      clearQuoteSelection()
    }
  }
 
  function updateScrollIndicatorsFromVisibility() {

    const hasItems = messageIds().length > 0
    const bottomVisible = bottomSentinelVisible()
    const topVisible = topSentinelVisible()
    setShowScrollBottomButton(hasItems && !bottomVisible)
    setShowScrollTopButton(hasItems && !topVisible)
  }

  function scheduleScrollPersist() {
    if (pendingScrollPersist !== null) return
    pendingScrollPersist = requestAnimationFrame(() => {
      pendingScrollPersist = null
      if (!containerRef) return
      // scrollCache.persist(containerRef, { atBottomOffset: SCROLL_SENTINEL_MARGIN_PX })
    })
  }
 
  function scrollToBottom(immediate = false, options?: { suppressAutoAnchor?: boolean }) {
    if (!containerRef) return
    const sentinel = bottomSentinel()
    const behavior = immediate ? "auto" : "smooth"
    const suppressAutoAnchor = options?.suppressAutoAnchor ?? !immediate
    if (suppressAutoAnchor) {
      suppressAutoScrollOnce = true
    }
    sentinel?.scrollIntoView({ block: "end", inline: "nearest", behavior })
    setAutoScroll(true)
    scheduleScrollPersist()
  }

  function clearScrollToBottomFrames() {
    if (scrollToBottomFrame !== null) {
      cancelAnimationFrame(scrollToBottomFrame)
      scrollToBottomFrame = null
    }
    if (scrollToBottomDelayedFrame !== null) {
      cancelAnimationFrame(scrollToBottomDelayedFrame)
      scrollToBottomDelayedFrame = null
    }
  }

  function requestScrollToBottom(immediate = true) {
    if (!isActive()) {
      pendingActiveScroll = true
      return
    }
    if (!containerRef || !bottomSentinel()) {
      pendingActiveScroll = true
      return
    }
    pendingActiveScroll = false
    clearScrollToBottomFrames()
    scrollToBottomFrame = requestAnimationFrame(() => {
      scrollToBottomFrame = null
      scrollToBottomDelayedFrame = requestAnimationFrame(() => {
        scrollToBottomDelayedFrame = null
        scrollToBottom(immediate)
      })
    })
  }

  function resolvePendingActiveScroll() {
    if (!pendingActiveScroll) return
    if (!isActive()) return
    requestScrollToBottom(true)
  }
 
  function scrollToTop(immediate = false) {
    if (!containerRef) return
    const behavior = immediate ? "auto" : "smooth"
    setAutoScroll(false)
    topSentinel()?.scrollIntoView({ block: "start", inline: "nearest", behavior })
    scheduleScrollPersist()
  }


  function scheduleAnchorScroll(immediate = false) {
    if (!autoScroll()) return
    if (!isActive()) {
      pendingActiveScroll = true
      return
    }
    const sentinel = bottomSentinel()
    if (!sentinel) {
      pendingActiveScroll = true
      return
    }
    if (pendingAnchorScroll !== null) {
      cancelAnimationFrame(pendingAnchorScroll)
      pendingAnchorScroll = null
    }
    pendingAnchorScroll = requestAnimationFrame(() => {
      pendingAnchorScroll = null
      sentinel.scrollIntoView({ block: "end", inline: "nearest", behavior: immediate ? "auto" : "smooth" })
    })
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
    if (props.loading) {
      return
    }
    scheduleAnchorScroll()
  }

  function handleScroll() {

    if (!containerRef) return
    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame)
    }
    const isUserScroll = hasUserScrollIntent()
    pendingScrollFrame = requestAnimationFrame(() => {
      pendingScrollFrame = null
      if (!containerRef) return
      const atBottom = bottomSentinelVisible()

      if (isUserScroll) {
        if (atBottom) {
          if (!autoScroll()) setAutoScroll(true)
        } else if (autoScroll()) {
          setAutoScroll(false)
        }
      }

      clearQuoteSelection()
      scheduleScrollPersist()
    })

  }


  createEffect(() => {
    if (props.registerScrollToBottom) {
      props.registerScrollToBottom(() => requestScrollToBottom(true))
    }
  })

  let lastActiveState = false
  createEffect(() => {
    const active = isActive()
    if (active) {
      resolvePendingActiveScroll()
      if (!lastActiveState && autoScroll()) {
        requestScrollToBottom(true)
      }
    } else if (autoScroll()) {
      pendingActiveScroll = true
    }
    lastActiveState = active
  })

  createEffect(() => {
    const loading = Boolean(props.loading)
    if (loading) {
      pendingInitialScroll = true
      return
    }
    if (!pendingInitialScroll) {
      return
    }
    const container = scrollElement()
    const sentinel = bottomSentinel()
    if (!container || !sentinel || messageIds().length === 0) {
      return
    }
    pendingInitialScroll = false
    requestScrollToBottom(true)
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

  let previousToken: string | undefined
  createEffect(() => {
    const token = changeToken()
    const loading = props.loading
    if (loading || !token || token === previousToken) {
      return
    }
    previousToken = token
    if (suppressAutoScrollOnce) {
      suppressAutoScrollOnce = false
      return
    }
    if (autoScroll()) {
      scheduleAnchorScroll(true)
    }
  })

  createEffect(() => {
    preferenceSignature()
    if (props.loading || !autoScroll()) {
      return
    }
    if (suppressAutoScrollOnce) {
      suppressAutoScrollOnce = false
      return
    }
    scheduleAnchorScroll(true)
  })

  createEffect(() => {
    if (messageIds().length === 0) {
      setShowScrollTopButton(false)
      setShowScrollBottomButton(false)
      setAutoScroll(true)
      return
    }
    updateScrollIndicatorsFromVisibility()
  })
  createEffect(() => {
    const container = scrollElement()
    const topTarget = topSentinel()
    const bottomTarget = bottomSentinel()
    if (!container || !topTarget || !bottomTarget) return
    const observer = new IntersectionObserver(
      (entries) => {
        let visibilityChanged = false
        for (const entry of entries) {
          if (entry.target === topTarget) {
            setTopSentinelVisible(entry.isIntersecting)
            visibilityChanged = true
          } else if (entry.target === bottomTarget) {
            setBottomSentinelVisible(entry.isIntersecting)
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
    if (pendingAnchorScroll !== null) {
      cancelAnimationFrame(pendingAnchorScroll)
    }
    clearScrollToBottomFrames()
    clearPendingTimelinePartUpdateFrame()
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
    }
    if (containerRef) {
      // scrollCache.persist(containerRef, { atBottomOffset: SCROLL_SENTINEL_MARGIN_PX })
    }
    clearQuoteSelection()
  })

  return (
    <div class="message-stream-container">
      <div class={`message-layout${hasTimelineSegments() ? " message-layout--with-timeline" : ""}`}>
        <div class="message-stream-shell" ref={setShellElement}>
          <div class="message-stream" ref={setContainerRef} onScroll={handleScroll} onMouseUp={handleStreamMouseUp}>
            <div ref={setTopSentinel} aria-hidden="true" style={{ height: "1px" }} />
            <Show when={!props.loading && messageIds().length === 0}>
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
                      <Kbd shortcut="cmd+shift+p" class="ml-2" />
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
              loading={props.loading}
              onRevert={props.onRevert}
              onFork={props.onFork}
              onContentRendered={handleContentRendered}
              setBottomSentinel={setBottomSentinel}
              suspendMeasurements={() => !isActive()}
            />


          </div>
 
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
                  onClick={() => scrollToBottom(false, { suppressAutoAnchor: false })}
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
            />
          </div>
        </Show>
      </div>

    </div>
  )
}
