import { Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { MoreHorizontal, Trash, X } from "lucide-solid"
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
import { deleteMessage, deleteMessagePart } from "../stores/session-actions"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { DeleteHoverState } from "../types/delete-hover"
import { buildRecordDisplayData } from "../stores/message-v2/record-display-cache"
import { getPartCharCount } from "../lib/token-utils"
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
    if (selectionMode() === "tools" && segment.type !== "tool") {
      setActiveSegmentId(segment.id)
      if (typeof document === "undefined") return
      const anchor = document.getElementById(getMessageAnchorId(segment.messageId))
      anchor?.scrollIntoView({ block: "start", behavior: "smooth" })
      return
    }
    setLastSelectionAnchorId(segment.id)
    setActiveSegmentId(segment.id)
    if (typeof document === "undefined") return
    const anchor = document.getElementById(getMessageAnchorId(segment.messageId))
    anchor?.scrollIntoView({ block: "start", behavior: "smooth" })
  }

  const [selectedTimelineIds, setSelectedTimelineIds] = createSignal<Set<string>>(new Set())
  const [lastSelectionAnchorId, setLastSelectionAnchorId] = createSignal<string | null>(null)
  const [expandedMessageIds, setExpandedMessageIds] = createSignal<Set<string>>(new Set())
  const [selectionMode, setSelectionMode] = createSignal<"all" | "tools">("all")
  const [isDeleteMenuOpen, setIsDeleteMenuOpen] = createSignal(false)
  let deleteMenuRef: HTMLDivElement | undefined
  let deleteMenuButtonRef: HTMLButtonElement | undefined

  // Deletion is only allowed for messages/tool parts that occur AFTER the most
  // recent compaction. Compaction effectively resets the stored context; deleting
  // earlier items would not reliably reflect what the model sees.
  const messageIndexById = createMemo(() => {
    const ids = messageIds()
    const map = new Map<string, number>()
    for (let i = 0; i < ids.length; i++) {
      map.set(ids[i], i)
    }
    return map
  })

  const lastCompactionIndex = createMemo(() => {
    // Depend on a single session revision signal (not every message/part read)
    // to keep reactive overhead small.
    sessionRevision()
    return untrack(() => store().getLastCompactionMessageIndex(props.sessionId))
  })

  const deletableStartIndex = createMemo(() => {
    const idx = lastCompactionIndex()
    return idx === -1 ? 0 : idx + 1
  })

  const deletableMessageIds = createMemo(() => {
    const ids = messageIds()
    const start = deletableStartIndex()
    return new Set(ids.slice(start))
  })

  const isMessageDeletable = (messageId: string): boolean => {
    const idx = messageIndexById().get(messageId)
    if (idx === undefined) return false
    return idx >= deletableStartIndex()
  }

  // Build the message group for a segment.
  // Tool calls belong to the same assistant turn (between user messages).
  // Only assistant badges trigger group selection; user/tool badges are standalone.
  const getAdjacentGroup = (_clickedIndex: number, segments: TimelineSegment[]): TimelineSegment[] => {
    const clicked = segments[_clickedIndex]
    if (clicked.type === "assistant") {
      let currentTurn = -1
      const turnByMessageId = new Map<string, number>()
      for (const segment of segments) {
        if (segment.type === "user") {
          currentTurn += 1
          continue
        }
        if (currentTurn === -1) currentTurn = 0
        if (!turnByMessageId.has(segment.messageId)) {
          turnByMessageId.set(segment.messageId, currentTurn)
        }
      }
      const turnIndex = turnByMessageId.get(clicked.messageId)
      if (turnIndex === undefined) {
        return segments.filter((s) => s.messageId === clicked.messageId)
      }
      return segments.filter((s) => s.type !== "user" && turnByMessageId.get(s.messageId) === turnIndex)
    }
    // User, tool, and compaction segments are standalone.
    return [clicked]
  }

  const handleToggleTimelineSelection = (id: string) => {
    const segments = timelineSegments()
    const segmentIndex = segments.findIndex((s) => s.id === id)
    if (segmentIndex === -1) return
    const segment = segments[segmentIndex]

    if (!isMessageDeletable(segment.messageId)) {
      return
    }

    setLastSelectionAnchorId(id)

    if (selectionMode() === "tools" && segment.type !== "tool") {
      return
    }

    const selected = selectedTimelineIds()
    const isCurrentlySelected = selected.has(id)
    const group = getAdjacentGroup(segmentIndex, segments)
    const hasToolsInGroup = group.some((s) => s.type === "tool")
    const isGroupCandidate = segment.type === "assistant" && hasToolsInGroup
    const selectedInGroup = isGroupCandidate
      ? group.reduce((count, s) => (selected.has(s.id) ? count + 1 : count), 0)
      : 0
    const isGroupEmpty = isGroupCandidate && selectedInGroup === 0

    if (isGroupCandidate && !isCurrentlySelected && isGroupEmpty) {
      // Parent click: select entire group only when none are selected yet.
      // Tool visibility is handled by isSelectionActive() in isHidden() — no
      // expand/collapse needed.
      setSelectedTimelineIds((prev) => {
        const next = new Set(prev)
        for (const s of group) next.add(s.id)
        return next
      })
    } else if (isCurrentlySelected) {
      // Individual deselect (tool or parent). No group deselect.
      const newSelected = new Set(selected)
      newSelected.delete(id)
      setSelectedTimelineIds(newSelected)
    } else {
      // Individual select (tool badge, parent with partial group, or standalone).
      setSelectedTimelineIds((prev) => {
        const next = new Set(prev)
        next.add(id)
        return next
      })
    }
  }

  const handleLongPressTimelineSelection = (segment: TimelineSegment) => {
    const segments = timelineSegments()
    const segmentIndex = segments.findIndex((s) => s.id === segment.id)
    if (segmentIndex === -1) return

    if (!isMessageDeletable(segment.messageId)) {
      return
    }

    setLastSelectionAnchorId(segment.id)

    if (selectionMode() === "tools" && segment.type !== "tool") {
      return
    }
    const group = getAdjacentGroup(segmentIndex, segments)
    const hasToolsInGroup = group.some((s) => s.type === "tool")
    const isGroupCandidate = segment.type === "assistant" && hasToolsInGroup
    if (!isGroupCandidate) {
      handleToggleTimelineSelection(segment.id)
      return
    }
    const selected = selectedTimelineIds()
    const hasAnySelected = group.some((s) => selected.has(s.id))
    if (!hasAnySelected) {
      setSelectedTimelineIds((prev) => {
        const next = new Set(prev)
        for (const s of group) next.add(s.id)
        return next
      })
      return
    }
    const newSelected = new Set(selected)
    for (const s of group) newSelected.delete(s.id)
    setSelectedTimelineIds(newSelected)
  }

  const handleSelectRangeTimeline = (id: string) => {
    const anchorId = lastSelectionAnchorId()
    if (!anchorId) {
      handleToggleTimelineSelection(id)
      return
    }

    const segments = timelineSegments()
    const anchorIndex = segments.findIndex((s) => s.id === anchorId)
    const targetIndex = segments.findIndex((s) => s.id === id)

    if (anchorIndex === -1 || targetIndex === -1) {
      handleToggleTimelineSelection(id)
      return
    }

    const start = Math.min(anchorIndex, targetIndex)
    const end = Math.max(anchorIndex, targetIndex)

    const rangeSegments = selectionMode() === "tools"
      ? segments.slice(start, end + 1).filter((s) => s.type === "tool" && isMessageDeletable(s.messageId))
      : segments.slice(start, end + 1).filter((s) => isMessageDeletable(s.messageId))
    // Range selection replaces current selection so it can grow or shrink.
    setSelectedTimelineIds(new Set(rangeSegments.map((segment) => segment.id)))
  }

  const handleClearTimelineSelection = () => {
    setSelectedTimelineIds(new Set<string>())
    setLastSelectionAnchorId(null)
  }

  const applySelectionMode = (mode: "all" | "tools") => {
    setSelectionMode(mode)
    if (mode !== "tools") return
    const segments = timelineSegments()
    const toolIds = new Set(
      segments
        .filter((segment) => segment.type === "tool" && isMessageDeletable(segment.messageId))
        .map((segment) => segment.id),
    )
    setSelectedTimelineIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((id) => toolIds.has(id)))
      if (next.size === 0) setLastSelectionAnchorId(null)
      return next
    })
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
  const [activeSegmentId, setActiveSegmentId] = createSignal<string | null>(null)

  const [deleteHover, setDeleteHover] = createSignal<DeleteHoverState>({ kind: "none" })

  const [selectedForDeletion, setSelectedForDeletion] = createSignal<Set<string>>(new Set<string>())
  const selectedToolParts = createMemo(() => {
    const selected = selectedTimelineIds()
    if (selected.size === 0) return [] as { messageId: string; partId: string }[]
    const segments = timelineSegments()
    const segmentById = new Map<string, TimelineSegment>()
    for (const segment of segments) segmentById.set(segment.id, segment)
    const toolParts: { messageId: string; partId: string }[] = []
    const seen = new Set<string>()
    for (const segId of selected) {
      const segment = segmentById.get(segId)
      if (!segment || segment.type !== "tool") continue
      for (const partId of segment.toolPartIds ?? []) {
        if (!partId) continue
        const key = `${segment.messageId}:${partId}`
        if (seen.has(key)) continue
        seen.add(key)
        toolParts.push({ messageId: segment.messageId, partId })
      }
    }
    return toolParts
  })
  const deleteMessageIds = createMemo(() => selectedForDeletion())
  const deleteToolParts = createMemo(() => {
    const messageIds = deleteMessageIds()
    const allowed = deletableMessageIds()
    return selectedToolParts().filter((entry) => allowed.has(entry.messageId) && !messageIds.has(entry.messageId))
  })
  const isDeleteMode = createMemo(() => deleteMessageIds().size > 0 || deleteToolParts().length > 0)
  const selectedDeleteCount = createMemo(() => deleteMessageIds().size + deleteToolParts().length)

  const selectedTokenTotal = createMemo(() => {
    const selected = deleteMessageIds()
    const toolParts = deleteToolParts()
    if (selected.size === 0 && toolParts.length === 0) return 0
    // Fresh-from-store chars: read parts directly via buildRecordDisplayData +
    // getPartCharCount so the toolbar stays consistent with the xray overlay
    // (which also reads live from the store). Falls back to segment totalChars
    // when no record is found (e.g. compaction segments).
    const s = store()
    let total = 0
    for (const messageId of selected) {
      let chars = 0
      const record = s.getMessage(messageId)
      if (record) {
        const displayData = buildRecordDisplayData(props.instanceId, record)
        for (const part of displayData.orderedParts) {
          chars += getPartCharCount(part)
        }
      } else {
        // Fallback: sum from segments (O(n) pre-pass scoped to this branch)
        for (const seg of timelineSegments()) {
          if (seg.messageId === messageId) chars += seg.totalChars
        }
      }
      total += Math.max(Math.round(chars / 4), 1)
    }
    if (toolParts.length > 0) {
      const partFallbackChars = new Map<string, number>()
      for (const segment of timelineSegments()) {
        if (segment.type !== "tool") continue
        for (const partId of segment.toolPartIds ?? []) {
          if (!partId || partFallbackChars.has(partId)) continue
          partFallbackChars.set(partId, segment.totalChars)
        }
      }
      for (const { messageId, partId } of toolParts) {
        let chars = 0
        const record = s.getMessage(messageId)
        const partRecord = record?.parts?.[partId]
        if (partRecord?.data) {
          chars = getPartCharCount(partRecord.data)
        } else {
          chars = partFallbackChars.get(partId) ?? 0
        }
        total += Math.max(Math.round(chars / 4), 1)
      }
    }
    return total
  })

  const formatTokenCount = (tokens: number): string => {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
    return String(tokens)
  }

  const isMessageSelectedForDeletion = (messageId: string) => selectedForDeletion().has(messageId)

  const setMessageSelectedForDeletion = (messageId: string, selected: boolean) => {
    if (!messageId) return
    if (!isMessageDeletable(messageId)) return
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
    setSelectedTimelineIds(new Set<string>())
    setLastSelectionAnchorId(null)
  }

  createEffect(() => {
    const timelineIds = selectedTimelineIds()
    if (timelineIds.size === 0) {
      setSelectedForDeletion(new Set<string>())
      return
    }
    const segments = timelineSegments()
    const segmentById = new Map<string, TimelineSegment>()
    for (const segment of segments) segmentById.set(segment.id, segment)
    const affectedMessageIds = new Set<string>()
    for (const segId of timelineIds) {
      const segment = segmentById.get(segId)
      if (segment && segment.type !== "tool" && isMessageDeletable(segment.messageId)) {
        affectedMessageIds.add(segment.messageId)
      }
    }
    setSelectedForDeletion(affectedMessageIds)
  })

  const selectAllForDeletion = () => {
    const allMessageIds = [...deletableMessageIds()]
    setSelectedForDeletion(new Set<string>(allMessageIds))
    // Also select all timeline segments — tool visibility is handled by
    // isSelectionActive() in isHidden(), no expand/collapse needed.
    const segments = timelineSegments()
    setSelectedTimelineIds(new Set(segments.filter((s) => isMessageDeletable(s.messageId)).map((s) => s.id)))
  }

  const deleteSelectedMessages = async () => {
    const selected = deleteMessageIds()
    const toolParts = deleteToolParts()
    if (selected.size === 0 && toolParts.length === 0) return

    const allowed = deletableMessageIds()

    const idsInSessionOrder = messageIds()
    const toDelete: string[] = []
    for (let idx = idsInSessionOrder.length - 1; idx >= 0; idx -= 1) {
      const id = idsInSessionOrder[idx]
      if (allowed.has(id) && selected.has(id)) {
        toDelete.push(id)
      }
    }

    try {
      for (const messageId of toDelete) {
        await deleteMessage(props.instanceId, props.sessionId, messageId)
      }
      for (const { messageId, partId } of toolParts) {
        if (!allowed.has(messageId)) continue
        await deleteMessagePart(props.instanceId, props.sessionId, messageId, partId)
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
  const scrollButtonsCount = createMemo(() => (showScrollTopButton() ? 1 : 0) + (showScrollBottomButton() ? 1 : 0))
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
      handleClearTimelineSelection()
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

      // Prune stale selection IDs: segment IDs are positional and change on rebuild.
      setSelectedTimelineIds((prev) => {
        if (prev.size === 0) return prev
        const currentIds = new Set(timelineSegments().map((s) => s.id))
        const pruned = new Set([...prev].filter((id) => currentIds.has(id)))
        return pruned.size === prev.size ? prev : pruned
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
    if (typeof document === "undefined") return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (selectedTimelineIds().size > 0 || selectedForDeletion().size > 0)) {
        clearDeleteMode()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
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
    if (!isDeleteMenuOpen()) return
    if (typeof document === "undefined") return
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (deleteMenuRef?.contains(target)) return
      if (deleteMenuButtonRef?.contains(target)) return
      setIsDeleteMenuOpen(false)
    }
    document.addEventListener("mousedown", handleClick)
    onCleanup(() => document.removeEventListener("mousedown", handleClick))
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
          const firstSeg = timelineSegments().find((s) => s.messageId === messageId)
          if (firstSeg) {
            setActiveSegmentId((current) => (current === firstSeg.id ? current : firstSeg.id))
          }
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
      <div
        class={`message-layout${hasTimelineSegments() ? " message-layout--with-timeline" : ""}`}
        data-scroll-buttons={scrollButtonsCount()}
      >
        <div class="message-stream-shell" ref={setShellElement}>
          <div class="message-stream" ref={setContainerRef} onScroll={handleScroll} onMouseUp={handleStreamMouseUp} onClick={(e) => {
            // Clicking anywhere inside the chat container clears selection mode.
            // Only fires when selection is active and the click target is not an
            // interactive element inside a message block (buttons, links, etc.).
            if (selectedTimelineIds().size === 0) return
            const target = e.target as HTMLElement
            if (target.closest("button, a, input, [role='button']")) return
            handleClearTimelineSelection()
          }}>
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
              onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
              onFork={props.onFork}
              onContentRendered={handleContentRendered}
              deleteHover={deleteHover}
              onDeleteHoverChange={setDeleteHover}
              selectedMessageIds={selectedForDeletion}
              onToggleSelectedMessage={setMessageSelectedForDeletion}
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

          <Show when={isDeleteMode()}>
            <div
              class="message-delete-mode-toolbar"
              role="toolbar"
              aria-label={t("messageSection.bulkDelete.toolbarAriaLabel", { count: selectedDeleteCount() })}
            >
              <span class="message-delete-mode-token-group" aria-hidden="true">
                <span class="message-delete-mode-count message-delete-mode-count--before" title={`${tokenStats().used} tokens currently in context`}>
                  {formatTokenCount(tokenStats().used)}
                </span>
                <span class="message-delete-mode-arrow" aria-hidden="true">{"\u203A"}</span>
                <span class="message-delete-mode-count message-delete-mode-count--selection" title={`${selectedTokenTotal()} tokens selected (${selectedDeleteCount()} messages)`}>
                  {formatTokenCount(selectedTokenTotal())}
                </span>
                <span class="message-delete-mode-arrow" aria-hidden="true">{"\u203A"}</span>
                <span class="message-delete-mode-count message-delete-mode-count--after" title={`${Math.max(0, tokenStats().used - selectedTokenTotal())} tokens remaining after deletion`}>
                  {formatTokenCount(Math.max(0, tokenStats().used - selectedTokenTotal()))}
                </span>
              </span>

              <button
                type="button"
                class="message-delete-mode-button message-delete-mode-button--delete"
                onClick={() => void deleteSelectedMessages()}
                title={t("messageSection.bulkDelete.deleteSelectedTitle")}
                aria-label={t("messageSection.bulkDelete.deleteSelectedTitle")}
              >
                <Trash class="w-4 h-4" aria-hidden="true" />
              </button>

              <div class="message-delete-mode-menu-container">
                <button
                  ref={(el) => {
                    deleteMenuButtonRef = el
                  }}
                  type="button"
                  class="message-delete-mode-button message-delete-mode-button--menu"
                  onClick={() => setIsDeleteMenuOpen((prev) => !prev)}
                  title={t("messageSection.bulkDelete.moreOptionsTitle")}
                  aria-label={t("messageSection.bulkDelete.moreOptionsTitle")}
                >
                  <MoreHorizontal class="w-4 h-4" aria-hidden="true" />
                </button>
                <Show when={isDeleteMenuOpen()}>
                  <div
                    ref={(el) => {
                      deleteMenuRef = el
                    }}
                    class="message-delete-mode-menu dropdown-surface"
                  >
                    <button
                      type="button"
                      class="dropdown-item"
                      onClick={() => {
                        selectAllForDeletion()
                        setIsDeleteMenuOpen(false)
                      }}
                    >
                      {t("messageSection.bulkDelete.selectAllTitle")}
                    </button>
                    <div class="message-delete-mode-menu-divider" aria-hidden="true" />
                    <div class="message-delete-mode-menu-row">
                      <span class="message-delete-mode-menu-label">
                        {t("messageSection.bulkDelete.selectionModeLabel")}
                      </span>
                      <div class="message-delete-mode-menu-toggle">
                        <button
                          type="button"
                          class="message-delete-mode-menu-toggle-button"
                          data-mode="all"
                          data-active={selectionMode() === "all"}
                          onClick={() => applySelectionMode("all")}
                        >
                          {t("messageSection.bulkDelete.selectionModeAll")}
                        </button>
                        <button
                          type="button"
                          class="message-delete-mode-menu-toggle-button"
                          data-mode="tools"
                          data-active={selectionMode() === "tools"}
                          onClick={() => applySelectionMode("tools")}
                        >
                          {t("messageSection.bulkDelete.selectionModeTools")}
                        </button>
                      </div>
                    </div>
                  </div>
                </Show>
              </div>

              <button
                type="button"
                class="message-delete-mode-button message-delete-mode-button--cancel"
                onClick={clearDeleteMode}
                title={t("messageSection.bulkDelete.cancelTitle")}
                aria-label={t("messageSection.bulkDelete.cancelTitle")}
              >
                <X class="w-4 h-4" aria-hidden="true" />
              </button>

              <div class="message-delete-mode-hint-row keyboard-hints" aria-hidden="true">
                <Kbd shortcut="cmd+click" />
                <span class="message-delete-mode-hint-text">{t("messageSection.bulkDelete.selectionHint.toggle")}</span>
                <span class="message-delete-mode-hint-sep">·</span>
                <Kbd shortcut="shift+click" />
                <span class="message-delete-mode-hint-text">{t("messageSection.bulkDelete.selectionHint.range")}</span>
                <span class="message-delete-mode-hint-sep">·</span>
                <Kbd shortcut="esc" />
                <span class="message-delete-mode-hint-text">{t("messageSection.bulkDelete.selectionHint.clear")}</span>
              </div>
            </div>
          </Show>
        </div>

        <Show when={hasTimelineSegments()}>
          <div class="message-timeline-sidebar">
            <MessageTimeline
              segments={timelineSegments()}
              onSegmentClick={handleTimelineSegmentClick}
              onToggleSelection={handleToggleTimelineSelection}
              onLongPressSelection={handleLongPressTimelineSelection}
              onSelectRange={handleSelectRangeTimeline}
              onClearSelection={handleClearTimelineSelection}
              selectedIds={selectedTimelineIds}
              expandedMessageIds={expandedMessageIds}
              deletableMessageIds={deletableMessageIds}
              activeSegmentId={activeSegmentId()}
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
      </div>

    </div>
  )
}
