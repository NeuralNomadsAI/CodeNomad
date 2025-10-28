import { For, Show, createSignal, createEffect, createMemo } from "solid-js"
import type { Message, MessageDisplayParts } from "../types/message"
import MessageItem from "./message-item"
import ToolCall from "./tool-call"
import { sseManager } from "../lib/sse-manager"
import Kbd from "./kbd"
import { preferences } from "../stores/preferences"
import { providers, getSessionInfo, computeDisplayParts } from "../stores/sessions"

// Calculate session tokens and cost from messagesInfo (matches TUI logic)
function calculateSessionInfo(messagesInfo?: Map<string, any>, instanceId?: string) {
  if (!messagesInfo || messagesInfo.size === 0)
    return { tokens: 0, cost: 0, contextWindow: 0, isSubscriptionModel: false }

  let tokens = 0
  let cost = 0
  let contextWindow = 0
  let isSubscriptionModel = false
  let modelID = ""
  let providerID = ""

  // Go backwards through messages to find the last relevant assistant message (like TUI)
  const messageArray = Array.from(messagesInfo.values()).reverse()

  for (const info of messageArray) {
    if (info.role === "assistant" && info.tokens) {
      const usage = info.tokens

      if (usage.output > 0) {
        if (info.summary) {
          // If summary message, only count output tokens and stop (like TUI)
          tokens = usage.output || 0
          cost = info.cost || 0
        } else {
          // Regular message - count all token types (like TUI)
          tokens =
            (usage.input || 0) +
            (usage.cache?.read || 0) +
            (usage.cache?.write || 0) +
            (usage.output || 0) +
            (usage.reasoning || 0)
          cost = info.cost || 0
        }

        // Get model info for context window and subscription check
        modelID = info.modelID || ""
        providerID = info.providerID || ""
        isSubscriptionModel = cost === 0

        break
      }
    }
  }

  // Try to get context window from providers
  if (instanceId && modelID && providerID) {
    const instanceProviders = providers().get(instanceId) || []
    console.log("[calculateSessionInfo] instanceProviders:", instanceProviders)
    console.log("[calculateSessionInfo] looking for providerID:", providerID, "modelID:", modelID)
    const provider = instanceProviders.find((p) => p.id === providerID)
    console.log("[calculateSessionInfo] found provider:", provider)
    if (provider) {
      const model = provider.models.find((m) => m.id === modelID)
      console.log("[calculateSessionInfo] found model:", model)
      if (model?.limit?.context) {
        contextWindow = model.limit.context
      }
      // Check if it's a subscription model (cost is 0 for both input and output)
      if (model?.cost?.input === 0 && model?.cost?.output === 0) {
        isSubscriptionModel = true
      }
    }
  }

  return { tokens, cost, contextWindow, isSubscriptionModel }
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

// Format session info like TUI (e.g., "110K/73% ($0.42)" or "110K/73%")
function formatSessionInfo(tokens: number, cost: number, contextWindow: number, isSubscriptionModel: boolean): string {
  const tokensStr = formatTokens(tokens)

  // Calculate percentage if we have context window
  if (contextWindow > 0) {
    const percentage = Math.round((tokens / contextWindow) * 100)
    if (isSubscriptionModel) {
      return `${tokensStr}/${percentage}%`
    }
    return `${tokensStr}/${percentage}% ($${cost.toFixed(2)})`
  }

  // Fallback without context window
  if (isSubscriptionModel) {
    return tokensStr
  }
  return `${tokensStr} ($${cost.toFixed(2)})`
}

interface MessageStreamProps {
  instanceId: string
  sessionId: string
  messages: Message[]
  messagesInfo?: Map<string, any>
  revert?: {
    messageID: string
    partID?: string
    snapshot?: string
    diff?: string
  }
  loading?: boolean
  onRevert?: (messageId: string) => void
}

interface MessageDisplayItem {
  type: "message"
  message: Message
  combinedParts: any[]
  isQueued: boolean
  messageInfo?: any
}

interface ToolDisplayItem {
  type: "tool"
  key: string
  toolPart: any
  messageInfo?: any
}

type DisplayItem = MessageDisplayItem | ToolDisplayItem

interface MessageCacheEntry {
  version: number
  showThinking: boolean
  isQueued: boolean
  messageInfo?: any
  displayParts: MessageDisplayParts
  item: MessageDisplayItem
}

interface ToolCacheEntry {
  toolPart: any
  messageInfo?: any
  item: ToolDisplayItem
}

export default function MessageStream(props: MessageStreamProps) {
  let containerRef: HTMLDivElement | undefined
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [showScrollButton, setShowScrollButton] = createSignal(false)

  let messageItemCache = new Map<string, MessageCacheEntry>()
  let toolItemCache = new Map<string, ToolCacheEntry>()

  const connectionStatus = () => sseManager.getStatus(props.instanceId)

  const sessionInfo = createMemo(() => {
    return (
      getSessionInfo(props.instanceId, props.sessionId) || {
        tokens: 0,
        cost: 0,
        contextWindow: 0,
        isSubscriptionModel: false,
      }
    )
  })

  const formattedSessionInfo = createMemo(() => {
    const sessionInfo = getSessionInfo(props.instanceId, props.sessionId) || {
      tokens: 0,
      cost: 0,
      contextWindow: 0,
      isSubscriptionModel: false,
    }
    return formatSessionInfo(
      sessionInfo.tokens,
      sessionInfo.cost,
      sessionInfo.contextWindow,
      sessionInfo.isSubscriptionModel,
    )
  })

  function scrollToBottom() {
    if (containerRef) {
      containerRef.scrollTop = containerRef.scrollHeight
      setAutoScroll(true)
      setShowScrollButton(false)
    }
  }

  function handleScroll() {
    // Scroll handling temporarily disabled during testing
    // if (!containerRef) return
    //
    // const { scrollTop, scrollHeight, clientHeight } = containerRef
    // const isAtBottom = scrollHeight - scrollTop - clientHeight < 50
    //
    // setAutoScroll(isAtBottom)
    // setShowScrollButton(!isAtBottom)
  }

  const displayItems = createMemo(() => {
    // Ensure memo reacts to preference changes
    const showThinking = preferences().showThinkingBlocks

    const items: DisplayItem[] = []
    const newMessageCache = new Map<string, MessageCacheEntry>()
    const newToolCache = new Map<string, ToolCacheEntry>()

    let lastAssistantIndex = -1
    for (let i = props.messages.length - 1; i >= 0; i--) {
      if (props.messages[i].type === "assistant") {
        lastAssistantIndex = i
        break
      }
    }

    for (let index = 0; index < props.messages.length; index++) {
      const message = props.messages[index]
      const messageInfo = props.messagesInfo?.get(message.id)

      // If we hit the revert point, stop rendering messages
      if (props.revert?.messageID && message.id === props.revert.messageID) {
        break
      }

      const baseDisplayParts = message.displayParts
      const displayParts: MessageDisplayParts =
        baseDisplayParts && baseDisplayParts.showThinking === showThinking
          ? baseDisplayParts
          : computeDisplayParts(message, showThinking)

      const combinedParts = displayParts.combined
      const version = message.version ?? 0
      const isQueued = message.type === "user" && (lastAssistantIndex === -1 || index > lastAssistantIndex)

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
          version,
          showThinking,
          isQueued,
          messageInfo,
          displayParts,
          item: messageItem,
        })
        items.push(messageItem)
      }

      for (let toolIndex = 0; toolIndex < displayParts.tool.length; toolIndex++) {
        const toolPart = displayParts.tool[toolIndex]
        const toolKey = typeof toolPart?.id === "string" ? toolPart.id : `${message.id}-tool-${toolIndex}`

        const toolEntry = toolItemCache.get(toolKey)
        if (toolEntry && toolEntry.toolPart === toolPart && toolEntry.messageInfo === messageInfo) {
          toolEntry.item.toolPart = toolPart
          toolEntry.item.messageInfo = messageInfo
          toolEntry.toolPart = toolPart
          toolEntry.messageInfo = messageInfo
          newToolCache.set(toolKey, toolEntry)
          items.push(toolEntry.item)
        } else {
          const toolItem: ToolDisplayItem = {
            type: "tool",
            key: toolKey,
            toolPart,
            messageInfo,
          }
          newToolCache.set(toolKey, { toolPart, messageInfo, item: toolItem })
          items.push(toolItem)
        }
      }
    }

    messageItemCache = newMessageCache
    toolItemCache = newToolCache

    return items
  })

  const itemsLength = () => displayItems().length
  createEffect(() => {
    // Scroll handling temporarily disabled during testing
    itemsLength()
    // if (autoScroll()) {
    //   setTimeout(scrollToBottom, 0)
    // }
  })

  return (
    <div class="message-stream-container">
      <div class="connection-status">
        <div class="flex items-center gap-2 text-sm font-medium text-gray-700">
          <span>{formattedSessionInfo()}</span>
        </div>
        <div class="flex-1" />
        <div class="flex items-center gap-2 text-sm font-medium text-gray-700">
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
              <h3>Start a conversation</h3>
              <p>Type a message below or try:</p>
              <ul>
                <li>
                  <code>/init-project</code>
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
                />
              )
            }

            const toolPart = item.toolPart

            return (
              <div class="tool-call-message" data-key={item.key}>
                <div class="tool-call-header-label">
                  <span class="tool-call-icon">🔧</span>
                  <span>Tool Call</span>
                  <span class="tool-name">{toolPart?.tool || "unknown"}</span>
                </div>
                <ToolCall toolCall={toolPart} toolCallId={toolPart?.id} />
              </div>
            )
          }}
        </For>
      </div>

      <Show when={showScrollButton()}>
        <button class="scroll-to-bottom" onClick={scrollToBottom} aria-label="Scroll to bottom">
          ↓
        </button>
      </Show>
    </div>
  )
}
