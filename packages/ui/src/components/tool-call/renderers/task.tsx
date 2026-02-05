import { For, Show, createEffect, createMemo, createSignal, untrack } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, getDefaultToolAction, getToolIcon, getToolName, readToolStatePayload } from "../utils"
import { resolveTitleForTool } from "../tool-title"
import { messageStoreBus } from "../../../stores/message-v2/bus"
import { loadMessages } from "../../../stores/session-api"
import { loading, messagesLoaded } from "../../../stores/session-state"

interface TaskSummaryItem {
  id: string
  tool: string
  input: Record<string, any>
  metadata: Record<string, any>
  state?: ToolState
  status?: ToolState["status"]
  title?: string
}

function extractSessionIdFromTaskState(state?: ToolState): string {
  if (!state) return ""
  const metadata = (state as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}
  const directId = (metadata as any)?.sessionId ?? (metadata as any)?.sessionID
  return typeof directId === "string" ? directId : ""
}

function splitToolKey(key: string): { messageId: string; partId: string } | null {
  const separator = "::"
  const index = key.lastIndexOf(separator)
  if (index <= 0) return null
  const messageId = key.slice(0, index)
  const partId = key.slice(index + separator.length)
  if (!messageId || !partId) return null
  return { messageId, partId }
}

function TaskToolCallRow(props: {
  toolKey: string
  store: ReturnType<typeof messageStoreBus.getOrCreate>
  sessionId: string
  renderToolCall: NonNullable<import("../types").ToolRendererContext["renderToolCall"]>
}) {
  const parts = createMemo(() => splitToolKey(props.toolKey))
  const messageId = createMemo(() => parts()?.messageId ?? "")
  const partId = createMemo(() => parts()?.partId ?? "")

  const record = createMemo(() => {
    const id = messageId()
    if (!id) return undefined
    return props.store.getMessage(id)
  })

  const partEntry = createMemo(() => {
    const rec = record()
    const pid = partId()
    if (!rec || !pid) return undefined
    return rec.parts?.[pid]
  })

  const toolPart = createMemo(() => {
    const data = partEntry()?.data
    return data && (data as any).type === "tool" ? (data as any) : undefined
  })

  const messageVersion = createMemo(() => record()?.revision ?? 0)
  const partVersion = createMemo(() => partEntry()?.revision ?? 0)

  const rendered = createMemo(() => {
    const part = toolPart()
    if (!part) return null
    return props.renderToolCall({
      toolCall: part as any,
      messageId: messageId(),
      messageVersion: messageVersion(),
      partVersion: partVersion(),
      sessionId: props.sessionId,
      forceCollapsed: true,
    })
  })

  return <>{rendered()}</>
}

function normalizeStatus(status?: string | null): ToolState["status"] | undefined {
  if (status === "pending" || status === "running" || status === "completed" || status === "error") {
    return status
  }
  return undefined
}

function summarizeStatusIcon(status?: ToolState["status"]) {
  switch (status) {
    case "pending":
      return "⏸"
    case "running":
      return "⏳"
    case "completed":
      return "✓"
    case "error":
      return "✗"
    default:
      return ""
  }
}

function summarizeStatusLabel(status?: ToolState["status"]) {
  return status
}

function describeTaskTitle(input: Record<string, any>) {
  const description = typeof input.description === "string" ? input.description : undefined
  const subagent = typeof input.subagent_type === "string" ? input.subagent_type : undefined
  const base = getToolName("task")
  if (description && subagent) {
    return `${base}[${subagent}] ${description}`
  }
  if (description) {
    return `${base} ${description}`
  }
  return base
}

function describeToolTitle(item: TaskSummaryItem): string {
  if (item.title && item.title.length > 0) {
    return item.title
  }

  if (item.tool === "task") {
    return describeTaskTitle({ ...item.metadata, ...item.input })
  }

  if (item.state) {
    return resolveTitleForTool({ toolName: item.tool, state: item.state })
  }

  return getDefaultToolAction(item.tool)
}

export const taskRenderer: ToolRenderer = {
  tools: ["task"],
  getAction: ({ t }) => t("toolCall.task.action.delegating"),
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    return describeTaskTitle(input)
  },
  renderBody({ toolState, instanceId, renderToolCall, messageVersion, partVersion, scrollHelpers, renderMarkdown, t }) {
    const store = messageStoreBus.getOrCreate(instanceId)
    const [requestedChildLoad, setRequestedChildLoad] = createSignal(false)

    const childSessionId = createMemo(() => {
      const state = toolState()
      return extractSessionIdFromTaskState(state)
    })

    const childSessionLoaded = createMemo(() => {
      const id = childSessionId()
      if (!id) return false
      const loadedForInstance = messagesLoaded().get(instanceId)
      return loadedForInstance?.has(id) ?? false
    })

    const childSessionLoading = createMemo(() => {
      const id = childSessionId()
      if (!id) return false
      const loadingSet = loading().loadingMessages.get(instanceId)
      return loadingSet?.has(id) ?? false
    })

    createEffect(() => {
      const id = childSessionId()
      if (!id) return
      if (requestedChildLoad()) return
      if (childSessionLoaded()) return
      if (childSessionLoading()) return
      setRequestedChildLoad(true)
      void loadMessages(instanceId, id)
    })

    const childToolKeys = createMemo(() => {
      const id = childSessionId()
      if (!id) return [] as string[]
      if (!childSessionLoaded()) return [] as string[]

      // React to session changes, but do the scan untracked to avoid
      // subscribing to every message/part node in the store.
      store.getSessionRevision(id)
      return untrack(() => {
        const messageIds = store.getSessionMessageIds(id)
        const keys: string[] = []
        for (const messageId of messageIds) {
          const record = store.getMessage(messageId)
          if (!record) continue
          for (const partId of record.partIds) {
            const entry = record.parts?.[partId]
            const data = entry?.data
            if (!data || (data as any).type !== "tool") continue
            keys.push(`${messageId}::${partId}`)
          }
        }
        return keys
      })
    })
    const promptContent = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const { input } = readToolStatePayload(state)
      const prompt = typeof input.prompt === "string" ? input.prompt : null
      return ensureMarkdownContent(prompt, undefined, false)
    })

    const outputContent = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const output = typeof (state as { output?: unknown }).output === "string" ? ((state as { output?: string }).output as string) : null
      return ensureMarkdownContent(output, undefined, false)
    })

    const agentLabel = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const { input } = readToolStatePayload(state)
      return typeof input.subagent_type === "string" ? input.subagent_type : null
    })

    const modelLabel = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const { metadata } = readToolStatePayload(state)
      const model = (metadata as any).model
      if (!model || typeof model !== "object") return null
      const providerId = typeof model.providerID === "string" ? model.providerID : null
      const modelId = typeof model.modelID === "string" ? model.modelID : null
      if (!providerId && !modelId) return null
      if (providerId && modelId) return `${providerId}/${modelId}`
      return providerId ?? modelId
    })

    const headerMeta = createMemo(() => {
      const agent = agentLabel()
      const model = modelLabel()
      if (agent && model) return t("toolCall.task.meta.agentModel", { agent, model })
      if (agent) return t("toolCall.task.meta.agent", { agent })
      if (model) return t("toolCall.task.meta.model", { model })
      return null
    })

    const legacyItems = createMemo(() => {
      // Track the reactive change points so we only recompute when the part/message changes
      messageVersion?.()
      partVersion?.()

      const state = toolState()
      if (!state) return []

      // Prefer deriving steps from the child session when loaded.
      if (childSessionLoaded()) return []

      const { metadata } = readToolStatePayload(state)
      const summary = Array.isArray((metadata as any).summary) ? ((metadata as any).summary as any[]) : []

      return summary.map((entry, index) => {
        const tool = typeof entry?.tool === "string" ? (entry.tool as string) : "unknown"
        const stateValue = typeof entry?.state === "object" ? (entry.state as ToolState) : undefined
        const metadataFromEntry = typeof entry?.metadata === "object" && entry.metadata ? entry.metadata : {}
        const fallbackInput = typeof entry?.input === "object" && entry.input ? entry.input : {}
        const id = typeof entry?.id === "string" && entry.id.length > 0 ? entry.id : `${tool}-${index}`
        const statusValue = normalizeStatus((entry?.status as string | undefined) ?? stateValue?.status)
        const title = typeof entry?.title === "string" ? entry.title : undefined
        return { id, tool, input: fallbackInput, metadata: metadataFromEntry, state: stateValue, status: statusValue, title }
      })
    })

    return (
      <div class="tool-call-task-sections">
        <Show when={promptContent()}>
          <section class="tool-call-task-section">
            <header class="tool-call-task-section-header">
              <span class="tool-call-task-section-title">{t("toolCall.task.sections.prompt")}</span>
              <Show when={headerMeta()}>
                <span class="tool-call-task-section-meta">{headerMeta()}</span>
              </Show>
            </header>
            <div class="tool-call-task-section-body">
              {renderMarkdown({
                content: promptContent()!,
                cacheKey: "task:prompt",
                disableScrollTracking: true,
                disableHighlight: true,
              })}
            </div>
          </section>
        </Show>

        <Show when={childToolKeys().length > 0 || legacyItems().length > 0}>
          <section class="tool-call-task-section">
            <header class="tool-call-task-section-header">
              <span class="tool-call-task-section-title">{t("toolCall.task.sections.steps")}</span>
              <span class="tool-call-task-section-meta">
                {t("toolCall.task.steps.count", { count: childToolKeys().length > 0 ? childToolKeys().length : legacyItems().length })}
              </span>
            </header>
            <div class="tool-call-task-section-body">
              <Show
                when={childToolKeys().length > 0}
                fallback={
                  <div
                    class="message-text tool-call-markdown tool-call-task-container"
                    ref={scrollHelpers?.registerContainer}
                    onScroll={
                      scrollHelpers ? (event) => scrollHelpers.handleScroll(event as Event & { currentTarget: HTMLDivElement }) : undefined
                    }
                  >
                    <div class="tool-call-task-summary">
                      <For each={legacyItems()}>
                        {(item) => {
                          const icon = getToolIcon(item.tool)
                          const description = describeToolTitle(item)
                          const toolLabel = getToolName(item.tool)
                          const status = normalizeStatus(item.status ?? item.state?.status)
                          const statusIcon = summarizeStatusIcon(status)
                          const statusKey = summarizeStatusLabel(status)
                          const statusLabel = statusKey
                            ? t(`toolCall.status.${statusKey}`)
                            : t("toolCall.status.unknown")
                          const statusAttr = status ?? "pending"
                          return (
                            <div class="tool-call-task-item" data-task-id={item.id} data-task-status={statusAttr}>
                              <span class="tool-call-task-icon">{icon}</span>
                              <span class="tool-call-task-label">{toolLabel}</span>
                              <span class="tool-call-task-separator" aria-hidden="true">—</span>
                              <span class="tool-call-task-text">{description}</span>
                              <Show when={statusIcon}>
                                <span class="tool-call-task-status" aria-label={statusLabel} title={statusLabel}>
                                  {statusIcon}
                                </span>
                              </Show>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                    {scrollHelpers?.renderSentinel?.()}
                  </div>
                }
              >
                <div
                  class="message-text tool-call-markdown tool-call-task-container"
                  ref={scrollHelpers?.registerContainer}
                  onScroll={
                    scrollHelpers ? (event) => scrollHelpers.handleScroll(event as Event & { currentTarget: HTMLDivElement }) : undefined
                  }
                >
                  <div class="tool-call-task-summary">
                    <For each={childToolKeys()}>
                      {(key) => (
                        <Show when={renderToolCall}>
                          {(render) => (
                            <TaskToolCallRow
                              toolKey={key}
                              store={store}
                              sessionId={childSessionId()}
                              renderToolCall={render()}
                            />
                          )}
                        </Show>
                      )}
                    </For>
                  </div>
                  {scrollHelpers?.renderSentinel?.()}
                </div>
              </Show>
            </div>
          </section>
        </Show>

        <Show when={outputContent()}>
          <section class="tool-call-task-section">
            <header class="tool-call-task-section-header">
              <span class="tool-call-task-section-title">{t("toolCall.task.sections.output")}</span>
              <Show when={headerMeta()}>
                <span class="tool-call-task-section-meta">{headerMeta()}</span>
              </Show>
            </header>
            <div class="tool-call-task-section-body">
              {renderMarkdown({
                content: outputContent()!,
                cacheKey: "task:output",
                disableScrollTracking: true,
              })}
            </div>
          </section>
        </Show>
      </div>
    )
  },
}
