import { For, Index, Match, Show, Suspense, Switch, createEffect, createMemo, createSignal, lazy, onCleanup, untrack, type Accessor } from "solid-js"
import { Copy, ExternalLink, FoldVertical, Loader2, Volume2, XCircle } from "lucide-solid"
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
import { useI18n } from "../lib/i18n"
import { useSpeech } from "../lib/hooks/use-speech"
import { createFollowScroll } from "../lib/follow-scroll"
import { inferReasoningDurationMs } from "../lib/message-timing"
import type { SessionSearchMatch } from "../lib/session-search"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import { copyToClipboard } from "../lib/clipboard"
import SpeechActionButton from "./speech-action-button"
import type { VisibilityPreference } from "../stores/preferences"
import type { ToolState, ToolStateCompleted, ToolStateError, ToolStateRunning } from "../types/tool-state"
import { parseReasoningSummary } from "../lib/reasoning-summary"
import { getFormQueue } from "../stores/forms"
import { resolveFormToolTarget } from "./form-request-tool-target"
import { Markdown } from "./markdown"
import { useTheme } from "../lib/theme"

const USER_BORDER_COLOR = "var(--message-user-border)"
const ASSISTANT_BORDER_COLOR = "var(--message-assistant-border)"
const NO_STEP_BORDER = "none"

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

function extractTaskSessionId(state: ToolState | undefined): string {
  if (!state) return ""
  const metadata = (state as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}
  const directId = metadata?.sessionId ?? metadata?.sessionID
  return typeof directId === "string" ? directId : ""
}

function reasoningHasRenderableContent(part: ClientPart): boolean {
  if (!part || part.type !== "reasoning") {
    return false
  }
  const checkSegment = (segment: unknown): boolean => {
    if (typeof segment === "string") {
      return segment.trim().length > 0
    }
    if (segment && typeof segment === "object") {
      const candidate = segment as { text?: unknown; value?: unknown; content?: unknown[] }
      if (typeof candidate.text === "string" && candidate.text.trim().length > 0) {
        return true
      }
      if (typeof candidate.value === "string" && candidate.value.trim().length > 0) {
        return true
      }
      if (Array.isArray(candidate.content)) {
        return candidate.content.some((entry) => checkSegment(entry))
      }
    }
    return false
  }

  if (checkSegment((part as any).text)) {
    return true
  }
  if (Array.isArray((part as any).content)) {
    return (part as any).content.some((entry: unknown) => checkSegment(entry))
  }
  return false
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

interface SessionRenderCache {
  messageItems: Map<string, ContentDisplayItem>
  toolItems: Map<string, ToolDisplayItem>
  messageBlocks: Map<string, CachedBlockEntry>
}

const renderCaches = new Map<string, SessionRenderCache>()

function makeSessionCacheKey(instanceId: string, sessionId: string) {
  return `${instanceId}:${sessionId}`
}

export function clearSessionRenderCache(instanceId: string, sessionId: string) {
  renderCaches.delete(makeSessionCacheKey(instanceId, sessionId))
}

function getSessionRenderCache(instanceId: string, sessionId: string): SessionRenderCache {
  const key = makeSessionCacheKey(instanceId, sessionId)
  let cache = renderCaches.get(key)
  if (!cache) {
    cache = {
      messageItems: new Map(),
      toolItems: new Map(),
      messageBlocks: new Map(),
    }
    renderCaches.set(key, cache)
  }
  return cache
}

function clearInstanceCaches(instanceId: string) {
  clearRecordDisplayCacheForInstance(instanceId)
  const prefix = `${instanceId}:`
  for (const key of renderCaches.keys()) {
    if (key.startsWith(prefix)) {
      renderCaches.delete(key)
    }
  }
}

messageStoreBus.onInstanceDestroyed(clearInstanceCaches)

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
  messageIndex: number
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  pendingPrompt?: SessionInboxUser
  pendingPromptBusy?: boolean
  onPendingPromptDeliveryChange?: (item: SessionInboxUser) => void
  onPendingPromptRemove?: (item: SessionInboxUser) => void
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
    const ids = current.partIds
    const startIndex = ids.indexOf(props.startPartId)
    if (startIndex === -1) return []

    const resolved: ClientPart[] = []
    for (let idx = startIndex; idx < ids.length; idx++) {
      const partId = ids[idx]
      const part = current.parts[partId]?.data
      if (!part) continue
      if (!isSupportedPartType(part)) continue

      if (!isContentPartType((part as any).type)) break
      resolved.push(part)
    }

    return resolved
  })

  const visibleParts = createMemo(() => parts().filter((part) => isVisibleContentPart(part)))

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
        showAgentMeta={showAgentMeta()}
        onRevert={props.onRevert}
        onFork={props.onFork}
        pendingPrompt={props.pendingPrompt}
        pendingPromptBusy={props.pendingPromptBusy}
        onPendingPromptDeliveryChange={props.onPendingPromptDeliveryChange}
        onPendingPromptRemove={props.onPendingPromptRemove}
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

    return items
  }

  return (
    <Show when={Boolean(toolPart())}>
      <div>
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

type ReasoningDisplayItem = {
  type: "reasoning"
  key: string
  part: ClientPart
  messageInfo?: MessageInfo
  durationMs?: number
  showAgentMeta?: boolean
  defaultExpanded: boolean
  messageId: string
  partId: string
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

type MessageBlockItem = ContentDisplayItem | ToolDisplayItem | StepDisplayItem | ReasoningDisplayItem | CompactionDisplayItem

interface MessageDisplayBlock {
  record: MessageRecord
  items: MessageBlockItem[]
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
  onPendingPromptRemove?: (item: SessionInboxUser) => void
  onContentRendered?: () => void
  searchQuery?: Accessor<string>
  searchResultMessageIds?: Accessor<Set<string>>
  activeSearchMatch?: Accessor<SessionSearchMatch | null>
}

export default function MessageBlock(props: MessageBlockProps) {
  const { t } = useI18n()
  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))
  const sessionCache = getSessionRenderCache(props.instanceId, props.sessionId)
  const [blockRef, setBlockRef] = createSignal<HTMLDivElement>()
  const isSearchResult = () => Boolean(props.searchResultMessageIds?.().has(props.messageId))
  const activeSearchMatch = () => props.activeSearchMatch?.() ?? null
  const isActiveSearchResult = () => activeSearchMatch()?.messageId === props.messageId
  let lastInlineScrolledSearchMatchId: string | null = null

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
    ].join("|")

    const cachedBlock = sessionCache.messageBlocks.get(current.id)
    if (cachedBlock && cachedBlock.signature === cacheSignature) {
      return cachedBlock.block
    }

    // Only capture info after cache check fails - ensures fresh data on version bump
    const info = untrack(messageInfo)

    const { orderedParts } = buildRecordDisplayData(props.instanceId, current)
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
        }
        sessionCache.messageItems.set(segmentKey, cached)
      }

      items.push(cached)
      blockContentKeys.push(segmentKey)
      lastAccentColor = defaultAccentColor
      pendingParts = []
    }

    orderedParts.forEach((part, partIndex) => {
      if (!isSupportedPartType(part)) {
        return
      }
      if (part.type === "tool") {
        flushContent()
        const partId = part.id
        if (!partId) {
          // Tool parts are required to have ids; if one slips through, skip rendering
          // to avoid unstable keys and accidental remount cascades.
          return
        }
        const key = `${current.id}:${partId}`
        let toolItem = sessionCache.toolItems.get(key)
        if (!toolItem) {
          toolItem = {
            type: "tool",
            key,
            messageId: current.id,
            partId,
          }
          sessionCache.toolItems.set(key, toolItem)
        } else {
          toolItem.key = key
          toolItem.messageId = current.id
          toolItem.partId = partId
        }
        items.push(toolItem)
        blockToolKeys.push(key)
        lastAccentColor = NO_STEP_BORDER
        return
      }

      if (part.type === "compaction") {
        flushContent()
        const partId = part.id ?? ""
        const key = `${current.id}:${partId || partIndex}:compaction`
        const isAuto = Boolean((part as any)?.auto)
        items.push({
          type: "compaction",
          key,
          part,
          messageInfo: info,
          accentColor: isAuto ? "var(--session-status-compacting-fg)" : USER_BORDER_COLOR,
          messageId: current.id,
          partId,
        })
        lastAccentColor = isAuto ? "var(--session-status-compacting-fg)" : USER_BORDER_COLOR
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

      if (part.type === "reasoning") {
        flushContent()
        if (props.showThinking() && reasoningHasRenderableContent(part)) {
          const partId = part.id ?? ""
          const key = `${current.id}:${partId || partIndex}:reasoning`
          const showAgentMeta = current.role === "assistant" && !agentMetaAttached
          if (showAgentMeta) {
            agentMetaAttached = true
          }
          items.push({
            type: "reasoning",
            key,
            part,
            messageInfo: info,
            durationMs: inferReasoningDurationMs(orderedParts, part, info, current.status),
            showAgentMeta,
            defaultExpanded: props.thinkingDefaultExpanded(),
            messageId: current.id,
            partId,
          })
          lastAccentColor = ASSISTANT_BORDER_COLOR
        }
        return
      }

      pendingParts.push(part)
    })

    flushContent()

    const resultBlock: MessageDisplayBlock = { record: current, items }
    sessionCache.messageBlocks.set(current.id, {
      signature: cacheSignature,
      block: resultBlock,
      contentKeys: blockContentKeys.slice(),
      toolKeys: blockToolKeys.slice(),
    })

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

  const isDisplayItemVisible = (item: MessageBlockItem) => {
    if (item.type !== "tool") return true
    const part = props.store().getMessage(item.messageId)?.parts[item.partId]?.data
    if (part?.type !== "tool" || props.toolVisibility(part.tool || "") !== "hidden") return true
    if (
      part.pendingPermission?.active ||
      props.store().getPermissionState(item.messageId, item.partId)?.active
    ) return true
    return pendingFormToolTargets().has(`${item.messageId}:${item.partId}`)
  }

  const pendingFormToolTargets = createMemo(() => new Set(getFormQueue(props.instanceId)
    .filter((form) => form.sessionID === props.sessionId)
    .flatMap((form) => {
      const target = resolveFormToolTarget(form, props.store())
      return target ? [`${target.messageId}:${target.partId}`] : []
    })))
  const visibleItemKeys = createMemo(() => new Set((block()?.items ?? [])
    .filter(isDisplayItemVisible)
    .map((item) => item.key)))
  return (
    <Show when={visibleItemKeys().size > 0}>
      <div
        ref={(element) => {
          setBlockRef(element)
          onCleanup(() => setBlockRef(undefined))
        }}
        class="message-stream-block"
        data-message-id={block()!.record.id}
        data-search-result={isSearchResult() ? "true" : undefined}
        data-search-active={isActiveSearchResult() ? "true" : undefined}
      >
        <Index each={block()!.items}>
          {(item, index) => (
              <Switch>
                <Match when={item().type === "content"}>
                  <MessageContentItem
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    store={props.store}
                    messageId={(item() as ContentDisplayItem).messageId}
                    startPartId={(item() as ContentDisplayItem).startPartId}
                    messageIndex={props.messageIndex}
                    onRevert={props.onRevert}
                    onFork={props.onFork}
                    pendingPrompt={props.pendingPrompt}
                    pendingPromptBusy={props.pendingPromptBusy}
                    onPendingPromptDeliveryChange={props.onPendingPromptDeliveryChange}
                    onPendingPromptRemove={props.onPendingPromptRemove}
                    onContentRendered={props.onContentRendered}
                  />
                </Match>
                <Match when={item().type === "tool"}>
                  <Show when={visibleItemKeys().has((item() as ToolDisplayItem).key)}>
                    <div
                      class="tool-call-message"
                      data-key={(item() as ToolDisplayItem).key}
                      data-part-id={(item() as ToolDisplayItem).partId}
                    >
                      <ToolCallItem
                        instanceId={props.instanceId}
                        sessionId={props.sessionId}
                        store={props.store}
                        messageId={(item() as ToolDisplayItem).messageId}
                        partId={(item() as ToolDisplayItem).partId}
                        onContentRendered={props.onContentRendered}
                      />
                    </div>
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
                    onContentRendered={props.onContentRendered}
                  />
                </Match>
                <Match when={item().type === "compaction"}>
                  <CompactionCard
                    part={(item() as CompactionDisplayItem).part}
                    messageInfo={(item() as CompactionDisplayItem).messageInfo}
                    status={block()!.record.status}
                    borderColor={(item() as CompactionDisplayItem).accentColor}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={(item() as CompactionDisplayItem).messageId}
                    onContentRendered={props.onContentRendered}
                  />
                </Match>
                <Match when={item().type === "reasoning"}>
                  <ReasoningCard
                    part={(item() as ReasoningDisplayItem).part}
                    messageInfo={(item() as ReasoningDisplayItem).messageInfo}
                    durationMs={(item() as ReasoningDisplayItem).durationMs}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={(item() as ReasoningDisplayItem).messageId}
                    showAgentMeta={(item() as ReasoningDisplayItem).showAgentMeta}
                    defaultExpanded={(item() as ReasoningDisplayItem).defaultExpanded}
                    onContentRendered={props.onContentRendered}
                    forceExpanded={activeSearchMatch()?.partId === (item() as ReasoningDisplayItem).partId}
                  />
                </Match>
              </Switch>
          )}
        </Index>
      </div>
    </Show>
  )
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
  const borderColor = () => props.borderColor ?? (isAuto() ? "var(--session-status-compacting-fg)" : USER_BORDER_COLOR)
  const content = () => isRunning() ? "" : typeof (props.part as any)?.text === "string" ? (props.part as any).text.trim() : ""
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
      style={{ "border-left": `4px solid ${borderColor()}` }}
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
  const { t } = useI18n()
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
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
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
          <span class="message-step-usage-disclosure" aria-hidden="true">{usageExpanded() ? "▼" : "▶"}</span>
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
                <Show when={agentIdentifier()}>{(value) => <span>{t("messageBlock.step.agentLabel", { agent: value() })}</span>}</Show>
                <Show when={modelIdentifier()}>{(value) => <span>{t("messageBlock.step.modelLabel", { model: value() })}</span>}</Show>
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

interface ReasoningCardProps {
  part: ClientPart
  messageInfo?: MessageInfo
  durationMs?: number
  instanceId: string
  sessionId: string
  messageId: string
  showAgentMeta?: boolean
  defaultExpanded?: boolean
  onContentRendered?: () => void
  forceExpanded?: boolean
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

  const reasoningText = () => {
    const part = props.part as any
    if (!part) return ""

    const stringifySegment = (segment: unknown): string => {
      if (typeof segment === "string") {
        return segment
      }
      if (segment && typeof segment === "object") {
        const obj = segment as { text?: unknown; value?: unknown; content?: unknown[] }
        const pieces: string[] = []
        if (typeof obj.text === "string") {
          pieces.push(obj.text)
        }
        if (typeof obj.value === "string") {
          pieces.push(obj.value)
        }
        if (Array.isArray(obj.content)) {
          pieces.push(obj.content.map((entry) => stringifySegment(entry)).join("\n"))
        }
        return pieces.filter((piece) => piece && piece.trim().length > 0).join("\n")
      }
      return ""
    }

    const textValue = stringifySegment(part.text)
    if (textValue.trim().length > 0) {
      return textValue
    }
    if (Array.isArray(part.content)) {
      return part.content.map((entry: unknown) => stringifySegment(entry)).join("\n")
    }
    return ""
  }

  const reasoningSummary = createMemo(() => parseReasoningSummary(reasoningText()))
  const reasoningBody = () => reasoningSummary().body
  const extractedTitle = () => reasoningSummary().title ?? ""

  const thoughtDurationTitle = () => {
    const duration = props.durationMs
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
      return t("messageBlock.reasoning.thoughtsFallback")
    }

    const seconds = Math.max(1, Math.round(duration / 1000))
    if (seconds < 60) {
      return seconds === 1
        ? t("messageBlock.reasoning.thoughtFor.seconds.one", { count: String(seconds) })
        : t("messageBlock.reasoning.thoughtFor.seconds.other", { count: String(seconds) })
    }

    const minutes = Math.max(1, Math.round(seconds / 60))
    if (minutes < 60) {
      return minutes === 1
        ? t("messageBlock.reasoning.thoughtFor.minutes.one", { count: String(minutes) })
        : t("messageBlock.reasoning.thoughtFor.minutes.other", { count: String(minutes) })
    }

    const hours = Math.max(1, Math.round(minutes / 60))
    return hours === 1
      ? t("messageBlock.reasoning.thoughtFor.hours.one", { count: String(hours) })
      : t("messageBlock.reasoning.thoughtFor.hours.other", { count: String(hours) })
  }

  const reasoningTitle = () => extractedTitle() || thoughtDurationTitle()

  const reasoningMetaTooltip = () => {
    const parts: string[] = [thoughtDurationTitle()]
    const agent = agentIdentifier()
    const model = modelIdentifier()
    if (agent) parts.push(t("messageBlock.step.agentLabel", { agent }))
    if (model) parts.push(t("messageBlock.step.modelLabel", { model }))
    return parts.join("\n")
  }

  const toggle = () => {
    if (reasoningBody()) setExpanded((prev) => !prev)
  }

  const speech = useSpeech({
    id: () => `${props.instanceId}:${props.sessionId}:${props.messageId}:${(props.part as any)?.id ?? "reasoning"}`,
    text: reasoningText,
  })

  const canSpeakReasoning = () => reasoningText().trim().length > 0 && speech.canUseSpeech()

  const handleCopyReasoning = async () => {
    const text = reasoningText()
    if (!text.trim()) return
    await copyToClipboard(text)
  }

  const actionMenuItems = (includePrimaryActions = false): ActionOverflowMenuItem[] => {
    const items: ActionOverflowMenuItem[] = []

    if (includePrimaryActions) {
      items.push({
        key: "copy",
        label: t("messageBlock.reasoning.copyTitle"),
        icon: <Copy class="w-3.5 h-3.5" aria-hidden="true" />,
        onSelect: handleCopyReasoning,
      })

      if (canSpeakReasoning()) {
        items.push({
          key: "speak",
          label: speech.buttonTitle(),
          icon: <Volume2 class="w-3.5 h-3.5" aria-hidden="true" />,
          onSelect: () => void speech.toggle(),
        })
      }
    }

    return items
  }

  return (
    <div
      class="delete-hover-scope message-reasoning-card"
      data-part-id={typeof (props.part as any)?.id === "string" ? (props.part as any).id : undefined}
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
            <span class="message-reasoning-disclosure" aria-hidden="true">{expanded() ? "▼" : "▶"}</span>
          </Show>
          <span class="message-reasoning-label">
            <span class="message-reasoning-type">{t("messageBlock.reasoning.thinkingLabel")}</span>
            <span class="message-reasoning-title" title={reasoningMetaTooltip() || undefined}>
              {reasoningTitle()}
            </span>
          </span>
        </button>

        <div class="message-reasoning-actions" data-action-overflow={actionMenuItems(true).length > 0 ? "true" : undefined}>
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

          <ActionOverflowMenu
            items={actionMenuItems()}
            label={t("messageItem.actions.more")}
            triggerClass="message-action-button action-overflow-wide"
            minItems={1}
          />
          <ActionOverflowMenu
            items={actionMenuItems(true)}
            label={t("messageItem.actions.more")}
            triggerClass="message-action-button action-overflow-narrow"
            minItems={1}
          />
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
