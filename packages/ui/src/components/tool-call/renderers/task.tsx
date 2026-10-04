import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Copy } from "lucide-solid"
import type { ToolState } from "../../../types/tool-state"
import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, getDefaultToolAction, getToolName, limitToolOutputForRender, limitToolTitleForRender, readToolStatePayload } from "../utils"
import { messageStoreBus } from "../../../stores/message-v2/bus"
import { beginMessageHistoryTraversal, isLatestMessageWindow, loadMessages, loadNewerMessageWindow, loadOldestMessageWindow } from "../../../stores/session-api"
import { getSessionMessagesLoadError, messagesLoaded, sessions } from "../../../stores/session-state"
import { setSessionTranscriptVisible } from "../../../stores/session-transcript-memory"
import { waitForInstanceWorkspaceMetadataHydration } from "../../../stores/instances"
import { useActiveSessionMessageLoad } from "../../../lib/hooks/use-active-session-message-load"
import { getMessageContentIcon } from "../../message-content-icons"
import { getTaskToolSearchText } from "../search-text"
import { copyTextChunksToClipboard, copyToClipboard } from "../../../lib/clipboard"
import LoadErrorState from "../../load-error-state"
import { collectChildTaskSteps, getLegacyTaskSummary, getTaskOutputCopyText, getTruncatedTaskStepTitleCopyText, isTaskScanTruncated, isTaskStepListTruncated, resolveTaskStepTruncation, stringifyLegacyTaskSummary, TASK_STEP_RENDER_LIMIT } from "./task-summary"
import { getMessageWindowPageKey } from "../../message-history-pagination"
import { useTaskStepCopy } from "./task-copy"
import { getCanonicalToolName } from "../tool-presentation"
import { describeTaskTitle, readSubagentName } from "./task-title"

const TASK_MESSAGE_SCAN_LIMIT = 10_000

interface TaskSummaryItem {
  id: string
  tool: string
  input: Record<string, any>
  metadata: Record<string, any>
  state?: ToolState
  status?: ToolState["status"]
  title?: string
}

type TaskScanBudget = { remaining: number }

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

  // Keep one shell for this key. Native page reprojections and unrelated text
  // revisions must update its props, not discard disclosure/scroll state.
  // Rows follow their tool identity, not their position in the bounded window.
  // A new identity still needs a fresh shell with its default disclosure.
  // Nonzero-arity Show callbacks mount untracked; getters update the child props.
  return <Show when={props.toolKey} keyed>{(_key) => (
    <Show when={toolPart()}>{(_part) => props.renderToolCall({
      get toolCall() { partVersion(); return toolPart()! },
      get messageId() { return messageId() },
      get messageVersion() { return messageVersion() },
      // Native page hydration resets the per-part revision to zero. Let
      // Markdown use its content hash instead of pinning changed output to 0;
      // the getter above still fences versioned in-place snapshot updates.
      get sessionId() { return props.sessionId },
      forceCollapsed: true,
    })}</Show>
  )}</Show>
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

function describeGenericToolTitle(tool: string, input: Record<string, any>) {
  const base = getToolName(tool)
  const detail =
    typeof input.description === "string" && input.description.trim().length > 0
      ? input.description.trim()
      : typeof input.filePath === "string" && input.filePath.trim().length > 0
        ? input.filePath.trim()
        : typeof input.path === "string" && input.path.trim().length > 0
          ? input.path.trim()
          : typeof input.url === "string" && input.url.trim().length > 0
            ? input.url.trim()
            : typeof input.pattern === "string" && input.pattern.trim().length > 0
              ? input.pattern.trim()
              : ""

  return detail ? `${base} ${detail}` : base
}

function describeToolTitle(item: TaskSummaryItem): string {
  if (item.title && item.title.length > 0) {
    return item.title
  }

  if (getCanonicalToolName(item.tool) === "task") {
    return describeTaskTitle({ ...item.metadata, ...item.input }, item.tool)
  }

  if (item.state) {
    const stateTitle = typeof (item.state as { title?: string }).title === "string" ? (item.state as { title?: string }).title : undefined
    if (stateTitle && stateTitle.length > 0) {
      return stateTitle
    }
    const { input } = readToolStatePayload(item.state)
    return describeGenericToolTitle(item.tool, { ...item.metadata, ...item.input, ...input })
  }

  return getDefaultToolAction(item.tool)
}

export const taskRenderer: ToolRenderer = {
  tools: ["task"],
  getSearchText: getTaskToolSearchText,
  getAction: ({ t }) => t("toolCall.task.action.delegating"),
  getOutputChrome({ toolState }) {
    const output = getTaskOutputCopyText(toolState())
    return output ? { getCopyText: () => output, hasCopyText: true } : undefined
  },
  getTitle({ toolState, toolName }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    return describeTaskTitle(input, toolName())
  },
  renderBody({ toolState, instanceId, isActive, renderToolCall, messageVersion, partVersion, scrollHelpers, renderMarkdown, t, onContentRendered }) {
    const store = messageStoreBus.getOrCreate(instanceId)

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

    const childSessionLoadError = createMemo(() => {
      const id = childSessionId()
      return id && !childSessionLoaded() ? getSessionMessagesLoadError(instanceId, id) : undefined
    })

    function retryChildSessionLoad() {
      const id = childSessionId()
      if (!id || isActive?.() === false) return
      void loadMessages(instanceId, id, { force: true }).catch(() => {})
    }

    useActiveSessionMessageLoad({
      isActive: () => Boolean(childSessionId()) && isActive?.() !== false,
      instanceId: () => instanceId,
      session: () => {
        const id = childSessionId()
        return id ? sessions().get(instanceId)?.get(id) : undefined
      },
      shouldLoad: () => !childSessionLoaded(),
      loadMessages: (childInstanceId, id, options) => loadMessages(childInstanceId, id, {
        signal: options?.signal,
        registerInvalidation: options?.registerInvalidation,
      }),
      waitForHydration: waitForInstanceWorkspaceMetadataHydration,
    })

    createEffect(() => {
      const id = childSessionId()
      if (!id || isActive?.() === false) return
      untrack(() => setSessionTranscriptVisible(instanceId, id, true))
      onCleanup(() => setSessionTranscriptVisible(instanceId, id, false))
    })

    const [childToolKeys, setChildToolKeys] = createSignal<string[]>([])
    const [childToolsTruncated, setChildToolsTruncated] = createSignal(false)
    const [childStepsOverflow, setChildStepsOverflow] = createSignal(false)

    let indexedSessionId = ""

    function resetChildToolIndex(nextSessionId: string) {
      indexedSessionId = nextSessionId
      setChildToolKeys([])
      setChildToolsTruncated(false)
      setChildStepsOverflow(false)
    }

    function scanMessageToolParts(messageId: string, startIndex: number, limit: number, budget: TaskScanBudget) {
      if (budget.remaining <= 0) {
        setChildToolsTruncated(true)
        return [] as string[]
      }
      budget.remaining -= 1
      const record = store.getMessage(messageId)
      if (!record) return [] as string[]

      const partIds = record.partIds
      const keys: string[] = []
      const oldestScannedIndex = Math.max(startIndex, partIds.length - budget.remaining)
      if (oldestScannedIndex > startIndex) setChildToolsTruncated(true)
      let idx = partIds.length - 1
      for (; idx >= oldestScannedIndex && keys.length < limit && budget.remaining > 0; idx -= 1) {
        budget.remaining -= 1
        const partId = partIds[idx]
        const entry = record.parts?.[partId]
        const data = entry?.data
        if (!data || (data as any).type !== "tool") continue
        keys.unshift(`${messageId}::${partId}`)
      }
      if (idx >= oldestScannedIndex) setChildToolsTruncated(true)
      return keys
    }

    function fullRescanChildTools(sessionId: string, messageIds: string[]) {
      indexedSessionId = sessionId
      setChildToolsTruncated(false)

      const nextKeys: string[] = []
      const scanLimit = TASK_STEP_RENDER_LIMIT + 1
      const budget = { remaining: TASK_MESSAGE_SCAN_LIMIT }
      const oldestScannedIndex = Math.max(0, messageIds.length - TASK_MESSAGE_SCAN_LIMIT)
      for (let index = messageIds.length - 1; index >= oldestScannedIndex && nextKeys.length < scanLimit && budget.remaining > 0; index -= 1) {
        const keys = scanMessageToolParts(messageIds[index], 0, scanLimit - nextKeys.length, budget)
        for (let keyIndex = keys.length - 1; keyIndex >= 0; keyIndex -= 1) nextKeys.unshift(keys[keyIndex])
      }
      setChildToolsTruncated((truncated) => isTaskScanTruncated(truncated, oldestScannedIndex > 0, isTaskStepListTruncated(nextKeys.length)))
      setChildStepsOverflow(isTaskStepListTruncated(nextKeys.length))
      const keys = nextKeys.slice(-TASK_STEP_RENDER_LIMIT)
      setChildToolKeys(previous => previous.length === keys.length && previous.every((key, index) => key === keys[index]) ? previous : keys)
    }

    createEffect(() => {
      const id = childSessionId()
      const loaded = childSessionLoaded()

      if (!id || (indexedSessionId && indexedSessionId !== id)) {
        resetChildToolIndex("")
      }
      if (!id) return
      if (!loaded) {
        // Invalidation requests a fresh page, but its resident display snapshot
        // may still be valid. Keep its shells while that read is pending, but
        // clear membership and truncation when deletion/eviction removed it.
        if (store.getSessionMessageIds(id).length === 0) resetChildToolIndex("")
        // Rebuild resident membership after the authoritative page arrives.
        return
      }

      // Authoritative pages can remove, replace or reorder parts without changing
      // message counts. Revalidate only bounded structural identities (not output
      // payloads); unchanged keys retain their array and keyed tool shells.
      store.getSessionRevision(id)

      untrack(() => {
        fullRescanChildTools(id, store.getSessionMessageIds(id))
      })
    })
    const promptContent = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const { input } = readToolStatePayload(state)
      const prompt = typeof input.prompt === "string" ? input.prompt : null
      return ensureMarkdownContent(prompt ? limitToolOutputForRender(prompt) : prompt, undefined, false)
    })

    const outputContent = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const output = typeof (state as { output?: unknown }).output === "string" ? ((state as { output?: string }).output as string) : null
      return ensureMarkdownContent(output ? limitToolOutputForRender(output) : output, undefined, false)
    })

    const agentLabel = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const { input } = readToolStatePayload(state)
      const agent = readSubagentName(input)
      return agent ? limitToolTitleForRender(agent) : null
    })

    const modelLabel = createMemo(() => {
      const state = toolState()
      if (!state) return null
      const { metadata } = readToolStatePayload(state)
      const model = (metadata as any).model
      if (!model || typeof model !== "object") return null
      const providerId = typeof model.providerID === "string" ? limitToolTitleForRender(model.providerID) : null
      const modelId = typeof model.modelID === "string" ? limitToolTitleForRender(model.modelID) : null
      if (!providerId && !modelId) return null
      if (providerId && modelId) return `${providerId}/${modelId}`
      return providerId ?? modelId
    })

    const headerMeta = createMemo(() => {
      const agent = agentLabel()
      const model = modelLabel()
      if (agent && model) return limitToolTitleForRender(t("toolCall.task.meta.agentModel", { agent, model }))
      if (agent) return limitToolTitleForRender(t("toolCall.task.meta.agent", { agent }))
      if (model) return limitToolTitleForRender(t("toolCall.task.meta.model", { model }))
      return null
    })

    const legacySummary = createMemo(() => {
      // Track the reactive change points so we only recompute when the part/message changes
      messageVersion?.()
      partVersion?.()

      const state = toolState()
      if (!state) return getLegacyTaskSummary(undefined)
      const { metadata } = readToolStatePayload(state)
      return getLegacyTaskSummary((metadata as any).summary)
    })

    const legacyItems = createMemo(() => {
      if (childToolKeys().length > 0) return []
      return legacySummary().renderedEntries.map((entry, index) => {
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
    // Coverage controls full-copy traversal, not a claim about omitted tool
    // rows. Native cursors can point to an empty boundary page; scan budgets
    // and historical windows likewise cannot prove render-limit overflow.
    const childTranscriptIncomplete = () => {
      const id = childSessionId()
      const window = id ? store.getMessageWindow(id) : undefined
      return childToolsTruncated() || Boolean(window && (window.kind !== "latest" || window.olderCursor))
    }
    const childSourceActive = () => childToolKeys().length > 0 || childTranscriptIncomplete()
    const stepsTruncated = () => resolveTaskStepTruncation(childSourceActive(), childStepsOverflow(), legacySummary().truncated)

    const childTaskCopy = useTaskStepCopy({
      childSessionId,
      isActive: () => isActive?.() ?? true,
      beginTraversal: id => beginMessageHistoryTraversal(instanceId, id),
      getPageKey: id => getMessageWindowPageKey(store.getMessageWindow(id)),
      isLatest: id => isLatestMessageWindow(instanceId, id),
      loadOldest: (id, signal) => loadOldestMessageWindow(instanceId, id, signal),
      loadNewer: (id, signal) => loadNewerMessageWindow(instanceId, id, signal),
      readSteps: id => collectChildTaskSteps(store.getSessionMessageIds(id), store.getMessage),
      copy: copyTextChunksToClipboard,
    })

    createEffect(() => {
      const childCount = childToolKeys().length
      const legacyCount = legacyItems().length
      if (childCount === 0 && legacyCount === 0) return
      scrollHelpers?.restoreAfterRender()
      onContentRendered?.()
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
                // Always use the normal markdown render path for prompt (even while running)
                // so the prompt doesn't visually change between running/completed states.
                disableHighlight: false,
              })}
            </div>
          </section>
        </Show>

        <Show when={childSessionLoadError()}>
          {(error) => (
            <LoadErrorState
              title={t("messageSection.loadError.title")}
              error={error()}
              retryLabel={t("messageSection.loadError.reload")}
              onRetry={retryChildSessionLoad}
              variant="compact"
            />
          )}
        </Show>

        <Show when={childToolKeys().length > 0 || legacyItems().length > 0 || stepsTruncated()}>
          <section class="tool-call-task-section">
            <header class="tool-call-task-section-header">
              <span class="tool-call-task-section-title">{t("toolCall.task.sections.steps")}</span>
              <span class="tool-call-io-actions">
                <span class="tool-call-task-section-meta">
                  {t("toolCall.task.steps.count", { count: stepsTruncated() ? `${TASK_STEP_RENDER_LIMIT}+` : childSourceActive() ? childToolKeys().length : legacyItems().length })}
                </span>
                <Show when={childTranscriptIncomplete()}>
                  <button type="button" class="tool-call-header-icon-button tool-call-io-copy" disabled={childTaskCopy.pending()} onClick={() => void childTaskCopy.copy().catch(() => {})} aria-label={t("toolCall.io.copyOutputAriaLabel")} title={t("toolCall.io.copyOutputTitle")}>
                    <Copy class="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </Show>
                <Show when={childToolKeys().length === 0 && legacySummary().truncated}>
                  <button type="button" class="tool-call-header-icon-button tool-call-io-copy" onClick={() => void copyToClipboard(stringifyLegacyTaskSummary(legacySummary().entries))} aria-label={t("toolCall.io.copyOutputAriaLabel")} title={t("toolCall.io.copyOutputTitle")}>
                    <Copy class="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </Show>
              </span>
            </header>
            <div class="tool-call-task-section-body">
              <Show when={stepsTruncated()}>
                <div class="tool-call-diagnostic-message" role="status">{t("toolCall.task.steps.truncated", { count: TASK_STEP_RENDER_LIMIT })}</div>
              </Show>
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
                          const icon = getMessageContentIcon(item.tool)
                          const fullDescription = describeToolTitle(item)
                          const description = limitToolTitleForRender(fullDescription)
                          const copyTitle = getTruncatedTaskStepTitleCopyText(fullDescription)
                          const toolLabel = limitToolTitleForRender(getToolName(item.tool))
                          const status = normalizeStatus(item.status ?? item.state?.status)
                          const statusIcon = summarizeStatusIcon(status)
                          const statusKey = summarizeStatusLabel(status)
                          const statusLabel = statusKey
                            ? t(`toolCall.status.${statusKey}`)
                            : t("toolCall.status.unknown")
                          const statusAttr = status ?? "pending"
                          return (
                            <div class="tool-call-task-item" data-task-id={item.id} data-task-status={statusAttr}>
                              <span class="tool-call-task-icon inline-flex flex-shrink-0">
                                <Dynamic component={icon} class="w-3.5 h-3.5" aria-hidden="true" />
                              </span>
                              <span class="tool-call-task-label">{toolLabel}</span>
                              <span class="tool-call-task-separator" aria-hidden="true">—</span>
                              <span class="tool-call-task-text">{description}</span>
                              <Show when={copyTitle}>
                                {(title) => (
                                  <button type="button" class="tool-call-header-icon-button tool-call-io-copy" onClick={() => void copyToClipboard(title())} aria-label={t("toolCall.io.copyOutputAriaLabel")} title={t("toolCall.io.copyOutputTitle")}>
                                    <Copy class="w-3.5 h-3.5" aria-hidden="true" />
                                  </button>
                                )}
                              </Show>
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
