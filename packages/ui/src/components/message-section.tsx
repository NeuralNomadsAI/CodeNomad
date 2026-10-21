import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, on, untrack, type JSX } from "solid-js"
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Search } from "lucide-solid"
import { Portal } from "solid-js/web"
import { matchesHotkey, withHotkey } from "../lib/hotkeys"
import DismissibleWindow from "./dismissible-window"
import WindowCloseButton from "./window-close-button"
import { isSessionSearchOpen, sessionSearchWindowId, setSessionSearchOpen } from "../stores/session-search"
import BrandedEmptyState from "./branded-empty-state"
import LoadErrorState from "./load-error-state"
import MessageBlock from "./message-block"
import PermissionReceipts from "./permission-receipts"
import { getMessageAnchorId } from "./message-anchors"
import MessageTimeline, { type TimelineSegment } from "./message-timeline"
import { buildTimelineSegments, getTimelineRecordSignature, timelineRunStart } from "./message-timeline-projection"
import VirtualFollowList, { type VirtualExplicitBottomPinIntent, type VirtualFollowListApi, type VirtualFollowListState, type VirtualFollowScrollSnapshot } from "./virtual-follow-list"
import { isSnapshotAutoFollowing } from "./virtual-follow-behavior"
import { useConfig } from "../stores/preferences"
import { MESSAGE_STREAM_SCROLL_SCOPE as MESSAGE_SCROLL_CACHE_SCOPE, messageStoreBus } from "../stores/message-v2/bus"
import { useI18n } from "../lib/i18n"
import { copyToClipboard } from "../lib/clipboard"
import { showToastNotification } from "../lib/notifications"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { ScrollSnapshot } from "../stores/message-v2/types"
import { partHasRenderableText } from "../types/message"
import { buildRecordDisplayData, getRecordDisplayPartIds, getRevealedRecordParts, isRecordPartDisplayed, MESSAGE_PART_REVEAL_STEP, revealHiddenRecordParts } from "../stores/message-v2/record-display-cache"
import { isDuplicateRunFailure } from "../stores/message-v2/run-failure"
import { getMessageSelectionActionPosition } from "../lib/message-selection-position"
import { findHistoryMatches } from "../stores/session-history"
import HistoryMessagePreview from "./history-message-preview"
import HistorySearchResults from "./history-search-results"
import { createSessionOutline } from "../stores/session-outline"
import { MissingHistoryAnchorError } from "../stores/history-window"
import { sessions } from "../stores/session-state"
import { createSessionOutlineProjection } from "./session-outline-projection"
import { findTimelineSegmentBlock, readingLineSegmentId } from "./timeline-transcript-blocks"
import { JUMP_USER_MESSAGE_EVENT, findUserMessageJumpTarget, keyAllowsUserMessageJump, type JumpUserMessageDetail, type UserMessageJumpDirection } from "./user-message-navigation"
import SessionCleanupProgress from "./session-cleanup-progress"
import type { SessionSearchMatch } from "../lib/session-search"
import type { SearchRevealRequest } from "./search-highlights"
import { resolveThinkingExpansionDefault, resolveToolVisibility } from "./tool-call/tool-registry"
import { isLatestWindow, preserveMessageWindowCursor, toWindowSnapshot } from "../stores/message-v2/message-window"
import { createSearchLocatorAuthority, getMessageWindowPageKey, hasMessageSearchAuthority, loadPagesUntilAnchor } from "./message-history-pagination"
import { getLogger } from "../lib/logger"
import { beginMessageHistoryTraversal, invalidateMessageHistoryTraversal } from "../stores/session-api"
import { getOpenCodeInstanceGeneration, getOpenCodeMutationRevision } from "../stores/opencode-data"
import type { SessionInboxUser } from "@opencode/client"
import { getFormQueue } from "../stores/forms"
import { resolveFormToolTarget } from "./form-request-tool-target"
import { getTechnicalCleanupParts, getTechnicalGroupKind, isResponseTextPart, isTechnicalGroupingVisiblePart, projectTranscriptTechnicalGroups, reasoningHasRenderableContent, technicalPartKey, type TechnicalCleanupTranscriptItem } from "../lib/message-part-grouping"

const QUOTE_SELECTION_MAX_LENGTH = 2000
const STREAMING_TEXT_HOLD_TOP_THRESHOLD_PX = 8
const SEARCH_DEBOUNCE_MS = 250
const SEARCH_MIN_CHARS = 3
const OPEN_SESSION_SEARCH_EVENT = "codenomad:open-session-search"
const log = getLogger("session")

/** Loads the anchor of the activation's scroll snapshot, then restores it through the list. */
interface RestoringNavigation { kind: "restoring"; sessionId: string; loading: AbortController | null }
/**
 * Pages the history window; `gesture` is the scroll direction that requested it.
 * `restored` records whether the activation restore had positioned the list
 * before paging began, and `positioned` whether paging has positioned it since.
 * Before the restore, `saved` keeps the stored position the page commit
 * replaces (`null`: none was stored).
 */
interface PagingNavigation {
  kind: "paging"; sessionId: string; controller: AbortController; gesture: "up" | "down" | null; around: boolean
  restored: boolean; positioned: boolean; saved?: ScrollSnapshot | null
}
/** One owner positions the transcript: the activation's restore, then history paging. */
type TranscriptNavigation = { kind: "unrestored" } | RestoringNavigation | PagingNavigation | { kind: "idle" }

function TimelinePlacement(props: { mount?: HTMLElement; children: JSX.Element }) {
  return <Show when={props.mount} fallback={props.children}>
    {(mount) => <Portal mount={mount()}>{props.children}</Portal>}
  </Show>
}

export interface MessageSectionProps {
  timelineMount?: HTMLElement
  instanceId: string
  sessionId: string
  loading?: boolean
  loadError?: string | null
  emptyStateVariant?: "messages" | "no-session"
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  showSidebarToggle?: boolean
  onSidebarToggle?: () => void
  forceCompactStatusLayout?: boolean
  onQuoteSelection?: (text: string, mode: "quote" | "code") => void
  onReloadMessages?: () => void
  hasMoreMessages?: boolean
  onLoadMoreMessages?: (signal?: AbortSignal) => Promise<boolean | void>
  onLoadNewerMessages?: (signal?: AbortSignal) => Promise<boolean | void>
  onLoadLatestMessages?: (signal?: AbortSignal) => Promise<boolean | void>
  onLoadOldestMessages?: (signal?: AbortSignal) => Promise<boolean | void>
  onLoadMessageAnchor?: (messageId: string, signal?: AbortSignal) => Promise<boolean | void>
  getMessageHistoryCursor?: () => string | undefined
  isActive?: boolean
  sessionStreamingActive?: boolean
  explicitBottomPinIntent?: VirtualExplicitBottomPinIntent | null
  onExplicitBottomPinCancelled?: () => void
  pendingPrompts?: ReadonlyMap<string, SessionInboxUser>
  pendingPromptBusy?: boolean
  onPendingPromptDeliveryChange?: (item: SessionInboxUser) => void
  onPendingPromptEdit?: (item: SessionInboxUser) => void
  onPendingPromptRemove?: (item: SessionInboxUser) => void
}

export default function MessageSection(props: MessageSectionProps) {
  const { preferences } = useConfig()
  const { locale, t } = useI18n()
  const usageMetricsVisibility = () =>
    preferences().showUsageMetrics ? preferences().usageMetricsExpansion : "hidden"
  const showMessageTimelinePreference = () => preferences().showMessageTimeline ?? true
  const holdLongAssistantRepliesEnabled = () => preferences().holdLongAssistantReplies ?? true
  const emptyStateVariant = () => props.emptyStateVariant ?? "messages"
  const store = createMemo<InstanceMessageStore>(() => messageStoreBus.getOrCreate(props.instanceId))
  const messageIds = createMemo(() => store().getSessionMessageIds(props.sessionId))
  const visibleMessageIds = createMemo(() => {
    const resolvedStore = store()
    const ids = messageIds()
    const visible = ids.filter((messageId, index) => {
      const record = resolvedStore.getMessage(messageId)
      if (!record) return false

      if (resolvedStore.getMessageInfo(messageId)?.nativeType === "system") {
        return preferences().systemMessagesVisibility !== "hidden"
      }

      // Thinking shows only with its preference, checked below.
      if (buildTimelineSegments(props.instanceId, record, t).some(segment => segment.type !== "reasoning")) {
        return true
      }

      if (record.role !== "assistant") {
        return true
      }

      // The transcript must still show retained thoughts after their neighbouring tools are pruned.
      if (preferences().showThinkingBlocks
        && buildRecordDisplayData(props.instanceId, record).orderedParts.some(reasoningHasRenderableContent)) return true

      const info = resolvedStore.getMessageInfo(messageId)
      if (!info || info.role !== "assistant") {
        return false
      }

      if (info.error) {
        return !isDuplicateRunFailure(ids, index, resolvedStore.getMessageInfo)
      }

      const timeInfo = info.time as { created: number; completed?: number } | undefined
      return Boolean(timeInfo && (timeInfo.completed === undefined || timeInfo.completed === 0))
    })
    if (!props.pendingPrompts?.size) return visible
    const visibleSet = new Set(visible)
    return [
      ...visible.filter((messageId) => !props.pendingPrompts!.has(messageId)),
      ...Array.from(props.pendingPrompts.keys()).filter((messageId) => visibleSet.has(messageId)),
    ]
  })

  const sessionRevision = createMemo(() => store().getSessionRevision(props.sessionId))
  const technicalCleanupTranscript = createMemo<TechnicalCleanupTranscriptItem[]>(() => {
    sessionRevision()
    const resolvedStore = store()
    return messageIds().flatMap((messageId) => {
      const record = resolvedStore.getMessage(messageId)
      if (!record) return []
      if (record.role === "user") return [null]
      const display = buildRecordDisplayData(props.instanceId, record)
      const projected = display.orderedParts.map<TechnicalCleanupTranscriptItem[]>((part) => {
        const partId = typeof part.id === "string" ? part.id : ""
        if (!partId) return []
        if (part.type === "tool" || part.type === "reasoning") {
          return [{ messageId, partId, type: part.type }]
        }
        if (isResponseTextPart(part)) return [{ messageId, partId, type: "boundary" as const }]
        return []
      })
      // Omitted parts may hold boundaries: never select a cleanup run across them.
      if (display.hiddenCount > 0) projected.splice(display.gapIndex, 0, [null])
      return projected.flat()
    })
  })
  const technicalCleanupParts = (messageId: string, partId: string) => getTechnicalCleanupParts(
    technicalCleanupTranscript(),
    messageId,
    partId,
  )
  const [technicalCleanupHoverTarget, setTechnicalCleanupHoverTarget] = createSignal<{ messageId: string; partId: string } | null>(null)
  const technicalCleanupPartKeys = createMemo<ReadonlySet<string>>(() => {
    const target = technicalCleanupHoverTarget()
    if (!target) return new Set()
    return new Set(technicalCleanupParts(target.messageId, target.partId).map((part) => technicalPartKey(part.messageId, part.partId)))
  })
  const handleTechnicalCleanupHoverChange = (messageId: string, partId: string, hovered: boolean) => {
    setTechnicalCleanupHoverTarget(hovered ? { messageId, partId } : null)
  }
  const pendingFormToolTargets = createMemo(() => new Set(getFormQueue(props.instanceId)
    .filter((form) => form.sessionID === props.sessionId)
    .flatMap((form) => {
      const target = resolveFormToolTarget(form, store())
      return target ? [technicalPartKey(target.messageId, target.partId)] : []
    })))
  const technicalGroupProjection = createMemo(() => {
    sessionRevision()
    const resolvedStore = store()
    const pendingForms = pendingFormToolTargets()
    const items = visibleMessageIds().flatMap((messageId) => {
      const record = resolvedStore.getMessage(messageId)
      if (!record) return []
      if (record.role === "user") return [null]
      const completed = record.status === "complete" || record.status === "error"
      const infoRevision = resolvedStore.state.messageInfoVersion[messageId] ?? 0
      const display = buildRecordDisplayData(props.instanceId, record)
      const projected = display.orderedParts.map((part) => {
        if (!isTechnicalGroupingVisiblePart(part)) return []
        const partId = typeof part.id === "string" ? part.id : ""
        const kind = getTechnicalGroupKind(part)
        const pending = part.type === "tool" && Boolean(
          part.pendingPermission?.active
          || (partId && resolvedStore.getPermissionState(messageId, partId)?.active)
          || (partId && pendingForms.has(technicalPartKey(messageId, partId)))
        )
        if (part.type === "tool" && resolveToolVisibility(preferences(), part.tool) === "hidden" && !pending) return []
        if (!kind || !partId) return [null]
        if ((kind === "exploration" || kind === "shell") && pending) return [null]
        return [{
          messageId,
          partId,
          part,
          completed,
          revision: `${record.revision}:${record.parts[partId]?.revision ?? 0}:${infoRevision}`,
        }]
      })
      // Technical groups never span omitted parts; the gap renders between them.
      // A step's usage line does not end its group: it folds with the group's tools.
      if (display.hiddenCount > 0) projected.splice(display.gapIndex, 0, [null])
      return projected.flat()
    })
    return projectTranscriptTechnicalGroups(items)
  })
  const technicalGroupForPart = (messageId: string, partId: string) => technicalGroupProjection().byPartKey.get(technicalPartKey(messageId, partId))
  const technicalGroupingSignature = (messageId: string) => {
    const resolvedStore = store()
    const record = resolvedStore.getMessage(messageId)
    if (!record) return ""
    const displayPartIds = getRecordDisplayPartIds(props.instanceId, record)
    const groups = Array.from(new Set(displayPartIds.flatMap((partId) => {
      const group = technicalGroupForPart(messageId, partId)
      return group ? [group.signature] : []
    }))).join(";")
    const pendingForms = pendingFormToolTargets()
    const tools = displayPartIds.flatMap((partId) => {
      const part = record.parts[partId]?.data
      if (part?.type !== "tool") return []
      const pending = Boolean(
        part.pendingPermission?.active
        || resolvedStore.getPermissionState(messageId, partId)?.active
        || pendingForms.has(technicalPartKey(messageId, partId))
      )
      return [`${partId}:${resolveToolVisibility(preferences(), part.tool)}:${pending ? 1 : 0}`]
    }).join(";")
    return `${groups}|${tools}`
  }
  const [technicalGroupExpansion, setTechnicalGroupExpansion] = createSignal(new Map<string, boolean>())
  const isTechnicalGroupExpanded = (groupId: string, defaultExpanded: boolean) => technicalGroupExpansion().get(groupId) ?? defaultExpanded
  const setTechnicalGroupExpanded = (groupId: string, expanded: boolean) => setTechnicalGroupExpansion((current) => {
    const next = new Map(current)
    next.set(groupId, expanded)
    return next
  })

  const preferenceSignature = createMemo(() => {
    const pref = preferences()
    const showThinking = pref.showThinkingBlocks ? 1 : 0
    const thinkingExpansion = resolveThinkingExpansionDefault(pref) ? "expanded" : "collapsed"
    const usageVisibility = pref.showUsageMetrics ? pref.usageMetricsExpansion : "hidden"
    return `${showThinking}|${thinkingExpansion}|${usageVisibility}|${pref.systemMessagesVisibility}`
  })

  // The active marker follows the block at the reading line. A selected marker
  // stays active instead until the reader scrolls: its placement, the row's late
  // layout or a top it cannot reach must not select a neighbour.
  let readerOwnsActiveSegment = true
  let readingLineFrame: number | undefined
  onCleanup(() => { if (readingLineFrame !== undefined) cancelAnimationFrame(readingLineFrame) })
  const handleTimelineSegmentClick = (segment: TimelineSegment) => {
    setActiveSegmentId(segment.id)
    navigateToMessage(segment.messageId, undefined, segment.id)
  }

  // Workspace metadata updates can re-evaluate the identity accessors without
  // changing search visibility. Only a real close may cancel history reads.
  const isSearchOpen = createMemo(() => isSessionSearchOpen(props.instanceId, props.sessionId))
  const setIsSearchOpen = (open: boolean) => setSessionSearchOpen(props.instanceId, props.sessionId, open)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [debouncedSearchQuery, setDebouncedSearchQuery] = createSignal("")
  const [searchedQuery, setSearchedQuery] = createSignal("")
  const [isSearchPending, setIsSearchPending] = createSignal(false)
  const [failedSearchQuery, setFailedSearchQuery] = createSignal("")
  const [searchRetryGeneration, setSearchRetryGeneration] = createSignal(0)
  const [searchMatches, setSearchMatches] = createSignal<Array<SessionSearchMatch & { sessionId: string }>>([])
  const [searchWorkspace, setSearchWorkspace] = createSignal(false)
  const [includeTechnical, setIncludeTechnical] = createSignal(false)
  const [scannedSearchMessages, setScannedSearchMessages] = createSignal(0)
  const [searchPageCursor, setSearchPageCursor] = createSignal<string>()
  const [nextSearchCursor, setNextSearchCursor] = createSignal<string | null>(null)
  const [skippedSearchMessages, setSkippedSearchMessages] = createSignal(0)
  const [previewSearchMatch, setPreviewSearchMatch] = createSignal<{ sessionId: string; messageId: string }>()
  const [activeSearchIndex, setActiveSearchIndex] = createSignal(0)
  // Set once a search navigation has placed its message: that row reveals the
  // occurrence once. Rows mounted later by paging or virtualization find it
  // claimed, and any reader gesture claims it first.
  const [searchReveal, setSearchReveal] = createSignal<SearchRevealRequest | null>(null)
  const searchLocatorAuthority = createSearchLocatorAuthority()
  let searchGeneration = 0
  let searchInputRef: HTMLInputElement | undefined

  const currentSearchMatches = createMemo(() => hasMessageSearchAuthority(searchQuery(), searchedQuery()) ? searchMatches() : [])
  const authoritativeSearchQuery = createMemo(() => hasMessageSearchAuthority(searchQuery(), searchedQuery()) ? debouncedSearchQuery() : "")

  const activeSearchMatch = createMemo(() => {
    const matches = currentSearchMatches()
    if (matches.length === 0) return null
    const index = Math.min(Math.max(activeSearchIndex(), 0), matches.length - 1)
    return matches[index] ?? null
  })

  const searchResultMessageIds = createMemo(() => new Set(currentSearchMatches().map((match) => match.messageId)))

  const trimmedSearchQuery = createMemo(() => searchQuery().trim())
  const isSearchSettled = createMemo(() => {
    const query = trimmedSearchQuery()
    return query.length >= SEARCH_MIN_CHARS && !isSearchPending() && hasMessageSearchAuthority(query, searchedQuery())
  })
  const searchFailed = createMemo(() => hasMessageSearchAuthority(trimmedSearchQuery(), failedSearchQuery()))

  const timelineSegmentCache = new Map<string, { revision: number; status: string; locale: string; revealed: number; signature: string; segments: TimelineSegment[] }>()
  const residentTimelineSegments = createMemo(() => {
    sessionRevision()
    const ids = visibleMessageIds()
    const resolvedStore = store()
    const activeLocale = locale()
    // Revealing omitted parts changes the rendered window without a record revision.
    const revealedByMessage = new Map(ids.map((messageId) => [messageId, getRevealedRecordParts(props.instanceId, messageId)]))

    return untrack(() => {
      const activeIds = new Set(ids)
      const segments: TimelineSegment[] = []
      for (const messageId of ids) {
        const record = resolvedStore.getMessage(messageId)
        if (!record) continue
        const revealed = revealedByMessage.get(messageId) ?? 0
        const cached = timelineSegmentCache.get(messageId)
        if (cached?.revision === record.revision && cached.status === record.status && cached.locale === activeLocale && cached.revealed === revealed) {
          segments.push(...cached.segments)
          continue
        }
        const signature = getTimelineRecordSignature(record)
        const current = cached?.signature === signature && cached.locale === activeLocale && cached.revealed === revealed
          ? cached.segments
          : buildTimelineSegments(props.instanceId, record, t)
        timelineSegmentCache.set(messageId, { revision: record.revision, status: record.status, locale: activeLocale, revealed, signature, segments: current })
        segments.push(...current)
      }
      for (const messageId of timelineSegmentCache.keys()) {
        if (!activeIds.has(messageId)) timelineSegmentCache.delete(messageId)
      }
      return segments
    })
  })
  // Jumping between user messages needs the same structural index, timeline shown or not.
  const [outlineDemanded, setOutlineDemanded] = createSignal(false)
  const outline = createSessionOutline({ instanceId: () => props.instanceId, sessionId: () => props.sessionId,
    active: () => props.isActive !== false && Boolean(props.onLoadMessageAnchor) && (showMessageTimelinePreference() || outlineDemanded()) })
  const projectSessionOutline = createSessionOutlineProjection()
  const timelineSegments = createMemo(() => {
    const boundary = sessions().get(props.instanceId)?.get(props.sessionId)?.revert?.messageID
    const entries = boundary ? outline.entries().filter(entry => entry.id < boundary) : outline.entries()
    return entries.length ? projectSessionOutline(entries, residentTimelineSegments(), messageIds(), t) : residentTimelineSegments()
  })
  const timelineSegmentsByMessage = createMemo(() => {
    const result = new Map<string, TimelineSegment[]>()
    for (const segment of timelineSegments()) {
      const list = result.get(segment.messageId)
      if (list) list.push(segment)
      else result.set(segment.messageId, [segment])
    }
    return result
  })
  // As in the transcript, a hidden tool awaiting a permission or form stays shown.
  const isPendingToolSegment = (segment: TimelineSegment) => (segment.toolPartIds ?? []).some((partId) => {
    const part = store().getMessage(segment.messageId)?.parts[partId]?.data
    return Boolean((part?.type === "tool" && part.pendingPermission?.active) || pendingFormToolTargets().has(technicalPartKey(segment.messageId, partId)))
  })
  const isTimelineSegmentHidden = (segment: TimelineSegment) => segment.type === "tool"
    ? resolveToolVisibility(preferences(), segment.toolName ?? "") === "hidden" && !isPendingToolSegment(segment)
    : segment.type === "reasoning" ? !preferences().showThinkingBlocks
      : segment.type === "system" && preferences().systemMessagesVisibility === "hidden"
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
    const matches = currentSearchMatches()
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

  const [activeSegmentId, setActiveSegmentId] = createSignal<string | null>(null)
  const [revealActiveToken, setRevealActiveToken] = createSignal(0)

  const isActive = createMemo(() => props.isActive !== false)
  const [listApi, setListApi] = createSignal<VirtualFollowListApi | null>(null)
  const [listState, setListState] = createSignal<VirtualFollowListState | null>(null)
  const showFirstButton = () => Boolean(props.hasMoreMessages || listState()?.showScrollTopButton())
  const showLatestButton = () => !isLatestWindow(store().getMessageWindow(props.sessionId)) || Boolean(listState()?.showScrollBottomButton())
  const scrollButtonsCount = createMemo(() => Number(showFirstButton()) + Number(showLatestButton()))

  const [streamElement, setStreamElement] = createSignal<HTMLDivElement | undefined>()
  const [streamShellElement, setStreamShellElement] = createSignal<HTMLDivElement | undefined>()
  // Only preferences should force a follow-token re-anchor. Message/session
  // revision churn at the end of a turn (terminal updates, session idle, etc.)
  // should not trigger an immediate scroll-to-bottom.
  const followToken = createMemo(() => preferenceSignature())

  const lastGoodScrollSnapshots = new Map<string, VirtualFollowScrollSnapshot>()
  // Restoring or paging owns the transcript position; only an idle (restored)
  // transcript persists it. An operation is current while it is the state.
  const [navigation, setNavigation] = createSignal<TranscriptNavigation>({ kind: "unrestored" })
  const navigationPending = () => {
    const nav = navigation()
    return nav.kind === "paging" && nav.around
  }
  let retryAnchorRestore: (() => void) | null = null
  const [olderMessageLoadFailed, setOlderMessageLoadFailed] = createSignal(false)
  // The list cannot raise a message near the end to its top, so the last jump's
  // target, while loading or shown, stays the reference for the next jump.
  let userMessageJumpTarget: string | null = null
  // A jump that finds nothing resident waits for the index it requested.
  let deferredUserMessageJump: UserMessageJumpDirection | null = null

  /** Another navigation or a scroll gesture now owns the position. */
  function forgetUserMessageJump() {
    userMessageJumpTarget = null
    deferredUserMessageJump = null
  }

  /** `positioning`: the caller positions the list at once, so it leaves no restore pending. */
  function cancelWindowNavigation(positioning = false) {
    forgetUserMessageJump()
    const nav = navigation()
    if (nav.kind === "paging") {
      nav.controller.abort()
      settlePaging(nav, positioning)
    } else if (nav.kind === "restoring" && nav.loading) {
      // The navigation that cancels the restore positions the list itself.
      nav.loading.abort()
      setNavigation({ kind: "idle" })
    } else if (positioning && nav.kind === "unrestored") setNavigation({ kind: "idle" })
  }

  function settlePaging(paging: PagingNavigation, positioning = false) {
    // Scrolls during paging were ignored, and a page may end without moving
    // anything: the reading line decides once it settles.
    scheduleReadingLineSegment()
    // Paging that never positioned a list the activation had not restored yet
    // leaves that restore pending, unless the caller positions the list now; its
    // unpositioned list has nothing to persist. A failed or cancelled jump thus
    // falls back to the saved position, put back over its page commit (none
    // saved stands for the latest bottom), and that restore then reloads the
    // saved position's window and owns the retry banner. A saved bottom of a
    // historical window carries no anchor to reload, so it is not covered.
    if (!paging.restored && !paging.positioned) {
      const resolvedStore = store()
      const current = resolvedStore.getScrollSnapshot(paging.sessionId, MESSAGE_SCROLL_CACHE_SCOPE)
      if (!positioning && paging.saved !== undefined && current !== (paging.saved ?? undefined)) {
        const { updatedAt: _updatedAt, ...saved } = paging.saved
          ?? { scrollTop: 0, atBottom: true, followModeType: "following" as const, windowIsLatest: true, updatedAt: 0 }
        resolvedStore.setScrollSnapshot(paging.sessionId, MESSAGE_SCROLL_CACHE_SCOPE, saved)
      }
      setNavigation(positioning ? { kind: "idle" } : { kind: "unrestored" })
      return
    }
    setNavigation({ kind: "idle" })
    // A committed page records its intended position in the store; record the reader's actual one.
    // Known follow-up: Virtua renders a jump's rows only at its next scroll event; a view hidden
    // before then finds no anchor to capture, so the last good position predates the jump.
    persistMessageScrollSnapshot({ sessionId: paging.sessionId, allowCapture: paging.sessionId === props.sessionId, requireActive: false })
  }

  function resetNavigation() {
    cancelWindowNavigation()
    retryAnchorRestore = null
    readerOwnsActiveSegment = true
    setNavigation({ kind: "unrestored" })
  }

  function registerListApi(api: VirtualFollowListApi) {
    if (listApi() !== api) untrack(resetNavigation)
    setListApi(api)
  }

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
        resetNavigation()
        setOlderMessageLoadFailed(false)
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
          if (wasActive === false) setNavigation({ kind: "unrestored" })
          return
        }
        const nav = navigation()
        cancelWindowNavigation()
        retryAnchorRestore = null
        if (nav.kind === "idle") persistMessageScrollSnapshot({ requireActive: false })
        else if (nav.kind === "restoring") setNavigation({ kind: "unrestored" })
      },
    ),
  )

  onCleanup(() => {
    cancelWindowNavigation()
    retryAnchorRestore = null
  })

  // A send loads and pins the latest window itself: stale paging must not resume
  // afterwards and leave follow, and a restore still pending must not run after
  // it, either of which would cancel the new send pin. The intent object is
  // rebuilt on every count/streaming change; only a new token is a send.
  const sendIntentToken = createMemo(() => props.explicitBottomPinIntent?.token)
  createEffect(on(sendIntentToken, (token) => {
    if (token === undefined) return
    cancelWindowNavigation(true)
    // The marker of the latest bottom the send pins replaces one selected before.
    releaseActiveSegment()
  }, { defer: true }))

  function canCaptureScrollSnapshot(options?: { requireActive?: boolean }) {
    const element = streamElement()
    if (!element) return false
    if ((options?.requireActive ?? true) && !isActive()) return false
    if (!element.isConnected) return false
    if (element.clientHeight <= 0) return false
    if (typeof getComputedStyle === "function" && getComputedStyle(element).display === "none") return false
    return true
  }

  function persistMessageScrollSnapshot(options?: { sessionId?: string; allowCapture?: boolean; requireActive?: boolean; snapshot?: VirtualFollowScrollSnapshot }) {
    if (navigation().kind !== "idle") return

    const sessionId = options?.sessionId ?? props.sessionId
    const allowCapture = options?.allowCapture ?? true
    const canCapture = canCaptureScrollSnapshot({ requireActive: options?.requireActive })
    if (allowCapture && canCapture) {
      const captured = options?.snapshot ?? listApi()?.captureScrollSnapshot()
      // Only the bottom or an anchored row identifies the reader; otherwise keep
      // the last good position.
      const snapshot = captured && (captured.atBottom || captured.anchorKey !== undefined) ? overlayWindowOnSnapshot(captured) : undefined
      if (snapshot) {
        setLastGoodScrollSnapshot(sessionId, snapshot)
        const resolvedStore = store()
        resolvedStore.setScrollSnapshot(sessionId, MESSAGE_SCROLL_CACHE_SCOPE, preserveMessageWindowCursor(
          snapshot,
          resolvedStore.getScrollSnapshot(sessionId, MESSAGE_SCROLL_CACHE_SCOPE),
          resolvedStore.getMessageWindow(sessionId),
        ))
        return
      }
    }

    const lastGoodScrollSnapshot = getLastGoodScrollSnapshot(sessionId)
    if (lastGoodScrollSnapshot) {
      const resolvedStore = store()
      resolvedStore.setScrollSnapshot(sessionId, MESSAGE_SCROLL_CACHE_SCOPE, preserveMessageWindowCursor(
        lastGoodScrollSnapshot,
        resolvedStore.getScrollSnapshot(sessionId, MESSAGE_SCROLL_CACHE_SCOPE),
        resolvedStore.getMessageWindow(sessionId),
      ))
      return
    }

  }

  // A scroll persists once Virtua reports it settled, not on every event. An
  // unsettled position is still recorded on unmount by the cleanup below (an
  // inactive SessionView unmounts this section before hiding it) and by a
  // state capture's flush.
  let scrollUnsettled = false
  function persistScroll() {
    scrollUnsettled = false
    persistMessageScrollSnapshot()
  }
  function persistSettledScroll() {
    if (scrollUnsettled) persistScroll()
  }
  onCleanup(messageStoreBus.onScrollSnapshotFlush(persistSettledScroll))
  // A pinned stream keeps scrolling, so it never settles: persist a follow-mode
  // change rather than wait for the stream to pause. The list captures a
  // following reader at the bottom even before a resuming gesture lands.
  createEffect(on(() => listState()?.autoScroll(), (following, previous) => {
    if (following === undefined || previous === undefined) return
    persistScroll()
    // Growth below an escaped reader (a long-reply hold) scrolls nothing, so
    // nothing settles: a state capture's flush must still record it again.
    if (!following) scrollUnsettled = true
  }, { defer: true }))

  // Persist scroll position when switching sessions. This effect's cleanup runs
  // when `props.sessionId` changes, before the next session is rendered.
  // Production sections are keyed per session: only the loading placeholder
  // changes session, and it never persists (loading keeps its navigation
  // unrestored). A retained section whose session changes after an unsettled
  // scroll would keep its last settled position.
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

  function isStreamingAssistantTextMessage(messageId: string | null | undefined) {
    if (!messageId) return false
    const resolvedStore = store()
    const record = resolvedStore.getMessage(messageId)
    if (!record || record.role !== "assistant") return false
    if (record.status !== "streaming") return false

    const info = resolvedStore.getMessageInfo(messageId)
    const timeInfo = info?.time as { completed?: number } | undefined
    if (typeof timeInfo?.completed === "number" && timeInfo.completed > 0) return false

    const { orderedParts } = buildRecordDisplayData(props.instanceId, record)
    return orderedParts.some((part) => {
      if ((part as any)?.type !== "text") return false
      if (partHasRenderableText(part)) return true
      return typeof (part as { text?: unknown }).text === "string"
    })
  }

  // Restore once per activation, when the transcript can show the snapshot.
  // The snapshot is read untracked: persisting the position must not restart it.
  createEffect(() => {
    // Checked first: once restored, the effect does not track the transcript.
    if (navigation().kind !== "unrestored") return
    const element = streamElement()
    const api = listApi()
    if (!element || !api || !isActive() || props.loading || visibleMessageIds().length === 0) return
    untrack(() => restoreTranscriptPosition(api))
  })

  function restoreTranscriptPosition(api: VirtualFollowListApi) {
    const restoreSessionId = props.sessionId
    const restoring: RestoringNavigation = { kind: "restoring", sessionId: restoreSessionId, loading: null }
    setNavigation(restoring)
    releaseActiveSegment()
    const isCurrentRestore = () => navigation() === restoring && isActive() && api === listApi()
    const finish = (applied: boolean) => {
      if (!isCurrentRestore()) return
      setNavigation({ kind: "idle" })
      // Record the position actually reached, not the requested one.
      if (applied) persistMessageScrollSnapshot()
    }
    // Without a snapshot, the latest page opens at its bottom.
    const stored = store().getScrollSnapshot(restoreSessionId, MESSAGE_SCROLL_CACHE_SCOPE)
    const snapshot: VirtualFollowScrollSnapshot = stored ?? { scrollTop: 0, atBottom: true, followModeType: "following" }
    const restore = async () => {
      setOlderMessageLoadFailed(false)
      let restoredSnapshot = snapshot
      // An anchor identifies an escaped reader, even one captured at the bottom
      // (a long-reply hold); only a following snapshot has none.
      const loadsAnchor = snapshot.anchorKey && !visibleMessageIds().includes(snapshot.anchorKey) && (props.onLoadMessageAnchor || props.onLoadMoreMessages)
      // The bottom of the latest page (or no position) reopens that page first
      // when a cancelled jump left a historical window in its place.
      const loadsLatest = snapshot.atBottom && !snapshot.anchorKey && stored?.windowIsLatest !== false && props.onLoadLatestMessages
        && !isLatestWindow(store().getMessageWindow(restoreSessionId))
      if (loadsAnchor || loadsLatest) {
        try {
          if (loadsLatest) {
            const controller = new AbortController()
            restoring.loading = controller
            try { await props.onLoadLatestMessages!(controller.signal) }
            finally { if (restoring.loading === controller) restoring.loading = null }
          } else if (props.onLoadMessageAnchor) {
            const controller = new AbortController()
            restoring.loading = controller
            try {
              try { await props.onLoadMessageAnchor(snapshot.anchorKey!, controller.signal) }
              catch (error) {
                if (!(error instanceof MissingHistoryAnchorError) || !props.onLoadLatestMessages || !isCurrentRestore()) throw error
                await props.onLoadLatestMessages(controller.signal)
                if (!isCurrentRestore()) return
                restoredSnapshot = store().getScrollSnapshot(restoreSessionId, MESSAGE_SCROLL_CACHE_SCOPE) ?? snapshot
              }
            }
            finally { if (restoring.loading === controller) restoring.loading = null }
          } else await loadPagesUntilAnchor({
            hasAnchor: () => visibleMessageIds().includes(snapshot.anchorKey!),
            hasMore: () => Boolean(props.hasMoreMessages),
            isCurrent: isCurrentRestore,
            loadMore: async () => { await props.onLoadMoreMessages?.() },
            getCursor: () => props.getMessageHistoryCursor?.(),
          })
        } catch (error) {
          if (!isCurrentRestore()) return
          retryAnchorRestore = () => void restore()
          setOlderMessageLoadFailed(true)
          log.error("Failed to load older messages while restoring scroll", { instanceId: props.instanceId, sessionId: restoreSessionId, error })
          return
        }
      }
      if (!isCurrentRestore()) return
      retryAnchorRestore = null

      api.restoreScrollSnapshot(restoredSnapshot, {
        fallback: () => {
          if (!isCurrentRestore()) return
          api.setAutoScroll(true)
          api.scrollToBottom({ immediate: true })
          finish(false)
        },
        onApplied: () => finish(true),
        onCancelled: () => finish(false),
      })
    }
    void restore()
  }

  function clearQuoteSelection() {
    setQuoteSelection(null)
  }

  function openSearch() {
    setIsSearchOpen(true)
    requestAnimationFrame(() => { if (isSearchOpen()) searchInputRef?.focus() })
  }

  function closeSearch() {
    invalidateMessageHistoryTraversal(props.instanceId, props.sessionId)
    searchLocatorAuthority.reset()
    searchGeneration += 1
    setIsSearchOpen(false)
    setSearchPageCursor(undefined)
    setNextSearchCursor(null)
    setPreviewSearchMatch(undefined)
    setSkippedSearchMessages(0)
    setScannedSearchMessages(0)
    setSearchQuery("")
    setDebouncedSearchQuery("")
    setSearchedQuery("")
    setIsSearchPending(false)
    setFailedSearchQuery("")
    setSearchMatches([])
    setActiveSearchIndex(0)
    setSearchReveal(null)
  }

  function updateSearchQuery(query: string) {
    if (query === searchQuery()) return
    invalidateMessageHistoryTraversal(props.instanceId, props.sessionId)
    searchLocatorAuthority.reset()
    searchGeneration += 1
    setSearchPageCursor(undefined)
    setSearchQuery(query)
  }

  onCleanup(() => {
    searchLocatorAuthority.reset()
    invalidateMessageHistoryTraversal(props.instanceId, props.sessionId)
  })

  function moveSearchMatch(direction: 1 | -1) {
    const count = currentSearchMatches().length
    if (count === 0) return
    selectSearchMatch((activeSearchIndex() + direction + count) % count)
  }

  function selectSearchMatch(index: number) {
    const previous = activeSearchMatch()
    setActiveSearchIndex(index)
    const match = activeSearchMatch()
    if (!match) return
    if (match.sessionId !== props.sessionId || !props.onLoadMessageAnchor) setPreviewSearchMatch(match)
    // The active-match effect locates a newly selected resident match.
    else if (match === previous || !messageIds().includes(match.messageId)) navigateToMessage(match.messageId, match.id)
  }

  /**
   * Places a message at the top, first paging in its history window when it is
   * not resident. A search navigation then reveals its occurrence once; a
   * selected marker keeps its highlight and places its own block.
   */
  function navigateToMessage(messageId: string, searchMatchId?: string, segmentId?: string) {
    forgetUserMessageJump()
    readerOwnsActiveSegment = !segmentId
    if (messageIds().includes(messageId)) placeResidentMessage(messageId, searchMatchId, segmentId)
    else void pageWindow("around", api => placeMessage(api, messageId, searchMatchId, segmentId), messageId)
  }

  function placeResidentMessage(messageId: string, searchMatchId?: string, segmentId?: string) {
    const api = listApi()
    // A resident message the list hides (filtered, beyond a revert) places nothing.
    const placeable = Boolean(api) && visibleMessageIds().includes(messageId)
    cancelWindowNavigation(placeable)
    if (placeable) placeMessage(api!, messageId, searchMatchId, segmentId)
    else claimSearchReveal()
  }

  function placeMessage(api: VirtualFollowListApi, messageId: string, searchMatchId?: string, segmentId?: string) {
    if (segmentId) revealTimelineSegment(messageId, segmentId)
    // A selected marker's own block (a later tool, a reply after its thinking)
    // is held at the top once its row renders, even when the row remounts.
    api.scrollToKey(messageId, segmentId ? () => {
      const scroller = streamElement(), segment = timelineSegmentsByMessage().get(messageId)?.find(candidate => candidate.id === segmentId)
      return scroller && segment ? findTimelineSegmentBlock(scroller, segment, technicalGroupForPart) : null
    } : undefined)
    if (searchMatchId) setSearchReveal({ matchId: searchMatchId, claimed: false })
    else claimSearchReveal()
  }

  /** An indexed marker may start among the parts its loaded message omits: reveal them first. */
  function revealTimelineSegment(messageId: string, segmentId: string) {
    const record = store().getMessage(messageId)
    if (!record || untrack(timelineSegmentsByMessage).get(messageId)?.some(segment => segment.id === segmentId)) return
    const start = timelineRunStart(record, segmentId, t)
    if (start === undefined) return
    for (let step = 0; step <= record.partIds.length / MESSAGE_PART_REVEAL_STEP && !isRecordPartDisplayed(props.instanceId, record, start); step++) {
      revealHiddenRecordParts(props.instanceId, messageId)
    }
  }

  /** The block at the reading line, not a marker selected before, is active again. */
  function releaseActiveSegment() {
    readerOwnsActiveSegment = true
    scheduleReadingLineSegment()
  }

  function scheduleReadingLineSegment() {
    if (readingLineFrame !== undefined || !readerOwnsActiveSegment) return
    readingLineFrame = requestAnimationFrame(() => {
      readingLineFrame = undefined
      // Intermediate positions while a window loads must not move the rail.
      const scroller = streamElement()
      if (!readerOwnsActiveSegment || navigation().kind === "paging" || !scroller) return
      const id = readingLineSegmentId(scroller, timelineSegmentsByMessage())
      if (id) setActiveSegmentId(current => (current === id ? current : id))
    })
  }

  /** Any other navigation or gesture now owns the position: a pending reveal must not pull it. */
  function claimSearchReveal() {
    const reveal = untrack(searchReveal)
    if (reveal) reveal.claimed = true
  }

  function jumpToUserMessage(direction: UserMessageJumpDirection) {
    const api = listApi()
    if (!api || !isActive()) return
    setOutlineDemanded(true)
    const pending = userMessageJumpTarget
    const current = pending && (navigation().kind === "paging" || isMessageRowShown(pending))
      ? pending
      : api.captureScrollSnapshot()?.anchorKey ?? listState()?.activeKey() ?? null
    const segments = timelineSegments()
    const target = findUserMessageJumpTarget({ markers: segments, resident: visibleMessageIds(), current, direction })
    if (!target) {
      if (current !== pending) userMessageJumpTarget = null
      deferredUserMessageJump = props.onLoadMessageAnchor && outline.entries().length === 0 ? direction : null
      return
    }
    const segment = segments.find(segment => segment.messageId === target && segment.type === "user")
    if (segment) setActiveSegmentId(segment.id)
    navigateToMessage(target, undefined, segment?.id)
    userMessageJumpTarget = target
  }

  function isMessageRowShown(messageId: string) {
    const scroller = streamElement()
    const row = scroller?.querySelector(`[data-virtual-follow-key="${CSS.escape(messageId)}"]`)
    if (!scroller || !row) return false
    const view = scroller.getBoundingClientRect(), rect = row.getBoundingClientRect()
    return rect.bottom > view.top && rect.top < view.bottom
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
    showToastNotification({ category: "copy",
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
    // Rendering can move the reading line's block without a scroll event.
    scheduleReadingLineSegment()
  }

  function overlayWindowOnSnapshot(snapshot: VirtualFollowScrollSnapshot | undefined) {
    if (!snapshot) return snapshot
    return { ...snapshot, ...toWindowSnapshot(store().getMessageWindow(props.sessionId) ?? { kind: "latest", newerCursors: [] }) }
  }

  function waitTwoFrames() {
    return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }

  async function pageWindow(
    direction: "older" | "newer" | "latest" | "oldest" | "around",
    after: (api: VirtualFollowListApi) => void,
    anchorMessageId?: string,
  ) {
    const api = listApi()
    if (!api || !isActive()) return
    const previous = navigation()
    if (previous.kind === "paging" && direction !== "around" && direction !== "latest") return
    // A restore loading its anchor replaces the window and positions the list
    // itself; a boundary gesture meanwhile must not page beyond that window.
    if (previous.kind === "restoring" && previous.loading && (direction === "older" || direction === "newer")) return
    const restored = previous.kind === "idle" || (previous.kind === "paging" && (previous.restored || previous.positioned))
    const load = direction === "around"
      ? props.onLoadMessageAnchor && anchorMessageId ? (signal?: AbortSignal) => props.onLoadMessageAnchor!(anchorMessageId, signal) : undefined
      : direction === "older"
      ? props.onLoadMoreMessages
      : direction === "newer"
        ? props.onLoadNewerMessages
        : direction === "oldest"
          ? props.onLoadOldestMessages
          : props.onLoadLatestMessages
    // First without a page to load is a local jump; other requests that load
    // nothing leave every navigation, including a loading restore, untouched.
    const localFirst = direction === "oldest" && (!load || !props.hasMoreMessages)
    if (!load && !localFirst) return
    if (direction === "older" && !props.hasMoreMessages) return
    if (direction === "newer" && isLatestWindow(store().getMessageWindow(props.sessionId))) return
    // Before the restore, keep the position a page commit would replace (a
    // superseded jump already kept it).
    const saved = restored ? undefined
      : previous.kind === "paging" ? previous.saved : store().getScrollSnapshot(props.sessionId, MESSAGE_SCROLL_CACHE_SCOPE) ?? null
    // Paging positions the list itself.
    cancelWindowNavigation(true)
    claimSearchReveal()
    if (localFirst || !load) {
      after(api)
      return
    }
    const sessionId = props.sessionId
    const controller = new AbortController()
    const paging: PagingNavigation = {
      kind: "paging",
      sessionId,
      controller,
      gesture: direction === "older" || direction === "oldest" ? "up" : direction === "around" ? null : "down",
      around: direction === "around",
      restored,
      positioned: false,
      saved,
    }
    setNavigation(paging)
    // A jump keeps its selected marker; other pages show the reading line's.
    if (direction !== "around") readerOwnsActiveSegment = true
    const isCurrent = () => navigation() === paging && isActive() && api === listApi()
    if (direction !== "latest") api.setAutoScroll(false)
    setOlderMessageLoadFailed(false)
    retryAnchorRestore = null
    try {
      const previousPage = messageWindowPageKey()
      const previousPosition = direction === "older" || direction === "newer" ? api.captureScrollSnapshot() : undefined
      const committed = await load(controller.signal)
      if (committed === false || !isCurrent()) return
      // An empty boundary probe retires the older cursor without changing the
      // resident page. Do not jump from its top back to its bottom in that case.
      if (direction === "older" && messageWindowPageKey() === previousPage) return
      api.setAutoScroll(direction === "latest")
      api.notifyContentRendered()
      await waitTwoFrames()
      if (!isCurrent()) return
      const visible = visibleMessageIds()
      const retainedAnchor = previousPosition?.anchorKey && visible.includes(previousPosition.anchorKey)
      // A jump target hidden from the list (filtered, beyond a revert) places nothing.
      paging.positioned = visible.length > 0 && (Boolean(retainedAnchor) || direction !== "around" || visible.includes(anchorMessageId!))
      if (retainedAnchor) api.restoreScrollSnapshot({ ...previousPosition, atBottom: false, followModeType: "escaped" })
      else after(api)
      const bottomSettlement = !retainedAnchor && (direction === "older" || direction === "latest")
        ? await api.settleAtBottom()
        : "settled"
      if (!isCurrent()) return
      api.setAutoScroll(direction === "latest" && bottomSettlement !== "cancelled")
      api.notifyContentRendered()
      await waitTwoFrames()
      if (!isCurrent()) return
      if (direction === "latest" || direction === "oldest") setRevealActiveToken(value => value + 1)
    } catch (error) {
      if (isCurrent()) {
        retryAnchorRestore = () => { void pageWindow(direction, after, anchorMessageId) }
        setOlderMessageLoadFailed(true)
        log.error("Failed to page message window", { instanceId: props.instanceId, sessionId, direction, error })
      }
    } finally {
      if (navigation() === paging) settlePaging(paging)
    }
  }

  function messageWindowPageKey() {
    return getMessageWindowPageKey(store().getMessageWindow(props.sessionId))
  }

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
      setFailedSearchQuery("")
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
    const query = debouncedSearchQuery()
    const workspace = searchWorkspace()
    const technical = includeTechnical()
    const systemVisibility = preferences().systemMessagesVisibility
    const cursor = searchPageCursor()
    const mutationRevision = getOpenCodeMutationRevision(props.instanceId, props.sessionId)
    const instanceGeneration = getOpenCodeInstanceGeneration(props.instanceId)
    searchRetryGeneration()
    if (!isActive() || !isSearchOpen() || query.trim().length < SEARCH_MIN_CHARS) {
      setIsSearchPending(false)
      return
    }

    setIsSearchPending(true)
    setSearchedQuery("")
    setFailedSearchQuery("")
    setSearchMatches([])
    setNextSearchCursor(null)
    setActiveSearchIndex(0)
    setPreviewSearchMatch(undefined)
    setSkippedSearchMessages(0)
    setScannedSearchMessages(0)
    const instanceId = props.instanceId
    const sessionId = props.sessionId
    const generation = ++searchGeneration
    const controller = new AbortController()
    let frame: number | undefined
    const isCurrentSearch = () => generation === searchGeneration
      && isActive()
      && isSearchOpen()
      && props.instanceId === instanceId
      && props.sessionId === sessionId
      && getOpenCodeInstanceGeneration(instanceId) === instanceGeneration
      && getOpenCodeMutationRevision(instanceId, sessionId) === mutationRevision
      && debouncedSearchQuery() === query
    const publish = (page: Awaited<ReturnType<typeof findHistoryMatches>>, settled: boolean) => {
      if (!isCurrentSearch()) return
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!isCurrentSearch()) return
        batch(() => {
          // Progress only appends hits within this page. Preserve row identities
          // so Solid keeps existing result buttons and their keyboard focus.
          setSearchMatches(previous => page.hits.filter(hit => hit.role !== "system" || systemVisibility !== "hidden").map((hit, index) => previous[index] ?? ({
            id: `${hit.sessionID}:${hit.messageID}:${hit.partIndex}`,
            sessionId: hit.sessionID, messageId: hit.messageID, partType: hit.kind,
            role: hit.role === "user" ? "user" : "assistant", start: 0, end: query.length,
            occurrence: 0, preview: hit.excerpt,
          })))
          setNextSearchCursor(page.cursor)
          setSkippedSearchMessages(page.skipped)
          setScannedSearchMessages(page.scanned)
          setSearchedQuery(query)
          setIsSearchPending(!settled)
        })
      })
    }
    void findHistoryMatches(instanceId, {
      sessionID: workspace ? undefined : sessionId, query, purpose: "search", includeTechnical: technical, cursor,
    }, controller.signal, page => publish(page, false)).then(page => publish(page, true)).catch((error) => {
      if (!isCurrentSearch()) return
      if (frame !== undefined) cancelAnimationFrame(frame)
      setIsSearchPending(false)
      setFailedSearchQuery(query)
      log.error("Failed to query message history", { instanceId, sessionId, error })
    })
    onCleanup(() => {
      controller.abort()
      if (generation === searchGeneration) searchGeneration += 1
      if (frame !== undefined) cancelAnimationFrame(frame)
    })
  })

  createEffect(() => {
    const count = currentSearchMatches().length
    if (count === 0) {
      if (activeSearchIndex() !== 0) setActiveSearchIndex(0)
      return
    }
    if (activeSearchIndex() >= count) {
      setActiveSearchIndex(count - 1)
    }
  })

  // Locates a newly active resident match. Residency is untracked: paging a
  // non-resident match in positions it once its page commits. `locate` never
  // awaits, so the match checked resident here is still resident when placed.
  createEffect(() => {
    const match = activeSearchMatch()
    if (!match || !isSearchOpen() || match.sessionId !== props.sessionId || !untrack(messageIds).includes(match.messageId)) return
    const locatorAuthority = searchLocatorAuthority.claim(match.id)
    if (!locatorAuthority) return
    const locate = async () => {
      const endTraversal = beginMessageHistoryTraversal(props.instanceId, props.sessionId)
      try {
      if (searchLocatorAuthority.isCurrent(locatorAuthority) && activeSearchMatch()?.id === match.id) {
        placeResidentMessage(match.messageId, match.id)
      }
      } finally {
        endTraversal()
        searchLocatorAuthority.reset(locatorAuthority)
      }
    }
    void untrack(locate).catch((error) => {
      if (activeSearchMatch()?.id === match.id) log.error("Failed to locate message search result", { instanceId: props.instanceId, sessionId: props.sessionId, error })
    })
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
      if (event.defaultPrevented) return
      if (matchesHotkey("session-search", event) && isActive()) {
        const modalOpen = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
        if (!modalOpen) {
          event.preventDefault()
          event.stopPropagation()
          openSearch()
          return
        }
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

  createEffect(() => {
    if (typeof document === "undefined") return
    // Capture: the stream reads arrow keys as a scroll gesture, which would
    // supersede the jump it is about to receive.
    const handleJumpKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isActive()) return
      const direction = matchesHotkey("user-message-prev", event) ? "previous"
        : matchesHotkey("user-message-next", event) ? "next" : null
      if (!direction || !keyAllowsUserMessageJump(event)) return
      // An open composer picker moves its selection with every arrow key.
      if (document.querySelector('[role="dialog"][aria-modal="true"], [data-prompt-picker]')) return
      event.preventDefault()
      if (!event.repeat) jumpToUserMessage(direction)
    }
    const handleJumpRequest = (event: Event) => {
      const detail = (event as CustomEvent<JumpUserMessageDetail>).detail
      if (detail?.instanceId === props.instanceId && detail.sessionId === props.sessionId) jumpToUserMessage(detail.direction)
    }
    document.addEventListener("keydown", handleJumpKey, true)
    window.addEventListener(JUMP_USER_MESSAGE_EVENT, handleJumpRequest)
    onCleanup(() => {
      document.removeEventListener("keydown", handleJumpKey, true)
      window.removeEventListener(JUMP_USER_MESSAGE_EVENT, handleJumpRequest)
    })
  })

  createEffect(on(() => outline.entries().length > 0, (indexed) => {
    const direction = deferredUserMessageJump
    if (!indexed || !direction) return
    deferredUserMessageJump = null
    jumpToUserMessage(direction)
  }, { defer: true }))
  createEffect(() => { if (outline.error()) deferredUserMessageJump = null })

  onCleanup(() => {
    setIsSearchOpen(false)
    timelineSegmentCache.clear()
    clearQuoteSelection()
  })

  const showTimeline = createMemo(() => showMessageTimelinePreference() && hasTimelineSegments())

  createEffect(on(isSearchOpen, open => { if (!open) closeSearch() }, { defer: true }))
  createEffect(() => { if (!isActive()) setIsSearchOpen(false) })

  return (
    <div
      class="message-stream-container"
      data-instance-id={props.instanceId}
      data-session-id={props.sessionId}
      data-stream-active={isActive() ? "true" : "false"}
    >
      <SessionCleanupProgress instanceId={props.instanceId} sessionId={props.sessionId} />
      <Show when={navigationPending()}>
        <div class="history-navigation-status window-toolbar" role="status">
          <span>{t("history.navigation.loading")}</span>
          <button type="button" class="button-tertiary" onClick={() => cancelWindowNavigation()}>{t("alertDialog.actions.cancel")}</button>
        </div>
      </Show>
      <Show when={outline.error() && !navigationPending() && showMessageTimelinePreference()}>
        <div class="history-navigation-status window-toolbar" role="status">
          <span title={outline.error()}>{t("history.navigation.outlineUnavailable")}</span>
          <button type="button" class="button-tertiary" onClick={outline.refresh}>{t("messageSection.search.retry")}</button>
        </div>
      </Show>
      <div
        class={`message-layout${showTimeline() && !props.timelineMount ? " message-layout--with-timeline" : ""}`}
        data-scroll-buttons={scrollButtonsCount()}
      >
        <VirtualFollowList
          items={visibleMessageIds}
          getKey={(messageId) => messageId}
          getAnchorId={getMessageAnchorId}
          overscanPx={800}
          streamingActive={streamingActive}
          isActive={isActive}
          initialAutoScroll={() => isSnapshotAutoFollowing(store().getScrollSnapshot(props.sessionId, MESSAGE_SCROLL_CACHE_SCOPE))}
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
            scrollUnsettled = true
            scheduleReadingLineSegment()
          }}
          onScrollEnd={persistSettledScroll}
          onUserReachedTop={() => { void pageWindow("older", (api) => api.scrollToBottom({ immediate: true })) }}
          onScrollIntent={(direction) => {
            setRevealActiveToken(value => value + 1)
            claimSearchReveal()
            forgetUserMessageJump()
            // The reader now owns the position, and with it the active marker.
            releaseActiveSegment()
            // An opposite directional gesture supersedes pending history paging
            // before it can position; taps and the requesting gesture do not.
            const nav = navigation()
            // The reader then owns a visible list; before any row shows, the restore stays pending.
            if (nav.kind === "paging" && (nav.around || (direction && nav.gesture && direction !== nav.gesture))) cancelWindowNavigation(visibleMessageIds().length > 0)
          }}
          onUserReachedBottom={() => { void pageWindow("newer", (api) => api.scrollToTop({ immediate: true })) }}
          onJumpTop={() => { releaseActiveSegment(); void pageWindow("oldest", (api) => api.scrollToTop({ immediate: true })) }}
          onJumpBottom={() => { releaseActiveSegment(); void pageWindow("latest", (api) => api.scrollToBottom({ immediate: true })) }}
          onMouseUp={() => handleStreamMouseUp()}
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
          registerApi={registerListApi}
          registerState={(state) => setListState(state)}
          renderControls={() => (
            <div class="message-scroll-controls">
              <Show when={showFirstButton()}>
                <button
                  type="button"
                  class="message-scroll-button"
                  onClick={() => void pageWindow("oldest", (api) => api.scrollToTop({ immediate: true }))}
                  aria-label={t("messageSection.scroll.toFirstAriaLabel")}
                  title={t("messageSection.scroll.toFirstAriaLabel")}
                >
                  <ArrowUp class="message-scroll-icon w-4 h-4" aria-hidden="true" />
                </button>
              </Show>
              <Show when={showLatestButton()}>
                <button
                  type="button"
                  class="message-scroll-button"
                  onClick={() => void pageWindow("latest", (api) => api.scrollToBottom({ immediate: true }))}
                  aria-label={t("messageSection.scroll.toLatestAriaLabel")}
                  title={t("messageSection.scroll.toLatestAriaLabel")}
                >
                  <ArrowDown class="message-scroll-icon w-4 h-4" aria-hidden="true" />
                </button>
              </Show>
            </div>
          )}
          renderBeforeItems={() => (
            <>
              <PermissionReceipts instanceId={props.instanceId} sessionId={props.sessionId} active={isActive()} />
              <Show when={olderMessageLoadFailed()}>
                <div class="flex justify-center py-2">
                  <button
                    type="button"
                    class="button-tertiary"
                    onClick={() => {
                      setOlderMessageLoadFailed(false)
                      const retry = retryAnchorRestore
                      if (retry) retry()
                      else void pageWindow("older", (api) => api.scrollToBottom({ immediate: true }))
                    }}
                  >
                    {t("messageSection.loadError.reload")}
                  </button>
                </div>
              </Show>

              <Show when={!props.loading && !props.loadError && !props.hasMoreMessages && visibleMessageIds().length === 0}>
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
                      </li>
                      <li>{t("messageSection.empty.tips.askAboutCodebase")}</li>
                      <li>
                        {t("messageSection.empty.tips.attachFilesPrefix")} <code>@</code>
                      </li>
                    </ul>
                  </BrandedEmptyState>
                </Show>
              </Show>

              <Show when={Boolean(props.loading) && messageIds().length === 0}>
                <div class="loading-state">
                  <div class="spinner" />
                  <p>{t("messageSection.loading.messages")}</p>
                </div>
              </Show>

              <Show when={!props.loading && Boolean(props.loadError)}>
                <LoadErrorState
                  title={t("messageSection.loadError.title")}
                  error={props.loadError!}
                  retryLabel={t("messageSection.loadError.reload")}
                  onRetry={() => retryAnchorRestore ? retryAnchorRestore() : props.onReloadMessages?.()}
                />
              </Show>
            </>
          )}
          renderItem={(messageId, index) => (
            <>
            <MessageBlock
              messageId={messageId}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              isActive={isActive}
              store={store}
              messageIndex={index()}
              showThinking={() => preferences().showThinkingBlocks}
              systemMessagesVisibility={() => preferences().systemMessagesVisibility}
              thinkingDefaultExpanded={() => resolveThinkingExpansionDefault(preferences())}
              usageMetricsVisibility={usageMetricsVisibility}
              toolVisibility={(toolName) => resolveToolVisibility(preferences(), toolName)}
              onRevert={props.onRevert}
              onFork={props.onFork}
              pendingPrompt={props.pendingPrompts?.get(messageId)}
              pendingPromptBusy={props.pendingPromptBusy}
              onPendingPromptDeliveryChange={props.onPendingPromptDeliveryChange}
              onPendingPromptEdit={props.onPendingPromptEdit}
              onPendingPromptRemove={props.onPendingPromptRemove}
              onContentRendered={handleContentRendered}
              searchQuery={authoritativeSearchQuery}
              searchResultMessageIds={searchResultMessageIds}
              activeSearchMatch={activeSearchMatch}
              searchReveal={searchReveal}
              pendingFormToolTargets={pendingFormToolTargets}
              technicalGroupForPart={technicalGroupForPart}
              technicalGroupingSignature={() => technicalGroupingSignature(messageId)}
              technicalCleanupParts={technicalCleanupParts}
              technicalCleanupPartKeys={technicalCleanupPartKeys}
              onTechnicalCleanupHoverChange={handleTechnicalCleanupHoverChange}
              isTechnicalGroupExpanded={isTechnicalGroupExpanded}
              setTechnicalGroupExpanded={setTechnicalGroupExpanded}
              alignInTranscript={(target, viewportOffset) => listApi()?.alignElement(target, viewportOffset)}
            />
            <PermissionReceipts instanceId={props.instanceId} sessionId={props.sessionId} messageId={messageId} active={isActive()} />
            </>
          )}
          renderOverlay={() => (
            <>
            <DismissibleWindow
                id={sessionSearchWindowId(props.instanceId, props.sessionId)}
                open={isSearchOpen()}
                onClose={closeSearch}
                title={t("messageSection.search.ariaLabel")}
                class="message-search-popover"
              draggable
              inline
              initialFocus={() => searchInputRef}
              >
                <div role="search" aria-label={t("messageSection.search.ariaLabel")}>
                  <div class="window-toolbar history-search-toolbar" data-window-drag-handle>
                    <div class="history-search-options">
                    <select class="selector-input history-search-scope" aria-label={t("history.scope")} value={searchWorkspace() ? "workspace" : "session"}
                      onChange={event => batch(() => { setSearchPageCursor(undefined); setSearchWorkspace(event.currentTarget.value === "workspace") })}>
                      <option value="session">{t("history.session")}</option>
                      <option value="workspace">{t("history.workspace")}</option>
                    </select>
                    <label><input type="checkbox" checked={includeTechnical()} onChange={event => batch(() => {
                      setSearchPageCursor(undefined); setIncludeTechnical(event.currentTarget.checked)
                    })} /> {t("history.technical")}</label>
                    </div>
                    <WindowCloseButton onClose={closeSearch} label={t("messageSection.search.closeAriaLabel")} />
                  </div>
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
                          setSearchedQuery("")
                          setFailedSearchQuery("")
                          updateSearchQuery(event.currentTarget.value)
                        }}
                        onKeyDown={(event) => {
                          if (event.defaultPrevented || !isActive()) return
                          const previous = matchesHotkey("search-prev-result", event)
                          if (previous || matchesHotkey("search-next-result", event)) {
                            event.preventDefault()
                            moveSearchMatch(previous ? -1 : 1)
                            return
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
                          : searchFailed()
                            ? t("messageSection.search.failed")
                          : currentSearchMatches().length === 0
                            ? t("messageSection.search.count.none")
                            : t("messageSection.search.count.matches", {
                                current: String(activeSearchIndex() + 1),
                                total: String(currentSearchMatches().length),
                              })}
                      </span>
                      <button
                        type="button"
                        class="message-search-button"
                        onClick={() => moveSearchMatch(-1)}
                        disabled={currentSearchMatches().length === 0}
                        aria-label={t("messageSection.search.previousAriaLabel")}
                        title={withHotkey(t("messageSection.search.previousAriaLabel"), "search-prev-result")}
                      >
                        <ChevronUp class="w-4 h-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        class="message-search-button"
                        onClick={() => moveSearchMatch(1)}
                        disabled={currentSearchMatches().length === 0}
                        aria-label={t("messageSection.search.nextAriaLabel")}
                        title={withHotkey(t("messageSection.search.nextAriaLabel"), "search-next-result")}
                      >
                        <ChevronDown class="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <Show when={trimmedSearchQuery().length >= SEARCH_MIN_CHARS && isSearchPending()}>
                    <div class="modal-empty-state message-search-empty">{t("messageSection.search.searching")}</div>
                  </Show>
                  <Show when={hasMessageSearchAuthority(searchQuery(), searchedQuery())}>
                    <div class="history-statistics" role="status">
                      {t("history.searchProgress", { matches: currentSearchMatches().length, messages: scannedSearchMessages() })}
                    </div>
                  </Show>
                  <Show when={searchFailed()}>
                    <div class="modal-empty-state message-search-empty">
                      <span>{t("messageSection.search.failed")}</span>
                      <button
                        type="button"
                        class="button-tertiary"
                        onClick={() => setSearchRetryGeneration((generation) => generation + 1)}
                      >
                        {t("messageSection.search.retry")}
                      </button>
                    </div>
                  </Show>
                  <HistorySearchResults instanceId={props.instanceId} matches={currentSearchMatches()} activeIndex={activeSearchIndex()}
                    showSessions={searchWorkspace()} onSelect={selectSearchMatch} />
                  <Show when={skippedSearchMessages()}><div class="history-statistics" role="status">
                    {t("history.skipped", { count: skippedSearchMessages() })}
                  </div></Show>
                  <Show when={previewSearchMatch()}>{match => <HistoryMessagePreview instanceId={props.instanceId}
                    sessionId={match().sessionId} messageId={match().messageId} />}</Show>
                  <Show when={nextSearchCursor()}>
                    <button type="button" class="button-tertiary" disabled={isSearchPending()}
                      onClick={() => setSearchPageCursor(nextSearchCursor() ?? undefined)}>{t("history.more")}</button>
                  </Show>
                  <Show when={isSearchSettled() && currentSearchMatches().length === 0}>
                    <div class="modal-empty-state message-search-empty">{t("messageSection.search.noVisibleMatches")}</div>
                  </Show>
                </div>
              </DismissibleWindow>

              <Show when={Boolean(quoteSelection())}>
                <div class="message-quote-popover" style={{ top: `${quoteSelection()!.top}px`, left: `${quoteSelection()!.left}px` }}>
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
              </Show>
            </>
          )}
        />

        <Show when={showTimeline()}>
          <TimelinePlacement mount={props.timelineMount}>
          <div class="message-timeline-sidebar">
            <MessageTimeline
              isActive={isActive()}
              segments={timelineSegments()}
              onSegmentClick={handleTimelineSegmentClick}
              activeSegmentId={activeSegmentId()}
              revealActiveToken={revealActiveToken()}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              isSegmentHidden={isTimelineSegmentHidden}
              searchMatchedSegmentIds={searchMatchedTimelineSegmentIds}
              activeSearchSegmentId={activeSearchTimelineSegmentId}
            />
          </div>
          </TimelinePlacement>
        </Show>
      </div>
    </div>
  )
}
