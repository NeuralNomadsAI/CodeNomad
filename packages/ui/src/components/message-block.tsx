import { For, Index, Match, Show, Suspense, Switch, createEffect, createMemo, createSignal, lazy, onCleanup, untrack, type Accessor } from "solid-js"
import { ChevronRight, Copy, ExternalLink, FoldVertical, Layers3, Loader2, Trash2, XCircle } from "lucide-solid"
import MessageItem from "./message-item"
import type { SessionInboxUser } from "@opencode-ai/client"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { ClientPart, Message, MessageInfo, TextPart } from "../types/message"
import { isHiddenSyntheticTextPart, partHasRenderableText } from "../types/message"
import { buildRecordDisplayData, clearRecordDisplayCacheForInstance } from "../stores/message-v2/record-display-cache"
import type { MessageRecord } from "../stores/message-v2/types"
import { messageStoreBus } from "../stores/message-v2/bus"
import { formatTokenTotal } from "../lib/formatters"
import { ensureSessionAncestorsExpanded, sessions, setActiveSessionFromList } from "../stores/sessions"
import { selectInstanceTab } from "../stores/app-tabs"
import { useI18n, type I18nContextValue } from "../lib/i18n"
import { useSpeech } from "../lib/hooks/use-speech"
import { createFollowScroll } from "../lib/follow-scroll"
import { formatElapsedClock, inferReasoningDurationMs } from "../lib/message-timing"
import type { SessionSearchMatch } from "../lib/session-search"
import type { ActionOverflowMenuItem } from "./action-overflow-menu"
import { copyToClipboard } from "../lib/clipboard"
import SpeechActionButton from "./speech-action-button"
import type { VisibilityPreference } from "../stores/preferences"
import type { ToolState, ToolStateCompleted, ToolStateError, ToolStateRunning } from "../types/tool-state"
import {
  clearInstanceMessageRenderCaches,
  clearSessionMessageRenderCache,
  getSessionMessageRenderCache,
  peekSessionMessageRenderCache,
  purgeMessageRenderCache,
  extractReasoningTextForCopy,
} from "../lib/message-render-cache"
import { accountSessionTranscript } from "../stores/session-transcript-memory"
import { parseReasoningSummary } from "../lib/reasoning-summary"
import { getFormQueue } from "../stores/forms"
import { backgroundSession, deleteMessagePart, deleteTechnicalPartGroup } from "../stores/session-actions"
import { showAlertDialog } from "../stores/alerts"
import { resolveFormToolTarget } from "./form-request-tool-target"
import { Markdown } from "./markdown"
import { useTheme } from "../lib/theme"
import { groupTechnicalParts, isTechnicalGroupingVisiblePart, isVisibleStepFinish, segmentExplorationItems, technicalPartKey, type TechnicalCleanupPart, type TranscriptTechnicalGroup } from "../lib/message-part-grouping"

const USER_BORDER_COLOR = "var(--message-user-border)"
const ASSISTANT_BORDER_COLOR = "var(--message-assistant-border)"
const NO_STEP_BORDER = "none"
const BACKGROUNDABLE_TOOLS = new Set(["bash", "shell", "task", "subagent"])

const LazyToolCall = lazy(() => import("./tool-call"))

function ToolCallFallback() {
  return <div class="tool-call tool-call-loading" />
}

type ToolCallPart = Extract<ClientPart, { type: "tool" }>


function isToolStateRunning(state: ToolState | undefined): state is ToolStateRunning {
  return Boolean(state && state.status === "running")
}

function isToolStateCompleted(state: ToolState | undefined): state is ToolStateCompleted {
  return Boolean(state && state.status === "completed")
}

function isToolStateError(state: ToolState | undefined): state is ToolStateError {
  return Boolean(state && state.status === "error")
}

function isBackgroundableTool(part: ToolCallPart | undefined) {
  return Boolean(part && BACKGROUNDABLE_TOOLS.has(part.tool.toLowerCase()) && isToolStateRunning(part.state))
}

async function moveRunningWorkToBackground(instanceId: string, sessionId: string, t: I18nContextValue["t"]) {
  try {
    await backgroundSession(instanceId, sessionId)
  } catch {
    showAlertDialog(t("promptInput.background.error.message"), {
      title: t("promptInput.background.error.title"),
      variant: "error",
    })
  }
}

function extractTaskSessionId(state: ToolState | undefined): string {
  if (!state) return ""
  const metadata = (state as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}
  const directId = metadata?.sessionId ?? metadata?.sessionID
  return typeof directId === "string" ? directId : ""
}

interface TaskSessionLocation {
  sessionId: string
  instanceId: string
  parentId: string | null
}

function findTaskSessionLocation(sessionId: string, preferredInstanceId?: string): TaskSessionLocation | null {
  if (!sessionId) return null

  if (preferredInstanceId) {
    const session = sessions().get(preferredInstanceId)?.get(sessionId)
    if (session) {
      return {
        sessionId: session.id,
        instanceId: preferredInstanceId,
        parentId: session.parentId ?? null,
      }
    }
  }

  const allSessions = sessions()
  for (const [instanceId, sessionMap] of allSessions) {
    const session = sessionMap?.get(sessionId)
    if (session) {
      return {
        sessionId: session.id,
        instanceId,
        parentId: session.parentId ?? null,
      }
    }
  }
  return null
}

function navigateToTaskSession(location: TaskSessionLocation) {
  selectInstanceTab(location.instanceId)
  ensureSessionAncestorsExpanded(location.instanceId, location.sessionId)
  setActiveSessionFromList(location.instanceId, location.sessionId)
}

interface CachedBlockEntry {
  signature: string
  block: MessageDisplayBlock
  contentKeys: string[]
  toolKeys: string[]
}

export function clearSessionRenderCache(instanceId: string, sessionId: string) {
  clearSessionMessageRenderCache(instanceId, sessionId)
}

function clearMessageRenderCache(instanceId: string, sessionId: string, messageIds: readonly string[]) {
  const cache = peekSessionMessageRenderCache(instanceId, sessionId)
  if (!cache) return
  purgeMessageRenderCache(cache, messageIds)
  if (cache.messageBlocks.size === 0 && cache.messageItems.size === 0 && cache.toolItems.size === 0) {
    clearSessionMessageRenderCache(instanceId, sessionId)
  }
}

function clearInstanceCaches(instanceId: string) {
  clearRecordDisplayCacheForInstance(instanceId)
  clearInstanceMessageRenderCaches(instanceId)
}

messageStoreBus.onInstanceDestroyed(clearInstanceCaches)
messageStoreBus.onSessionCleared(clearSessionRenderCache)
messageStoreBus.onMessagesRemoved(clearMessageRenderCache)

function removeSearchMarks(root: HTMLElement) {
  const marks = Array.from(root.querySelectorAll("mark.session-search-match"))
  for (const mark of marks) {
    const parent = mark.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark)
    parent.normalize()
  }
}

function getPartIdForSearchContainer(container: HTMLElement): string | undefined {
  const target = container.closest<HTMLElement>("[data-part-id]") ?? container
  const id = target.dataset.partId
  return id && id.length > 0 ? id : undefined
}

function applySearchMarks(root: HTMLElement, query: string, activeMatch?: SessionSearchMatch | null, scrollActive = false) {
  removeSearchMarks(root)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return

  const containers = Array.from(root.querySelectorAll<HTMLElement>(".message-text, .tool-call, .message-reasoning-text"))
  let occurrenceInActivePart = 0
  let activeMark: HTMLElement | null = null

  for (const container of containers) {
    const containerPartId = getPartIdForSearchContainer(container)
    const canContainActiveMatch = Boolean(activeMatch) && (!activeMatch?.partId || activeMatch.partId === containerPartId)
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        if (parent.closest("button, input, textarea, select, mark.session-search-match")) return NodeFilter.FILTER_REJECT
        if (!node.nodeValue || !node.nodeValue.toLocaleLowerCase().includes(normalizedQuery)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })

    const textNodes: Text[] = []
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode as Text)
    }

    for (const textNode of textNodes) {
      const original = textNode.nodeValue ?? ""
      const lower = original.toLocaleLowerCase()
      const fragment = document.createDocumentFragment()
      let cursor = 0
      while (cursor < original.length) {
        const index = lower.indexOf(normalizedQuery, cursor)
        if (index === -1) break
        if (index > cursor) {
          fragment.appendChild(document.createTextNode(original.slice(cursor, index)))
        }
        const mark = document.createElement("mark")
        const isActive = Boolean(canContainActiveMatch && activeMatch && occurrenceInActivePart === activeMatch.occurrence)
        mark.className = isActive ? "session-search-match session-search-match-active" : "session-search-match"
        mark.textContent = original.slice(index, index + normalizedQuery.length)
        fragment.appendChild(mark)
        if (canContainActiveMatch) {
          if (isActive) activeMark = mark
          occurrenceInActivePart += 1
        }
        cursor = index + normalizedQuery.length
      }
      if (cursor < original.length) {
        fragment.appendChild(document.createTextNode(original.slice(cursor)))
      }
      textNode.parentNode?.replaceChild(fragment, textNode)
    }
  }

  if (activeMark && scrollActive) {
    requestAnimationFrame(() => activeMark?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }))
  }
}

interface ContentDisplayItem {
  type: "content"
  key: string
  messageId: string
  startPartId: string
  partIds: string[]
}

interface ToolDisplayItem {
  type: "tool"
  key: string
  messageId: string
  partId: string
}

interface MessageContentItemProps {
  instanceId: string
  sessionId: string
  store: () => InstanceMessageStore
  messageId: string
  startPartId: string
  partIds: string[]
  messageIndex: number
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  pendingPrompt?: SessionInboxUser
  pendingPromptBusy?: boolean
  onPendingPromptDeliveryChange?: (item: SessionInboxUser) => void
  onPendingPromptEdit?: (item: SessionInboxUser) => void
  onPendingPromptRemove?: (item: SessionInboxUser) => void
  technicalCleanupParts: () => TechnicalCleanupPart[]
  onTechnicalCleanupHoverChange?: (hovered: boolean) => void
  onContentRendered?: () => void
}

function isSupportedPartType(part: unknown): boolean {
  const type = (part as any)?.type
  // Ignore part types the UI does not support rendering yet.
  return !(typeof type === "string" && type === "patch")
}

function isContentPartType(type: unknown): boolean {
  return type === "text" || type === "file"
}

function isVisibleContentPart(part: ClientPart): boolean {
  if (!part || !isContentPartType((part as any).type)) return false
  if (isHiddenSyntheticTextPart(part)) return false
  return partHasRenderableText(part)
}

function MessageContentItem(props: MessageContentItemProps) {
  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))

  const parts = createMemo<ClientPart[]>(() => {
    const current = record()
    if (!current) return []
    const resolved: ClientPart[] = []
    for (const partId of props.partIds) {
      const part = current.parts[partId]?.data
      if (!part) continue
      if (!isSupportedPartType(part)) continue
      if (!isContentPartType((part as any).type)) continue
      resolved.push(part)
    }

    return resolved
  })

  const visibleParts = createMemo(() => parts().filter((part) => isVisibleContentPart(part)))

  const isFinalAssistantTextBlock = createMemo(() => {
    const current = record()
    if (current?.role !== "assistant") return false
    const lastTextPartId = [...current.partIds].reverse().find((partId) => {
      const part = current.parts[partId]?.data
      return part?.type === "text" && isVisibleContentPart(part)
    })
    return Boolean(lastTextPartId && visibleParts().some((part) => part.id === lastTextPartId))
  })

  const showAgentMeta = createMemo(() => {
    const current = record()
    if (!current) return false
    if (current.role !== "assistant") return false

    const currentParts = parts()
    if (visibleParts().length === 0) {
      return false
    }

    const ids = current.partIds
    const startIndex = ids.indexOf(props.startPartId)
    if (startIndex === -1) return false

    // Only show agent meta on the first content segment that contains renderable content.
    for (let idx = 0; idx < startIndex; idx++) {
      const partId = ids[idx]
      const part = current.parts[partId]?.data
      if (!part) continue
      if (!isSupportedPartType(part)) continue

      if (!isContentPartType((part as any).type)) continue
        if (isVisibleContentPart(part)) {
          return false
        }
      }

    return true
  })

  return (
    <Show when={Boolean(record())}>
      <MessageItem
        record={record()!}
        messageInfo={messageInfo()}
        parts={visibleParts()}
        instanceId={props.instanceId}
        sessionId={props.sessionId}
        contentStartPartId={props.startPartId}
        showTechnicalCleanup={isFinalAssistantTextBlock()}
        showAgentMeta={showAgentMeta()}
        onRevert={props.onRevert}
        onFork={props.onFork}
        pendingPrompt={props.pendingPrompt}
        pendingPromptBusy={props.pendingPromptBusy}
        onPendingPromptDeliveryChange={props.onPendingPromptDeliveryChange}
        onPendingPromptEdit={props.onPendingPromptEdit}
        onPendingPromptRemove={props.onPendingPromptRemove}
        technicalCleanupParts={props.technicalCleanupParts}
        onTechnicalCleanupHoverChange={props.onTechnicalCleanupHoverChange}
        onContentRendered={props.onContentRendered}
      />
    </Show>
  )
}

interface ToolCallItemProps {
  instanceId: string
  sessionId: string
  store: () => InstanceMessageStore
  messageId: string
  partId: string
  onContentRendered?: () => void
}

function ToolCallItem(props: ToolCallItemProps) {
  const { t } = useI18n()
  const [deleting, setDeleting] = createSignal(false)
  const [deleteHovered, setDeleteHovered] = createSignal(false)

  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))
  const partEntry = createMemo(() => record()?.parts?.[props.partId])

  const toolPart = createMemo(() => {
    const part = partEntry()?.data as ClientPart | undefined
    if (!part || part.type !== "tool") return undefined
    return part as ToolCallPart
  })

  const toolState = createMemo(() => toolPart()?.state as ToolState | undefined)
  const messageVersion = createMemo(() => record()?.revision ?? 0)
  const partVersion = createMemo(() => partEntry()?.revision ?? 0)

  const taskSessionId = createMemo(() => {
    const state = toolState()
    if (!state) return ""
    if (!(isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state))) {
      return ""
    }
    return extractTaskSessionId(state)
  })

  const taskLocation = createMemo(() => {
    const id = taskSessionId()
    if (!id) return null
    return findTaskSessionLocation(id, props.instanceId)
  })

  const goToTaskSession = () => {
    const location = taskLocation()
    if (!location) return
    navigateToTaskSession(location)
  }

  const handleDelete = async () => {
    if (deleting() || (record()?.status !== "complete" && record()?.status !== "error")) return
    setDeleting(true)
    try {
      await deleteMessagePart(props.instanceId, props.sessionId, props.messageId, props.partId)
    } catch (error) {
      showAlertDialog(t("messagePart.actions.deleteFailedMessage"), {
        title: t("messagePart.actions.deleteFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setDeleting(false)
    }
  }

  const actionMenuItems = (): ActionOverflowMenuItem[] => {
    const items: ActionOverflowMenuItem[] = []

    if (taskSessionId()) {
      items.push({
        key: "go-to-session",
        label: t("messageBlock.tool.goToSession.label"),
        icon: <ExternalLink class="w-3.5 h-3.5" aria-hidden="true" />,
        disabled: !taskLocation(),
        onSelect: goToTaskSession,
      })
    }

    items.push({
      key: "delete-part",
      label: deleting() ? t("messagePart.actions.deleting") : t("messagePart.actions.delete"),
      icon: <Trash2 class="w-3.5 h-3.5" aria-hidden="true" />,
      disabled: deleting() || (record()?.status !== "complete" && record()?.status !== "error"),
      onMouseEnter: () => setDeleteHovered(true),
      onMouseLeave: () => setDeleteHovered(false),
      onSelect: handleDelete,
    })

    return items
  }

  return (
    <Show when={Boolean(toolPart())}>
      <div class="delete-hover-scope" data-delete-part-hover={deleteHovered() ? "true" : undefined}>
        <Suspense fallback={<ToolCallFallback />}>
          <LazyToolCall
            toolCall={toolPart()!}
            toolCallId={props.partId}
            messageId={props.messageId}
            messageVersion={messageVersion()}
            partVersion={partVersion()}
            instanceId={props.instanceId}
            sessionId={props.sessionId}
            onContentRendered={props.onContentRendered}
            headerAction={isBackgroundableTool(toolPart()) ? (
              <button
                type="button"
                class="tool-call-header-icon-button"
                onClick={(event) => {
                  event.stopPropagation()
                  void moveRunningWorkToBackground(props.instanceId, props.sessionId, t)
                }}
                aria-label={t("promptInput.background.title")}
                title={t("promptInput.background.title")}
              >
                <Layers3 class="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            ) : undefined}
            headerMenuItems={actionMenuItems}
          />
        </Suspense>
      </div>
    </Show>
  )
}

interface StepDisplayItem {
  type: "step-start" | "step-finish"
  key: string
  part: ClientPart
  messageInfo?: MessageInfo
  accentColor?: string
}

interface ReasoningDisplayPart {
  part: ClientPart
  messageInfo?: MessageInfo
  durationMs?: number
  messageId: string
  partId: string
}

type ReasoningDisplayItem = {
  type: "reasoning"
  key: string
  parts: ReasoningDisplayPart[]
  completed: boolean
  showAgentMeta?: boolean
  defaultExpanded: boolean
  technicalGroup?: TranscriptTechnicalGroup
}

type ExplorationDisplayItem = {
  type: "exploration"
  kind: "exploration" | "shell"
  key: string
  tools: ToolDisplayItem[]
  completed: boolean
  technicalGroup?: TranscriptTechnicalGroup
}

type CompactionDisplayItem = {
  type: "compaction"
  key: string
  part: ClientPart
  messageInfo?: MessageInfo
  accentColor?: string
  messageId: string
  partId: string
}

type MessageBlockItem = ContentDisplayItem | ToolDisplayItem | ExplorationDisplayItem | StepDisplayItem | ReasoningDisplayItem | CompactionDisplayItem

interface MessageDisplayBlock {
  messageId: string
  status: MessageRecord["status"]
  items: MessageBlockItem[]
  truncated: boolean
}

interface MessageBlockProps {
  messageId: string
  instanceId: string
  sessionId: string
  store: () => InstanceMessageStore
  messageIndex: number
  showThinking: () => boolean
  thinkingDefaultExpanded: () => boolean
  usageMetricsVisibility: () => VisibilityPreference
  toolVisibility: (toolName: string) => VisibilityPreference
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  pendingPrompt?: SessionInboxUser
  pendingPromptBusy?: boolean
  onPendingPromptDeliveryChange?: (item: SessionInboxUser) => void
  onPendingPromptEdit?: (item: SessionInboxUser) => void
  onPendingPromptRemove?: (item: SessionInboxUser) => void
  onContentRendered?: () => void
  searchQuery?: Accessor<string>
  searchResultMessageIds?: Accessor<Set<string>>
  activeSearchMatch?: Accessor<SessionSearchMatch | null>
  pendingFormToolTargets?: Accessor<ReadonlySet<string>>
  technicalGroupForPart?: (messageId: string, partId: string) => TranscriptTechnicalGroup | undefined
  technicalGroupingSignature?: Accessor<string>
  technicalCleanupParts?: (messageId: string, partId: string) => TechnicalCleanupPart[]
  technicalCleanupPartKeys?: Accessor<ReadonlySet<string>>
  onTechnicalCleanupHoverChange?: (messageId: string, partId: string, hovered: boolean) => void
  isTechnicalGroupExpanded?: (groupId: string, defaultExpanded: boolean) => boolean
  setTechnicalGroupExpanded?: (groupId: string, expanded: boolean) => void
}

export default function MessageBlock(props: MessageBlockProps) {
  const { t } = useI18n()
  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))
  const sessionCache = getSessionMessageRenderCache(props.instanceId, props.sessionId) as {
    messageItems: Map<string, ContentDisplayItem>
    toolItems: Map<string, ToolDisplayItem>
    messageBlocks: Map<string, CachedBlockEntry>
  }
  const [blockRef, setBlockRef] = createSignal<HTMLDivElement>()
  const isSearchResult = () => Boolean(props.searchResultMessageIds?.().has(props.messageId))
  const activeSearchMatch = () => props.activeSearchMatch?.() ?? null
  const isActiveSearchResult = () => activeSearchMatch()?.messageId === props.messageId
  const localPendingFormToolTargets = createMemo(() => new Set(getFormQueue(props.instanceId)
    .filter((form) => form.sessionID === props.sessionId)
    .flatMap((form) => {
      const target = resolveFormToolTarget(form, props.store())
      return target ? [technicalPartKey(target.messageId, target.partId)] : []
    })))
  const pendingFormToolTargets = () => props.pendingFormToolTargets?.() ?? localPendingFormToolTargets()
  const technicalCleanupPartKeys = () => props.technicalCleanupPartKeys?.() ?? new Set<string>()
  let lastInlineScrolledSearchMatchId: string | null = null
  const handleContentRendered = () => {
    props.onContentRendered?.()
    accountSessionTranscript(props.instanceId, props.sessionId)
  }

  onCleanup(() => accountSessionTranscript(props.instanceId, props.sessionId))

  createEffect(() => {
    const query = props.searchQuery?.() ?? ""
    const active = activeSearchMatch()
    const relevantActiveMatch = active?.messageId === props.messageId ? active : null
    const shouldScrollActive = Boolean(relevantActiveMatch && relevantActiveMatch.id !== lastInlineScrolledSearchMatchId)
    const current = record()
    if (current) void current.revision
    const element = blockRef()
    if (!element) return
    if (shouldScrollActive && relevantActiveMatch) lastInlineScrolledSearchMatchId = relevantActiveMatch.id

    const frame = requestAnimationFrame(() => applySearchMarks(element, query, relevantActiveMatch, shouldScrollActive))
    onCleanup(() => {
      cancelAnimationFrame(frame)
      removeSearchMarks(element)
    })
  })

  const block = createMemo<MessageDisplayBlock | null>(() => {
    const current = record()
    if (!current) return null

    const messageInfoVersion = props.store().state.messageInfoVersion[current.id] ?? 0

    const cacheSignature = [
      current.id,
      current.revision,
      messageInfoVersion,
      props.showThinking() ? 1 : 0,
      props.thinkingDefaultExpanded() ? 1 : 0,
      props.usageMetricsVisibility(),
      props.technicalGroupingSignature?.() ?? "",
    ].join("|")

    const cachedBlock = sessionCache.messageBlocks.get(current.id)
    if (cachedBlock && cachedBlock.signature === cacheSignature) {
      return cachedBlock.block
    }

    // Only capture info after cache check fails - ensures fresh data on version bump
    const info = untrack(messageInfo)

    const displayData = buildRecordDisplayData(props.instanceId, current)
    const { orderedParts } = displayData
    const items: MessageBlockItem[] = []
    const blockContentKeys: string[] = []
    const blockToolKeys: string[] = []
    let pendingParts: ClientPart[] = []
    let agentMetaAttached = current.role !== "assistant"
    const defaultAccentColor = current.role === "user" ? USER_BORDER_COLOR : ASSISTANT_BORDER_COLOR
    let lastAccentColor = defaultAccentColor

    const flushContent = () => {
      if (pendingParts.length === 0) return
      const startPartId = typeof (pendingParts[0] as any)?.id === "string" ? ((pendingParts[0] as any).id as string) : ""
      if (!startPartId) {
        pendingParts = []
        return
      }

      if (!agentMetaAttached && pendingParts.some((part) => partHasRenderableText(part))) {
        agentMetaAttached = true
      }

      const segmentKey = `${current.id}:content:${startPartId}`
      let cached = sessionCache.messageItems.get(segmentKey)
      if (!cached) {
        cached = {
          type: "content",
          key: segmentKey,
          messageId: current.id,
          startPartId,
          partIds: pendingParts.flatMap((part) => typeof part.id === "string" ? [part.id] : []),
        }
        sessionCache.messageItems.set(segmentKey, cached)
      } else {
        cached.partIds = pendingParts.flatMap((part) => typeof part.id === "string" ? [part.id] : [])
      }

      items.push(cached)
      blockContentKeys.push(segmentKey)
      lastAccentColor = defaultAccentColor
      pendingParts = []
    }

    const toolItem = (part: ToolCallPart) => {
      const partId = part.id
      if (!partId) return
      const key = `${current.id}:${partId}`
      let item = sessionCache.toolItems.get(key)
      if (!item) {
        item = { type: "tool", key, messageId: current.id, partId }
        sessionCache.toolItems.set(key, item)
      }
      blockToolKeys.push(key)
      return item
    }

    const displayParts = orderedParts.filter((part) => {
      if (part.type === "step-finish") {
        return isVisibleStepFinish(part, info, props.usageMetricsVisibility() !== "hidden")
      }
      if (!isTechnicalGroupingVisiblePart(part)) return false
      if (part.type !== "tool" || !props.technicalGroupForPart || props.toolVisibility(part.tool) !== "hidden") return true
      return Boolean(
        part.pendingPermission?.active
        || (part.id && props.store().getPermissionState(current.id, part.id)?.active)
        || (part.id && pendingFormToolTargets().has(technicalPartKey(current.id, part.id)))
      )
    })
    const groupedParts = groupTechnicalParts(displayParts, (part) => {
      const partId = typeof part.id === "string" ? part.id : ""
      return partId ? props.technicalGroupForPart?.(current.id, partId)?.id : undefined
    })

    groupedParts.forEach((group, groupIndex) => {
      if (group.kind === "exploration" || group.kind === "shell") {
        flushContent()
        const tools = group.parts.flatMap((part) => {
          const item = toolItem(part as ToolCallPart)
          return item ? [item] : []
        })
        if (tools.length > 0) {
          const technicalGroup = group.groupId ? props.technicalGroupForPart?.(current.id, tools[0].partId) : undefined
          items.push({
            type: "exploration",
            kind: group.kind,
            key: `${tools[0].key}:${group.kind}`,
            tools,
            completed: technicalGroup?.completed ?? (groupIndex < groupedParts.length - 1 || current.status === "complete" || current.status === "error"),
            technicalGroup,
          })
        }
        lastAccentColor = NO_STEP_BORDER
        return
      }

      if (group.kind === "reasoning") {
        flushContent()
        if (props.showThinking()) {
          const reasoningParts = group.parts.flatMap((part) => {
            const partId = part.id ?? ""
            return partId ? [{
              part,
              messageInfo: info,
              durationMs: inferReasoningDurationMs(orderedParts, part, info, current.status),
              messageId: current.id,
              partId,
            }] : []
          })
          if (reasoningParts.length > 0) {
            const technicalGroup = group.groupId ? props.technicalGroupForPart?.(current.id, reasoningParts[0].partId) : undefined
            const showAgentMeta = current.role === "assistant" && !agentMetaAttached
            if (showAgentMeta) agentMetaAttached = true
            items.push({
              type: "reasoning",
              key: `${current.id}:${reasoningParts[0].partId}:reasoning`,
              parts: reasoningParts,
              completed: technicalGroup?.completed ?? (groupIndex < groupedParts.length - 1 || current.status === "complete" || current.status === "error"),
              showAgentMeta,
              defaultExpanded: props.thinkingDefaultExpanded(),
              technicalGroup,
            })
            lastAccentColor = ASSISTANT_BORDER_COLOR
          }
        }
        return
      }

      const part = group.part
      const partIndex = orderedParts.indexOf(part)
      if (part.type === "tool") {
        flushContent()
        const item = toolItem(part as ToolCallPart)
        if (item) items.push(item)
        lastAccentColor = NO_STEP_BORDER
        return
      }

      if (part.type === "compaction") {
        flushContent()
        const partId = part.id ?? ""
        const key = `${current.id}:${partId || partIndex}:compaction`
        items.push({
          type: "compaction",
          key,
          part,
          messageInfo: info,
          accentColor: "var(--session-status-compacting-fg)",
          messageId: current.id,
          partId,
        })
        lastAccentColor = "var(--session-status-compacting-fg)"
        return
      }

      if (part.type === "step-start") {
        flushContent()
        return
      }

      if (part.type === "step-finish") {
        flushContent()
        if (props.usageMetricsVisibility() !== "hidden") {
          const key = `${current.id}:${part.id ?? partIndex}:${part.type}`
          const accentColor = lastAccentColor || defaultAccentColor
          items.push({ type: part.type, key, part, messageInfo: info, accentColor })
          lastAccentColor = accentColor
        }
        return
      }

      pendingParts.push(part)
    })

    flushContent()

    const resultBlock: MessageDisplayBlock = { messageId: current.id, status: current.status, items, truncated: displayData.truncated }
    sessionCache.messageBlocks.set(current.id, {
      signature: cacheSignature,
      block: resultBlock,
      contentKeys: blockContentKeys.slice(),
      toolKeys: blockToolKeys.slice(),
    })
    accountSessionTranscript(props.instanceId, props.sessionId)

    const messagePrefix = `${current.id}:`
    for (const [key] of sessionCache.messageItems) {
      if (key.startsWith(messagePrefix) && !blockContentKeys.includes(key)) {
        sessionCache.messageItems.delete(key)
      }
    }
    for (const [key] of sessionCache.toolItems) {
      if (key.startsWith(messagePrefix) && !blockToolKeys.includes(key)) {
        sessionCache.toolItems.delete(key)
      }
    }

    return resultBlock
  })

  const isToolDisplayItemVisible = (item: ToolDisplayItem) => {
    const part = props.store().getMessage(item.messageId)?.parts[item.partId]?.data
    if (part?.type !== "tool" || props.toolVisibility(part.tool || "") !== "hidden") return true
    if (
      part.pendingPermission?.active ||
      props.store().getPermissionState(item.messageId, item.partId)?.active
    ) return true
    return pendingFormToolTargets().has(`${item.messageId}:${item.partId}`)
  }

  const technicalGroupStartsHere = (group: TranscriptTechnicalGroup | undefined) => !group || group.parts[0]?.messageId === props.messageId
  const technicalGroupTools = (group: TranscriptTechnicalGroup | undefined) => group?.parts.flatMap((item) => item.part.type === "tool"
    ? [{ type: "tool" as const, key: technicalPartKey(item.messageId, item.partId), messageId: item.messageId, partId: item.partId }]
    : []) ?? []
  const technicalGroupReasoning = (group: TranscriptTechnicalGroup | undefined) => group?.parts.flatMap((item) => {
    if (item.part.type !== "reasoning") return []
    const sourceRecord = props.store().getMessage(item.messageId)
    const sourceInfo = props.store().getMessageInfo(item.messageId)
    const orderedParts = sourceRecord ? buildRecordDisplayData(props.instanceId, sourceRecord).orderedParts : []
    return [{
      part: item.part,
      messageInfo: sourceInfo,
      durationMs: inferReasoningDurationMs(orderedParts, item.part, sourceInfo, sourceRecord?.status),
      messageId: item.messageId,
      partId: item.partId,
    }]
  }) ?? []

  const isDisplayItemVisible = (item: MessageBlockItem) => {
    if (item.type === "tool") return isToolDisplayItemVisible(item)
    if (item.type === "exploration") return (item.technicalGroup ? technicalGroupTools(item.technicalGroup) : item.tools).some(isToolDisplayItemVisible)
    return true
  }

  const visibleItemKeys = createMemo(() => new Set((block()?.items ?? [])
    .filter(isDisplayItemVisible)
    .map((item) => item.key)))
  return (
    <Show when={block()}>
      {(resolvedBlock) => (
        <Show when={resolvedBlock().truncated || resolvedBlock().items.some(isDisplayItemVisible)}>
          <div
            ref={(element) => {
              setBlockRef(element)
              onCleanup(() => setBlockRef(undefined))
            }}
            class="message-stream-block"
            data-message-id={resolvedBlock().messageId}
            data-search-result={isSearchResult() ? "true" : undefined}
            data-search-active={isActiveSearchResult() ? "true" : undefined}
          >
            <Index each={resolvedBlock().items}>
              {(item) => (
              <Switch>
                <Match when={item().type === "content"}>
                  <MessageContentItem
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    store={props.store}
                    messageId={(item() as ContentDisplayItem).messageId}
                    startPartId={(item() as ContentDisplayItem).startPartId}
                    partIds={(item() as ContentDisplayItem).partIds}
                    messageIndex={props.messageIndex}
                    onRevert={props.onRevert}
                    onFork={props.onFork}
                    pendingPrompt={props.pendingPrompt}
                    pendingPromptBusy={props.pendingPromptBusy}
                    onPendingPromptDeliveryChange={props.onPendingPromptDeliveryChange}
                    onPendingPromptEdit={props.onPendingPromptEdit}
                    onPendingPromptRemove={props.onPendingPromptRemove}
                    technicalCleanupParts={() => props.technicalCleanupParts?.(
                      (item() as ContentDisplayItem).messageId,
                      (item() as ContentDisplayItem).startPartId,
                    ) ?? []}
                    onTechnicalCleanupHoverChange={(hovered) => props.onTechnicalCleanupHoverChange?.(
                      (item() as ContentDisplayItem).messageId,
                      (item() as ContentDisplayItem).startPartId,
                      hovered,
                    )}
                    onContentRendered={handleContentRendered}
                  />
                </Match>
                <Match when={item().type === "tool"}>
                  <Show when={visibleItemKeys().has((item() as ToolDisplayItem).key)}>
                    <div
                      class="tool-call-message"
                      data-key={(item() as ToolDisplayItem).key}
                      data-part-id={(item() as ToolDisplayItem).partId}
                      data-delete-technical-selected={technicalCleanupPartKeys().has((item() as ToolDisplayItem).key) ? "true" : undefined}
                    >
                      <ToolCallItem
                        instanceId={props.instanceId}
                        sessionId={props.sessionId}
                        store={props.store}
                        messageId={(item() as ToolDisplayItem).messageId}
                        partId={(item() as ToolDisplayItem).partId}
                        onContentRendered={handleContentRendered}
                      />
                    </div>
                  </Show>
                </Match>
                <Match when={item().type === "exploration"}>
                  <Show when={visibleItemKeys().has((item() as ExplorationDisplayItem).key)}>
                    <ExplorationGroup
                      kind={(item() as ExplorationDisplayItem).kind}
                      tools={(item() as ExplorationDisplayItem).tools.filter(isToolDisplayItemVisible)}
                      summaryTools={(item() as ExplorationDisplayItem).technicalGroup
                        ? technicalGroupTools((item() as ExplorationDisplayItem).technicalGroup).filter(isToolDisplayItemVisible)
                        : undefined}
                      completed={(item() as ExplorationDisplayItem).completed}
                      instanceId={props.instanceId}
                      sessionId={props.sessionId}
                      store={props.store}
                      pendingFormToolTargets={pendingFormToolTargets()}
                      activePartId={activeSearchMatch()?.partId}
                      showHeader={technicalGroupStartsHere((item() as ExplorationDisplayItem).technicalGroup)}
                      expanded={(item() as ExplorationDisplayItem).technicalGroup
                        ? () => props.isTechnicalGroupExpanded?.((item() as ExplorationDisplayItem).technicalGroup!.id, false) ?? false
                        : undefined}
                      onExpandedChange={(item() as ExplorationDisplayItem).technicalGroup
                        ? (expanded) => props.setTechnicalGroupExpanded?.((item() as ExplorationDisplayItem).technicalGroup!.id, expanded)
                        : undefined}
                      technicalCleanupPartKeys={technicalCleanupPartKeys}
                      onContentRendered={handleContentRendered}
                    />
                  </Show>
                </Match>
                <Match when={item().type === "step-start"}>
                  <StepCard
                    kind="start"
                    part={(item() as StepDisplayItem).part}
                    messageInfo={(item() as StepDisplayItem).messageInfo}
                    showAgentMeta
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={props.messageId}
                  />
                </Match>
                <Match when={item().type === "step-finish"}>
                  <StepCard
                    kind="finish"
                    part={(item() as StepDisplayItem).part}
                    messageInfo={(item() as StepDisplayItem).messageInfo}
                    usageVisibility={props.usageMetricsVisibility()}
                    borderColor={(item() as StepDisplayItem).accentColor}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={props.messageId}
                    onContentRendered={handleContentRendered}
                  />
                </Match>
                <Match when={item().type === "compaction"}>
                  <CompactionCard
                    part={(item() as CompactionDisplayItem).part}
                    messageInfo={(item() as CompactionDisplayItem).messageInfo}
                    status={resolvedBlock().status}
                    borderColor={(item() as CompactionDisplayItem).accentColor}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={(item() as CompactionDisplayItem).messageId}
                    onContentRendered={handleContentRendered}
                  />
                </Match>
                <Match when={item().type === "reasoning"}>
                  <ReasoningGroupCard
                    parts={(item() as ReasoningDisplayItem).parts}
                    summaryParts={(item() as ReasoningDisplayItem).technicalGroup
                      ? technicalGroupReasoning((item() as ReasoningDisplayItem).technicalGroup)
                      : undefined}
                    completed={(item() as ReasoningDisplayItem).completed}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    status={resolvedBlock().status}
                    showAgentMeta={(item() as ReasoningDisplayItem).showAgentMeta}
                    defaultExpanded={(item() as ReasoningDisplayItem).defaultExpanded}
                    onContentRendered={handleContentRendered}
                    activePartId={activeSearchMatch()?.partId}
                    showHeader={technicalGroupStartsHere((item() as ReasoningDisplayItem).technicalGroup)}
                    expanded={(item() as ReasoningDisplayItem).technicalGroup
                      ? () => props.isTechnicalGroupExpanded?.(
                          (item() as ReasoningDisplayItem).technicalGroup!.id,
                          (item() as ReasoningDisplayItem).defaultExpanded,
                        ) ?? false
                      : undefined}
                    onExpandedChange={(item() as ReasoningDisplayItem).technicalGroup
                      ? (expanded) => props.setTechnicalGroupExpanded?.((item() as ReasoningDisplayItem).technicalGroup!.id, expanded)
                      : undefined}
                    technicalCleanupPartKeys={technicalCleanupPartKeys}
                  />
                </Match>
              </Switch>
              )}
            </Index>
            <Show when={resolvedBlock().truncated}>
              <div class="tool-call-diagnostic-message" role="status">
                <span>{t("toolCall.output.truncated")}</span>
                <button
                  type="button"
                  class="tool-call-header-icon-button tool-call-header-copy"
                  onClick={() => {
                    const current = props.store().getMessage(resolvedBlock().messageId)
                    if (current) void copyToClipboard(JSON.stringify(orderedMessageParts(current), null, 2))
                  }}
                  aria-label={t("toolCall.io.copyOutputAriaLabel")}
                  title={t("toolCall.io.copyOutputTitle")}
                >
                  <Copy class="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </Show>
          </div>
        </Show>
      )}
    </Show>
  )
}

interface ExplorationGroupProps {
  kind: "exploration" | "shell"
  tools: ToolDisplayItem[]
  summaryTools?: ToolDisplayItem[]
  completed: boolean
  instanceId: string
  sessionId: string
  store: () => InstanceMessageStore
  pendingFormToolTargets: ReadonlySet<string>
  activePartId?: string
  showHeader?: boolean
  expanded?: Accessor<boolean>
  onExpandedChange?: (expanded: boolean) => void
  technicalCleanupPartKeys: Accessor<ReadonlySet<string>>
  onContentRendered?: () => void
}

function ExplorationGroup(props: ExplorationGroupProps) {
  const { t } = useI18n()
  const [localExpanded, setLocalExpanded] = createSignal(new Set<string>())
  const [deletingGroup, setDeletingGroup] = createSignal(false)
  const [deleteGroupHovered, setDeleteGroupHovered] = createSignal(false)

  const isPending = (item: ToolDisplayItem) => {
    const part = props.store().getMessage(item.messageId)?.parts[item.partId]?.data
    return Boolean(
      part?.pendingPermission?.active ||
      props.store().getPermissionState(item.messageId, item.partId)?.active ||
      props.pendingFormToolTargets.has(`${item.messageId}:${item.partId}`),
    )
  }
  const segments = createMemo(() => segmentExplorationItems(props.tools, isPending))
  const completed = (items: ToolDisplayItem[]) => props.completed || items.every((item) => {
    const part = props.store().getMessage(item.messageId)?.parts[item.partId]?.data
    const status = part?.type === "tool" ? part.state?.status : undefined
    return status === "completed" || status === "error"
  })
  const label = (items: ToolDisplayItem[]) => {
    if (props.kind === "shell") {
      return t(completed(items) ? "messageBlock.shell.completed" : "messageBlock.shell.active", { count: String(items.length) })
    }
    const counts = items.reduce((result, item) => {
      const part = props.store().getMessage(item.messageId)?.parts[item.partId]?.data
      const name = part?.type === "tool" && part.tool.toLowerCase() === "read" ? "read" : "search"
      result[name] += 1
      return result
    }, { read: 0, search: 0 })
    const names = (["read", "search"] as const).flatMap((name) => counts[name] > 0
      ? [t(`messageBlock.exploration.${name}.${counts[name] === 1 ? "one" : "other"}`, { count: String(counts[name]) })]
      : [])
    return t(completed(items) ? "messageBlock.exploration.completed" : "messageBlock.exploration.active", { tools: names.join(", ") })
  }

  const expanded = (key: string) => props.expanded?.() ?? localExpanded().has(key)
  const setExpanded = (key: string, value: boolean) => {
    if (props.onExpandedChange) {
      props.onExpandedChange(value)
      return
    }
    setLocalExpanded((current) => {
      const next = new Set(current)
      if (value) next.add(key)
      else next.delete(key)
      return next
    })
  }
  const toggle = (key: string) => setExpanded(key, !expanded(key))
  const groupTools = () => props.summaryTools ?? props.tools
  const canBackgroundGroup = () => props.kind === "shell" && groupTools().some((item) => {
    const part = props.store().getMessage(item.messageId)?.parts[item.partId]?.data
    return part?.type === "tool" && isBackgroundableTool(part)
  })
  const canDeleteGroup = () => props.completed && groupTools().length > 1 && groupTools().every((item) => {
    const status = props.store().getMessage(item.messageId)?.status
    return status === "complete" || status === "error"
  })
  const handleDeleteGroup = async () => {
    if (deletingGroup() || !canDeleteGroup()) return
    setDeletingGroup(true)
    try {
      await deleteTechnicalPartGroup(props.instanceId, props.sessionId, groupTools())
    } catch (error) {
      showAlertDialog(t("messagePart.actions.deleteFailedMessage"), {
        title: t("messagePart.actions.deleteFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setDeletingGroup(false)
    }
  }

  createEffect(() => {
    const segment = segments().find((item) => item.kind === "group" && item.items.some((tool) => tool.partId === props.activePartId))
    const key = segment?.kind === "group" ? segment.items[0]?.key : undefined
    if (key && !expanded(key)) setExpanded(key, true)
  })

  const renderTool = (item: ToolDisplayItem) => (
    <div
      class="tool-call-message"
      data-key={item.key}
      data-part-id={item.partId}
      data-delete-technical-selected={props.technicalCleanupPartKeys().has(item.key) ? "true" : undefined}
    >
      <ToolCallItem
        instanceId={props.instanceId}
        sessionId={props.sessionId}
        store={props.store}
        messageId={item.messageId}
        partId={item.partId}
        onContentRendered={props.onContentRendered}
      />
    </div>
  )
  const singleton = () => (props.summaryTools ?? props.tools).length <= 1

  return (
    <Show when={!singleton()} fallback={<For each={props.tools}>{renderTool}</For>}>
    <div
      class="message-technical-group message-exploration-group"
      data-delete-technical-selected={deleteGroupHovered() || groupTools().some((item) => props.technicalCleanupPartKeys().has(item.key)) ? "true" : undefined}
    >
      <Show when={props.showHeader !== false && props.summaryTools?.length}>
        <div class="message-technical-group-header tool-call-header">
          <button
            type="button"
            class="message-technical-group-toggle tool-call-header-toggle"
            aria-expanded={expanded(props.summaryTools![0].key)}
            onClick={() => toggle(props.summaryTools![0].key)}
          >
            <ChevronRight class="message-technical-group-disclosure disclosure-chevron" aria-hidden="true" />
            <Show when={!completed(props.summaryTools!)}><Loader2 class="message-technical-group-spinner w-3.5 h-3.5 animate-spin" aria-hidden="true" /></Show>
            <span class="message-technical-group-title">{label(props.summaryTools!)}</span>
          </button>
          <Show when={canBackgroundGroup()}>
            <button
              type="button"
              class="tool-call-header-icon-button"
              onClick={(event) => {
                event.stopPropagation()
                void moveRunningWorkToBackground(props.instanceId, props.sessionId, t)
              }}
              aria-label={t("promptInput.background.title")}
              title={t("promptInput.background.title")}
            >
              <Layers3 class="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </Show>
          <Show when={!expanded(props.summaryTools![0].key) && canDeleteGroup()}>
            <button
              type="button"
              class="tool-call-header-icon-button"
              disabled={deletingGroup()}
              onMouseEnter={() => setDeleteGroupHovered(true)}
              onMouseLeave={() => setDeleteGroupHovered(false)}
              onClick={(event) => { event.stopPropagation(); void handleDeleteGroup() }}
              aria-label={deletingGroup() ? t("messagePart.actions.deleting") : t("messagePart.actions.delete")}
              title={deletingGroup() ? t("messagePart.actions.deleting") : t("messagePart.actions.delete")}
            >
              <Trash2 class="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </Show>
        </div>
      </Show>
      <For each={segments()}>{(segment) => segment.kind === "pending"
        ? renderTool(segment.item)
        : (() => {
          const key = segment.items[0].key
          return <>
            <Show when={props.showHeader !== false && !props.summaryTools}>
              <button
                type="button"
                class="message-technical-group-toggle"
                aria-expanded={expanded(key)}
                onClick={() => toggle(key)}
              >
                <ChevronRight class="message-technical-group-disclosure disclosure-chevron" aria-hidden="true" />
                <Show when={!completed(props.summaryTools ?? segment.items)}><Loader2 class="message-technical-group-spinner w-3.5 h-3.5 animate-spin" aria-hidden="true" /></Show>
                <span class="message-technical-group-title">{label(props.summaryTools ?? segment.items)}</span>
              </button>
            </Show>
            <Show when={expanded(key)}>
              <div class="message-technical-group-parts">
                <For each={segment.items}>{renderTool}</For>
              </div>
            </Show>
          </>
        })()
      }</For>
    </div>
    </Show>
  )
}

function orderedMessageParts(record: MessageRecord): ClientPart[] {
  return record.partIds.flatMap((partId) => {
    const part = record.parts[partId]?.data
    return part ? [part] : []
  })
}

interface StepCardProps {
  kind: "start" | "finish"
  part: ClientPart
  messageInfo?: MessageInfo
  showAgentMeta?: boolean
  usageVisibility?: VisibilityPreference
  borderColor?: string
  instanceId?: string
  sessionId?: string
  messageId?: string
  onContentRendered?: () => void
}

interface CompactionCardProps {
  part: ClientPart
  messageInfo?: MessageInfo
  status: Message["status"]
  borderColor?: string
  instanceId: string
  sessionId: string
  messageId: string
  onContentRendered?: () => void
}

function CompactionCard(props: CompactionCardProps) {
  const { t } = useI18n()
  const { isDark } = useTheme()
  const isAuto = () => Boolean((props.part as any)?.auto)
  const isRunning = () => props.status === "sent" || props.status === "streaming"
  const isFailed = () => props.status === "error"
  const label = () => isRunning()
    ? t("sessionList.status.compacting")
    : isFailed()
      ? t("commands.compactSession.alert.title")
      : isAuto()
        ? t("messageBlock.compaction.autoLabel")
        : t("messageBlock.compaction.manualLabel")
  const borderColor = () => props.borderColor ?? "var(--session-status-compacting-fg)"
  const content = () => typeof (props.part as any)?.text === "string" ? (props.part as any).text.trim() : ""
  const markdownPart = createMemo<TextPart>(() => ({
    id: `${props.messageId}-compaction-summary`,
    type: "text",
    text: content(),
  }))

  const containerClass = () =>
    `message-compaction-card ${isAuto() ? "message-compaction-card--auto" : "message-compaction-card--manual"}${isFailed() ? " message-compaction-card--failed" : ""}`

  return (
    <div
      class={`delete-hover-scope ${containerClass()} relative`}
      style={{ "border-left": `1px solid ${borderColor()}` }}
      role={isFailed() ? "alert" : "status"}
      aria-label={t("messageBlock.compaction.ariaLabel")}
    >
      <div class="message-compaction-row">
        <Show when={!isRunning()} fallback={<Loader2 class="message-compaction-icon w-4 h-4 animate-spin" aria-hidden="true" />}>
          <Show when={!isFailed()} fallback={<XCircle class="message-compaction-icon w-4 h-4" aria-hidden="true" />}>
            <FoldVertical class="message-compaction-icon w-4 h-4" aria-hidden="true" />
          </Show>
        </Show>
        <span class="message-compaction-label">{label()}</span>
      </div>
      <Show when={content()}>
        <div class="message-compaction-content">
          <Markdown
            part={markdownPart()}
            instanceId={props.instanceId}
            sessionId={props.sessionId}
            isDark={isDark()}
            size="tight"
            escapeRawHtml
            onRendered={props.onContentRendered}
          />
        </div>
      </Show>
    </div>
  )
}

function StepCard(props: StepCardProps) {
  const { t, locale } = useI18n()
  const [usageExpandedOverride, setUsageExpandedOverride] = createSignal<boolean | null>(null)
  const usageExpanded = () => usageExpandedOverride() ?? props.usageVisibility === "expanded"
  let usagePartId = (props.part as { id?: string }).id
  createEffect(() => {
    const nextPartId = (props.part as { id?: string }).id
    if (nextPartId === usagePartId) return
    usagePartId = nextPartId
    setUsageExpandedOverride(null)
  })
  const timestamp = () => {
    const value = props.messageInfo?.time?.created ?? (props.part as any)?.time?.start ?? Date.now()
    const date = new Date(value)
    return date.toLocaleString(locale(), {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  const agentIdentifier = () => {
    if (!props.showAgentMeta) return ""
    const info = props.messageInfo
    if (!info || info.role !== "assistant") return ""
    return info.mode || ""
  }

  const modelIdentifier = () => {
    if (!props.showAgentMeta) return ""
    const info = props.messageInfo
    if (!info || info.role !== "assistant") return ""
    const modelID = info.modelID || ""
    const providerID = info.providerID || ""
    if (modelID && providerID) return `${providerID}/${modelID}`
    return modelID
  }

  const usageStats = () => {
    if (props.kind !== "finish" || props.usageVisibility === "hidden") {
      return null
    }
    const info = props.messageInfo
    const part = props.part as any

    // step-finish parts have tokens embedded; also check messageInfo
    const partTokens = part?.tokens
    const infoTokens = info && info.role === "assistant" ? info.tokens : undefined
    const tokens = partTokens ?? infoTokens
    if (!tokens) {
      return null
    }

    return {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cacheRead: tokens.cache?.read ?? 0,
      cacheWrite: tokens.cache?.write ?? 0,
      cost: (part?.cost ?? (info && info.role === "assistant" ? info.cost : 0)) ?? 0,
    }
  }

  const finishStyle = () => {
    if (props.borderColor === NO_STEP_BORDER) {
      return {
        "border-inline-start": "none",
      }
    }
    return props.borderColor ? { "border-left-color": props.borderColor } : undefined
  }
  let didReportUsageStats = false

  createEffect(() => {
    if (didReportUsageStats) return
    if (props.kind !== "finish" || !usageStats()) return
    didReportUsageStats = true
    props.onContentRendered?.()
  })


  const usageEntries = (usage: NonNullable<ReturnType<typeof usageStats>>) => [
      { label: t("messageBlock.usage.input"), value: usage.input, formatter: formatTokenTotal },
      { label: t("messageBlock.usage.output"), value: usage.output, formatter: formatTokenTotal },
      ...(usageExpanded()
        ? [
            { label: t("messageBlock.usage.reasoning"), value: usage.reasoning, formatter: formatTokenTotal },
            { label: t("messageBlock.usage.cacheRead"), value: usage.cacheRead, formatter: formatTokenTotal },
            { label: t("messageBlock.usage.cacheWrite"), value: usage.cacheWrite, formatter: formatTokenTotal },
          ]
        : []),
      { label: t("messageBlock.usage.cost"), value: usage.cost, formatter: formatCostValue },
    ]

  const renderUsageChips = (usage: NonNullable<ReturnType<typeof usageStats>>) => {
    const entries = usageEntries(usage)

    return (
      <div class="message-step-usage">
        <For each={entries}>
          {(entry) => (
            <span class="message-step-usage-chip" data-label={entry.label}>
              {entry.formatter(entry.value)}
            </span>
          )}
        </For>
      </div>
    )
  }

  if (props.kind === "finish") {
    const usage = usageStats()
    if (!usage) {
      return null
    }
    return (
      <div
        class="delete-hover-scope message-step-card message-step-finish message-step-finish-flush relative"
        style={finishStyle()}
      >
        <button
          type="button"
          class="message-step-usage-toggle"
          aria-expanded={usageExpanded()}
          aria-label={`${t(usageExpanded() ? "messageBlock.usage.collapseAriaLabel" : "messageBlock.usage.expandAriaLabel")}. ${usageEntries(usage).map((entry) => `${entry.label}: ${entry.formatter(entry.value)}`).join(", ")}`}
          onClick={() => setUsageExpandedOverride((current) => !(current ?? props.usageVisibility === "expanded"))}
        >
          <ChevronRight class="message-step-usage-disclosure disclosure-chevron" aria-hidden="true" />
          {renderUsageChips(usage)}
        </button>
      </div>
    )
  }

  return (
    <div class={`message-step-card message-step-start relative`}>
      <div class="message-step-heading">
        <div class="message-step-title">
          <div class="message-step-title-left">
            <Show when={props.showAgentMeta && (agentIdentifier() || modelIdentifier())}>
              <span class="message-step-meta-inline">
                {[
                  agentIdentifier(),
                  modelIdentifier(),
                ].filter(Boolean).join(" • ")}
              </span>
            </Show>
          </div>
          <span class="message-step-right">
            <span class="message-step-time">{timestamp()}</span>
          </span>
        </div>
      </div>
    </div>
  )
}

function formatCostValue(value: number) {
  if (!value) return "$0.00"
  if (value < 0.01) return `$${value.toPrecision(2)}`
  return `$${value.toFixed(2)}`
}

function getReasoningText(part: ClientPart) {
  const stringify = (segment: unknown): string => {
    if (typeof segment === "string") return segment
    if (!segment || typeof segment !== "object") return ""
    const value = segment as { text?: unknown; value?: unknown; content?: unknown[] }
    return [
      typeof value.text === "string" ? value.text : "",
      typeof value.value === "string" ? value.value : "",
      Array.isArray(value.content) ? value.content.map(stringify).join("\n") : "",
    ].filter((item) => item.trim()).join("\n")
  }
  const text = stringify((part as any).text)
  if (text.trim()) return text
  const content = (part as any).content
  return Array.isArray(content) ? content.map(stringify).join("\n") : ""
}

function reasoningDurationTitle(t: I18nContextValue["t"], durationMs?: number) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return t("messageBlock.reasoning.thoughtsFallback")
  }
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  if (seconds < 60) return t(`messageBlock.reasoning.thoughtFor.seconds.${seconds === 1 ? "one" : "other"}`, { count: String(seconds) })
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return t(`messageBlock.reasoning.thoughtFor.minutes.${minutes === 1 ? "one" : "other"}`, { count: String(minutes) })
  const hours = Math.max(1, Math.round(minutes / 60))
  return t(`messageBlock.reasoning.thoughtFor.hours.${hours === 1 ? "one" : "other"}`, { count: String(hours) })
}

function ReasoningGroupCard(props: {
  parts: ReasoningDisplayPart[]
  summaryParts?: ReasoningDisplayPart[]
  completed: boolean
  instanceId: string
  sessionId: string
  status: MessageRecord["status"]
  showAgentMeta?: boolean
  defaultExpanded?: boolean
  onContentRendered?: () => void
  activePartId?: string
  showHeader?: boolean
  expanded?: Accessor<boolean>
  onExpandedChange?: (expanded: boolean) => void
  technicalCleanupPartKeys: Accessor<ReadonlySet<string>>
}) {
  const { t, locale } = useI18n()
  const [localExpanded, setLocalExpanded] = createSignal(Boolean(props.defaultExpanded))
  const [deletingGroup, setDeletingGroup] = createSignal(false)
  const [deleteGroupHovered, setDeleteGroupHovered] = createSignal(false)
  const expanded = () => props.expanded?.() ?? localExpanded()
  const setExpanded = (value: boolean) => props.onExpandedChange ? props.onExpandedChange(value) : setLocalExpanded(value)
  const summaryParts = () => props.summaryParts ?? props.parts
  const totalDuration = createMemo(() => summaryParts().reduce((total, item) => total + (item.durationMs ?? 0), 0))
  const latestTitle = createMemo(() => {
    const latest = summaryParts().at(-1)
    return latest ? parseReasoningSummary(getReasoningText(latest.part)).title ?? "" : ""
  })
  const canDeleteGroup = () => props.completed && summaryParts().length > 1 && summaryParts().every((item) => {
    const status = messageStoreBus.getOrCreate(props.instanceId).getMessage(item.messageId)?.status
    return status === "complete" || status === "error"
  })
  const handleDeleteGroup = async () => {
    if (deletingGroup() || !canDeleteGroup()) return
    setDeletingGroup(true)
    try {
      await deleteTechnicalPartGroup(props.instanceId, props.sessionId, summaryParts())
    } catch (error) {
      showAlertDialog(t("messagePart.actions.deleteFailedMessage"), {
        title: t("messagePart.actions.deleteFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setDeletingGroup(false)
    }
  }

  createEffect(() => {
    if (!props.expanded) setExpanded(Boolean(props.defaultExpanded))
  })
  createEffect(() => {
    if (props.activePartId && props.parts.some((item) => item.partId === props.activePartId)) setExpanded(true)
  })

  const renderCard = (item: ReasoningDisplayPart) => (
    <ReasoningCard
      part={item.part}
      copyText={() => extractReasoningTextForCopy(
        messageStoreBus.getOrCreate(props.instanceId).getMessage(item.messageId)?.parts[item.partId]?.data,
      )}
      messageInfo={item.messageInfo}
      durationMs={item.durationMs}
      instanceId={props.instanceId}
      sessionId={props.sessionId}
      messageId={item.messageId}
      status={props.status}
      showAgentMeta={props.showAgentMeta}
      defaultExpanded
      onContentRendered={props.onContentRendered}
      forceExpanded={props.activePartId === item.partId}
      technicalCleanupSelected={() => props.technicalCleanupPartKeys().has(technicalPartKey(item.messageId, item.partId))}
    />
  )

  return (
    <Show when={summaryParts().length > 1} fallback={<For each={props.parts}>{renderCard}</For>}>
    <div
      class="message-technical-group message-reasoning-group"
      data-delete-technical-selected={deleteGroupHovered() || summaryParts().some((item) => props.technicalCleanupPartKeys().has(technicalPartKey(item.messageId, item.partId))) ? "true" : undefined}
    >
      <Show when={props.showHeader !== false}>
        <div class="message-technical-group-header tool-call-header">
          <button
            type="button"
            class="message-technical-group-toggle tool-call-header-toggle"
            aria-expanded={expanded()}
            aria-label={expanded() ? t("messageBlock.reasoning.collapseAriaLabel") : t("messageBlock.reasoning.expandAriaLabel")}
            onClick={() => setExpanded(!expanded())}
          >
            <ChevronRight class="message-technical-group-disclosure disclosure-chevron" aria-hidden="true" />
            <Show when={!props.completed}><Loader2 class="message-technical-group-spinner w-3.5 h-3.5 animate-spin" aria-hidden="true" /></Show>
            <span class="message-reasoning-type">
              {t(props.completed ? "messageBlock.reasoning.thoughtLabel" : "messageBlock.reasoning.thinkingLabel")}
            </span>
            <span class="message-technical-group-title">{latestTitle() || t("messageBlock.reasoning.thoughtsFallback")}</span>
            <span class="message-technical-group-meta">
              · {t(`messageBlock.reasoning.steps.${summaryParts().length === 1 ? "one" : "other"}`, { count: String(summaryParts().length) })}
            </span>
            <Show when={totalDuration() > 0}>
              <span class="message-technical-group-meta">· {formatElapsedClock(totalDuration(), locale())}</span>
            </Show>
          </button>
          <Show when={!expanded() && canDeleteGroup()}>
            <button
              type="button"
              class="tool-call-header-icon-button"
              disabled={deletingGroup()}
              onMouseEnter={() => setDeleteGroupHovered(true)}
              onMouseLeave={() => setDeleteGroupHovered(false)}
              onClick={(event) => { event.stopPropagation(); void handleDeleteGroup() }}
              aria-label={deletingGroup() ? t("messagePart.actions.deleting") : t("messagePart.actions.delete")}
              title={deletingGroup() ? t("messagePart.actions.deleting") : t("messagePart.actions.delete")}
            >
              <Trash2 class="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </Show>
        </div>
      </Show>
      <Show when={expanded()}>
        <div class="message-technical-group-parts message-reasoning-group-parts">
          <For each={props.parts}>{renderCard}</For>
        </div>
      </Show>
    </div>
    </Show>
  )
}

interface ReasoningCardProps {
  part: ClientPart
  copyText: () => string
  messageInfo?: MessageInfo
  durationMs?: number
  instanceId: string
  sessionId: string
  messageId: string
  status: MessageRecord["status"]
  showAgentMeta?: boolean
  defaultExpanded?: boolean
  onContentRendered?: () => void
  forceExpanded?: boolean
  technicalCleanupSelected: Accessor<boolean>
}

function ReasoningStreamOutput(props: {
  text: Accessor<string>
  scrollTopSnapshot: Accessor<number>
  setScrollTopSnapshot: (next: number) => void
  onContentRendered?: () => void
  ariaLabel: string
}) {
  let preRef: HTMLPreElement | undefined
  let pendingRenderNotificationFrame: number | null = null

  const followScroll = createFollowScroll({
    getScrollTopSnapshot: props.scrollTopSnapshot,
    setScrollTopSnapshot: props.setScrollTopSnapshot,
    sentinelClassName: "reasoning-scroll-sentinel",
  })

  const notifyContentRendered = () => {
    if (!props.onContentRendered || typeof requestAnimationFrame !== "function") return
    if (pendingRenderNotificationFrame !== null) {
      cancelAnimationFrame(pendingRenderNotificationFrame)
    }
    pendingRenderNotificationFrame = requestAnimationFrame(() => {
      pendingRenderNotificationFrame = null
      props.onContentRendered?.()
    })
  }

  createEffect(() => {
    const nextText = props.text()
    if (preRef && preRef.textContent !== nextText) {
      preRef.textContent = nextText
    }
    followScroll.restoreAfterRender()
    notifyContentRendered()
  })

  onCleanup(() => {
    if (pendingRenderNotificationFrame !== null) {
      cancelAnimationFrame(pendingRenderNotificationFrame)
      pendingRenderNotificationFrame = null
    }
  })

  return (
    <div
      ref={followScroll.registerContainer}
      class="message-reasoning-output"
      role="region"
      aria-label={props.ariaLabel}
      onScroll={followScroll.handleScroll}
    >
      <pre
        ref={(element) => {
          preRef = element || undefined
          if (preRef) {
            preRef.textContent = props.text() || ""
          }
        }}
        class="message-reasoning-text"
        dir="auto"
      />
      {followScroll.renderSentinel()}
    </div>
  )
}

function ReasoningCard(props: ReasoningCardProps) {
  const { t } = useI18n()
  const [expanded, setExpanded] = createSignal(Boolean(props.defaultExpanded))
  const [scrollTopSnapshot, setScrollTopSnapshot] = createSignal(0)
  const [deleting, setDeleting] = createSignal(false)
  const [deleteHovered, setDeleteHovered] = createSignal(false)

  createEffect(() => {
    setExpanded(Boolean(props.defaultExpanded))
  })

  createEffect(() => {
    if (props.forceExpanded) {
      setExpanded(true)
    }
  })

  const agentIdentifier = () => {
    const info = props.messageInfo
    if (!info || info.role !== "assistant") return ""
    return info.mode || ""
  }

  const modelIdentifier = () => {
    const info = props.messageInfo
    if (!info || info.role !== "assistant") return ""
    const modelID = info.modelID || ""
    const providerID = info.providerID || ""
    if (modelID && providerID) return `${providerID}/${modelID}`
    return modelID
  }

  const reasoningText = () => getReasoningText(props.part)

  const reasoningSummary = createMemo(() => parseReasoningSummary(reasoningText()))
  const reasoningBody = () => reasoningSummary().body
  const extractedTitle = () => reasoningSummary().title ?? ""

  const thoughtDurationTitle = () => reasoningDurationTitle(t, props.durationMs)

  const reasoningTitle = () => extractedTitle() || thoughtDurationTitle()

  const reasoningMetaTooltip = () => {
    const parts: string[] = [thoughtDurationTitle()]
    const agent = agentIdentifier()
    const model = modelIdentifier()
    if (agent) parts.push(agent)
    if (model) parts.push(model)
    return parts.join("\n")
  }

  const toggle = () => {
    if (reasoningBody()) setExpanded((prev) => !prev)
  }

  const speech = useSpeech({
    id: () => `${props.instanceId}:${props.sessionId}:${props.messageId}:${props.part.id || "reasoning"}`,
    text: reasoningText,
  })

  const canSpeakReasoning = () => reasoningText().trim().length > 0 && speech.canUseSpeech()

  const handleCopyReasoning = async () => {
    const text = props.copyText()
    if (!text.trim()) return
    await copyToClipboard(text)
  }

  const handleDelete = async () => {
    const partId = typeof props.part.id === "string" ? props.part.id : ""
    if (!partId || deleting() || (props.status !== "complete" && props.status !== "error")) return
    setDeleting(true)
    try {
      await deleteMessagePart(props.instanceId, props.sessionId, props.messageId, partId)
    } catch (error) {
      showAlertDialog(t("messagePart.actions.deleteFailedMessage"), {
        title: t("messagePart.actions.deleteFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      class="delete-hover-scope message-reasoning-card"
      data-part-id={typeof (props.part as any)?.id === "string" ? (props.part as any).id : undefined}
      data-delete-technical-selected={props.technicalCleanupSelected() ? "true" : undefined}
      data-delete-part-hover={deleteHovered() ? "true" : undefined}
    >
      <div class="message-reasoning-header">
        <button
          type="button"
          class="message-reasoning-toggle"
          onClick={toggle}
          disabled={!reasoningBody()}
          aria-expanded={Boolean(reasoningBody() && expanded())}
          aria-label={expanded() ? t("messageBlock.reasoning.collapseAriaLabel") : t("messageBlock.reasoning.expandAriaLabel")}
        >
          <Show when={reasoningBody()}>
            <ChevronRight class="message-reasoning-disclosure disclosure-chevron" aria-hidden="true" />
          </Show>
          <span class="message-reasoning-label">
            <span class="message-reasoning-type">{t("messageBlock.reasoning.thinkingLabel")}</span>
            <span class="message-reasoning-title" title={reasoningMetaTooltip() || undefined}>
              {reasoningTitle()}
            </span>
          </span>
        </button>

        <div class="message-reasoning-actions">
          <button
            type="button"
            class="message-action-button"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void handleCopyReasoning()
            }}
            aria-label={t("messageBlock.reasoning.copyAriaLabel")}
            title={t("messageBlock.reasoning.copyTitle")}
          >
            <Copy class="w-3.5 h-3.5" aria-hidden="true" />
          </button>

          <Show when={canSpeakReasoning()}>
            <SpeechActionButton
              class="message-action-button"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void speech.toggle()
              }}
              title={speech.buttonTitle()}
              isLoading={speech.isLoading()}
              isPlaying={speech.isPlaying()}
            />
          </Show>

          <button
            type="button"
            class="message-action-button"
            disabled={deleting() || (props.status !== "complete" && props.status !== "error")}
            onMouseEnter={() => setDeleteHovered(true)}
            onMouseLeave={() => setDeleteHovered(false)}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void handleDelete()
            }}
            aria-label={deleting() ? t("messagePart.actions.deleting") : t("messagePart.actions.delete")}
            title={deleting() ? t("messagePart.actions.deleting") : t("messagePart.actions.delete")}
          >
            <Trash2 class="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <Show when={reasoningBody() && expanded()}>
        <div class="message-reasoning-expanded">
          <div class="message-reasoning-body">
            <ReasoningStreamOutput
              text={reasoningBody}
              scrollTopSnapshot={scrollTopSnapshot}
              setScrollTopSnapshot={setScrollTopSnapshot}
              onContentRendered={props.onContentRendered}
              ariaLabel={t("messageBlock.reasoning.detailsAriaLabel")}
            />
          </div>
        </div>
      </Show>
    </div>
  )
}
