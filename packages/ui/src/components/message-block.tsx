import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { ChevronsDownUp, ChevronsUpDown, ExternalLink, FoldVertical, ListStart, Trash } from "lucide-solid"
import MessageItem from "./message-item"
import ToolCall from "./tool-call"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { ClientPart, MessageInfo } from "../types/message"
import { partHasRenderableText } from "../types/message"
import { buildRecordDisplayData, clearRecordDisplayCacheForInstance } from "../stores/message-v2/record-display-cache"
import type { MessageRecord } from "../stores/message-v2/types"
import { messageStoreBus } from "../stores/message-v2/bus"
import { formatTokenTotal } from "../lib/formatters"
import { sessions, setActiveParentSession, setActiveSession } from "../stores/sessions"
import { setActiveInstanceId } from "../stores/instances"
import { showAlertDialog } from "../stores/alerts"
import { deleteMessage } from "../stores/session-actions"
import { useI18n } from "../lib/i18n"
import type { DeleteHoverState } from "../types/delete-hover"

function DeleteUpToIcon() {
  return (
    <span class="relative inline-block w-3.5 h-3.5" aria-hidden="true">
      <ListStart class="absolute inset-0 w-3.5 h-3.5" aria-hidden="true" />
    </span>
  )
}

const TOOL_ICON = "🔧"
const USER_BORDER_COLOR = "var(--message-user-border)"
const ASSISTANT_BORDER_COLOR = "var(--message-assistant-border)"
const TOOL_BORDER_COLOR = "var(--message-tool-border)"

type ToolCallPart = Extract<ClientPart, { type: "tool" }>


type ToolState = import("@opencode-ai/sdk/v2").ToolState
type ToolStateRunning = import("@opencode-ai/sdk/v2").ToolStateRunning
type ToolStateCompleted = import("@opencode-ai/sdk/v2").ToolStateCompleted
type ToolStateError = import("@opencode-ai/sdk/v2").ToolStateError

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
  setActiveInstanceId(location.instanceId)
  const parentToActivate = location.parentId ?? location.sessionId
  setActiveParentSession(location.instanceId, parentToActivate)
  if (location.parentId) {
    setActiveSession(location.instanceId, location.sessionId)
  }
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
  lastAssistantIndex: () => number
  onRevert?: (messageId: string) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  onFork?: (messageId?: string) => void
  onContentRendered?: () => void
  showDeleteMessage?: boolean
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  selectedMessageIds?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
}

function isSupportedPartType(part: unknown): boolean {
  const type = (part as any)?.type
  // Ignore part types the UI does not support rendering yet.
  return !(typeof type === "string" && type === "patch")
}

function isContentPartType(type: unknown): boolean {
  return type === "text" || type === "file"
}

function MessageContentItem(props: MessageContentItemProps) {
  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))

  const isQueued = createMemo(() => {
    const current = record()
    if (!current) return false
    if (current.role !== "user") return false
    const lastAssistant = props.lastAssistantIndex()
    return lastAssistant === -1 || props.messageIndex > lastAssistant
  })

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

  const showAgentMeta = createMemo(() => {
    const current = record()
    if (!current) return false
    if (current.role !== "assistant") return false

    const currentParts = parts()
    if (!currentParts.some((part) => partHasRenderableText(part))) {
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
      if (partHasRenderableText(part)) {
        return false
      }
    }

    return true
  })

  return (
    <Show when={record()}>
      {(resolvedRecord) => (
        <MessageItem
          record={resolvedRecord()}
          messageInfo={messageInfo()}
          parts={parts()}
          instanceId={props.instanceId}
          sessionId={props.sessionId}
          isQueued={isQueued()}
          showAgentMeta={showAgentMeta()}
          showDeleteMessage={props.showDeleteMessage}
          onDeleteHoverChange={props.onDeleteHoverChange}
          selectedMessageIds={props.selectedMessageIds}
          onToggleSelectedMessage={props.onToggleSelectedMessage}
          onRevert={props.onRevert}
          onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
          onFork={props.onFork}
          onContentRendered={props.onContentRendered}
        />
      )}
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
  showDeleteMessage?: boolean
  deleteHover?: () => DeleteHoverState
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  selectedMessageIds?: () => Set<string>
  selectedToolPartKeys?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
}

function ToolCallItem(props: ToolCallItemProps) {
  const { t } = useI18n()
  const [deletingMessage, setDeletingMessage] = createSignal(false)
  const [deletingUpTo, setDeletingUpTo] = createSignal(false)

  const isSelectedForDeletion = () => Boolean(props.selectedMessageIds?.().has(props.messageId))

  const isSelectedToolPartForDeletion = () => Boolean(props.selectedToolPartKeys?.().has(`${props.messageId}:${props.partId}`))

  const isDeleteOverlayActive = () => {
    if (isSelectedForDeletion()) return true
    if (isSelectedToolPartForDeletion()) return true
    const hover = props.deleteHover?.() ?? ({ kind: "none" } as DeleteHoverState)
    if (hover.kind === "message") {
      return hover.messageId === props.messageId
    }
    if (hover.kind === "deleteUpTo") {
      const ids = props.store().getSessionMessageIds(props.sessionId)
      const targetIndex = ids.indexOf(hover.messageId)
      if (targetIndex === -1) return false
      const currentIndex = ids.indexOf(props.messageId)
      if (currentIndex === -1) return false
      return currentIndex >= targetIndex
    }
    return false
  }

  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))
  const partEntry = createMemo(() => record()?.parts?.[props.partId])

  const toolPart = createMemo(() => {
    const part = partEntry()?.data as ClientPart | undefined
    if (!part || part.type !== "tool") return undefined
    return part as ToolCallPart
  })

  const toolState = createMemo(() => toolPart()?.state as ToolState | undefined)
  const toolName = createMemo(() => toolPart()?.tool || "")
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

  const handleGoToTaskSession = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const location = taskLocation()
    if (!location) return
    navigateToTaskSession(location)
  }

  const handleDeleteMessage = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    if (!props.showDeleteMessage) return
    if (deletingMessage()) return

    setDeletingMessage(true)
    try {
      await deleteMessage(props.instanceId, props.sessionId, props.messageId)
    } catch (error) {
      showAlertDialog(t("messageItem.actions.deleteMessageFailedMessage"), {
        title: t("messageItem.actions.deleteMessageFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setDeletingMessage(false)
    }
  }

  const handleDeleteUpTo = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!props.showDeleteMessage) return
    if (!props.onDeleteMessagesUpTo) return
    if (deletingUpTo()) return

    setDeletingUpTo(true)
    try {
      await props.onDeleteMessagesUpTo(props.messageId)
    } finally {
      setDeletingUpTo(false)
    }
  }

  return (
    <Show when={toolPart()}>
      {(resolvedToolPart) => (
        <div class="delete-hover-scope" data-delete-part-hover={isDeleteOverlayActive() ? "true" : undefined}>
          <div class="tool-call-header-label">
            <div class="tool-call-header-meta">
              <Show when={props.showDeleteMessage}>
                <input
                  class="message-select-checkbox"
                  type="checkbox"
                  checked={isSelectedForDeletion()}
                  onClick={(event) => {
                    event.stopPropagation()
                  }}
                  onChange={(event) => {
                    event.stopPropagation()
                    const next = Boolean((event.currentTarget as HTMLInputElement).checked)
                    props.onToggleSelectedMessage?.(props.messageId, next)
                  }}
                  aria-label={t("messageItem.selection.checkboxAriaLabel")}
                  title={t("messageItem.selection.checkboxAriaLabel")}
                />
              </Show>

              <span class="tool-call-icon">{TOOL_ICON}</span>
              <span>{t("messageBlock.tool.header")}</span>
              <span class="tool-name">{toolName() || t("messageBlock.tool.unknown")}</span>
            </div>

            <div class="flex items-center gap-0">
              <Show when={taskSessionId()}>
                <button
                  class="tool-call-header-button"
                  type="button"
                  disabled={!taskLocation()}
                  onClick={handleGoToTaskSession}
                  title={t("messageBlock.tool.goToSession.label")}
                  aria-label={t("messageBlock.tool.goToSession.label")}
                >
                  <ExternalLink class="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </Show>

              <Show when={props.showDeleteMessage}>
                <button
                  class="tool-call-header-button"
                  type="button"
                  disabled={!props.onDeleteMessagesUpTo || deletingUpTo()}
                  onClick={handleDeleteUpTo}
                  onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "deleteUpTo", messageId: props.messageId })}
                  onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
                  title={t("messageItem.actions.deleteMessagesUpTo")}
                  aria-label={t("messageItem.actions.deleteMessagesUpTo")}
                >
                  <DeleteUpToIcon />
                </button>

                <button
                  class="tool-call-header-button"
                  type="button"
                  disabled={deletingMessage()}
                  onClick={handleDeleteMessage}
                  onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "message", messageId: props.messageId })}
                  onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
                  title={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
                  aria-label={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
                >
                  <Trash class="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </Show>
            </div>
          </div>

          <ToolCall
            toolCall={resolvedToolPart()}
            toolCallId={props.partId}
            messageId={props.messageId}
            messageVersion={messageVersion()}
            partVersion={partVersion()}
            instanceId={props.instanceId}
            sessionId={props.sessionId}
            onContentRendered={props.onContentRendered}
          />
        </div>
      )}
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
  lastAssistantIndex: () => number
  showThinking: () => boolean
  thinkingDefaultExpanded: () => boolean
  showUsageMetrics: () => boolean
  deleteHover?: () => DeleteHoverState
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  selectedMessageIds?: () => Set<string>
  selectedToolPartKeys?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
  onRevert?: (messageId: string) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  onFork?: (messageId?: string) => void
  onContentRendered?: () => void
}

export default function MessageBlock(props: MessageBlockProps) {
  const { t } = useI18n()
  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))
  const sessionCache = getSessionRenderCache(props.instanceId, props.sessionId)
  const isDeleteMessageHovered = () => {
    const hover = props.deleteHover?.() ?? ({ kind: "none" } as DeleteHoverState)

    const selected = props.selectedMessageIds?.() ?? new Set<string>()
    if (selected.has(props.messageId)) {
      return true
    }

    if (hover.kind === "message") {
      return hover.messageId === props.messageId
    }

    if (hover.kind === "deleteUpTo") {
      const ids = props.store().getSessionMessageIds(props.sessionId)
      const targetIndex = ids.indexOf(hover.messageId)
      if (targetIndex === -1) return false
      const currentIndex = ids.indexOf(props.messageId)
      if (currentIndex === -1) return false
      return currentIndex >= targetIndex
    }

    return false
  }

  const block = createMemo<MessageDisplayBlock | null>(() => {
    const current = record()
    if (!current) return null

    const index = props.messageIndex
    const lastAssistantIdx = props.lastAssistantIndex()
    const isQueued = current.role === "user" && (lastAssistantIdx === -1 || index > lastAssistantIdx)

    // Intentionally untracked: messageInfoVersion updates should not trigger
    // a full message block rebuild; record revision is the invalidation key.
    const info = untrack(messageInfo)

    const cacheSignature = [
      current.id,
      current.revision,
      isQueued ? 1 : 0,
      props.showThinking() ? 1 : 0,
      props.thinkingDefaultExpanded() ? 1 : 0,
      props.showUsageMetrics() ? 1 : 0,
    ].join("|")

    const cachedBlock = sessionCache.messageBlocks.get(current.id)
    if (cachedBlock && cachedBlock.signature === cacheSignature) {
      return cachedBlock.block
    }

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
        lastAccentColor = TOOL_BORDER_COLOR
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
        if (props.showUsageMetrics()) {
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

  return (
    <Show when={block()}>
      {(resolvedBlock) => (
        <div
          class="message-stream-block"
          data-message-id={resolvedBlock().record.id}
          data-delete-message-hover={isDeleteMessageHovered() ? "true" : undefined}
        >
          <For each={resolvedBlock().items}>
            {(item, index) => (
              <Switch>
                <Match when={item.type === "content"}>
                  <MessageContentItem
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    store={props.store}
                    messageId={(item as ContentDisplayItem).messageId}
                    startPartId={(item as ContentDisplayItem).startPartId}
                    messageIndex={props.messageIndex}
                    lastAssistantIndex={props.lastAssistantIndex}
                    showDeleteMessage={index() === 0}
                    onDeleteHoverChange={props.onDeleteHoverChange}
                    onRevert={props.onRevert}
                    onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                    selectedMessageIds={props.selectedMessageIds}
                    onToggleSelectedMessage={props.onToggleSelectedMessage}
                    onFork={props.onFork}
                    onContentRendered={props.onContentRendered}
                  />
                </Match>
                <Match when={item.type === "tool"}>
                  {(() => {
                    const toolItem = item as ToolDisplayItem
                    return (
                      <div class="tool-call-message" data-key={toolItem.key}>
                        <ToolCallItem
                          instanceId={props.instanceId}
                          sessionId={props.sessionId}
                          store={props.store}
                          messageId={toolItem.messageId}
                          partId={toolItem.partId}
                          showDeleteMessage={index() === 0}
                          deleteHover={props.deleteHover}
                          onDeleteHoverChange={props.onDeleteHoverChange}
                          onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                          selectedMessageIds={props.selectedMessageIds}
                          selectedToolPartKeys={props.selectedToolPartKeys}
                          onToggleSelectedMessage={props.onToggleSelectedMessage}
                          onContentRendered={props.onContentRendered}
                        />
                      </div>
                    )
                  })()}
                </Match>
                <Match when={item.type === "step-start"}>
                  <StepCard
                    kind="start"
                    part={(item as StepDisplayItem).part}
                    messageInfo={(item as StepDisplayItem).messageInfo}
                    showAgentMeta
                    showDeleteMessage={index() === 0}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={props.messageId}
                    onDeleteHoverChange={props.onDeleteHoverChange}
                    onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                    selectedMessageIds={props.selectedMessageIds}
                    onToggleSelectedMessage={props.onToggleSelectedMessage}
                  />
                </Match>
                <Match when={item.type === "step-finish"}>
                  <StepCard
                    kind="finish"
                    part={(item as StepDisplayItem).part}
                    messageInfo={(item as StepDisplayItem).messageInfo}
                    showUsage={props.showUsageMetrics()}
                    borderColor={(item as StepDisplayItem).accentColor}
                    showDeleteMessage={index() === 0}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={props.messageId}
                    onDeleteHoverChange={props.onDeleteHoverChange}
                    onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                    selectedMessageIds={props.selectedMessageIds}
                    onToggleSelectedMessage={props.onToggleSelectedMessage}
                  />
                </Match>
                <Match when={item.type === "compaction"}>
                  <CompactionCard
                    part={(item as CompactionDisplayItem).part}
                    messageInfo={(item as CompactionDisplayItem).messageInfo}
                    borderColor={(item as CompactionDisplayItem).accentColor}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={(item as CompactionDisplayItem).messageId}
                    showDeleteMessage={index() === 0}
                    onDeleteHoverChange={props.onDeleteHoverChange}
                    onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                    selectedMessageIds={props.selectedMessageIds}
                    onToggleSelectedMessage={props.onToggleSelectedMessage}
                  />
                </Match>
                <Match when={item.type === "reasoning"}>
                  <ReasoningCard
                    part={(item as ReasoningDisplayItem).part}
                    messageInfo={(item as ReasoningDisplayItem).messageInfo}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={(item as ReasoningDisplayItem).messageId}
                    showAgentMeta={(item as ReasoningDisplayItem).showAgentMeta}
                    defaultExpanded={(item as ReasoningDisplayItem).defaultExpanded}
                    showDeleteMessage={index() === 0}
                    onDeleteHoverChange={props.onDeleteHoverChange}
                    onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                    selectedMessageIds={props.selectedMessageIds}
                    onToggleSelectedMessage={props.onToggleSelectedMessage}
                  />
                </Match>
              </Switch>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}

interface StepCardProps {
  kind: "start" | "finish"
  part: ClientPart
  messageInfo?: MessageInfo
  showAgentMeta?: boolean
  showUsage?: boolean
  borderColor?: string
  showDeleteMessage?: boolean
  instanceId?: string
  sessionId?: string
  messageId?: string
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  selectedMessageIds?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
}

interface CompactionCardProps {
  part: ClientPart
  messageInfo?: MessageInfo
  borderColor?: string
  instanceId: string
  sessionId: string
  messageId: string
  showDeleteMessage?: boolean
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  selectedMessageIds?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
}

function CompactionCard(props: CompactionCardProps) {
  const { t } = useI18n()
  const [deletingMessage, setDeletingMessage] = createSignal(false)
  const [deletingUpTo, setDeletingUpTo] = createSignal(false)
  const isSelectedForDeletion = () => Boolean(props.selectedMessageIds?.().has(props.messageId))
  const isAuto = () => Boolean((props.part as any)?.auto)
  const label = () => (isAuto() ? t("messageBlock.compaction.autoLabel") : t("messageBlock.compaction.manualLabel"))
  const borderColor = () => props.borderColor ?? (isAuto() ? "var(--session-status-compacting-fg)" : USER_BORDER_COLOR)

  const containerClass = () =>
    `message-compaction-card ${isAuto() ? "message-compaction-card--auto" : "message-compaction-card--manual"}`

  const canDeleteMessage = () => Boolean(props.showDeleteMessage) && !deletingMessage()

  const handleDeleteMessage = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!props.showDeleteMessage) return
    if (!canDeleteMessage()) return
    setDeletingMessage(true)
    try {
      await deleteMessage(props.instanceId, props.sessionId, props.messageId)
    } catch (error) {
      showAlertDialog(t("messageItem.actions.deleteMessageFailedMessage"), {
        title: t("messageItem.actions.deleteMessageFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setDeletingMessage(false)
    }
  }

  const handleDeleteUpTo = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!props.showDeleteMessage) return
    if (!props.onDeleteMessagesUpTo) return
    if (deletingUpTo()) return

    setDeletingUpTo(true)
    try {
      await props.onDeleteMessagesUpTo(props.messageId)
    } finally {
      setDeletingUpTo(false)
    }
  }

  return (
    <div
      class={`delete-hover-scope ${containerClass()} relative`}
      style={{ "border-left": `4px solid ${borderColor()}` }}
      role="status"
      aria-label={t("messageBlock.compaction.ariaLabel")}
    >
      <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
        <Show when={props.showDeleteMessage}>
          <button
            type="button"
            class="tool-call-header-button"
            disabled={!props.onDeleteMessagesUpTo || deletingUpTo()}
            onClick={handleDeleteUpTo}
            onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "deleteUpTo", messageId: props.messageId })}
            onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
            title={t("messageItem.actions.deleteMessagesUpTo")}
            aria-label={t("messageItem.actions.deleteMessagesUpTo")}
          >
            <DeleteUpToIcon />
          </button>

          <button
            type="button"
            class="tool-call-header-button"
            disabled={!canDeleteMessage()}
            onClick={handleDeleteMessage}
            onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "message", messageId: props.messageId })}
            onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
            title={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
            aria-label={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
          >
            <Trash class="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </Show>
      </div>

      <div class="message-compaction-row">
        <Show when={props.showDeleteMessage}>
          <input
            class="message-select-checkbox"
            type="checkbox"
            checked={isSelectedForDeletion()}
            onClick={(event) => {
              event.stopPropagation()
            }}
            onChange={(event) => {
              event.stopPropagation()
              const next = Boolean((event.currentTarget as HTMLInputElement).checked)
              props.onToggleSelectedMessage?.(props.messageId, next)
            }}
            aria-label={t("messageItem.selection.checkboxAriaLabel")}
            title={t("messageItem.selection.checkboxAriaLabel")}
          />
        </Show>

        <FoldVertical class="message-compaction-icon w-4 h-4" aria-hidden="true" />
        <span class="message-compaction-label">{label()}</span>
      </div>
    </div>
  )
}

function StepCard(props: StepCardProps) {
  const { t } = useI18n()
  const [deletingMessage, setDeletingMessage] = createSignal(false)
  const [deletingUpTo, setDeletingUpTo] = createSignal(false)
  const isSelectedForDeletion = () => Boolean(props.messageId && props.selectedMessageIds?.().has(props.messageId))
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
    if (props.kind !== "finish" || !props.showUsage) {
      return null
    }
    const info = props.messageInfo
    if (!info || info.role !== "assistant" || !info.tokens) {
      return null
    }
    const tokens = info.tokens
    return {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cacheRead: tokens.cache?.read ?? 0,
      cacheWrite: tokens.cache?.write ?? 0,
      cost: info.cost ?? 0,
    }
  }

  const finishStyle = () => (props.borderColor ? { "border-left-color": props.borderColor } : undefined)

  const canDeleteMessage = () =>
    Boolean(props.showDeleteMessage && props.instanceId && props.sessionId && props.messageId) && !deletingMessage()

  const handleDeleteMessage = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!canDeleteMessage()) return
    setDeletingMessage(true)
    try {
      await deleteMessage(props.instanceId!, props.sessionId!, props.messageId!)
    } catch (error) {
      showAlertDialog(t("messageItem.actions.deleteMessageFailedMessage"), {
        title: t("messageItem.actions.deleteMessageFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setDeletingMessage(false)
    }
  }

  const handleDeleteUpTo = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!props.messageId) return
    if (!props.onDeleteMessagesUpTo) return
    if (deletingUpTo()) return

    setDeletingUpTo(true)
    try {
      await props.onDeleteMessagesUpTo(props.messageId)
    } finally {
      setDeletingUpTo(false)
    }
  }


  const renderUsageChips = (usage: NonNullable<ReturnType<typeof usageStats>>) => {
    const entries = [
      { label: t("messageBlock.usage.input"), value: usage.input, formatter: formatTokenTotal },
      { label: t("messageBlock.usage.output"), value: usage.output, formatter: formatTokenTotal },
      { label: t("messageBlock.usage.reasoning"), value: usage.reasoning, formatter: formatTokenTotal },
      { label: t("messageBlock.usage.cacheRead"), value: usage.cacheRead, formatter: formatTokenTotal },
      { label: t("messageBlock.usage.cacheWrite"), value: usage.cacheWrite, formatter: formatTokenTotal },
      { label: t("messageBlock.usage.cost"), value: usage.cost, formatter: formatCostValue },
    ]

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
      <div class={`message-step-card message-step-finish message-step-finish-flush relative`} style={finishStyle()}>
        <Show when={props.showDeleteMessage && props.messageId}>
          <input
            class="message-select-checkbox absolute left-2 top-1/2 -translate-y-1/2"
            type="checkbox"
            checked={isSelectedForDeletion()}
            onClick={(event) => {
              event.stopPropagation()
            }}
            onChange={(event) => {
              event.stopPropagation()
              const next = Boolean((event.currentTarget as HTMLInputElement).checked)
              props.onToggleSelectedMessage?.(props.messageId!, next)
            }}
            aria-label={t("messageItem.selection.checkboxAriaLabel")}
            title={t("messageItem.selection.checkboxAriaLabel")}
          />
        </Show>

        <Show when={props.showDeleteMessage}>
          <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <button
              type="button"
              class="message-action-button"
              disabled={!props.onDeleteMessagesUpTo || deletingUpTo()}
              onClick={handleDeleteUpTo}
              onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "deleteUpTo", messageId: props.messageId! })}
              onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
              title={t("messageItem.actions.deleteMessagesUpTo")}
              aria-label={t("messageItem.actions.deleteMessagesUpTo")}
            >
              <DeleteUpToIcon />
            </button>

            <button
              type="button"
              class="message-action-button"
              disabled={!canDeleteMessage()}
              onClick={handleDeleteMessage}
              onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "message", messageId: props.messageId! })}
              onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
              title={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
              aria-label={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
            >
              <Trash class="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </Show>

        {renderUsageChips(usage)}
      </div>
    )
  }

  return (
    <div class={`message-step-card message-step-start relative`}>
      <div class="message-step-heading">
        <div class="message-step-title">
          <div class="message-step-title-left">
            <Show when={props.showDeleteMessage && props.messageId}>
              <input
                class="message-select-checkbox"
                type="checkbox"
                checked={isSelectedForDeletion()}
                onClick={(event) => {
                  event.stopPropagation()
                }}
                onChange={(event) => {
                  event.stopPropagation()
                  const next = Boolean((event.currentTarget as HTMLInputElement).checked)
                  props.onToggleSelectedMessage?.(props.messageId!, next)
                }}
                aria-label={t("messageItem.selection.checkboxAriaLabel")}
                title={t("messageItem.selection.checkboxAriaLabel")}
              />
            </Show>

            <Show when={props.showAgentMeta && (agentIdentifier() || modelIdentifier())}>
              <span class="message-step-meta-inline">
                <Show when={agentIdentifier()}>{(value) => <span>{t("messageBlock.step.agentLabel", { agent: value() })}</span>}</Show>
                <Show when={modelIdentifier()}>{(value) => <span>{t("messageBlock.step.modelLabel", { model: value() })}</span>}</Show>
              </span>
            </Show>
          </div>
          <span class="message-step-time">{timestamp()}</span>
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
  instanceId: string
  sessionId: string
  messageId: string
  showAgentMeta?: boolean
  defaultExpanded?: boolean
  showDeleteMessage?: boolean
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  selectedMessageIds?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
}

function ReasoningCard(props: ReasoningCardProps) {
  const { t } = useI18n()
  const [expanded, setExpanded] = createSignal(Boolean(props.defaultExpanded))
  const [deletingMessage, setDeletingMessage] = createSignal(false)
  const [deletingUpTo, setDeletingUpTo] = createSignal(false)
  const isSelectedForDeletion = () => Boolean(props.selectedMessageIds?.().has(props.messageId))

  createEffect(() => {
    setExpanded(Boolean(props.defaultExpanded))
  })

  const timestamp = () => {
    const value = props.messageInfo?.time?.created ?? (props.part as any)?.time?.start ?? Date.now()
    const date = new Date(value)
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

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

  const hasMeta = () => Boolean(props.showAgentMeta && (agentIdentifier() || modelIdentifier()))

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

  const toggle = () => setExpanded((prev) => !prev)

  const viewHideLabel = () =>
    expanded() ? t("messageBlock.reasoning.indicator.hide") : t("messageBlock.reasoning.indicator.view")

  const canDeleteMessage = () => Boolean(props.showDeleteMessage) && !deletingMessage()

  const handleDeleteMessage = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!props.showDeleteMessage) return
    if (!canDeleteMessage()) return
    setDeletingMessage(true)
    try {
      await deleteMessage(props.instanceId, props.sessionId, props.messageId)
    } catch (error) {
      showAlertDialog(t("messageItem.actions.deleteMessageFailedMessage"), {
        title: t("messageItem.actions.deleteMessageFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setDeletingMessage(false)
    }
  }

  const handleDeleteUpTo = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!props.showDeleteMessage) return
    if (!props.onDeleteMessagesUpTo) return
    if (deletingUpTo()) return

    setDeletingUpTo(true)
    try {
      await props.onDeleteMessagesUpTo(props.messageId)
    } finally {
      setDeletingUpTo(false)
    }
  }

  return (
    <div class="delete-hover-scope message-reasoning-card">
      <div class="message-reasoning-header">
        <button
          type="button"
          class="message-reasoning-toggle"
          onClick={toggle}
          aria-expanded={expanded()}
          aria-label={expanded() ? t("messageBlock.reasoning.collapseAriaLabel") : t("messageBlock.reasoning.expandAriaLabel")}
        >
          <span class="message-reasoning-label">
            <span class="message-reasoning-label-primary">
              <Show when={props.showDeleteMessage}>
                <input
                  class="message-select-checkbox"
                  type="checkbox"
                  checked={isSelectedForDeletion()}
                  onClick={(event) => {
                    event.stopPropagation()
                  }}
                  onChange={(event) => {
                    event.stopPropagation()
                    const next = Boolean((event.currentTarget as HTMLInputElement).checked)
                    props.onToggleSelectedMessage?.(props.messageId, next)
                  }}
                  aria-label={t("messageItem.selection.checkboxAriaLabel")}
                  title={t("messageItem.selection.checkboxAriaLabel")}
                />
              </Show>

              <span>{t("messageBlock.reasoning.thinkingLabel")}</span>
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
              toggle()
            }}
            aria-label={viewHideLabel()}
            title={viewHideLabel()}
          >
            <Show when={expanded()} fallback={<ChevronsUpDown class="w-3.5 h-3.5" aria-hidden="true" />}>
              <ChevronsDownUp class="w-3.5 h-3.5" aria-hidden="true" />
            </Show>
          </button>

          <Show when={props.showDeleteMessage}>
            <button
              type="button"
              class="message-action-button"
              onClick={handleDeleteUpTo}
              disabled={!props.onDeleteMessagesUpTo || deletingUpTo()}
              onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "deleteUpTo", messageId: props.messageId })}
              onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
              aria-label={t("messageItem.actions.deleteMessagesUpTo")}
              title={t("messageItem.actions.deleteMessagesUpTo")}
            >
              <DeleteUpToIcon />
            </button>

            <button
              type="button"
              class="message-action-button"
              onClick={handleDeleteMessage}
              disabled={!canDeleteMessage()}
              onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "message", messageId: props.messageId })}
              onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
              aria-label={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
              title={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
            >
              <Trash class="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </Show>

          <span class="message-reasoning-time">{timestamp()}</span>
        </div>
      </div>

      <Show when={hasMeta()}>
        <div class="message-reasoning-meta-row">
          <span class="message-step-meta-inline">
            <Show when={agentIdentifier()}>
              {(value) => (
                <span class="font-medium text-[var(--message-assistant-border)]">{t("messageBlock.step.agentLabel", { agent: value() })}</span>
              )}
            </Show>
            <Show when={modelIdentifier()}>
              {(value) => (
                <span class="font-medium text-[var(--message-assistant-border)]">{t("messageBlock.step.modelLabel", { model: value() })}</span>
              )}
            </Show>
          </span>
        </div>
      </Show>

      <Show when={expanded()}>
        <div class="message-reasoning-expanded">
          <div class="message-reasoning-body">
            <div class="message-reasoning-output" role="region" aria-label={t("messageBlock.reasoning.detailsAriaLabel")}>
              <pre class="message-reasoning-text">{reasoningText() || ""}</pre>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
