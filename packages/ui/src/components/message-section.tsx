import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import Kbd from "./kbd"
import MessageBlockList, { getMessageAnchorId } from "./message-block-list"
import MessageListHeader from "./message-list-header"
import MessageTimeline, { buildTimelineSegments, type TimelineSegment } from "./message-timeline"
import { useConfig } from "../stores/preferences"
import { getSessionInfo } from "../stores/sessions"
import { showCommandPalette } from "../stores/command-palette"
import { messageStoreBus } from "../stores/message-v2/bus"
import { useScrollCache } from "../lib/hooks/use-scroll-cache"
import { sseManager } from "../lib/sse-manager"
import { formatTokenTotal } from "../lib/formatters"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"

const SCROLL_SCOPE = "session"
const SCROLL_SENTINEL_MARGIN_PX = 48
const USER_SCROLL_INTENT_WINDOW_MS = 600
const SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])
const QUOTE_SELECTION_MAX_LENGTH = 2000
const codeNomadLogo = new URL("../images/CodeNomad-Icon.png", import.meta.url).href

function formatTokens(tokens: number): string {
  return formatTokenTotal(tokens)
}

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

  const connectionStatus = () => sseManager.getStatus(props.instanceId)
  const handleCommandPaletteClick = () => {
    showCommandPalette(props.instanceId)
  }
 
  const handleTimelineSegmentClick = (segment: TimelineSegment) => {
    if (typeof document === "undefined") return
    const anchor = document.getElementById(getMessageAnchorId(segment.messageId))
    anchor?.scrollIntoView({ block: "start", behavior: "smooth" })
  }
 
  const messageIndexMap = createMemo(() => {

    const map = new Map<string, number>()
    const ids = messageIds()
    ids.forEach((id, index) => map.set(id, index))
    return map
  })
 
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
 
  const timelineSegments = createMemo<TimelineSegment[]>(() => {
    const ids = messageIds()
    const resolvedStore = store()
    const segments: TimelineSegment[] = []
    ids.forEach((messageId) => {
      const record = resolvedStore.getMessage(messageId)
      if (!record) return
      const built = buildTimelineSegments(props.instanceId, record)
      segments.push(...built)
    })
    return segments
  })
 
  const hasTimelineSegments = () => timelineSegments().length > 0
  const [activeMessageId, setActiveMessageId] = createSignal<string | null>(null)
 
  const changeToken = createMemo(() => String(sessionRevision()))


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

  const [initialRenderComplete, setInitialRenderComplete] = createSignal(false)

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
 
  function scrollToBottom(immediate = false) {
    if (!containerRef) return
    const sentinel = bottomSentinel()
    const behavior = immediate ? "auto" : "smooth"
    if (!immediate) {
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
    if (!props.isActive) return
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
    const sentinel = bottomSentinel()
    if (!sentinel) return
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

  function handleInitialRenderComplete() {
    setInitialRenderComplete(true)
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
    const active = Boolean(props.isActive)
    if (active && !lastActiveState) {
      requestScrollToBottom(true)
    }
    lastActiveState = active
  })

  createEffect(() => {
    const loading = Boolean(props.loading)
    if (loading) {
      pendingInitialScroll = true
      setInitialRenderComplete(false)
      return
    }
    if (pendingInitialScroll && initialRenderComplete()) {
      pendingInitialScroll = false
      requestScrollToBottom(false)
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
      <MessageListHeader
        usedTokens={tokenStats().used}
        availableTokens={tokenStats().avail}
        connectionStatus={connectionStatus()}
        onCommandPalette={handleCommandPaletteClick}
        formatTokens={formatTokens}
        showSidebarToggle={props.showSidebarToggle}
        onSidebarToggle={props.onSidebarToggle}
        forceCompactStatusLayout={props.forceCompactStatusLayout}
      />

      <div class={`message-layout${hasTimelineSegments() ? " message-layout--with-timeline" : ""}`}>
        <div class="message-stream-shell" ref={setShellElement}>
          <div class="message-stream" ref={setContainerRef} onScroll={handleScroll} onMouseUp={handleStreamMouseUp}>
            <div ref={setTopSentinel} aria-hidden="true" style={{ height: "1px" }} />
            <Show when={!props.loading && messageIds().length === 0}>
              <div class="empty-state">
                <div class="empty-state-content">
                  <div class="flex flex-col items-center gap-3 mb-6">
                    <img src={codeNomadLogo} alt="CodeNomad logo" class="h-48 w-auto" loading="lazy" />
                    <h1 class="text-3xl font-semibold text-primary">CodeNomad</h1>
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
              <div class="loading-state">
                <div class="spinner" />
                <p>Loading messages...</p>
              </div>
            </Show>
 
            <MessageBlockList
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              store={store}
              messageIds={messageIds}
              messageIndexMap={messageIndexMap}
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
              suspendMeasurements={() => props.isActive === false}
              onInitialRenderComplete={handleInitialRenderComplete}
            />


          </div>
 
          <Show when={showScrollTopButton() || showScrollBottomButton()}>
            <div class="message-scroll-button-wrapper">
              <Show when={showScrollTopButton()}>
                <button type="button" class="message-scroll-button" onClick={() => scrollToTop()} aria-label="Scroll to first message">
                  <span class="message-scroll-icon" aria-hidden="true">↑</span>
                </button>
              </Show>
              <Show when={showScrollBottomButton()}>
                <button
                  type="button"
                  class="message-scroll-button"
                  onClick={() => scrollToBottom()}
                  aria-label="Scroll to latest message"
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
                    Add as quote
                  </button>
                  <button type="button" class="message-quote-button" onClick={() => handleQuoteSelectionRequest("code")}>
                    Add as code
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
