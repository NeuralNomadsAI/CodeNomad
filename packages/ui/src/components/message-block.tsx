import { For, Match, Show, Switch, createEffect, createMemo, createSignal } from "solid-js"
import MessageItem from "./message-item"
import ToolCall from "./tool-call"
import ToolCallGroup from "./tool-call-group"
import SubAgentGroup from "./subagent-group"
import PipelineGroup from "./pipeline-group"
import { detectPipelinePattern } from "./pipeline-step"
import type { ToolDisplayItem } from "./inline-tool-call"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { ClientPart, MessageInfo } from "../types/message"
import { partHasRenderableText } from "../types/message"
import { buildRecordDisplayData, clearRecordDisplayCacheForInstance } from "../stores/message-v2/record-display-cache"
import type { MessageRecord } from "../stores/message-v2/types"
import { messageStoreBus } from "../stores/message-v2/bus"
import { formatTokenTotal } from "../lib/formatters"

const USER_BORDER_COLOR = "hsl(var(--primary) / 0.3)"
const ASSISTANT_BORDER_COLOR = "hsl(var(--muted-foreground) / 0.2)"
const TOOL_BORDER_COLOR = "hsl(var(--accent) / 0.5)"

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

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

// ToolDisplayItem is imported from inline-tool-call.tsx

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
  isLastMessage?: boolean
  isLastInAssistantTurn?: boolean
  turnMessageIds?: string[]
  showStepFinish?: boolean
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  onContentRendered?: () => void
}

export default function MessageBlock(props: MessageBlockProps) {
  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))
  const sessionCache = getSessionRenderCache(props.instanceId, props.sessionId)

  const block = createMemo<MessageDisplayBlock | null>(() => {
    const current = record()
    if (!current) return null

    const index = props.messageIndex
    const lastAssistantIdx = props.lastAssistantIndex()
    const isQueued = current.role === "user" && (lastAssistantIdx === -1 || index > lastAssistantIdx)
    const info = messageInfo()
    const infoTime = (info?.time ?? {}) as { created?: number; updated?: number; completed?: number }
    const infoTimestamp =
      typeof infoTime.completed === "number"
        ? infoTime.completed
        : typeof infoTime.updated === "number"
          ? infoTime.updated
          : infoTime.created ?? 0
    const infoError = (info as { error?: { name?: string } } | undefined)?.error
    const infoErrorName = typeof infoError?.name === "string" ? infoError.name : ""
    const cacheSignature = [
      current.id,
      current.revision,
      isQueued ? 1 : 0,
      props.showThinking() ? 1 : 0,
      props.thinkingDefaultExpanded() ? 1 : 0,
      props.showUsageMetrics() ? 1 : 0,
      infoTimestamp,
      infoErrorName,
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

  // Extract step-finish item separately - it's NOT a tool and should always show at the bottom
  const stepFinishItem = createMemo(() => {
    const items = block()?.items ?? []
    return items.find((item) => item.type === "step-finish") as StepDisplayItem | undefined
  })

  // Get all tool items for sibling navigation in the modal
  const allToolItems = createMemo(() => {
    const items = block()?.items ?? []
    return items.filter((item) => item.type === "tool") as ToolDisplayItem[]
  })

  // Group items into sections: regular items stay individual, consecutive regular tools are batched
  // Consecutive sub-agent tasks (tool name "task") are also batched together
  type RenderSection =
    | { type: "item"; item: MessageBlockItem }
    | { type: "tool-group"; tools: ToolDisplayItem[] }
    | { type: "subagent-group"; tools: ToolDisplayItem[] }
    | { type: "pipeline-group"; tools: ToolDisplayItem[]; patternName: string }
    | { type: "standalone-tool"; tool: ToolDisplayItem }
    | { type: "collapsed-tools"; hiddenCount: number; toolGroupCount: number }

  const renderSections = createMemo<RenderSection[]>(() => {
    const items = block()?.items ?? []
    const sections: RenderSection[] = []
    let pendingTools: ToolDisplayItem[] = []
    let pendingSubAgents: ToolDisplayItem[] = []
    // Buffer for non-task tools that appear between sub-agent tasks.
    // If a pipeline pattern is detected, these interstitial items are
    // absorbed into the pipeline group; otherwise they're flushed normally.
    let interstitialTools: ToolDisplayItem[] = []

    const flushTools = () => {
      if (pendingTools.length > 0) {
        sections.push({ type: "tool-group", tools: [...pendingTools] })
        pendingTools = []
      }
    }

    const flushSubAgents = () => {
      if (pendingSubAgents.length > 0) {
        const pipelinePattern = detectPipelinePattern(pendingSubAgents)
        if (pipelinePattern) {
          // Pipeline detected -- interstitial tools are absorbed (not shown separately)
          sections.push({ type: "pipeline-group", tools: [...pendingSubAgents], patternName: pipelinePattern })
        } else {
          // No pipeline -- flush interstitial tools before the subagent group
          if (interstitialTools.length > 0) {
            sections.push({ type: "tool-group", tools: [...interstitialTools] })
          }
          sections.push({ type: "subagent-group", tools: [...pendingSubAgents] })
        }
        pendingSubAgents = []
        interstitialTools = []
      }
    }

    for (const item of items) {
      if (item.type === "step-finish") {
        // Skip step-finish - rendered separately
        continue
      }

      if (item.type === "tool") {
        const toolItem = item as ToolDisplayItem
        const toolName = toolItem.toolPart.tool || "unknown"
        const isSubAgentTask = toolName === "task"
        const isQuestionTool = toolName === "question"

        if (isQuestionTool) {
          // Question tools render as standalone ToolCall components so the
          // interactive question block can appear inline in the message stream
          flushTools()
          flushSubAgents()
          sections.push({ type: "standalone-tool", tool: toolItem })
        } else if (isSubAgentTask) {
          // Sub-agent tasks: flush pending regular tools, then batch sub-agents
          flushTools()
          pendingSubAgents.push(toolItem)
        } else if (pendingSubAgents.length > 0) {
          // Non-task tool while sub-agents are accumulating -- buffer as interstitial
          // so we don't break pipeline detection across gaps like:
          // task(coder) -> read(file) -> task(test-writer) -> task(reviewer)
          interstitialTools.push(toolItem)
        } else {
          // Regular tools with no sub-agents in flight
          pendingTools.push(toolItem)
        }
      } else {
        // Non-tool items: flush all pending tools first, then add the item
        flushTools()
        flushSubAgents()
        sections.push({ type: "item", item })
      }
    }

    // Flush any remaining tools
    flushTools()
    flushSubAgents()

    return sections
  })

  // Collapse excess tool-group sections behind a "Show more" toggle
  const TOOL_SECTION_COLLAPSE_THRESHOLD = 4
  const [sectionsExpanded, setSectionsExpanded] = createSignal(false)

  const displaySections = createMemo<RenderSection[]>(() => {
    const raw = renderSections()

    // Pass 1: Merge nearby subagent-group sections that are separated only by
    // text/content items.  The assistant often emits short text between
    // consecutive Task tool calls, which splits them into many groups of 1.
    const afterSubagentMerge: RenderSection[] = []
    let subagentAccum: ToolDisplayItem[] = []

    const flushSubagentAccum = () => {
      if (subagentAccum.length > 0) {
        afterSubagentMerge.push({ type: "subagent-group", tools: [...subagentAccum] })
        subagentAccum = []
      }
    }

    for (const section of raw) {
      if (section.type === "subagent-group") {
        subagentAccum.push(...section.tools)
      } else if (section.type === "item" && subagentAccum.length > 0) {
        // Text between sub-agents -- skip it from rendering (it's usually
        // just transitional filler like "Now let me...").  The sub-agent
        // rows already show their own descriptions.
        continue
      } else {
        flushSubagentAccum()
        afterSubagentMerge.push(section)
      }
    }
    flushSubagentAccum()

    // Pass 2: Merge nearby tool-group sections that are separated only by
    // text/content items.  The assistant often emits transitional text between
    // consecutive tool calls (e.g., "Let me read this file"), which splits
    // them into many groups of 1 instead of one collapsed group.
    const all: RenderSection[] = []
    let toolAccum: ToolDisplayItem[] = []

    const flushToolAccum = () => {
      if (toolAccum.length > 0) {
        all.push({ type: "tool-group", tools: [...toolAccum] })
        toolAccum = []
      }
    }

    for (const section of afterSubagentMerge) {
      if (section.type === "tool-group") {
        toolAccum.push(...section.tools)
      } else if (section.type === "item" && toolAccum.length > 0) {
        // Text between tool groups -- skip transitional filler.
        // Tool rows already show their own file paths / summaries.
        continue
      } else {
        flushToolAccum()
        all.push(section)
      }
    }
    flushToolAccum()

    if (sectionsExpanded()) return all

    // Find indices of tool-like sections
    const toolIndices: number[] = []
    for (let i = 0; i < all.length; i++) {
      const t = all[i].type
      if (t === "tool-group" || t === "subagent-group" || t === "pipeline-group") {
        toolIndices.push(i)
      }
    }

    if (toolIndices.length <= TOOL_SECTION_COLLAPSE_THRESHOLD) return all

    // Keep sections up to and including the 3rd tool section,
    // collapse middle, then show from the last tool section onward
    const collapseStart = toolIndices[2] + 1
    const resumeAt = toolIndices[toolIndices.length - 1]

    if (resumeAt <= collapseStart) return all

    const hiddenSlice = all.slice(collapseStart, resumeAt)
    const hiddenToolGroups = hiddenSlice.filter(
      (s) => s.type === "tool-group" || s.type === "subagent-group" || s.type === "pipeline-group"
    ).length

    return [
      ...all.slice(0, collapseStart),
      { type: "collapsed-tools" as const, hiddenCount: hiddenSlice.length, toolGroupCount: hiddenToolGroups },
      ...all.slice(resumeAt),
    ]
  })

  // Render a single non-tool item
  const renderItem = (item: MessageBlockItem) => (
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
  )

  // Render a section (either individual item, grouped tools, or grouped sub-agents)
  const renderSection = (section: RenderSection) => {
    if (section.type === "item") {
      return renderItem(section.item)
    }
    if (section.type === "collapsed-tools") {
      return (
        <button
          type="button"
          class="tool-groups-collapsed-toggle"
          onClick={() => setSectionsExpanded(true)}
        >
          Show {section.toolGroupCount} more tool group{section.toolGroupCount !== 1 ? "s" : ""}
        </button>
      )
    }
    if (section.type === "pipeline-group") {
      return (
        <PipelineGroup
          tools={section.tools}
          patternName={section.patternName}
          instanceId={props.instanceId}
          sessionId={props.sessionId}
        />
      )
    }
    if (section.type === "subagent-group") {
      // Sub-agent group - render via SubAgentGroup with accordion behavior
      return (
        <SubAgentGroup
          tools={section.tools}
          instanceId={props.instanceId}
          sessionId={props.sessionId}
        />
      )
    }
    if (section.type === "standalone-tool") {
      // Standalone tool - render as full ToolCall component (e.g., question tool)
      return (
        <ToolCall
          toolCall={section.tool.toolPart}
          toolCallId={section.tool.key}
          messageId={section.tool.messageId}
          messageVersion={section.tool.messageVersion}
          partVersion={section.tool.partVersion}
          instanceId={props.instanceId}
          sessionId={props.sessionId}
        />
      )
    }
    // Tool group - render via ToolCallGroup with all message tools for navigation
    return (
      <ToolCallGroup
        tools={section.tools}
        allToolsInMessage={allToolItems()}
        instanceId={props.instanceId}
        sessionId={props.sessionId}
      />
    )
  }

  return (
    <Show when={block()} keyed>
      {(resolvedBlock) => (
        <div class="flex flex-col gap-2 rounded-lg" data-message-id={resolvedBlock.record.id}>
          {/* Render sections: content, reasoning, and grouped tools in their original order */}
          <For each={displaySections()}>{(section) => renderSection(section)}</For>

          {/* Step-finish (usage/summary bar) - only shown when session is ready for user input */}
          <Show when={props.showStepFinish && stepFinishItem()}>
            {(item) => (
              <StepCard
                kind="finish"
                part={item().part}
                messageInfo={item().messageInfo}
                showUsage={props.showUsageMetrics()}
                borderColor={item().accentColor}

              />
            )}
          </Show>
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
      { label: "Input", value: usage.input, formatter: formatTokenTotal },
      { label: "Output", value: usage.output, formatter: formatTokenTotal },
      { label: "Reasoning", value: usage.reasoning, formatter: formatTokenTotal },
      { label: "Cache Read", value: usage.cacheRead, formatter: formatTokenTotal },
      { label: "Cache Write", value: usage.cacheWrite, formatter: formatTokenTotal },
      { label: "Cost", value: usage.cost, formatter: formatCostValue },
    ]

    return (
      <div class="flex flex-wrap items-center gap-1.5 text-[10px]">
        <For each={entries}>
          {(entry) => (
            <span
              class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] bg-info/10 border-info/25 text-foreground font-semibold"
              data-label={entry.label}
            >
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
        class="flex flex-col gap-2 px-3 py-2 mt-2 ml-6 rounded-lg border border-teal-500/20 border-l-4 bg-gradient-to-br from-teal-500/[0.08] to-teal-500/[0.04] dark:from-teal-500/[0.12] dark:to-teal-500/[0.06]"
        style={finishStyle()}
      >
        {renderUsageChips(usage)}
      </div>
    )
  }

  return (
    <div class="flex flex-col gap-2 px-3 py-2 bg-muted border-l-4 border-l-warning/50">
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <div class="flex items-center justify-between w-full font-semibold text-foreground">
          <div class="flex items-center gap-2 text-muted-foreground">
            <Show when={props.showAgentMeta && (agentIdentifier() || modelIdentifier())}>
              <span class="inline-flex flex-wrap items-center gap-2 text-xs font-medium text-warning">
                <Show when={agentIdentifier()}>{(value) => <span>Agent: {value()}</span>}</Show>
                <Show when={modelIdentifier()}>{(value) => <span>Model: {value()}</span>}</Show>
              </span>
            </Show>
          </div>
          <span class="text-xs text-muted-foreground font-normal ml-auto">{timestamp()}</span>
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
    <div class="bg-muted border-l-4 border-l-warning/50 mt-0 mb-0 p-0 flex flex-col gap-0">
      <button
        type="button"
        class="w-full flex items-center justify-between gap-2.5 bg-transparent border-none px-2.5 py-1 font-inherit text-inherit text-left cursor-pointer transition-colors duration-200 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        onClick={toggle}
        aria-expanded={expanded()}
        aria-label={expanded() ? "Collapse thinking" : "Expand thinking"}
      >
        <span class="text-xs font-medium text-warning flex flex-wrap items-center gap-2">
          <span>Thinking</span>
          <Show when={props.showAgentMeta && (agentIdentifier() || modelIdentifier())}>
            <span class="inline-flex flex-wrap items-center gap-2 text-xs font-medium text-warning">
              <Show when={agentIdentifier()}>{(value) => <span class="font-medium text-warning">Agent: {value()}</span>}</Show>
              <Show when={modelIdentifier()}>{(value) => <span class="font-medium text-warning">Model: {value()}</span>}</Show>
            </span>
          </Show>
        </span>
        <span class="inline-flex items-center gap-2">
          <span class="inline-flex items-center justify-center h-6 px-3 border border-border rounded-md bg-transparent text-muted-foreground font-semibold text-xs leading-none tracking-[0.01em] transition-all duration-200 hover:bg-accent hover:border-primary hover:text-primary active:scale-[0.97]">
            {expanded() ? "Hide" : "View"}
          </span>
          <span class="text-xs text-muted-foreground">{timestamp()}</span>
        </span>
      </button>

      <Show when={expanded()}>
        <div class="flex flex-col gap-1.5">
          <div class="p-0 bg-muted m-3">
            <div
              class="flex flex-col m-0 p-3 max-h-[30rem] overflow-y-auto bg-muted"
              style={{ "scrollbar-width": "thin", "scrollbar-gutter": "stable both-edges" }}
              role="region"
              aria-label="Reasoning details"
            >
              <pre class="font-mono text-xs leading-tight text-foreground whitespace-pre-wrap m-0">{reasoningText() || ""}</pre>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
