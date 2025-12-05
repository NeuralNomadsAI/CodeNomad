import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import Kbd from "./kbd"
import MessageBlockList from "./message-block-list"
import MessageListHeader from "./message-list-header"
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
}

export default function MessageSection(props: MessageSectionProps) {
  const { preferences } = useConfig()
  const showUsagePreference = () => preferences().showUsageMetrics ?? true
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

  const changeToken = createMemo(() => String(sessionRevision()))

  const scrollCache = useScrollCache({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    scope: SCROLL_SCOPE,
  })

  const [scrollElement, setScrollElement] = createSignal<HTMLDivElement | undefined>()
  const [topSentinel, setTopSentinel] = createSignal<HTMLDivElement | null>(null)
  const [bottomSentinel, setBottomSentinel] = createSignal<HTMLDivElement | null>(null)
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  const [topSentinelVisible, setTopSentinelVisible] = createSignal(true)
  const [bottomSentinelVisible, setBottomSentinelVisible] = createSignal(true)

  let containerRef: HTMLDivElement | undefined
  let pendingScrollFrame: number | null = null
  let pendingAnchorScroll: number | null = null
  let pendingScrollPersist: number | null = null
  let userScrollIntentUntil = 0
  let detachScrollIntentListeners: (() => void) | undefined
  let hasRestoredScroll = false
  let suppressAutoScrollOnce = false

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
  }

  function updateScrollIndicatorsFromVisibility() {
    const hasItems = messageIds().length > 0
    setShowScrollBottomButton(hasItems && !bottomSentinelVisible())
    setShowScrollTopButton(hasItems && !topSentinelVisible())
  }

  function scheduleScrollPersist() {
    if (pendingScrollPersist !== null) return
    pendingScrollPersist = requestAnimationFrame(() => {
      pendingScrollPersist = null
      if (!containerRef) return
      scrollCache.persist(containerRef, { atBottomOffset: SCROLL_SENTINEL_MARGIN_PX })
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

  function handleContentRendered() {
    scheduleAnchorScroll()
  }

  createEffect(() => {
    if (props.registerScrollToBottom) {
      props.registerScrollToBottom(() => scrollToBottom(true))
    }
  })

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

      scheduleScrollPersist()
    })
  }

  createEffect(() => {
    const target = containerRef
    const loading = props.loading
    if (!target || loading || hasRestoredScroll) return

    scrollCache.restore(target, {
      onApplied: (snapshot) => {
        if (snapshot) {
          setAutoScroll(snapshot.atBottom)
        } else {
          setAutoScroll(bottomSentinelVisible())
        }
        updateScrollIndicatorsFromVisibility()
      },
    })

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
    if (autoScroll() && bottomSentinel()) {
      scheduleAnchorScroll()
    }
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
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
    }
    if (containerRef) {
      scrollCache.persist(containerRef, { atBottomOffset: SCROLL_SENTINEL_MARGIN_PX })
    }
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
      />

      <div class="message-stream" ref={setContainerRef} onScroll={handleScroll}>
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
    </div>
  )
}
