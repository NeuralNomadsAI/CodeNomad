import { Show, createEffect, createMemo, createSignal, onCleanup, on, untrack } from "solid-js"
import { ArrowUpDown, ChevronDown, ChevronUp, Pause, Search, X } from "lucide-solid"
import Kbd from "./kbd"
import BrandedEmptyState from "./branded-empty-state"
import LoadErrorState from "./load-error-state"
import MessageBlock from "./message-block"
import { getMessageAnchorId } from "./message-anchors"
import MessageTimeline, { buildTimelineSegments, type TimelineSegment } from "./message-timeline"
import VirtualFollowList, { type VirtualExplicitBottomPinIntent, type VirtualFollowListApi, type VirtualFollowListState, type VirtualFollowScrollSnapshot } from "./virtual-follow-list"
import { isScrollRestoreGenerationCurrent, isSnapshotAutoFollowing } from "./virtual-follow-behavior"
import { useConfig } from "../stores/preferences"
import { messageStoreBus } from "../stores/message-v2/bus"
import { useI18n } from "../lib/i18n"
import { copyToClipboard } from "../lib/clipboard"
import { showToastNotification } from "../lib/notifications"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import { partHasRenderableText } from "../types/message"
import { buildRecordDisplayData } from "../stores/message-v2/record-display-cache"
import { getMessageSelectionActionPosition } from "../lib/message-selection-position"
import { buildSessionSearchMatches } from "../lib/session-search"
import type { SessionSearchMatch } from "../lib/session-search"
import { resolveThinkingExpansionDefault, resolveToolVisibility } from "./tool-call/tool-registry"

const MESSAGE_SCROLL_CACHE_SCOPE = "message-stream"
const QUOTE_SELECTION_MAX_LENGTH = 2000
const STREAMING_TEXT_HOLD_TOP_THRESHOLD_PX = 8
const SEARCH_DEBOUNCE_MS = 250
const SEARCH_MIN_CHARS = 3
const OPEN_SESSION_SEARCH_EVENT = "codenomad:open-session-search"

export interface MessageSectionProps {
  instanceId: string
  sessionId: string
  loading?: boolean
  loadError?: string | null
  emptyStateVariant?: "messages" | "no-session"
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  registerScrollToBottom?: (fn: (() => void) | null) => void
  showSidebarToggle?: boolean
  onSidebarToggle?: () => void
  forceCompactStatusLayout?: boolean
  onQuoteSelection?: (text: string, mode: "quote" | "code") => void
  onReloadMessages?: () => void
  isActive?: boolean
  sessionStreamingActive?: boolean
  explicitBottomPinIntent?: VirtualExplicitBottomPinIntent | null
  onExplicitBottomPinCancelled?: () => void
}

export default function MessageSection(props: MessageSectionProps) {
  const { preferences, updatePreferences } = useConfig()
  const { t } = useI18n()
  const usageMetricsVisibility = () =>
    preferences().showUsageMetrics ? preferences().usageMetricsExpansion : "hidden"
  const showMessageTimelinePreference = () => preferences().showMessageTimeline ?? true
  const showTimelineToolsPreference = () => preferences().showTimelineTools ?? true
  const holdLongAssistantRepliesEnabled = () => preferences().holdLongAssistantReplies ?? true
  const emptyStateVariant = () => props.emptyStateVariant ?? "messages"
  const store = createMemo<InstanceMessageStore>(() => messageStoreBus.getOrCreate(props.instanceId))
  const messageIds = createMemo(() => store().getSessionMessageIds(props.sessionId))
  const visibleMessageIds = createMemo(() => {
    const resolvedStore = store()
    return messageIds().filter((messageId) => {
      const record = resolvedStore.getMessage(messageId)
      if (!record) return false

      if (buildTimelineSegments(props.instanceId, record, t).length > 0) {
        return true
      }

      if (record.role !== "assistant") {
        return false
      }

      const info = resolvedStore.getMessageInfo(messageId)
      if (!info || info.role !== "assistant") {
        return false
      }

      if (info.error) {
        return true
      }

      const timeInfo = info.time as { created: number; end?: number } | undefined
      return Boolean(timeInfo && (timeInfo.end === undefined || timeInfo.end === 0))
    })
  })

  const sessionRevision = createMemo(() => store().getSessionRevision(props.sessionId))

  const preferenceSignature = createMemo(() => {
    const pref = preferences()
    const showThinking = pref.showThinkingBlocks ? 1 : 0
    const thinkingExpansion = resolveThinkingExpansionDefault(pref) ? "expanded" : "collapsed"
    const usageVisibility = pref.showUsageMetrics ? pref.usageMetricsExpansion : "hidden"
    return `${showThinking}|${thinkingExpansion}|${usageVisibility}`
  })

  const handleTimelineSegmentClick = (segment: TimelineSegment) => {
    const scrollToMessage = () => {
      const api = listApi()
      if (api) {
        api.scrollToKey(segment.messageId, { behavior: "smooth", block: "start" })
        return
      }
      if (typeof document === "undefined") return
      const anchor = document.getElementById(getMessageAnchorId(segment.messageId))
      anchor?.scrollIntoView({ block: "start", behavior: "smooth" })
    }

    setActiveSegmentId(segment.id)
    scrollToMessage()
  }

  const [expandedMessageIds, setExpandedMessageIds] = createSignal<Set<string>>(new Set())
  const [isSearchOpen, setIsSearchOpen] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [debouncedSearchQuery, setDebouncedSearchQuery] = createSignal("")
  const [searchedQuery, setSearchedQuery] = createSignal("")
  const [isSearchPending, setIsSearchPending] = createSignal(false)
  const [searchMatches, setSearchMatches] = createSignal<SessionSearchMatch[]>([])
  const [activeSearchIndex, setActiveSearchIndex] = createSignal(0)
  let searchInputRef: HTMLInputElement | undefined

  const messageIndexById = createMemo(() => {
    const ids = messageIds()
    const map = new Map<string, number>()
    for (let i = 0; i < ids.length; i++) {
      map.set(ids[i], i)
    }
    return map
  })

  const lastAssistantMessageId = createMemo(() => store().getLastAssistantMessageId(props.sessionId))

  const activeSearchMatch = createMemo(() => {
    const matches = searchMatches()
    if (matches.length === 0) return null
    const index = Math.min(Math.max(activeSearchIndex(), 0), matches.length - 1)
    return matches[index] ?? null
  })

  const searchResultMessageIds = createMemo(() => new Set(searchMatches().map((match) => match.messageId)))

  const trimmedSearchQuery = createMemo(() => searchQuery().trim())
  const isSearchSettled = createMemo(() => {
    const query = trimmedSearchQuery()
    return query.length >= SEARCH_MIN_CHARS && !isSearchPending() && searchedQuery().trim() === query
  })

  const lastAssistantIndex = createMemo(() => {
    const messageId = lastAssistantMessageId()
    if (!messageId) return -1
    return messageIndexById().get(messageId) ?? -1
  })
 
  const [timelineSegments, setTimelineSegments] = createSignal<TimelineSegment[]>([])
  const hasTimelineSegments = () => timelineSegments().length > 0

  function segmentMatchesSearch(segment: TimelineSegment, match: { messageId: string; partId?: string; partType?: string }): boolean {
    if (segment.messageId !== match.messageId) return false
    if (!match.partId) return true
    if (segment.partId === match.partId) return true
    if (segment.partIds?.includes(match.partId)) return true
    if (segment.toolPartIds?.includes(match.partId)) return true
    return false
  }

  const searchMatchedTimelineSegmentIds = createMemo(() => {
    const matches = searchMatches()
    if (matches.length === 0) return new Set<string>()
    const result = new Set<string>()
    for (const segment of timelineSegments()) {
      if (matches.some((match) => segmentMatchesSearch(segment, match))) {
        result.add(segment.id)
      }
    }
    return result
  })

  const activeSearchTimelineSegmentId = createMemo(() => {
    const match = activeSearchMatch()
    if (!match) return null
    return timelineSegments().find((segment) => segmentMatchesSearch(segment, match))?.id ?? null
  })

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
  const [activeSegmentId, setActiveSegmentId] = createSignal<string | null>(null)

  const isActive = createMemo(() => props.isActive !== false)
  const [listApi, setListApi] = createSignal<VirtualFollowListApi | null>(null)
  const [listState, setListState] = createSignal<VirtualFollowListState | null>(null)
  const [scrollControlsOpen, setScrollControlsOpen] = createSignal(false)
  const [scrollControlsHoverSuppressed, setScrollControlsHoverSuppressed] = createSignal(false)
  const scrollButtonsCount = createMemo(() => listState()?.scrollButtonsCount() ?? 0)

  const [streamElement, setStreamElement] = createSignal<HTMLDivElement | undefined>()
  const [streamShellElement, setStreamShellElement] = createSignal<HTMLDivElement | undefined>()
  let scrollControlsRef: HTMLDivElement | undefined

  // Only preferences should force a follow-token re-anchor. Message/session
  // revision churn at the end of a turn (terminal updates, session idle, etc.)
  // should not trigger an immediate scroll-to-bottom.
  const followToken = createMemo(() => preferenceSignature())

  const initialScrollSnapshot = createMemo(() => store().getScrollSnapshot(props.sessionId, MESSAGE_SCROLL_CACHE_SCOPE))
  const initialAutoScroll = createMemo(() => isSnapshotAutoFollowing(initialScrollSnapshot()))

  const [didRestoreScroll, setDidRestoreScroll] = createSignal(false)
  const lastGoodScrollSnapshots = new Map<string, VirtualFollowScrollSnapshot>()
  let restoringScrollSnapshot = false
  let scrollRestoreGeneration = 0

  function getLastGoodScrollSnapshot(sessionId: string) {
    return lastGoodScrollSnapshots.get(sessionId) ?? store().getScrollSnapshot(sessionId, MESSAGE_SCROLL_CACHE_SCOPE)
  }

  function setLastGoodScrollSnapshot(sessionId: string, snapshot: VirtualFollowScrollSnapshot) {
    lastGoodScrollSnapshots.set(sessionId, snapshot)
  }

  createEffect(
    on(
      () => props.sessionId,
      () => {
        scrollRestoreGeneration += 1
        restoringScrollSnapshot = false
        setDidRestoreScroll(false)
        const snapshot = store().getScrollSnapshot(props.sessionId, MESSAGE_SCROLL_CACHE_SCOPE)
        if (snapshot) setLastGoodScrollSnapshot(props.sessionId, snapshot)
      },
    ),
  )

  createEffect(
    on(
      isActive,
      (active, wasActive) => {
        if (active) {
          if (wasActive === false) {
            setDidRestoreScroll(false)
          }
          return
        }
        persistMessageScrollSnapshot({ requireActive: false })
      },
    ),
  )

  function canCaptureScrollSnapshot(options?: { requireActive?: boolean }) {
    const element = streamElement()
    if (!element) return false
    if ((options?.requireActive ?? true) && !isActive()) return false
    if (restoringScrollSnapshot) return false
    if (!element.isConnected) return false
    if (element.clientHeight <= 0) return false
    if (typeof getComputedStyle === "function" && getComputedStyle(element).display === "none") return false
    return true
  }

  function persistMessageScrollSnapshot(options?: { sessionId?: string; allowCapture?: boolean; requireActive?: boolean }) {
    if (restoringScrollSnapshot) return
    if (!didRestoreScroll()) return

    const sessionId = options?.sessionId ?? props.sessionId
    const allowCapture = options?.allowCapture ?? true
    const canCapture = canCaptureScrollSnapshot({ requireActive: options?.requireActive })
    if (allowCapture && canCapture) {
      const snapshot = listApi()?.captureScrollSnapshot()
      if (snapshot) {
        setLastGoodScrollSnapshot(sessionId, snapshot)
        store().setScrollSnapshot(sessionId, MESSAGE_SCROLL_CACHE_SCOPE, snapshot)
        return
      }
    }

    const lastGoodScrollSnapshot = getLastGoodScrollSnapshot(sessionId)
    if (lastGoodScrollSnapshot) {
      store().setScrollSnapshot(sessionId, MESSAGE_SCROLL_CACHE_SCOPE, lastGoodScrollSnapshot)
      return
    }

  }

  // Persist scroll position when switching sessions. This effect's cleanup runs
  // when `props.sessionId` changes, before the next session is rendered.
  createEffect(() => {
    const sessionId = props.sessionId
    onCleanup(() => {
      persistMessageScrollSnapshot({ sessionId, allowCapture: props.sessionId === sessionId, requireActive: false })
    })
  })

  const [quoteSelection, setQuoteSelection] = createSignal<{ text: string; top: number; left: number } | null>(null)

  const streamingAssistantTextMessageId = createMemo(() => {
    const ids = messageIds()
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const messageId = ids[index]
      if (isStreamingAssistantTextMessage(messageId)) return messageId
    }
    return null
  })

  const streamingActive = createMemo(() => Boolean(props.sessionStreamingActive) && streamingAssistantTextMessageId() !== null)

  const autoPinHoldTargetKey = createMemo(() => {
    if (!holdLongAssistantRepliesEnabled()) return null
    if (!streamingActive()) return null
    return streamingAssistantTextMessageId()
  })

  function toggleHoldLongAssistantReplies() {
    updatePreferences({ holdLongAssistantReplies: !holdLongAssistantRepliesEnabled() })
  }

  function closeScrollControls() {
    setScrollControlsOpen(false)
  }

  function openScrollControlsFromTrigger(event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (scrollControlsOpen()) return
    setScrollControlsHoverSuppressed(false)
    setScrollControlsOpen(true)
  }

  function runScrollControlAction(event: PointerEvent, action: () => void) {
    event.preventDefault()
    event.stopPropagation()
    action()
    setScrollControlsHoverSuppressed(false)
    closeScrollControls()
  }

  createEffect(() => {
    if (!scrollControlsOpen()) return
    if (typeof document === "undefined") return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && scrollControlsRef?.contains(target)) return
      closeScrollControls()
    }

    document.addEventListener("pointerdown", handlePointerDown)
    onCleanup(() => document.removeEventListener("pointerdown", handlePointerDown))
  })

  function isStreamingAssistantTextMessage(messageId: string | null | undefined) {
    if (!messageId) return false
    const resolvedStore = store()
    const record = resolvedStore.getMessage(messageId)
    if (!record || record.role !== "assistant") return false
    if (record.status !== "streaming") return false

    const info = resolvedStore.getMessageInfo(messageId)
    const timeInfo = info?.time as { end?: number } | undefined
    if (typeof timeInfo?.end === "number" && timeInfo.end > 0) return false

    const { orderedParts } = buildRecordDisplayData(props.instanceId, record)
    return orderedParts.some((part) => {
      if ((part as any)?.type !== "text") return false
      if (partHasRenderableText(part)) return true
      return typeof (part as { text?: unknown }).text === "string"
    })
  }

  createEffect(() => {
    const api = listApi()
    if (!api) return
    if (props.registerScrollToBottom) {
      props.registerScrollToBottom(() => api.scrollToBottom({ immediate: true }))
      onCleanup(() => props.registerScrollToBottom?.(null))
    }
  })

  // Restore scroll position when the stream element is available.
  createEffect(() => {
    const element = streamElement()
    const api = listApi()
    if (!element || !api) return
    if (!isActive()) return
    if (props.loading) return
    if (visibleMessageIds().length === 0) return
    if (didRestoreScroll()) return

    const snapshot = store().getScrollSnapshot(props.sessionId, MESSAGE_SCROLL_CACHE_SCOPE)
    if (!snapshot) {
      api.setAutoScroll(true)
      api.scrollToBottom({ immediate: true })
      setDidRestoreScroll(true)
      return
    }

    const restoreSessionId = props.sessionId
    const restoreGeneration = ++scrollRestoreGeneration
    const isCurrentRestore = () => isScrollRestoreGenerationCurrent(
      restoreSessionId,
      restoreGeneration,
      props.sessionId,
      scrollRestoreGeneration,
    )
    restoringScrollSnapshot = true
    api.restoreScrollSnapshot(snapshot, {
      behavior: "auto",
      fallback: () => {
        if (!isCurrentRestore()) return
        api.setAutoScroll(true)
        api.scrollToBottom({ immediate: true })
        restoringScrollSnapshot = false
        setDidRestoreScroll(true)
      },
      onApplied: () => {
        if (!isCurrentRestore()) return
        restoringScrollSnapshot = false
        setLastGoodScrollSnapshot(restoreSessionId, snapshot)
        setDidRestoreScroll(true)
      },
      onCancelled: () => {
        if (!isCurrentRestore()) return
        restoringScrollSnapshot = false
        setDidRestoreScroll(true)
      },
    })
  })

  onCleanup(() => {
    const allowCapture = !restoringScrollSnapshot
    scrollRestoreGeneration += 1
    restoringScrollSnapshot = false
    persistMessageScrollSnapshot({ allowCapture, requireActive: false })
  })

  function clearQuoteSelection() {
    setQuoteSelection(null)
  }

  function openSearch() {
    setIsSearchOpen(true)
    requestAnimationFrame(() => searchInputRef?.focus())
  }

  function closeSearch() {
    setIsSearchOpen(false)
    setSearchQuery("")
    setDebouncedSearchQuery("")
    setSearchedQuery("")
    setIsSearchPending(false)
    setSearchMatches([])
    setActiveSearchIndex(0)
  }

  function moveSearchMatch(direction: 1 | -1) {
    const count = searchMatches().length
    if (count === 0) return
    setActiveSearchIndex((index) => (index + direction + count) % count)
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
    const rects = Array.from(range.getClientRects())
    const fallbackRect = range.getBoundingClientRect()
    const shellRect = shell.getBoundingClientRect()
    const touchOnly = Boolean(
      window.matchMedia?.("(pointer: coarse)")?.matches
      && !window.matchMedia?.("(any-pointer: fine)")?.matches,
    )
    const position = getMessageSelectionActionPosition(
      rects,
      fallbackRect,
      shellRect,
      shell.clientWidth,
      shell.clientHeight,
      touchOnly,
    )
    setQuoteSelection({ text: limited, ...position })
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
    listApi()?.notifyContentRendered()
  }

  let previousTimelineIds: string[] = []

  createEffect(() => {
    const loading = Boolean(props.loading)
    const ids = messageIds()

    // Wrap all iteration of the store-proxied `ids` array in untrack()
    // to prevent O(n) per-element reactive subscriptions.  The effect
    // only needs to re-run when `messageIds` (memo) changes.
    untrack(() => {
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
        previousTimelineIds = [...ids]
        return
      }

      if (ids.length < previousTimelineIds.length) {
        seedTimeline()
        previousTimelineIds = [...ids]
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

            previousTimelineIds = [...ids]
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

      previousTimelineIds = [...ids]
    })
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
  // Explicitly replace segments for messages whose part count changed.
  createEffect(() => {
    if (props.loading) return
    const ids = messageIds()
    // Also re-run when sessionRevision bumps (covers part additions within
    // existing messages) but read individual records inside untrack() to
    // avoid creating O(n) fine-grained subscriptions.
    sessionRevision()

    // Wrap the iteration in untrack() so that accessing individual elements
    // of the store-proxied `ids` array does not create O(n) per-element
    // reactive subscriptions.  We only need to re-run when the memo
    // (messageIds) or sessionRevision changes — not per-element.
    untrack(() => {
      const resolvedStore = store()
      const idsSet = new Set(ids)
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
      // Use the Set for O(1) lookups instead of ids.includes() which is O(n).
      for (const trackedId of Array.from(timelinePartCountsByMessageId.keys())) {
        if (!idsSet.has(trackedId)) {
          timelinePartCountsByMessageId.delete(trackedId)
        }
      }

      if (hasChanges) {
        scheduleTimelinePartUpdateFlush()
      }
    })
  })

  createEffect(() => {
    if (!props.onQuoteSelection) {
      clearQuoteSelection()
    }
  })

  createEffect(() => {
    const query = searchQuery()
    if (query.trim().length < SEARCH_MIN_CHARS) {
      setDebouncedSearchQuery("")
      setActiveSearchIndex(0)
      setSearchedQuery("")
      setIsSearchPending(false)
      setSearchMatches([])
      return
    }
    setIsSearchPending(true)
    const timeout = window.setTimeout(() => {
      setDebouncedSearchQuery(query)
    }, SEARCH_DEBOUNCE_MS)
    onCleanup(() => window.clearTimeout(timeout))
  })

  createEffect(() => {
    sessionRevision()
    const query = debouncedSearchQuery()
    const includeThinking = Boolean(preferences().showThinkingBlocks)
    if (query.trim().length < SEARCH_MIN_CHARS) {
      return
    }

    setIsSearchPending(true)
    const frame = requestAnimationFrame(() => {
      const matches = buildSessionSearchMatches({
        store: store(),
        sessionId: props.sessionId,
        query,
        includeThinking,
      })
      setSearchMatches(matches)
      setSearchedQuery(query)
      setActiveSearchIndex(0)
      setIsSearchPending(false)
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })

  createEffect(() => {
    const count = searchMatches().length
    if (count === 0) {
      if (activeSearchIndex() !== 0) setActiveSearchIndex(0)
      return
    }
    if (activeSearchIndex() >= count) {
      setActiveSearchIndex(count - 1)
    }
  })

  let lastScrolledSearchMatchId: string | null = null
  createEffect(() => {
    const match = activeSearchMatch()
    if (!match || !isSearchOpen()) return
    if (match.id === lastScrolledSearchMatchId) return
    lastScrolledSearchMatchId = match.id
    listApi()?.scrollToKey(match.messageId, { behavior: "smooth", block: "start" })
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

  createEffect(() => {
    if (typeof document === "undefined") return
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const isModSearch = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && key === "f"
      if (isModSearch && isActive()) {
        const modalOpen = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
        if (!modalOpen) {
          event.preventDefault()
          event.stopPropagation()
          openSearch()
          return
        }
      }

      if (event.key === "Escape" && isSearchOpen()) {
        event.preventDefault()
        event.stopPropagation()
        closeSearch()
        return
      }

    }
    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    const handleOpenSearch = () => {
      if (!isActive()) return
      openSearch()
    }
    window.addEventListener(OPEN_SESSION_SEARCH_EVENT, handleOpenSearch)
    onCleanup(() => window.removeEventListener(OPEN_SESSION_SEARCH_EVENT, handleOpenSearch))
  })

  onCleanup(() => {
    clearPendingTimelinePartUpdateFrame()
    clearQuoteSelection()
  })

  const showTimeline = createMemo(() => showMessageTimelinePreference() && hasTimelineSegments())

  return (
    <div
      class="message-stream-container"
      data-instance-id={props.instanceId}
      data-session-id={props.sessionId}
      data-stream-active={isActive() ? "true" : "false"}
    >
      <div
        class={`message-layout${showTimeline() ? " message-layout--with-timeline" : ""}`}
        data-scroll-buttons={scrollButtonsCount()}
      >
        <VirtualFollowList
          items={visibleMessageIds}
          getKey={(messageId) => messageId}
          getAnchorId={getMessageAnchorId}
          overscanPx={800}
          streamingActive={streamingActive}
          isActive={isActive}
          scrollToBottomOnActivate={() => false}
          initialScrollToBottom={() => false}
          initialAutoScroll={initialAutoScroll}
          resetKey={() => props.sessionId}
          followToken={followToken}
          explicitBottomPinIntent={() => props.explicitBottomPinIntent ?? null}
          onExplicitBottomPinCancelled={props.onExplicitBottomPinCancelled}
          autoPinHoldEnabled={holdLongAssistantRepliesEnabled}
          autoPinHoldTargetKey={autoPinHoldTargetKey}
          autoPinHoldTopThresholdPx={STREAMING_TEXT_HOLD_TOP_THRESHOLD_PX}
          resolveAutoPinHoldElement={(itemWrapper, key) => {
            const candidates = Array.from(itemWrapper.querySelectorAll<HTMLElement>(`.message-item-base[data-message-id="${key}"][data-message-role="assistant"][data-assistant-text-block="true"]`))
            return candidates[candidates.length - 1] ?? null
          }}
          onScroll={() => {
            clearQuoteSelection()
            persistMessageScrollSnapshot()
          }}
          onMouseUp={() => handleStreamMouseUp()}
          onActiveKeyChange={(messageId) => {
            if (!messageId) return
            const firstSeg = timelineSegments().find((s) => s.messageId === messageId)
            if (firstSeg) {
              setActiveSegmentId((current) => (current === firstSeg.id ? current : firstSeg.id))
            }
          }}
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
          renderControls={(state, api) => (
            <div
              ref={(el) => {
                scrollControlsRef = el
              }}
              class="message-scroll-controls"
              data-open={scrollControlsOpen() ? "true" : "false"}
              data-hover-suppressed={scrollControlsHoverSuppressed() ? "true" : "false"}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") setScrollControlsHoverSuppressed(false)
              }}
            >
              <button
                type="button"
                class="message-scroll-button message-scroll-controls-trigger"
                onClick={openScrollControlsFromTrigger}
                aria-label={t("messageSection.scroll.showControlsAriaLabel")}
                title={t("messageSection.scroll.showControlsAriaLabel")}
              >
                <ArrowUpDown class="message-scroll-icon w-4 h-4" aria-hidden="true" />
              </button>

              <div class="message-scroll-controls-expanded">
                <button
                  type="button"
                  class="message-scroll-button"
                  data-active={holdLongAssistantRepliesEnabled() ? "true" : "false"}
                  onPointerUp={(event) => runScrollControlAction(event, toggleHoldLongAssistantReplies)}
                  aria-pressed={holdLongAssistantRepliesEnabled()}
                  aria-label={
                    holdLongAssistantRepliesEnabled()
                      ? t("messageSection.scroll.disableHoldAriaLabel")
                      : t("messageSection.scroll.enableHoldAriaLabel")
                  }
                  title={
                    holdLongAssistantRepliesEnabled()
                      ? t("messageSection.scroll.disableHoldAriaLabel")
                      : t("messageSection.scroll.enableHoldAriaLabel")
                  }
                >
                  <Pause class="message-scroll-icon message-scroll-icon--toggle w-4 h-4" aria-hidden="true" />
                </button>
                <Show when={state.showScrollTopButton()}>
                  <button
                    type="button"
                    class="message-scroll-button"
                    onPointerUp={(event) => runScrollControlAction(event, () => api.scrollToTop())}
                    aria-label={t("messageSection.scroll.toFirstAriaLabel")}
                  >
                    <span class="message-scroll-icon" aria-hidden="true">
                      ↑
                    </span>
                  </button>
                </Show>
                <Show when={state.showScrollBottomButton()}>
                  <button
                    type="button"
                    class="message-scroll-button"
                    onPointerUp={(event) => runScrollControlAction(event, () => api.scrollToBottom())}
                    aria-label={t("messageSection.scroll.toLatestAriaLabel")}
                  >
                    <span class="message-scroll-icon" aria-hidden="true">
                      ↓
                    </span>
                  </button>
                </Show>
              </div>
            </div>
          )}
          renderBeforeItems={() => (
            <>
              <Show when={!props.loading && !props.loadError && visibleMessageIds().length === 0}>
                <Show
                  when={emptyStateVariant() === "no-session"}
                  fallback={
                    <BrandedEmptyState
                      title={t("messageSection.empty.title")}
                      description={t("messageSection.empty.description")}
                    >
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
                    </BrandedEmptyState>
                  }
                >
                  <BrandedEmptyState
                    title={t("messageSection.empty.title")}
                    description={t("instanceShell.empty.description")}
                  >
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
                  </BrandedEmptyState>
                </Show>
              </Show>

              <Show when={props.loading}>
                <div class="loading-state">
                  <div class="spinner" />
                  <p>{t("messageSection.loading.messages")}</p>
                </div>
              </Show>

              <Show when={!props.loading && props.loadError}>
                {(loadError) => (
                  <LoadErrorState
                    title={t("messageSection.loadError.title")}
                    error={loadError()}
                    retryLabel={t("messageSection.loadError.reload")}
                    onRetry={() => props.onReloadMessages?.()}
                  />
                )}
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
              thinkingDefaultExpanded={() => resolveThinkingExpansionDefault(preferences())}
              usageMetricsVisibility={usageMetricsVisibility}
              toolVisibility={(toolName) => resolveToolVisibility(preferences(), toolName)}
              onRevert={props.onRevert}
              onFork={props.onFork}
              onContentRendered={handleContentRendered}
              searchQuery={debouncedSearchQuery}
              searchResultMessageIds={searchResultMessageIds}
              activeSearchMatch={activeSearchMatch}
            />
          )}
          renderOverlay={() => (
            <>
              <Show when={isSearchOpen()}>
                <div class="message-search-popover modal-surface" role="search" aria-label={t("messageSection.search.ariaLabel")}>
                  <div class="modal-search-container message-search-container">
                    <div class="message-search-input-row">
                      <Search class="w-4 h-4 modal-search-icon" aria-hidden="true" />
                      <input
                        ref={(el) => {
                          searchInputRef = el
                        }}
                        class="modal-search-input message-search-input"
                        type="search"
                        value={searchQuery()}
                        placeholder={t("messageSection.search.placeholder")}
                        onInput={(event) => {
                          setSearchQuery(event.currentTarget.value)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            moveSearchMatch(event.shiftKey ? -1 : 1)
                            return
                          }
                          if (event.key === "Escape") {
                            event.preventDefault()
                            closeSearch()
                          }
                        }}
                      />
                      <span class="message-search-count" aria-live="polite">
                        {searchQuery().trim().length === 0
                          ? t("messageSection.search.count.empty")
                          : trimmedSearchQuery().length < SEARCH_MIN_CHARS
                            ? t("messageSection.search.count.minChars", { count: String(SEARCH_MIN_CHARS) })
                          : isSearchPending()
                            ? t("messageSection.search.count.searching")
                          : searchMatches().length === 0
                            ? t("messageSection.search.count.none")
                            : t("messageSection.search.count.matches", {
                                current: String(activeSearchIndex() + 1),
                                total: String(searchMatches().length),
                              })}
                      </span>
                      <button
                        type="button"
                        class="message-search-button"
                        onClick={() => moveSearchMatch(-1)}
                        disabled={searchMatches().length === 0}
                        aria-label={t("messageSection.search.previousAriaLabel")}
                        title={t("messageSection.search.previousAriaLabel")}
                      >
                        <ChevronUp class="w-4 h-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        class="message-search-button"
                        onClick={() => moveSearchMatch(1)}
                        disabled={searchMatches().length === 0}
                        aria-label={t("messageSection.search.nextAriaLabel")}
                        title={t("messageSection.search.nextAriaLabel")}
                      >
                        <ChevronDown class="w-4 h-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        class="message-search-button"
                        onClick={closeSearch}
                        aria-label={t("messageSection.search.closeAriaLabel")}
                        title={t("messageSection.search.closeAriaLabel")}
                      >
                        <X class="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <Show when={trimmedSearchQuery().length >= SEARCH_MIN_CHARS && isSearchPending()}>
                    <div class="modal-empty-state message-search-empty">{t("messageSection.search.searching")}</div>
                  </Show>
                  <Show when={isSearchSettled() && searchMatches().length === 0}>
                    <div class="modal-empty-state message-search-empty">{t("messageSection.search.noVisibleMatches")}</div>
                  </Show>
                </div>
              </Show>

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
            </>
          )}
        />

        <Show when={showTimeline()}>
          <div class="message-timeline-sidebar">
            <MessageTimeline
              segments={timelineSegments()}
              onSegmentClick={handleTimelineSegmentClick}
              expandedMessageIds={expandedMessageIds}
              activeSegmentId={activeSegmentId()}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              showToolSegments={showTimelineToolsPreference()}
              searchMatchedSegmentIds={searchMatchedTimelineSegmentIds}
              activeSearchSegmentId={activeSearchTimelineSegmentId}
            />
          </div>
        </Show>
      </div>
    </div>
  )
}
