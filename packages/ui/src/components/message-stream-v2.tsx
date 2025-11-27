import { For, Match, Show, Switch, createMemo, createSignal, createEffect, onCleanup } from "solid-js"
import MessageItem from "./message-item"
import ToolCall from "./tool-call"
import Kbd from "./kbd"
import type { MessageInfo, ClientPart } from "../types/message"
import { partHasRenderableText } from "../types/message"
import { getSessionInfo, sessions, setActiveParentSession, setActiveSession } from "../stores/sessions"
import { showCommandPalette } from "../stores/command-palette"
import { messageStoreBus } from "../stores/message-v2/bus"
import type { MessageRecord } from "../stores/message-v2/types"
import { buildRecordDisplayData, clearRecordDisplayCacheForInstance } from "../stores/message-v2/record-display-cache"
import { useConfig } from "../stores/preferences"
import { sseManager } from "../lib/sse-manager"
import { formatTokenTotal } from "../lib/formatters"
import { useScrollCache } from "../lib/hooks/use-scroll-cache"
import { setActiveInstanceId } from "../stores/instances"

const SCROLL_SCOPE = "session"
const SCROLL_DIRECTION_THRESHOLD = 10
const USER_SCROLL_INTENT_WINDOW_MS = 600
const SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])

const TOOL_ICON = "🔧"
const codeNomadLogo = new URL("../images/CodeNomad-Icon.png", import.meta.url).href

const USER_BORDER_COLOR = "var(--message-user-border)"
const ASSISTANT_BORDER_COLOR = "var(--message-assistant-border)"
const TOOL_BORDER_COLOR = "var(--message-tool-border)"

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

type ToolState = import("@opencode-ai/sdk").ToolState
type ToolStateRunning = import("@opencode-ai/sdk").ToolStateRunning
type ToolStateCompleted = import("@opencode-ai/sdk").ToolStateCompleted
type ToolStateError = import("@opencode-ai/sdk").ToolStateError

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

interface TaskSessionLocation {
  sessionId: string
  instanceId: string
  parentId: string | null
}

function findTaskSessionLocation(sessionId: string): TaskSessionLocation | null {
  if (!sessionId) return null
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

function formatTokens(tokens: number): string {
  return formatTokenTotal(tokens)
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


interface MessageStreamV2Props {
  instanceId: string
  sessionId: string
  loading?: boolean
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
}

interface ContentDisplayItem {
  type: "content"
  key: string
  record: MessageRecord
  parts: ClientPart[]
  messageInfo?: MessageInfo
  isQueued: boolean
  showAgentMeta?: boolean
}

interface ToolDisplayItem {
  type: "tool"
  key: string
  toolPart: ToolCallPart
  messageInfo?: MessageInfo
  messageId: string
  messageVersion: number
  partVersion: number
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
}

type MessageBlockItem = ContentDisplayItem | ToolDisplayItem | StepDisplayItem | ReasoningDisplayItem

interface MessageDisplayBlock {
  record: MessageRecord
  items: MessageBlockItem[]
}

export default function MessageStreamV2(props: MessageStreamV2Props) {
  const { preferences } = useConfig()
  const showUsagePreference = () => preferences().showUsageMetrics ?? true
  const store = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))
  const messageIds = createMemo(() => store().getSessionMessageIds(props.sessionId))
  const messageRecords = createMemo(() =>
    messageIds()
      .map((id) => store().getMessage(id))
      .filter((record): record is MessageRecord => Boolean(record)),
  )

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

  const messageInfoMap = createMemo(() => {
    const map = new Map<string, MessageInfo>()
    messageRecords().forEach((record) => {
      const info = store().getMessageInfo(record.id)
      if (info) {
        map.set(record.id, info)
      }
    })
    return map
  })
  const revertTarget = createMemo(() => store().getSessionRevert(props.sessionId))

  const messageIndexMap = createMemo(() => {
    const map = new Map<string, number>()
    const records = messageRecords()
    records.forEach((record, index) => map.set(record.id, index))
    return map
  })

  const lastAssistantIndex = createMemo(() => {
    const records = messageRecords()
    for (let index = records.length - 1; index >= 0; index--) {
      if (records[index].role === "assistant") {
        return index
      }
    }
    return -1
  })

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

  const displayBlocks = createMemo<MessageDisplayBlock[]>(() => {
    const infoMap = messageInfoMap()
    const showThinking = preferences().showThinkingBlocks
    const showUsageMetrics = showUsagePreference()
    const thinkingDefaultExpanded = (preferences().thinkingBlocksExpansion ?? "expanded") === "expanded"
    const revert = revertTarget()
    const instanceId = props.instanceId
    const sessionCache = getSessionRenderCache(instanceId, props.sessionId)
    const blocks: MessageDisplayBlock[] = []
    const usedMessageKeys = new Set<string>()
    const usedToolKeys = new Set<string>()
    const activeMessageIds = new Set<string>()
    const records = messageRecords()
    const assistantIndex = lastAssistantIndex()
    const indexMap = messageIndexMap()
 
    for (const record of records) {

      if (revert?.messageID && record.id === revert.messageID) {
        break
      }

      const { orderedParts } = buildRecordDisplayData(instanceId, record)
      const messageInfo = infoMap.get(record.id)
      const recordIndex = indexMap.get(record.id) ?? 0
      const isQueued = record.role === "user" && (assistantIndex === -1 || recordIndex > assistantIndex)
      const infoTime = (messageInfo?.time ?? {}) as { created?: number; updated?: number; completed?: number }
      const infoTimestamp = typeof infoTime.completed === "number"
        ? infoTime.completed
        : typeof infoTime.updated === "number"
          ? infoTime.updated
          : infoTime.created ?? 0
      const infoError = (messageInfo as { error?: { name?: string } } | undefined)?.error
      const infoErrorName = typeof infoError?.name === "string" ? infoError.name : ""
      const cacheSignature = [
        record.id,
        record.revision,
        isQueued ? 1 : 0,
        showThinking ? 1 : 0,
        thinkingDefaultExpanded ? 1 : 0,
        showUsageMetrics ? 1 : 0,
        infoTimestamp,
        infoErrorName,
      ].join("|")
      const cachedBlock = sessionCache.messageBlocks.get(record.id)
      if (cachedBlock && cachedBlock.signature === cacheSignature) {
        cachedBlock.contentKeys.forEach((key) => usedMessageKeys.add(key))
        cachedBlock.toolKeys.forEach((key) => usedToolKeys.add(key))
        blocks.push(cachedBlock.block)
        activeMessageIds.add(record.id)
        continue
      }
 
      const items: MessageBlockItem[] = []
      const blockContentKeys: string[] = []
      const blockToolKeys: string[] = []
      let segmentIndex = 0
      let pendingParts: ClientPart[] = []
      let agentMetaAttached = record.role !== "assistant"
      const defaultAccentColor = record.role === "user" ? USER_BORDER_COLOR : ASSISTANT_BORDER_COLOR
      let lastAccentColor = defaultAccentColor


      const flushContent = () => {
        if (pendingParts.length === 0) return
        const segmentKey = `${record.id}:segment:${segmentIndex}`
        segmentIndex += 1
        const shouldShowAgentMeta =
          record.role === "assistant" &&
          !agentMetaAttached &&
          pendingParts.some((part) => partHasRenderableText(part))
        let cached = sessionCache.messageItems.get(segmentKey)
        if (!cached) {
          cached = {
            type: "content",
            key: segmentKey,
            record,
            parts: pendingParts.slice(),
            messageInfo,
            isQueued,
            showAgentMeta: shouldShowAgentMeta,
          }
          sessionCache.messageItems.set(segmentKey, cached)
        } else {
          cached.record = record
          cached.parts = pendingParts.slice()
          cached.messageInfo = messageInfo
          cached.isQueued = isQueued
          cached.showAgentMeta = shouldShowAgentMeta
        }
        if (shouldShowAgentMeta) {
          agentMetaAttached = true
        }
        items.push(cached)
        usedMessageKeys.add(segmentKey)
        blockContentKeys.push(segmentKey)
        lastAccentColor = defaultAccentColor
        pendingParts = []
      }

      orderedParts.forEach((part, partIndex) => {
        if (part.type === "tool") {
          flushContent()
          const partRevision = typeof part.revision === "number" ? part.revision : 0
          const messageVersion = record.revision
          const key = `${record.id}:${part.id ?? partIndex}`
          let toolItem = sessionCache.toolItems.get(key)
          if (!toolItem) {
            toolItem = {
              type: "tool",
              key,
              toolPart: part as ToolCallPart,
              messageInfo,
              messageId: record.id,
              messageVersion,
              partRevision,
            }
            sessionCache.toolItems.set(key, toolItem)
          } else {
            toolItem.key = key
            toolItem.toolPart = part as ToolCallPart
            toolItem.messageInfo = messageInfo
            toolItem.messageId = record.id
            toolItem.messageVersion = messageVersion
            toolItem.partRevision = partRevision
          }
          items.push(toolItem)
          usedToolKeys.add(key)
          blockToolKeys.push(key)
          lastAccentColor = TOOL_BORDER_COLOR
          return
        }

        if (part.type === "step-start") {
          flushContent()
          return
        }

        if (part.type === "step-finish") {
          flushContent()
          if (showUsageMetrics) {
            const key = `${record.id}:${part.id ?? partIndex}:${part.type}`
            const accentColor = lastAccentColor || defaultAccentColor
            items.push({ type: part.type, key, part, messageInfo, accentColor })
            lastAccentColor = accentColor
          }
          return
        }

        if (part.type === "reasoning") {
          flushContent()
          if (showThinking && reasoningHasRenderableContent(part)) {
            const key = `${record.id}:${part.id ?? partIndex}:reasoning`
            const showAgentMeta = record.role === "assistant" && !agentMetaAttached
            if (showAgentMeta) {
              agentMetaAttached = true
            }
            items.push({
              type: "reasoning",
              key,
              part,
              messageInfo,
              showAgentMeta,
              defaultExpanded: thinkingDefaultExpanded,
            })
            lastAccentColor = ASSISTANT_BORDER_COLOR
          }
          return
        }

        pendingParts.push(part)
      })

      flushContent()

      if (items.length === 0) {
        continue
      }

      const resultBlock: MessageDisplayBlock = { record, items }
      blocks.push(resultBlock)
      sessionCache.messageBlocks.set(record.id, {
        signature: cacheSignature,
        block: resultBlock,
        contentKeys: blockContentKeys.slice(),
        toolKeys: blockToolKeys.slice(),
      })
      activeMessageIds.add(record.id)
    }
 
    for (const [key] of sessionCache.messageItems) {
      if (!usedMessageKeys.has(key)) {
        sessionCache.messageItems.delete(key)
      }
    }
    for (const [key] of sessionCache.toolItems) {
      if (!usedToolKeys.has(key)) {
        sessionCache.toolItems.delete(key)
      }
    }
    for (const [messageId] of sessionCache.messageBlocks) {
      if (!activeMessageIds.has(messageId)) {
        sessionCache.messageBlocks.delete(messageId)
      }
    }
 
    return blocks

  })

  const changeToken = createMemo(() => {
    const revisionValue = sessionRevision()
    const blocks = displayBlocks()
    if (blocks.length === 0) {
      return `${revisionValue}:empty`
    }
    const lastBlock = blocks[blocks.length - 1]
    const lastItem = lastBlock.items[lastBlock.items.length - 1]
    let tailSignature: string
    if (!lastItem) {
      tailSignature = `msg:${lastBlock.record.id}:${lastBlock.record.revision}`
    } else if (lastItem.type === "tool") {
      tailSignature = `tool:${lastItem.key}:${lastItem.partRevision}`
    } else if (lastItem.type === "content") {
      tailSignature = `content:${lastItem.key}:${lastBlock.record.revision}`
    } else {
      const revision = typeof lastItem.part.revision === "number" ? lastItem.part.revision : lastBlock.record.revision
      tailSignature = `step:${lastItem.key}:${revision}`
    }
    return `${revisionValue}:${tailSignature}`
  })

  const scrollCache = useScrollCache({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    scope: SCROLL_SCOPE,
  })

  const [autoScroll, setAutoScroll] = createSignal(true)
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  let containerRef: HTMLDivElement | undefined
  let lastKnownScrollTop = 0
  let lastMeasuredScrollHeight = 0
  let pendingScrollFrame: number | null = null
  let userScrollIntentUntil = 0
  let detachScrollIntentListeners: (() => void) | undefined

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
    lastKnownScrollTop = containerRef?.scrollTop ?? 0
    lastMeasuredScrollHeight = containerRef?.scrollHeight ?? 0
    attachScrollIntentListeners(containerRef)
  }

  function isNearBottom(element: HTMLDivElement, offset = 48) {
    const { scrollTop, scrollHeight, clientHeight } = element
    return scrollHeight - (scrollTop + clientHeight) <= offset
  }

  function isNearTop(element: HTMLDivElement, offset = 48) {
    return element.scrollTop <= offset
  }

  function updateScrollIndicators(element: HTMLDivElement) {
    const hasItems = displayBlocks().length > 0
    setShowScrollBottomButton(hasItems && !isNearBottom(element))
    setShowScrollTopButton(hasItems && !isNearTop(element))
  }
 
  function scrollToBottom(immediate = false) {
    if (!containerRef) return
    const behavior = immediate ? "auto" : "smooth"
    requestAnimationFrame(() => {
      if (!containerRef) return
      containerRef.scrollTo({ top: containerRef.scrollHeight, behavior })
      setAutoScroll(true)
      lastMeasuredScrollHeight = containerRef.scrollHeight
      lastKnownScrollTop = containerRef.scrollTop
      updateScrollIndicators(containerRef)
      scheduleScrollPersist()
    })
  }
 
  function scrollToBottomAndClamp(immediate = false) {
    scrollToBottom(immediate)
    requestAnimationFrame(() => clampScrollAfterShrink())
  }
 
  function scrollToTop(immediate = false) {
    if (!containerRef) return
    const behavior = immediate ? "auto" : "smooth"
    setAutoScroll(false)
    requestAnimationFrame(() => {
      if (!containerRef) return
      containerRef.scrollTo({ top: 0, behavior })
      lastMeasuredScrollHeight = containerRef.scrollHeight
      lastKnownScrollTop = containerRef.scrollTop
      updateScrollIndicators(containerRef)
      scheduleScrollPersist()
    })
  }
 
  let pendingScrollPersist: number | null = null
  function scheduleScrollPersist() {
    if (pendingScrollPersist !== null) return
    pendingScrollPersist = requestAnimationFrame(() => {
      pendingScrollPersist = null
      if (!containerRef) return
      scrollCache.persist(containerRef, { atBottomOffset: 48 })
    })
  }

  function clampScrollAfterShrink() {
    if (!containerRef || !autoScroll()) return
    const currentHeight = containerRef.scrollHeight
    const clientHeight = containerRef.clientHeight
    if (currentHeight < lastMeasuredScrollHeight) {
      const maxScrollTop = Math.max(currentHeight - clientHeight, 0)
      containerRef.scrollTo({ top: maxScrollTop, behavior: "auto" })
      lastKnownScrollTop = containerRef.scrollTop
    }
    lastMeasuredScrollHeight = currentHeight
  }


 
  function handleScroll(event: Event) {
    if (!containerRef) return
    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame)
    }
    const isUserScroll = hasUserScrollIntent()
    pendingScrollFrame = requestAnimationFrame(() => {
      pendingScrollFrame = null
      if (!containerRef) return
      const previousTop = lastKnownScrollTop
      const currentTop = containerRef.scrollTop
      const movingUp = currentTop < previousTop - SCROLL_DIRECTION_THRESHOLD
      const movingDown = currentTop > previousTop + SCROLL_DIRECTION_THRESHOLD
      lastKnownScrollTop = currentTop
      lastMeasuredScrollHeight = containerRef.scrollHeight
      const atBottom = isNearBottom(containerRef)
      if (isUserScroll) {
        if (movingUp && !atBottom && autoScroll()) {
          setAutoScroll(false)
        } else if (movingDown && atBottom && !autoScroll()) {
          setAutoScroll(true)
        }
      }
      updateScrollIndicators(containerRef)
      scheduleScrollPersist()
    })
  }
 
  createEffect(() => {
    const target = containerRef
    if (!target) return
    scrollCache.restore(target, {
      fallback: () => scrollToBottom(true),
      onApplied: (snapshot) => {
        if (snapshot) {
          setAutoScroll(snapshot.atBottom)
        } else {
          const atBottom = isNearBottom(target)
          setAutoScroll(atBottom)
        }
        lastMeasuredScrollHeight = target.scrollHeight
        updateScrollIndicators(target)
      },
    })
  })
 
  let previousToken: string | undefined
 
  createEffect(() => {
    const token = changeToken()
    if (!token || token === previousToken) {
      return
    }
    previousToken = token
    if (autoScroll()) {
      scrollToBottomAndClamp(true)
    }
  })
 
  createEffect(() => {
    preferenceSignature()
    if (!autoScroll()) {
      return
    }
    scrollToBottomAndClamp(true)
  })
 
  createEffect(() => {
    if (messageRecords().length === 0) {
      setShowScrollTopButton(false)
      setShowScrollBottomButton(false)
      setAutoScroll(true)
    }
  })

 
  onCleanup(() => {
    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame)
      pendingScrollFrame = null
    }
    if (pendingScrollPersist !== null) {
      cancelAnimationFrame(pendingScrollPersist)
      pendingScrollPersist = null
    }
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
      detachScrollIntentListeners = undefined
    }
    if (containerRef) {
      scrollCache.persist(containerRef, { atBottomOffset: 48 })
    }
  })


  return (
    <div class="message-stream-container">
      <div class="connection-status">
        <div class="connection-status-text connection-status-info flex flex-wrap items-center gap-2 text-sm font-medium">
          <div class="inline-flex items-center gap-1 rounded-full border border-base px-2 py-0.5 text-xs text-primary">
            <span class="uppercase text-[10px] tracking-wide text-primary/70">Used</span>
            <span class="font-semibold text-primary">{formatTokens(tokenStats().used)}</span>
          </div>
          <div class="inline-flex items-center gap-1 rounded-full border border-base px-2 py-0.5 text-xs text-primary">
            <span class="uppercase text-[10px] tracking-wide text-primary/70">Avail</span>
            <span class="font-semibold text-primary">
              {sessionInfo().contextAvailableTokens !== null ? formatTokens(sessionInfo().contextAvailableTokens ?? 0) : "--"}
            </span>
          </div>
        </div>

        <div class="connection-status-text connection-status-shortcut">
          <div class="connection-status-shortcut-action">
            <button type="button" class="connection-status-button" onClick={handleCommandPaletteClick} aria-label="Open command palette">
              Command Palette
            </button>
            <span class="connection-status-shortcut-hint">
              <Kbd shortcut="cmd+shift+p" />
            </span>
          </div>
        </div>
        <div class="connection-status-meta flex items-center justify-end gap-3">
          <Show when={connectionStatus() === "connected"}>
            <span class="status-indicator connected">
              <span class="status-dot" />
              Connected
            </span>
          </Show>
          <Show when={connectionStatus() === "connecting"}>
            <span class="status-indicator connecting">
              <span class="status-dot" />
              Connecting...
            </span>
          </Show>
          <Show when={connectionStatus() === "error" || connectionStatus() === "disconnected"}>
            <span class="status-indicator disconnected">
              <span class="status-dot" />
              Disconnected
            </span>
          </Show>
        </div>
      </div>

      <div
        class="message-stream"
        ref={setContainerRef}
        onScroll={handleScroll}
      >
        <Show when={!props.loading && displayBlocks().length === 0}>
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

        <For each={displayBlocks()}>
          {(block) => (
            <div class="message-stream-block" data-message-id={block.record.id}>
              <For each={block.items}>
                {(item) => (
                  <Switch>
                    <Match when={item.type === "content"}>
                      <MessageItem
                        record={(item as ContentDisplayItem).record}
                        messageInfo={(item as ContentDisplayItem).messageInfo}
                        combinedParts={(item as ContentDisplayItem).parts}
                        orderedParts={(item as ContentDisplayItem).parts}
                        instanceId={props.instanceId}
                        sessionId={props.sessionId}
                        isQueued={(item as ContentDisplayItem).isQueued}
                        showAgentMeta={(item as ContentDisplayItem).showAgentMeta}
                        onRevert={props.onRevert}
                        onFork={props.onFork}
                      />
                    </Match>
                    <Match when={item.type === "tool"}>
                      {(() => {
                        const toolItem = item as ToolDisplayItem
                        const toolState = toolItem.toolPart.state as ToolState | undefined
                        const hasToolState =
                          Boolean(toolState) &&
                          (isToolStateRunning(toolState) || isToolStateCompleted(toolState) || isToolStateError(toolState))
                        const taskSessionId = hasToolState ? extractTaskSessionId(toolState) : ""
                        const taskLocation = taskSessionId ? findTaskSessionLocation(taskSessionId) : null
                        const handleGoToTaskSession = (event: MouseEvent) => {
                          event.preventDefault()
                          event.stopPropagation()
                          if (!taskLocation) return
                          navigateToTaskSession(taskLocation)
}



                        return (
                          <div class="tool-call-message" data-key={toolItem.key}>
                            <div class="tool-call-header-label">
                              <div class="tool-call-header-meta">
                                <span class="tool-call-icon">{TOOL_ICON}</span>
                                <span>Tool Call</span>
                                <span class="tool-name">{toolItem.toolPart.tool || "unknown"}</span>
                              </div>
                              <Show when={taskSessionId}>
                                <button
                                  class="tool-call-header-button"
                                  type="button"
                                  disabled={!taskLocation}
                                  onClick={handleGoToTaskSession}
                                  title={!taskLocation ? "Session not available yet" : "Go to session"}
                                >
                                  Go to Session
                                </button>
                              </Show>
                            </div>
                            <ToolCall
                              toolCall={toolItem.toolPart}
                              toolCallId={toolItem.key}
                              messageId={toolItem.messageId}
                              messageVersion={toolItem.messageVersion}
                              partVersion={toolItem.partVersion}
                              instanceId={props.instanceId}
                              sessionId={props.sessionId}
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
                      />
                    </Match>
                    <Match when={item.type === "step-finish"}>
                      <StepCard
                        kind="finish"
                        part={(item as StepDisplayItem).part}
                        messageInfo={(item as StepDisplayItem).messageInfo}
                        showUsage={showUsagePreference()}
                        borderColor={(item as StepDisplayItem).accentColor}
                      />
                    </Match>
                    <Match when={item.type === "reasoning"}>
                      <ReasoningCard
                        part={(item as ReasoningDisplayItem).part}
                        messageInfo={(item as ReasoningDisplayItem).messageInfo}
                        instanceId={props.instanceId}
                        sessionId={props.sessionId}
                        showAgentMeta={(item as ReasoningDisplayItem).showAgentMeta}
                        defaultExpanded={(item as ReasoningDisplayItem).defaultExpanded}
                      />
                    </Match>
                  </Switch>
                )}
              </For>
            </div>
          )}
        </For>
      </div>

      <Show when={showScrollTopButton() || showScrollBottomButton()}>
        <div class="message-scroll-button-wrapper">
          <Show when={showScrollTopButton()}>
            <button
              type="button"
              class="message-scroll-button"
              onClick={() => scrollToTop()}
              aria-label="Scroll to first message"
            >
              <span class="message-scroll-icon" aria-hidden="true">
                ↑
              </span>
            </button>
          </Show>
          <Show when={showScrollBottomButton()}>
            <button
              type="button"
              class="message-scroll-button"
              onClick={() => scrollToBottom()}
              aria-label="Scroll to latest message"
            >
              <span class="message-scroll-icon" aria-hidden="true">
                ↓
              </span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

interface StepCardProps {
  kind: "start" | "finish"
  part: ClientPart
  messageInfo?: MessageInfo
  showAgentMeta?: boolean
  showUsage?: boolean
  borderColor?: string
}

function StepCard(props: StepCardProps) {
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
    const input = tokens.input ?? 0
    const output = tokens.output ?? 0
    const reasoningTokens = tokens.reasoning ?? 0
    if (input === 0 && output === 0 && reasoningTokens === 0) {
      return null
    }
    return {
      input,
      output,
      reasoning: reasoningTokens,
      cacheRead: tokens.cache?.read ?? 0,
      cacheWrite: tokens.cache?.write ?? 0,
      cost: info.cost ?? 0,
    }
  }

  const finishStyle = () => (props.borderColor ? { "border-left-color": props.borderColor } : undefined)

  const renderUsageChips = (usage: NonNullable<ReturnType<typeof usageStats>>) => (
    <div class="message-step-usage">
      <div class="inline-flex items-center gap-1 rounded-full border border-[var(--border-base)] px-2 py-0.5 text-[10px]">
        <span class="uppercase text-[9px] tracking-wide text-[var(--text-muted)]">Input</span>
        <span class="font-semibold text-[var(--text-primary)]">{formatTokenTotal(usage.input)}</span>
      </div>
      <div class="inline-flex items-center gap-1 rounded-full border border-[var(--border-base)] px-2 py-0.5 text-[10px]">
        <span class="uppercase text-[9px] tracking-wide text-[var(--text-muted)]">Output</span>
        <span class="font-semibold text-[var(--text-primary)]">{formatTokenTotal(usage.output)}</span>
      </div>
      <div class="inline-flex items-center gap-1 rounded-full border border-[var(--border-base)] px-2 py-0.5 text-[10px]">
        <span class="uppercase text-[9px] tracking-wide text-[var(--text-muted)]">Reasoning</span>
        <span class="font-semibold text-[var(--text-primary)]">{formatTokenTotal(usage.reasoning)}</span>
      </div>
      <div class="inline-flex items-center gap-1 rounded-full border border-[var(--border-base)] px-2 py-0.5 text-[10px]">
        <span class="uppercase text-[9px] tracking-wide text-[var(--text-muted)]">Cache Read</span>
        <span class="font-semibold text-[var(--text-primary)]">{formatTokenTotal(usage.cacheRead)}</span>
      </div>
      <div class="inline-flex items-center gap-1 rounded-full border border-[var(--border-base)] px-2 py-0.5 text-[10px]">
        <span class="uppercase text-[9px] tracking-wide text-[var(--text-muted)]">Cache Write</span>
        <span class="font-semibold text-[var(--text-primary)]">{formatTokenTotal(usage.cacheWrite)}</span>
      </div>
      <div class="inline-flex items-center gap-1 rounded-full border border-[var(--border-base)] px-2 py-0.5 text-[10px]">
        <span class="uppercase text-[9px] tracking-wide text-[var(--text-muted)]">Cost</span>
        <span class="font-semibold text-[var(--text-primary)]">{formatCostValue(usage.cost)}</span>
      </div>
    </div>
  )

  if (props.kind === "finish") {
    const usage = usageStats()
    if (!usage) {
      return null
    }
    return (
      <div class={`message-step-card message-step-finish message-step-finish-flush`} style={finishStyle()}>
        {renderUsageChips(usage)}
      </div>
    )
  }

  return (
    <div class={`message-step-card message-step-start`}>
      <div class="message-step-heading">
        <div class="message-step-title">
          <div class="message-step-title-left">
            <Show when={props.showAgentMeta && (agentIdentifier() || modelIdentifier())}>
              <span class="message-step-meta-inline">
                <Show when={agentIdentifier()}>{(value) => <span>Agent: {value()}</span>}</Show>
                <Show when={modelIdentifier()}>{(value) => <span>Model: {value()}</span>}</Show>
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
  showAgentMeta?: boolean
  defaultExpanded?: boolean
}

function ReasoningCard(props: ReasoningCardProps) {
  const [expanded, setExpanded] = createSignal(Boolean(props.defaultExpanded))

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

  return (
    <div class="message-reasoning-card">
      <button
        type="button"
        class="message-reasoning-toggle"
        onClick={toggle}
        aria-expanded={expanded()}
        aria-label={expanded() ? "Collapse thinking" : "Expand thinking"}
      >
        <span class="message-reasoning-label flex flex-wrap items-center gap-2">
          <span>Thinking</span>
          <Show when={props.showAgentMeta && (agentIdentifier() || modelIdentifier())}>
            <span class="message-step-meta-inline">
              <Show when={agentIdentifier()}>{(value) => <span class="font-medium text-[var(--message-assistant-border)]">Agent: {value()}</span>}</Show>
              <Show when={modelIdentifier()}>{(value) => <span class="font-medium text-[var(--message-assistant-border)]">Model: {value()}</span>}</Show>
            </span>
          </Show>
        </span>
        <span class="message-reasoning-meta">
          <span class="message-reasoning-indicator">{expanded() ? "Hide" : "View"}</span>
          <span class="message-reasoning-time">{timestamp()}</span>
        </span>
      </button>

      <Show when={expanded()}>
        <div class="message-reasoning-expanded">
          <div class="message-reasoning-body">
            <div class="message-reasoning-output" role="region" aria-label="Reasoning details">
              <pre class="message-reasoning-text">{reasoningText() || ""}</pre>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
