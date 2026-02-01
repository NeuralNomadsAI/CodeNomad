import { Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import Kbd from "./kbd"
import MessageBlockList, { getMessageAnchorId } from "./message-block-list"
import MessageTimeline, { buildTimelineSegments, type TimelineSegment } from "./message-timeline"
import { useConfig } from "../stores/preferences"
import { getSessionInfo } from "../stores/sessions"
import { messageStoreBus } from "../stores/message-v2/bus"
import { useScrollCache } from "../lib/hooks/use-scroll-cache"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import { cn } from "../lib/cn"

const SCROLL_SCOPE = "session"
const SCROLL_SENTINEL_MARGIN_PX = 48
const USER_SCROLL_INTENT_WINDOW_MS = 600
const SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])
const QUOTE_SELECTION_MAX_LENGTH = 2000
const codeNomadLogo = new URL("../images/EraCode-Icon.png", import.meta.url).href

export interface MessageSectionProps {
  instanceId: string
  sessionId: string
  loading?: boolean
  isSessionBusy?: boolean
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

  function makeTimelineKey(segment: TimelineSegment) {
    return `${segment.messageId}:${segment.id}:${segment.type}`
  }

  function seedTimeline() {
    seenTimelineMessageIds.clear()
    seenTimelineSegmentKeys.clear()
    const ids = untrack(messageIds)
    const resolvedStore = untrack(store)
    const segments: TimelineSegment[] = []
    ids.forEach((messageId) => {
      const record = resolvedStore.getMessage(messageId)
      if (!record) return
      seenTimelineMessageIds.add(messageId)
      const built = buildTimelineSegments(props.instanceId, record)
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
    const built = buildTimelineSegments(props.instanceId, record)
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
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  const [topSentinelVisible, setTopSentinelVisible] = createSignal(true)
  const [bottomSentinelVisible, setBottomSentinelVisible] = createSignal(true)
  const [quoteSelection, setQuoteSelection] = createSignal<{ text: string; top: number; left: number } | null>(null)
  const [hasNewActivity, setHasNewActivity] = createSignal(false)

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
    setShowScrollBottomButton(hasItems && !bottomVisible)
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
    setHasNewActivity(false)
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
    const maxLeft = Math.max(shell.clientWidth - 180, 8)
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
  let previousLastTimelineMessageId: string | null = null
  let previousLastTimelinePartCount = 0

  createEffect(() => {
    const loading = Boolean(props.loading)
    const ids = messageIds()

    if (loading) {
      previousTimelineIds = []
      previousLastTimelineMessageId = null
      previousLastTimelinePartCount = 0
      setTimelineSegments([])
      seenTimelineMessageIds.clear()
      seenTimelineSegmentKeys.clear()
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

  createEffect(() => {
    if (props.loading) return
    const ids = messageIds()
    if (ids.length === 0) return
    const lastId = ids[ids.length - 1]
    if (!lastId) return
    const record = store().getMessage(lastId)
    if (!record) return
    const partCount = record.partIds.length
    if (lastId === previousLastTimelineMessageId && partCount === previousLastTimelinePartCount) {
      return
    }
    previousLastTimelineMessageId = lastId
    previousLastTimelinePartCount = partCount
    const built = buildTimelineSegments(props.instanceId, record)
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
    } else {
      // User is scrolled up - show new activity indicator
      setHasNewActivity(true)
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

    // Debounce active message updates to prevent flickering during scroll
    let pendingActiveMessage: string | null = null
    let activeMessageFrame: number | null = null
    const ACTIVE_MESSAGE_DEBOUNCE_MS = 100
    let activeMessageDebounceTimer: ReturnType<typeof setTimeout> | null = null

    const updateActiveMessage = (messageId: string) => {
      pendingActiveMessage = messageId
      if (activeMessageDebounceTimer !== null) {
        clearTimeout(activeMessageDebounceTimer)
      }
      activeMessageDebounceTimer = setTimeout(() => {
        if (pendingActiveMessage !== null) {
          // Use requestAnimationFrame to batch with rendering
          if (activeMessageFrame !== null) {
            cancelAnimationFrame(activeMessageFrame)
          }
          activeMessageFrame = requestAnimationFrame(() => {
            activeMessageFrame = null
            setActiveMessageId((current) => (current === pendingActiveMessage ? current : pendingActiveMessage))
          })
        }
      }, ACTIVE_MESSAGE_DEBOUNCE_MS)
    }

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
          updateActiveMessage(messageId)
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

    onCleanup(() => {
      observer.disconnect()
      if (activeMessageDebounceTimer !== null) {
        clearTimeout(activeMessageDebounceTimer)
      }
      if (activeMessageFrame !== null) {
        cancelAnimationFrame(activeMessageFrame)
      }
    })
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
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
    }
    if (containerRef) {
      // scrollCache.persist(containerRef, { atBottomOffset: SCROLL_SENTINEL_MARGIN_PX })
    }
    clearQuoteSelection()
  })

  return (
    <div class="relative flex-1 min-h-0 flex flex-col overflow-hidden">
      <div class={cn(
        "grid grid-cols-[minmax(0,1fr)] w-full min-h-0 flex-1 relative",
        hasTimelineSegments() && "grid-cols-[minmax(0,1fr)_64px] max-sm:grid-cols-[minmax(0,1fr)_40px]"
      )}>
        <div class="min-h-0 flex flex-col relative" ref={setShellElement}>
          <div
            class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 p-4 px-5 bg-background text-inherit overscroll-contain"
            style={{ contain: "style" }}
            ref={setContainerRef}
            onScroll={handleScroll}
            onMouseUp={handleStreamMouseUp}
          >
            <div ref={setTopSentinel} aria-hidden="true" style={{ height: "1px" }} />
            <Show when={!props.loading && messageIds().length === 0}>
              <div class="flex-1 flex items-center justify-center p-12">
                <div class="text-center max-w-sm">
                  <div class="flex flex-col items-center gap-3 mb-6">
                    <img src={codeNomadLogo} alt="Era Code logo" class="h-48 w-auto" loading="lazy" />
                    <h1 class="text-3xl font-semibold text-primary">Era Code</h1>
                  </div>
                  <h3>Start a conversation</h3>
                  <p>Type a message below or open the Command Palette:</p>
                  <ul>
                    <li>
                      <span>Command Palette</span>
                      <Kbd shortcut="cmd+shift+p" class="ml-2" />
                    </li>
                    <li>Ask about your codebase</li>
                    <li>
                      Attach files with <code>@</code>
                    </li>
                  </ul>
                </div>
              </div>
            </Show>

            <Show when={props.loading}>
              <div class="flex-1 flex flex-col items-center justify-center gap-4 p-12">
                <div class="w-8 h-8 border-2 border-border border-t-primary rounded-full animate-spin" />
                <p>Loading messages...</p>
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
              isSessionBusy={props.isSessionBusy}
              onRevert={props.onRevert}
              onFork={props.onFork}
              onContentRendered={handleContentRendered}
              setBottomSentinel={setBottomSentinel}
              suspendMeasurements={() => !isActive()}
            />


          </div>

          <Show when={hasNewActivity()}>
            <button
              type="button"
              class="absolute top-3 left-1/2 -translate-x-1/2 z-[15] inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full border border-primary bg-primary text-primary-foreground text-sm font-medium cursor-pointer shadow-lg animate-in fade-in slide-in-from-top-2"
              onClick={() => scrollToBottom(false, { suppressAutoAnchor: false })}
              aria-label="New activity - scroll to latest"
            >
              New Activity &#8595;
            </button>
          </Show>

          <Show when={showScrollBottomButton()}>
            <div class="absolute right-4 bottom-4 flex flex-col gap-2 items-end">
              <button
                type="button"
                class="inline-flex items-center justify-center w-11 h-11 rounded-full border border-border bg-transparent text-foreground shadow-md transition-all duration-200 hover:bg-accent hover:-translate-y-px"
                onClick={() => scrollToBottom(false, { suppressAutoAnchor: false })}
                aria-label="Scroll to latest message"
              >
                <span class="text-lg text-primary" aria-hidden="true">&#8595;</span>
              </button>
            </div>
          </Show>

          <Show when={quoteSelection()}>
            {(selection) => (
              <div
                class="absolute z-[5] flex items-center justify-center pointer-events-none"
                style={{ top: `${selection().top}px`, left: `${selection().left}px` }}
              >
                <div class="pointer-events-auto inline-flex rounded-full border border-border bg-popover shadow-lg overflow-hidden">
                  <button
                    type="button"
                    class="pointer-events-auto inline-flex items-center justify-center px-3.5 py-1.5 text-sm font-medium border-none bg-transparent text-foreground transition-colors duration-200 hover:bg-accent"
                    onClick={() => handleQuoteSelectionRequest("quote")}
                  >
                    Add as quote
                  </button>
                  <button
                    type="button"
                    class="pointer-events-auto inline-flex items-center justify-center px-3.5 py-1.5 text-sm font-medium border-none bg-transparent text-foreground transition-colors duration-200 hover:bg-accent border-l border-l-border"
                    onClick={() => handleQuoteSelectionRequest("code")}
                  >
                    Add as code
                  </button>
                </div>
              </div>
            )}
          </Show>
        </div>

        <Show when={hasTimelineSegments()}>
          <div class="w-16 max-sm:w-10 min-h-0 flex flex-col border-l border-border/50">
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
