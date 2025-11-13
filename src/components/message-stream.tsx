import { For, Show, createSignal, createEffect, createMemo, onCleanup } from "solid-js"
import type { Message, MessageDisplayParts, SDKPart, MessageInfo, ClientPart } from "../types/message"

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

// Import ToolState types from SDK
type ToolState = import("@opencode-ai/sdk").ToolState
type ToolStateRunning = import("@opencode-ai/sdk").ToolStateRunning  
type ToolStateCompleted = import("@opencode-ai/sdk").ToolStateCompleted
type ToolStateError = import("@opencode-ai/sdk").ToolStateError

// Type guards
function isToolStateRunning(state: ToolState): state is ToolStateRunning {
  return state.status === "running"
}

function isToolStateCompleted(state: ToolState): state is ToolStateCompleted {
  return state.status === "completed"
}

function isToolStateError(state: ToolState): state is ToolStateError {
  return state.status === "error"
}

// Type guard to check if a part is a tool part
function isToolPart(part: ClientPart): part is ToolCallPart {
  return part.type === "tool"
}
import MessageItem from "./message-item"
import ToolCall from "./tool-call"
import { sseManager } from "../lib/sse-manager"
import Kbd from "./kbd"
import { preferences } from "../stores/preferences"
import { getSessionInfo, computeDisplayParts, sessions, setActiveSession, setActiveParentSession } from "../stores/sessions"
import { setActiveInstanceId } from "../stores/instances"

const codeNomadLogo = new URL("../../images/CodeNomad-Icon.png", import.meta.url).href
const SCROLL_OFFSET = 64

interface TaskSessionLocation {
  sessionId: string
  instanceId: string
  parentId: string | null
}

const messageScrollState = new Map<string, { scrollTop: number; autoScroll: boolean }>()

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

// Format tokens like TUI (e.g., "110K", "1.2M")
function formatTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}K`
  }
  return tokens.toString()
}

// Format session info for the session view header
function formatSessionInfo(usageTokens: number, contextWindow: number, usagePercent: number | null): string {
  if (contextWindow > 0) {
    const windowStr = formatTokens(contextWindow)
    const usageStr = formatTokens(usageTokens)
    const percent = usagePercent ?? Math.min(100, Math.max(0, Math.round((usageTokens / contextWindow) * 100)))
    return `${usageStr} of ${windowStr} (${percent}%)`
  }

  return formatTokens(usageTokens)
}

interface MessageStreamProps {
  instanceId: string
  sessionId: string
  messages: Message[]
  messagesInfo?: Map<string, MessageInfo>
  revert?: {
    messageID: string
    partID?: string
    snapshot?: string
    diff?: string
  }
  loading?: boolean
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
}

interface MessageDisplayItem {
  type: "message"
  message: Message
  combinedParts: ClientPart[]
  isQueued: boolean
  messageInfo?: MessageInfo
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

type DisplayItem = MessageDisplayItem | ToolDisplayItem

interface MessageCacheEntry {
  message: Message
  version: number
  showThinking: boolean
  isQueued: boolean
  messageInfo?: MessageInfo
  displayParts: MessageDisplayParts
  item: MessageDisplayItem
}

interface ToolCacheEntry {
  toolPart: ClientPart
  messageInfo?: MessageInfo
  signature: string
  contentKey: string
  item: ToolDisplayItem
}



interface SessionCache {
  messageItemCache: Map<string, MessageCacheEntry>
  toolItemCache: Map<string, ToolCacheEntry>
}

const sessionCaches = new Map<string, SessionCache>()

function getSessionCache(instanceId: string, sessionId: string): SessionCache {
  const key = `${instanceId}:${sessionId}`
  let cache = sessionCaches.get(key)
  if (!cache) {
    cache = {
      messageItemCache: new Map(),
      toolItemCache: new Map(),
    }
    sessionCaches.set(key, cache)
  }
  return cache
}

export default function MessageStream(props: MessageStreamProps) {
  let containerRef: HTMLDivElement | undefined
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)

  const sessionCache = getSessionCache(props.instanceId, props.sessionId)
  let messageItemCache = sessionCache.messageItemCache
  let toolItemCache = sessionCache.toolItemCache
  let scrollAnimationFrame: number | null = null
  let lastKnownScrollTop = 0

  const makeScrollKey = (instanceId: string, sessionId: string) => `${instanceId}:${sessionId}`

  const scrollStateKey = () => makeScrollKey(props.instanceId, props.sessionId)
  const connectionStatus = () => sseManager.getStatus(props.instanceId)

  function createToolSignature(message: Message, toolPart: ClientPart, toolIndex: number, messageInfo?: MessageInfo): string {
    const messageId = message.id
    const partId = typeof toolPart?.id === "string" ? toolPart.id : `${messageId}-tool-${toolIndex}`
    return `${messageId}:${partId}`
  }

  function createToolContentKey(toolPart: ClientPart, messageInfo?: MessageInfo): string {
    const state = isToolPart(toolPart) ? toolPart.state : undefined
    const version = typeof toolPart?.version === "number" ? toolPart.version : 0
    const status = state?.status ?? "unknown"
    return `${toolPart.id}:${version}:${status}`
  }

  const sessionInfo = createMemo(() =>
    getSessionInfo(props.instanceId, props.sessionId) ?? {
      tokens: 0,
      cost: 0,
      contextWindow: 0,
      isSubscriptionModel: false,
      contextUsageTokens: 0,
      contextUsagePercent: null,
    },
  )

  const formattedSessionInfo = createMemo(() => {
    const info = sessionInfo()
    return formatSessionInfo(info.contextUsageTokens, info.contextWindow, info.contextUsagePercent)
  })

  function isNearBottom(element: HTMLDivElement, offset = SCROLL_OFFSET) {
    const { scrollTop, scrollHeight, clientHeight } = element
    const distance = scrollHeight - (scrollTop + clientHeight)
    return distance <= offset
  }

  function isNearTop(element: HTMLDivElement, offset = SCROLL_OFFSET) {
    return element.scrollTop <= offset
  }

  function scrollToBottom(options: { smooth?: boolean } = {}) {
    if (!containerRef) return

    const behavior = options.smooth ? "smooth" : "auto"

    requestAnimationFrame(() => {
      if (!containerRef) return
      containerRef.scrollTo({ top: containerRef.scrollHeight, behavior })
      setAutoScroll(true)
      updateScrollIndicators(containerRef)
    })
  }


  function scrollToTop(options: { smooth?: boolean } = {}) {
    if (!containerRef) return

    const behavior = options.smooth ? "smooth" : "auto"
    setAutoScroll(false)

    requestAnimationFrame(() => {
      if (!containerRef) return
      containerRef.scrollTo({ top: 0, behavior })
      setShowScrollTopButton(false)
      updateScrollIndicators(containerRef)
    })
  }

  function handleScroll(event: Event) {
    if (!containerRef) return

    if (scrollAnimationFrame !== null) {
      cancelAnimationFrame(scrollAnimationFrame)
    }

    const isUserScroll = event.isTrusted

    scrollAnimationFrame = requestAnimationFrame(() => {
      if (!containerRef) return

      const currentScrollTop = containerRef.scrollTop
      const movingUp = currentScrollTop < lastKnownScrollTop - 1
      lastKnownScrollTop = currentScrollTop

      const atBottom = isNearBottom(containerRef)

      if (isUserScroll) {
        if ((movingUp || !atBottom) && autoScroll()) {
          setAutoScroll(false)
        } else if (!movingUp && atBottom && !autoScroll()) {
          setAutoScroll(true)
        }
      }

      updateScrollIndicators(containerRef)
      scrollAnimationFrame = null
    })
  }

  const messageView = createMemo(() => {
    const showThinking = preferences().showThinkingBlocks

    const items: DisplayItem[] = []
    const newMessageCache = new Map<string, MessageCacheEntry>()
    const newToolCache = new Map<string, ToolCacheEntry>()
    const tokenSegments: string[] = []

    let lastAssistantIndex = -1
    for (let i = props.messages.length - 1; i >= 0; i--) {
      if (props.messages[i].type === "assistant") {
        lastAssistantIndex = i
        break
      }
    }

    tokenSegments.push(`count:${props.messages.length}`)
    tokenSegments.push(`revert:${props.revert?.messageID ?? ""}`)
    tokenSegments.push(`thinking:${showThinking ? 1 : 0}`)

    for (let index = 0; index < props.messages.length; index++) {
      const message = props.messages[index]
      const messageInfo = props.messagesInfo?.get(message.id)

      if (props.revert?.messageID && message.id === props.revert.messageID) {
        break
      }

      tokenSegments.push(`${message.id}:${message.version ?? 0}:${message.status}:${message.parts.length}`)

      const baseDisplayParts = message.displayParts
      const displayParts: MessageDisplayParts =
        !baseDisplayParts || baseDisplayParts.showThinking !== showThinking
          ? computeDisplayParts(message, showThinking)
          : (baseDisplayParts as MessageDisplayParts)

      const combinedParts = displayParts.combined
      const version = message.version ?? 0
      const isQueued = message.type === "user" && (lastAssistantIndex === -1 || index > lastAssistantIndex)

      const hasRenderableContent =
        message.type !== "assistant" ||
        combinedParts.length > 0 ||
        Boolean(messageInfo && messageInfo.role === "assistant" && messageInfo.error) ||
        message.status === "error"

      if (hasRenderableContent) {
        const cacheEntry = messageItemCache.get(message.id)
        if (
          cacheEntry &&
          cacheEntry.version === version &&
          cacheEntry.showThinking === showThinking &&
          cacheEntry.isQueued === isQueued &&
          cacheEntry.messageInfo === messageInfo
        ) {
          cacheEntry.displayParts = displayParts
          cacheEntry.version = version
          cacheEntry.showThinking = showThinking
          cacheEntry.isQueued = isQueued
          cacheEntry.messageInfo = messageInfo
          cacheEntry.item.message = message
          cacheEntry.item.combinedParts = combinedParts
          cacheEntry.item.isQueued = isQueued
          cacheEntry.item.messageInfo = messageInfo
          newMessageCache.set(message.id, cacheEntry)
          items.push(cacheEntry.item)
        } else {
          const messageItem: MessageDisplayItem = {
            type: "message",
            message,
            combinedParts,
            isQueued,
            messageInfo,
          }
          newMessageCache.set(message.id, {
            message,
            version,
            showThinking,
            isQueued,
            messageInfo,
            displayParts,
            item: messageItem,
          })
          items.push(messageItem)
        }
      }

      const toolParts = displayParts.tool.filter(isToolPart)
      for (let toolIndex = 0; toolIndex < toolParts.length; toolIndex++) {
        const toolPart = toolParts[toolIndex]
        const originalIndex = displayParts.tool.indexOf(toolPart)
        const toolKey = toolPart?.id || `${message.id}-tool-${originalIndex}`
        const messageVersion = typeof message.version === "number" ? message.version : 0
        const partVersion = typeof toolPart?.version === "number" ? toolPart.version : 0

        const toolSignature = createToolSignature(message, toolPart, originalIndex, messageInfo)
        const contentKey = createToolContentKey(toolPart, messageInfo)
        const toolEntry = toolItemCache.get(toolKey)
        if (toolEntry && toolEntry.signature === toolSignature) {
          if (toolEntry.contentKey !== contentKey) {
            const updatedItem: ToolDisplayItem = {
              ...toolEntry.item,
              toolPart,
              messageInfo,
              messageId: message.id,
              messageVersion,
              partVersion,
            }
            toolEntry.toolPart = toolPart
            toolEntry.messageInfo = messageInfo
            toolEntry.signature = toolSignature
            toolEntry.contentKey = contentKey
            toolEntry.item = updatedItem
            console.debug("[ToolCall] update", toolKey, toolPart.state?.status)
            newToolCache.set(toolKey, toolEntry)
            items.push(updatedItem)
          } else {
            const cachedItem = toolEntry.item
            cachedItem.toolPart = toolPart
            cachedItem.messageInfo = messageInfo
            cachedItem.messageId = message.id
            cachedItem.messageVersion = messageVersion
            cachedItem.partVersion = partVersion
            toolEntry.toolPart = toolPart
            toolEntry.messageInfo = messageInfo
            newToolCache.set(toolKey, toolEntry)
            items.push(cachedItem)
          }
        } else {
          const toolItem: ToolDisplayItem = {
            type: "tool",
            key: toolKey,
            toolPart,
            messageInfo,
            messageId: message.id,
            messageVersion,
            partVersion,
          }
          console.debug("[ToolCall] create", toolKey, toolPart.state?.status)
          newToolCache.set(toolKey, { toolPart, messageInfo, signature: toolSignature, contentKey, item: toolItem })
          items.push(toolItem)
        }
      }
    }

    messageItemCache = newMessageCache
    toolItemCache = newToolCache
    sessionCache.messageItemCache = messageItemCache
    sessionCache.toolItemCache = toolItemCache

    tokenSegments.push(`items:${items.length}`)

    if (items.length > 0) {
      const tail = items[items.length - 1]
      if (tail.type === "message") {
        tokenSegments.push(`tail:${tail.message.id}:${tail.message.version ?? 0}`)
      } else {
        tokenSegments.push(`tail:${tail.key}`)
      }
    }

    return { items, token: tokenSegments.join("|") }
  })

  const displayItems = () => messageView().items
  const changeToken = () => messageView().token

  function updateScrollIndicators(element: HTMLDivElement) {
    const itemsLength = displayItems().length
    setShowScrollBottomButton(!isNearBottom(element) && itemsLength > 0)
    setShowScrollTopButton(!isNearTop(element) && itemsLength > 0)
    persistScrollState()
  }

  function getActiveScrollKey() {
    return containerRef?.dataset.scrollKey || scrollStateKey()
  }

  function persistScrollState() {
    if (!containerRef) return
    const key = getActiveScrollKey()
    messageScrollState.set(key, {
      scrollTop: containerRef.scrollTop,
      autoScroll: autoScroll(),
    })
  }

  createEffect(() => {
    const key = scrollStateKey()
    if (containerRef) {
      containerRef.dataset.scrollKey = key
    }
    const savedState = messageScrollState.get(key)
    const shouldAutoScroll = savedState?.autoScroll ?? true

    setAutoScroll(shouldAutoScroll)

    requestAnimationFrame(() => {
      if (!containerRef) return

      if (savedState) {
        if (shouldAutoScroll) {
          scrollToBottom({ smooth: false })
        } else {
          const maxScrollTop = Math.max(containerRef.scrollHeight - containerRef.clientHeight, 0)
          containerRef.scrollTop = Math.min(savedState.scrollTop, maxScrollTop)
          updateScrollIndicators(containerRef)
        }
      } else {
        scrollToBottom({ smooth: false })
      }
    })

    onCleanup(() => {
      if (containerRef) {
        messageScrollState.set(key, {
          scrollTop: containerRef.scrollTop,
          autoScroll: autoScroll(),
        })
        if (containerRef.dataset.scrollKey === key) {
          delete containerRef.dataset.scrollKey
        }
      }
    })
  })

  let previousToken: string | undefined
  createEffect(() => {
    const token = changeToken()
    const shouldScroll = autoScroll()

    if (!token || token === previousToken) {
      return
    }

    previousToken = token

    if (!shouldScroll) {
      return
    }

    scrollToBottom()
  })

  createEffect(() => {
    if (displayItems().length === 0) {
      setShowScrollBottomButton(false)
      setShowScrollTopButton(false)
      setAutoScroll(true)
      persistScrollState()
    }
  })

  onCleanup(() => {
    if (scrollAnimationFrame !== null) {
      cancelAnimationFrame(scrollAnimationFrame)
    }
  })

  return (
    <div class="message-stream-container">
      <div class="connection-status">
        <div class="connection-status-text flex items-center gap-2 text-sm font-medium">
          <span>{formattedSessionInfo()}</span>
        </div>
        <div class="flex-1" />
        <div class="connection-status-text flex items-center gap-2 text-sm font-medium">
          <span>Command Palette</span>
          <Kbd shortcut="cmd+shift+p" />
        </div>
        <div class="flex-1 flex items-center justify-end gap-3">
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
      <div ref={containerRef} class="message-stream" onScroll={handleScroll}>
        <Show when={!props.loading && displayItems().length === 0}>
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

        <For each={displayItems()} fallback={null}>
          {(item) => {
            if (item.type === "message") {
              return (
                <MessageItem
                  message={item.message}
                  messageInfo={item.messageInfo}
                  isQueued={item.isQueued}
                  parts={item.combinedParts}
                  onRevert={props.onRevert}
                  onFork={props.onFork}
                />

              )
            }

            const toolPart = item.toolPart

            const taskSessionId =
              (isToolStateRunning(toolPart.state) || isToolStateCompleted(toolPart.state) || isToolStateError(toolPart.state))
                ? toolPart.state.metadata?.sessionId === "string" ? toolPart.state.metadata.sessionId : ""
                : ""
            const taskLocation = taskSessionId ? findTaskSessionLocation(taskSessionId) : null

            const handleGoToTaskSession = (event: Event) => {
              event.preventDefault()
              event.stopPropagation()
              if (!taskLocation) return
              navigateToTaskSession(taskLocation)
            }

            return (
              <div class="tool-call-message" data-key={item.key}>
                <div class="tool-call-header-label">
                  <div class="tool-call-header-meta">
                    <span class="tool-call-icon">🔧</span>
                    <span>Tool Call</span>
                    <span class="tool-name">{toolPart?.tool || "unknown"}</span>
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
                  toolCall={toolPart}
                  toolCallId={item.key}
                  messageId={item.messageId}
                  messageVersion={item.messageVersion}
                  partVersion={item.partVersion}
                />
              </div>
            )
          }}
        </For>
      </div>

      <Show when={showScrollTopButton() || showScrollBottomButton()}>
        <div class="message-scroll-button-wrapper">
          <Show when={showScrollTopButton()}>
            <button
              type="button"
              class="message-scroll-button"
              onClick={() => scrollToTop({ smooth: true })}
              aria-label="Scroll to first message"
            >
              <span class="message-scroll-icon" aria-hidden="true">↑</span>
            </button>
          </Show>
          <Show when={showScrollBottomButton()}>
            <button
              type="button"
              class="message-scroll-button"
              onClick={() => scrollToBottom({ smooth: true })}
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
