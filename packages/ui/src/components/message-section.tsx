import { Show, createEffect, createMemo, createSignal, onCleanup, on, untrack } from "solid-js"
import { MoreHorizontal, Trash, X } from "lucide-solid"
import Kbd from "./kbd"
import MessageBlock from "./message-block"
import { getMessageAnchorId, getMessageIdFromAnchorId } from "./message-anchors"
import MessageTimeline, { buildTimelineSegments, type TimelineSegment } from "./message-timeline"
import VirtualFollowList, { type VirtualFollowListApi, type VirtualFollowListState } from "./virtual-follow-list"
import { useConfig } from "../stores/preferences"
import { getSessionInfo } from "../stores/sessions"
import { messageStoreBus } from "../stores/message-v2/bus"
import { useI18n } from "../lib/i18n"
import { useScrollCache } from "../lib/hooks/use-scroll-cache"
import { copyToClipboard } from "../lib/clipboard"
import { showToastNotification } from "../lib/notifications"
import { showAlertDialog } from "../stores/alerts"
import { deleteMessage, deleteMessagePart } from "../stores/session-actions"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { MessageRecord } from "../stores/message-v2/types"
import type { DeleteHoverState } from "../types/delete-hover"
import { buildRecordDisplayData } from "../stores/message-v2/record-display-cache"
import { getPartCharCount } from "../lib/token-utils"

const SCROLL_SENTINEL_MARGIN_PX = 48
const MESSAGE_SCROLL_CACHE_SCOPE = "message-stream"
const QUOTE_SELECTION_MAX_LENGTH = 2000
const FOLLOW_MODE_VIRTUALIZATION_THRESHOLD = 40
const FOLLOW_MODE_VISIBLE_TAIL_COUNT = 24
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
  const { t, locale } = useI18n()
  const showUsagePreference = () => preferences().showUsageMetrics ?? true
  const showTimelineToolsPreference = () => preferences().showTimelineTools ?? true
  const store = createMemo<InstanceMessageStore>(() => messageStoreBus.getOrCreate(props.instanceId))
  const messageIds = createMemo(() => store().getSessionMessageIds(props.sessionId))

  const scrollCache = useScrollCache({
    instanceId: props.instanceId,
    sessionId: props.sessionId,
    scope: MESSAGE_SCROLL_CACHE_SCOPE,
  })

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

    if (selectionMode() === "tools" && segment.type !== "tool") {
      setActiveSegmentId(segment.id)
      scrollToMessage()
      return
    }

    setLastSelectionAnchorId(segment.id)
    setActiveSegmentId(segment.id)
    scrollToMessage()
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
    clearDeleteMode()
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
  const timelineSegmentsCache = new Map<string, { revision: number; locale: string; segments: TimelineSegment[] }>()
  let pendingTimelineMessagePartUpdates = new Set<string>()
  let pendingTimelinePartUpdateFrame: number | null = null

  function makeTimelineKey(segment: TimelineSegment) {
    return `${segment.messageId}:${segment.id}:${segment.type}`
  }

  function getTimelineSegmentsForMessage(record: MessageRecord) {
    const localeKey = locale()
    const cached = timelineSegmentsCache.get(record.id)
    if (cached && cached.revision === record.revision && cached.locale === localeKey) {
      return cached.segments
    }

    const built = buildTimelineSegments(props.instanceId, record, t)
    timelineSegmentsCache.set(record.id, {
      revision: record.revision,
      locale: localeKey,
      segments: built,
    })
    return built
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
      const built = getTimelineSegmentsForMessage(record)
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
    const built = getTimelineSegmentsForMessage(record)
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

  const deleteToolPartKeys = createMemo(() => {
    const set = new Set<string>()
    for (const entry of deleteToolParts()) {
      set.add(`${entry.messageId}:${entry.partId}`)
    }
    return set
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
    setIsDeleteMenuOpen(false)
  }

  createEffect(() => {
    const timelineIds = selectedTimelineIds()
    if (timelineIds.size === 0) {
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
 
  const isActive = createMemo(() => props.isActive !== false)
  const [listApi, setListApi] = createSignal<VirtualFollowListApi | null>(null)
  const [listState, setListState] = createSignal<VirtualFollowListState | null>(null)
  const scrollButtonsCount = createMemo(() => listState()?.scrollButtonsCount() ?? 0)

  const [streamElement, setStreamElement] = createSignal<HTMLDivElement | undefined>()
  const [streamShellElement, setStreamShellElement] = createSignal<HTMLDivElement | undefined>()

  const followToken = createMemo(() => `${sessionRevision()}|${preferenceSignature()}`)

  const initialScrollSnapshot = createMemo(() => store().getScrollSnapshot(props.sessionId, MESSAGE_SCROLL_CACHE_SCOPE))
  const initialAutoScroll = createMemo(() => initialScrollSnapshot()?.atBottom ?? true)

  const [didRestoreScroll, setDidRestoreScroll] = createSignal(false)
  createEffect(
    on(
      () => props.sessionId,
      () => {
        setDidRestoreScroll(false)
      },
    ),
  )

  // Persist scroll position when switching sessions. This effect's cleanup runs
  // when `props.sessionId` changes, before the next session is rendered.
  createEffect(() => {
    const sessionId = props.sessionId
    onCleanup(() => {
      const element = streamElement()
      if (!element) return
      const scrollTop = element.scrollTop
      const atBottom = element.scrollHeight - (element.scrollTop + element.clientHeight) <= 48
      store().setScrollSnapshot(sessionId, MESSAGE_SCROLL_CACHE_SCOPE, { scrollTop, atBottom })
    })
  })

  const [quoteSelection, setQuoteSelection] = createSignal<{ text: string; top: number; left: number } | null>(null)

  createEffect(() => {
    const api = listApi()
    if (!api) return
    if (props.registerScrollToBottom) {
      props.registerScrollToBottom(() => api.scrollToBottom({ immediate: true }))
    }
  })

  // Restore scroll position when the stream element is available.
  createEffect(() => {
    const element = streamElement()
    const api = listApi()
    if (!element || !api) return
    if (props.loading) return
    if (messageIds().length === 0) return
    if (didRestoreScroll()) return

    scrollCache.restore(element, {
      behavior: "auto",
      fallback: () => {
        api.setAutoScroll(true)
        api.scrollToBottom({ immediate: true })
      },
      onApplied: (snapshot) => {
        // Keep follow mode consistent with the restored state.
        api.setAutoScroll(snapshot?.atBottom ?? true)
        setDidRestoreScroll(true)
      },
    })
  })

  onCleanup(() => {
    scrollCache.persist(streamElement())
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
    const active = isActive()
    const loading = Boolean(props.loading)
    const ids = messageIds()

    if (!active) {
      clearPendingTimelinePartUpdateFrame()
      pendingTimelineMessagePartUpdates.clear()
      return
    }

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

          setSelectedTimelineIds((prev) => {
            if (prev.size === 0) return prev
            let changed = false
            const next = new Set<string>()
            for (const id of prev) {
              if (id.includes(oldId)) {
                next.add(id.replace(oldId, newId))
                changed = true
              } else {
                next.add(id)
              }
            }
            return changed ? next : prev
          })

          setLastSelectionAnchorId((prev) => {
            if (!prev || !prev.includes(oldId)) return prev
            return prev.replace(oldId, newId)
          })

          setActiveSegmentId((prev) => {
            if (!prev || !prev.includes(oldId)) return prev
            return prev.replace(oldId, newId)
          })

          setSelectedForDeletion((prev) => {
            if (!prev.has(oldId)) return prev
            const next = new Set(prev)
            next.delete(oldId)
            next.add(newId)
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
          const rebuilt = record ? getTimelineSegmentsForMessage(record) : []

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
    if (!isActive()) {
      clearPendingTimelinePartUpdateFrame()
      pendingTimelineMessagePartUpdates.clear()
      return
    }

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
    if (!isActive()) {
      return
    }

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
    if (!isActive()) {
      clearQuoteSelection()
      return
    }

    if (props.loading) {
      clearQuoteSelection()
    }
  })

  createEffect(() => {
    if (!isActive()) {
      return
    }

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
          virtualizeWhileAutoScroll={() => messageIds().length >= FOLLOW_MODE_VIRTUALIZATION_THRESHOLD}
          forceVisible={(_messageId, index) => index >= Math.max(0, messageIds().length - FOLLOW_MODE_VISIBLE_TAIL_COUNT)}
          suspendMeasurements={() => !isActive()}
          loading={() => Boolean(props.loading)}
          isActive={isActive}
          scrollToBottomOnActivate={() => false}
          initialScrollToBottom={() => false}
          initialAutoScroll={initialAutoScroll}
          resetKey={() => props.sessionId}
          followToken={followToken}
          onScroll={() => {
            clearQuoteSelection()
            scrollCache.persist(streamElement())
          }}
          onMouseUp={() => handleStreamMouseUp()}
          onClick={(e) => {
            if (selectedTimelineIds().size === 0) return
            const target = e.target as HTMLElement
            if (target.closest("button, a, input, [role='button']")) return
            handleClearTimelineSelection()
          }}
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
          renderBeforeItems={() => (
            <>
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
              selectedToolPartKeys={deleteToolPartKeys}
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

        <Show when={isDeleteMode()}>
          <div
            class="message-delete-mode-toolbar"
            role="toolbar"
            aria-label={t("messageSection.bulkDelete.toolbarAriaLabel", { count: selectedDeleteCount() })}
          >
            <div class="message-delete-mode-toolbar-row" aria-hidden="true">
              <span class="message-delete-mode-token-group">
                <span class="message-delete-mode-count message-delete-mode-count--before" title={`${tokenStats().used} tokens currently in context`}>
                  {formatTokenCount(tokenStats().used)}
                </span>
                <span class="message-delete-mode-arrow" aria-hidden="true">{"\u203A"}</span>
                <span
                  class="message-delete-mode-count message-delete-mode-count--selection"
                  title={`${selectedTokenTotal()} tokens selected (${selectedDeleteCount()} messages)`}
                >
                  {formatTokenCount(selectedTokenTotal())}
                </span>
                <span class="message-delete-mode-arrow" aria-hidden="true">{"\u203A"}</span>
                <span
                  class="message-delete-mode-count message-delete-mode-count--after"
                  title={`${Math.max(0, tokenStats().used - selectedTokenTotal())} tokens remaining after deletion`}
                >
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
                      <span class="message-delete-mode-menu-label">{t("messageSection.bulkDelete.selectionModeLabel")}</span>
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
            </div>

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
