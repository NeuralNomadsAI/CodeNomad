import { For, Match, Show, Switch, createEffect, createMemo, createSignal, untrack } from "solid-js"
import { FoldVertical } from "lucide-solid"
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
import { useI18n } from "../lib/i18n"

const TOOL_ICON = "🔧"
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

type CompactionDisplayItem = {
  type: "compaction"
  key: string
  part: ClientPart
  messageInfo?: MessageInfo
  accentColor?: string
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
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  onContentRendered?: () => void
}

export default function MessageBlock(props: MessageBlockProps) {
  const { t } = useI18n()
  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))
  const sessionCache = getSessionRenderCache(props.instanceId, props.sessionId)

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
    let segmentIndex = 0
    let pendingParts: ClientPart[] = []
    let agentMetaAttached = current.role !== "assistant"
    const defaultAccentColor = current.role === "user" ? USER_BORDER_COLOR : ASSISTANT_BORDER_COLOR
    let lastAccentColor = defaultAccentColor

    const flushContent = () => {
      if (pendingParts.length === 0) return
      const segmentKey = `${current.id}:segment:${segmentIndex}`
      segmentIndex += 1
      const shouldShowAgentMeta =
        current.role === "assistant" &&
        !agentMetaAttached &&
        pendingParts.some((part) => partHasRenderableText(part))
      let cached = sessionCache.messageItems.get(segmentKey)
      if (!cached) {
        cached = {
          type: "content",
          key: segmentKey,
          record: current,
          parts: pendingParts.slice(),
          messageInfo: info,
          isQueued,
          showAgentMeta: shouldShowAgentMeta,
        }
        sessionCache.messageItems.set(segmentKey, cached)
      } else {
        cached.record = current
        cached.parts = pendingParts.slice()
        cached.messageInfo = info
        cached.isQueued = isQueued
        cached.showAgentMeta = shouldShowAgentMeta
      }
      if (shouldShowAgentMeta) {
        agentMetaAttached = true
      }
      items.push(cached)
      blockContentKeys.push(segmentKey)
      lastAccentColor = defaultAccentColor
      pendingParts = []
    }

    orderedParts.forEach((part, partIndex) => {
      if (part.type === "tool") {
        flushContent()
        const partVersion = typeof (part as any).revision === "number" ? (part as any).revision : 0
        const messageVersion = current.revision
        const key = `${current.id}:${part.id ?? partIndex}`
        let toolItem = sessionCache.toolItems.get(key)
        if (!toolItem) {
          toolItem = {
            type: "tool",
            key,
            toolPart: part as ToolCallPart,
            messageInfo: info,
            messageId: current.id,
            messageVersion,
            partVersion,
          }
          sessionCache.toolItems.set(key, toolItem)
        } else {
          toolItem.key = key
          toolItem.toolPart = part as ToolCallPart
          toolItem.messageInfo = info
          toolItem.messageId = current.id
          toolItem.messageVersion = messageVersion
          toolItem.partVersion = partVersion
        }
        items.push(toolItem)
        blockToolKeys.push(key)
        lastAccentColor = TOOL_BORDER_COLOR
        return
      }

      if (part.type === "compaction") {
        flushContent()
        const key = `${current.id}:${part.id ?? partIndex}:compaction`
        const isAuto = Boolean((part as any)?.auto)
        items.push({
          type: "compaction",
          key,
          part,
          messageInfo: info,
          accentColor: isAuto ? "var(--session-status-compacting-fg)" : USER_BORDER_COLOR,
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
          const key = `${current.id}:${part.id ?? partIndex}:reasoning`
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
    <Show when={block()} keyed>
      {(resolvedBlock) => (
        <div class="message-stream-block" data-message-id={resolvedBlock.record.id}>
          <For each={resolvedBlock.items}>
            {(item) => (
              <Switch>
                <Match when={item.type === "content"}>
                  <MessageItem
                    record={(item as ContentDisplayItem).record}
                    messageInfo={(item as ContentDisplayItem).messageInfo}
                    parts={(item as ContentDisplayItem).parts}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    isQueued={(item as ContentDisplayItem).isQueued}
                    showAgentMeta={(item as ContentDisplayItem).showAgentMeta}
                    onRevert={props.onRevert}
                    onFork={props.onFork}
                    onContentRendered={props.onContentRendered}
                  />
                </Match>
                <Match when={item.type === "tool"}>
                  {(() => {
                    const toolItem = item as ToolDisplayItem
                    const toolState = toolItem.toolPart.state as ToolState | undefined
                    const hasToolState =
                      Boolean(toolState) && (isToolStateRunning(toolState) || isToolStateCompleted(toolState) || isToolStateError(toolState))
                    const taskSessionId = hasToolState ? extractTaskSessionId(toolState) : ""
                    const taskLocation = taskSessionId ? findTaskSessionLocation(taskSessionId, props.instanceId) : null
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
                            <span>{t("messageBlock.tool.header")}</span>
                            <span class="tool-name">{toolItem.toolPart.tool || t("messageBlock.tool.unknown")}</span>
                          </div>
                          <Show when={taskSessionId}>
                            <button
                              class="tool-call-header-button"
                              type="button"
                              disabled={!taskLocation}
                              onClick={handleGoToTaskSession}
                              title={!taskLocation ? t("messageBlock.tool.goToSession.unavailableTitle") : t("messageBlock.tool.goToSession.title")}
                            >
                              {t("messageBlock.tool.goToSession.label")}
                            </button>
                          </Show>
                        </div>
                        <ToolCall
                          toolCall={toolItem.toolPart}
                          toolCallId={toolItem.toolPart.id}
                          messageId={toolItem.messageId}
                          messageVersion={toolItem.messageVersion}
                          partVersion={toolItem.partVersion}
                          instanceId={props.instanceId}
                          sessionId={props.sessionId}
                          onContentRendered={props.onContentRendered}
                        />
                      </div>
                    )
                  })()}
                </Match>
                <Match when={item.type === "step-start"}>
                  <StepCard kind="start" part={(item as StepDisplayItem).part} messageInfo={(item as StepDisplayItem).messageInfo} showAgentMeta />
                </Match>
                <Match when={item.type === "step-finish"}>
                  <StepCard
                    kind="finish"
                    part={(item as StepDisplayItem).part}
                    messageInfo={(item as StepDisplayItem).messageInfo}
                    showUsage={props.showUsageMetrics()}
                    borderColor={(item as StepDisplayItem).accentColor}
                  />
                </Match>
                <Match when={item.type === "compaction"}>
                  <CompactionCard part={(item as CompactionDisplayItem).part} messageInfo={(item as CompactionDisplayItem).messageInfo} borderColor={(item as CompactionDisplayItem).accentColor} />
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
}

function CompactionCard(props: { part: ClientPart; messageInfo?: MessageInfo; borderColor?: string }) {
  const { t } = useI18n()
  const isAuto = () => Boolean((props.part as any)?.auto)
  const label = () => (isAuto() ? t("messageBlock.compaction.autoLabel") : t("messageBlock.compaction.manualLabel"))
  const borderColor = () => props.borderColor ?? (isAuto() ? "var(--session-status-compacting-fg)" : USER_BORDER_COLOR)

  const containerClass = () =>
    `message-compaction-card ${isAuto() ? "message-compaction-card--auto" : "message-compaction-card--manual"}`

  return (
    <div
      class={containerClass()}
      style={{ "border-left": `4px solid ${borderColor()}` }}
      role="status"
      aria-label={t("messageBlock.compaction.ariaLabel")}
    >
      <div class="message-compaction-row">
        <FoldVertical class="message-compaction-icon w-4 h-4" aria-hidden="true" />
        <span class="message-compaction-label">{label()}</span>
      </div>
    </div>
  )
}

function StepCard(props: StepCardProps) {
  const { t } = useI18n()
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
  showAgentMeta?: boolean
  defaultExpanded?: boolean
}

function ReasoningCard(props: ReasoningCardProps) {
  const { t } = useI18n()
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
        aria-label={expanded() ? t("messageBlock.reasoning.collapseAriaLabel") : t("messageBlock.reasoning.expandAriaLabel")}
      >
        <span class="message-reasoning-label flex flex-wrap items-center gap-2">
          <span>{t("messageBlock.reasoning.thinkingLabel")}</span>
          <Show when={props.showAgentMeta && (agentIdentifier() || modelIdentifier())}>
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
          </Show>
        </span>
        <span class="message-reasoning-meta">
          <span class="message-reasoning-indicator">
            {expanded() ? t("messageBlock.reasoning.indicator.hide") : t("messageBlock.reasoning.indicator.view")}
          </span>
          <span class="message-reasoning-time">{timestamp()}</span>
        </span>
      </button>

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
