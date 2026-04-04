import { createSignal, Show, createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import { ArrowRightSquare, Check, Copy, Hourglass, Loader2, XCircle } from "lucide-solid"
import { stringify as stringifyYaml } from "yaml"
import { messageStoreBus } from "../stores/message-v2/bus"
import { useTheme } from "../lib/theme"
import { useGlobalCache } from "../lib/hooks/use-global-cache"
import { useConfig } from "../stores/preferences"
import { activeInterruption, sendPermissionResponse, sendQuestionReject, sendQuestionReply } from "../stores/instances"
import { copyToClipboard } from "../lib/clipboard"
import type { PermissionRequestLike } from "../types/permission"
import { getPermissionSessionId } from "../types/permission"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { useI18n } from "../lib/i18n"
import { resolveToolRenderer } from "./tool-call/renderers"
import { QuestionToolBlock } from "./tool-call/question-block"
import { PermissionToolBlock } from "./tool-call/permission-block"
import { createAnsiContentRenderer } from "./tool-call/ansi-render"
import { createDiffContentRenderer } from "./tool-call/diff-render"
import { createMarkdownContentRenderer } from "./tool-call/markdown-render"
import { extractDiagnostics, diagnosticFileName } from "./tool-call/diagnostics"
import { renderDiagnosticsSection } from "./tool-call/diagnostics-section"
import type {
  DiffPayload,
  DiffRenderOptions,
  MarkdownRenderOptions,
  AnsiRenderOptions,
  ToolCallPart,
  ToolRendererContext,
  ToolScrollHelpers,
} from "./tool-call/types"
import {
  buildToolSpeechText,
  ensureMarkdownContent,
  getRelativePath,
  getToolIcon,
  getToolName,
  isToolStateCompleted,
  isToolStateError,
  isToolStateRunning,
  getDefaultToolAction,
  readToolStatePayload,
} from "./tool-call/utils"
import { resolveTitleForTool } from "./tool-call/tool-title"
import { getLogger } from "../lib/logger"
import { useSpeech } from "../lib/hooks/use-speech"
import SpeechActionButton from "./speech-action-button"
import { createFollowScroll } from "../lib/follow-scroll"

const log = getLogger("session")

type ToolState = import("@opencode-ai/sdk/v2").ToolState

const TOOL_CALL_CACHE_SCOPE = "tool-call"
const TOOL_SCROLL_SENTINEL_MARGIN_PX = 48

function makeRenderCacheKey(
  toolCallId?: string | null,
  messageId?: string,
  partId?: string | null,
  variant = "default",
) {
  const messageComponent = messageId ?? "unknown-message"
  const toolCallComponent = partId ?? toolCallId ?? "unknown-tool-call"
  return `${messageComponent}:${toolCallComponent}:${variant}`
}


interface ToolCallProps {
  toolCall: ToolCallPart
  toolCallId?: string
  messageId?: string
  messageVersion?: number
  partVersion?: number
  instanceId: string
  sessionId: string
  onContentRendered?: () => void
  /**
   * When true, tool call starts collapsed regardless of user preferences.
   * Users can still expand/collapse manually.
   */
  forceCollapsed?: boolean
 }

function ToolStatusIndicator(props: { status: Accessor<string> }) {
  const isVisible = (value: string) => props.status() === value

  return (
    <span class="tool-call-header-status" aria-hidden="true" data-status={props.status() || "pending"}>
      <span style={{ display: isVisible("pending") ? "inline-flex" : "none" }}>
        <Hourglass class="w-4 h-4" />
      </span>
      <span style={{ display: isVisible("running") ? "inline-flex" : "none" }}>
        <Loader2 class="w-4 h-4 animate-spin" />
      </span>
      <span style={{ display: isVisible("completed") ? "inline-flex" : "none" }}>
        <Check class="w-4 h-4" />
      </span>
      <span style={{ display: isVisible("error") ? "inline-flex" : "none" }}>
        <XCircle class="w-4 h-4" />
      </span>
    </span>
  )
}

function ToolCallDetails(props: {
  toolCallMemo: () => ToolCallPart
  toolState: () => ToolState | undefined
  toolName: () => string
  toolCallIdentifier: () => string
  instanceId: string
  sessionId: string
  messageId?: string
  messageVersion?: number
  partVersion?: number
  onContentRendered?: () => void
  preferences: ReturnType<typeof useConfig>["preferences"]
  setDiffViewMode: ReturnType<typeof useConfig>["setDiffViewMode"]
  isDark: () => boolean
  t: ReturnType<typeof useI18n>["t"]
  store: () => ReturnType<typeof messageStoreBus.getOrCreate>
  pendingPermission: () => { permission: PermissionRequestLike; active: boolean } | undefined
  pendingQuestion: () => { request: QuestionRequest; active: boolean } | undefined
  isPermissionActive: () => boolean
  isQuestionActive: () => boolean
  hasToolInput: () => boolean
  isToolInputVisible: () => boolean
  toolInput: () => Record<string, any> | undefined
  inputSectionExpanded: () => boolean
  outputSectionExpanded: () => boolean
  toggleInputSection: () => void
  toggleOutputSection: () => void
  toolCallRootEl: () => HTMLDivElement | undefined
  scrollTopSnapshot: () => number
  setScrollTopSnapshot: (next: number) => void
}) {
  const messageVersionAccessor = createMemo(() => props.messageVersion)
  const partVersionAccessor = createMemo(() => props.partVersion)

  const cacheContext = createMemo(() => ({
    toolCallId: props.toolCallIdentifier(),
    messageId: props.messageId,
    partId: props.toolCallMemo()?.id ?? null,
  }))

  const cacheVersion = createMemo(() => {
    if (typeof props.partVersion === "number") {
      return String(props.partVersion)
    }
    if (typeof props.messageVersion === "number") {
      return String(props.messageVersion)
    }
    return "noversion"
  })

  const createVariantCache = (variant: string | (() => string), version?: () => string) =>
    useGlobalCache({
      instanceId: () => props.instanceId,
      sessionId: () => props.sessionId,
      scope: TOOL_CALL_CACHE_SCOPE,
      cacheId: () => {
        const context = cacheContext()
        const resolvedVariant = typeof variant === "function" ? variant() : variant
        return makeRenderCacheKey(context.toolCallId || undefined, context.messageId, context.partId, resolvedVariant)
      },
      version: () => (version ? version() : cacheVersion()),
    })

  const diffCache = createVariantCache("diff")
  const permissionDiffCache = createVariantCache("permission-diff")
  const ansiRunningCache = createVariantCache("ansi-running", () => "running")
  const ansiFinalCache = createVariantCache("ansi-final")

  const permissionDetails = createMemo(() => props.pendingPermission()?.permission)
  const questionDetails = createMemo(() => props.pendingQuestion()?.request)

  const activePermissionKey = createMemo(() => {
    const permission = permissionDetails()
    return permission && props.isPermissionActive() ? permission.id : ""
  })

  const activeQuestionKey = createMemo(() => {
    const request = questionDetails()
    return request && props.isQuestionActive() ? request.id : ""
  })

  const [permissionSubmitting, setPermissionSubmitting] = createSignal(false)
  const [permissionError, setPermissionError] = createSignal<string | null>(null)

  const followScroll = createFollowScroll({
    getScrollTopSnapshot: props.scrollTopSnapshot,
    setScrollTopSnapshot: props.setScrollTopSnapshot,
    sentinelMarginPx: TOOL_SCROLL_SENTINEL_MARGIN_PX,
    sentinelClassName: "tool-call-scroll-sentinel",
  })

  const scrollHelpers: ToolScrollHelpers = {
    registerContainer: (element, options) => {
      followScroll.registerContainer(element, options)
    },
    handleScroll: followScroll.handleScroll,
    renderSentinel: followScroll.renderSentinel,
    restoreAfterRender: followScroll.restoreAfterRender,
  }

  const handleScrollRendered = () => {
    followScroll.restoreAfterRender()
  }

  createEffect(() => {
    const permission = permissionDetails()
    if (!permission) {
      setPermissionSubmitting(false)
      setPermissionError(null)
    } else {
      setPermissionError(null)
    }
  })

  createEffect(() => {
    const activeKey = activePermissionKey() || activeQuestionKey()
    if (!activeKey) return
    requestAnimationFrame(() => {
      props.toolCallRootEl()?.scrollIntoView({ block: "center", behavior: "smooth" })
    })
  })

  async function handlePermissionResponse(permission: PermissionRequestLike, response: "once" | "always" | "reject") {
    if (!permission) return
    setPermissionSubmitting(true)
    setPermissionError(null)
    try {
      const sessionId = getPermissionSessionId(permission) || props.sessionId
      await sendPermissionResponse(props.instanceId, sessionId, permission.id, response)
    } catch (error) {
      log.error("Failed to send permission response", error)
      setPermissionError(error instanceof Error ? error.message : props.t("toolCall.permission.errors.unableToUpdate"))
    } finally {
      setPermissionSubmitting(false)
    }
  }

  createEffect(() => {
    const activeKey = activePermissionKey()
    if (!activeKey) return
    const handler = (event: KeyboardEvent) => {
      const permission = permissionDetails()
      if (!permission || !props.isPermissionActive()) return
      if (event.key === "Enter") {
        event.preventDefault()
        void handlePermissionResponse(permission, "once")
      } else if (event.key === "a" || event.key === "A") {
        event.preventDefault()
        void handlePermissionResponse(permission, "always")
      } else if (event.key === "d" || event.key === "D") {
        event.preventDefault()
        void handlePermissionResponse(permission, "reject")
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  const [questionSubmitting, setQuestionSubmitting] = createSignal(false)
  const [questionError, setQuestionError] = createSignal<string | null>(null)
  const [questionDraftAnswers, setQuestionDraftAnswers] = createSignal<Record<string, string[][]>>({})

  function isTextInputFocused() {
    const active = document.activeElement
    return (
      active?.tagName === "TEXTAREA" ||
      active?.tagName === "INPUT" ||
      (active?.hasAttribute("contenteditable") ?? false)
    )
  }

  async function handleQuestionSubmit() {
    const request = questionDetails()
    if (!request || !props.isQuestionActive()) {
      return
    }
    const answers = (questionDraftAnswers()[request.id] ?? []).map((x) => (Array.isArray(x) ? x : []))
    const normalized = request.questions.map((_, index) => {
      const row = answers[index] ?? []
      return row.map((value) => value.trim()).filter((value) => value.length > 0)
    })
    if (normalized.some((item) => (item?.length ?? 0) === 0)) {
      setQuestionError(props.t("toolCall.question.validation.answerAll"))
      return
    }

    setQuestionSubmitting(true)
    setQuestionError(null)
    try {
      const sessionId = (request as any).sessionID ?? (request as any).sessionId ?? props.sessionId
      await sendQuestionReply(props.instanceId, sessionId, request.id, normalized)
    } catch (error) {
      log.error("Failed to send question reply", error)
      setQuestionError(error instanceof Error ? error.message : props.t("toolCall.question.errors.unableToReply"))
    } finally {
      setQuestionSubmitting(false)
    }
  }

  async function handleQuestionDismiss() {
    const request = questionDetails()
    if (!request || !props.isQuestionActive()) {
      return
    }
    setQuestionSubmitting(true)
    setQuestionError(null)
    try {
      const sessionId = (request as any).sessionID ?? (request as any).sessionId ?? props.sessionId
      await sendQuestionReject(props.instanceId, sessionId, request.id)
    } catch (error) {
      log.error("Failed to reject question", error)
      setQuestionError(error instanceof Error ? error.message : props.t("toolCall.question.errors.unableToDismiss"))
    } finally {
      setQuestionSubmitting(false)
    }
  }

  createEffect(() => {
    const activeKey = activeQuestionKey()
    if (!activeKey) return
    const handler = (event: KeyboardEvent) => {
      if (isTextInputFocused()) return
      if (event.key === "Enter") {
        event.preventDefault()
        void handleQuestionSubmit()
      } else if (event.key === "Escape") {
        event.preventDefault()
        void handleQuestionDismiss()
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  createEffect(() => {
    const request = questionDetails()
    if (!request) {
      setQuestionSubmitting(false)
      setQuestionError(null)
      return
    }
    setQuestionError(null)
    const requestId = request.id
    setQuestionDraftAnswers((prev) => {
      if (prev[requestId]) return prev
      const initial = request.questions.map(() => [])
      return { ...prev, [requestId]: initial }
    })
  })

  const status = () => props.toolState()?.status || ""

  const toolInputMarkdown = createMemo(() => {
    const input = props.toolInput()
    if (!input || Object.keys(input).length === 0) return null

    try {
      const yamlText = stringifyYaml(input)
      return ensureMarkdownContent(yamlText, "yaml", true)
    } catch (error) {
      log.error("Failed to convert tool call input to YAML", error)
      try {
        const jsonText = JSON.stringify(input, null, 2)
        return ensureMarkdownContent(jsonText, "json", true)
      } catch (nestedError) {
        log.error("Failed to stringify tool call input", nestedError)
        return null
      }
    }
  })

  const renderer = createMemo(() => resolveToolRenderer(props.toolName()))

  const { renderAnsiContent } = createAnsiContentRenderer({
    ansiRunningCache,
    ansiFinalCache,
    scrollHelpers,
    partVersion: partVersionAccessor,
  })

  const { renderDiffContent } = createDiffContentRenderer({
    toolState: props.toolState,
    preferences: props.preferences,
    setDiffViewMode: props.setDiffViewMode,
    isDark: props.isDark,
    t: props.t,
    diffCache,
    permissionDiffCache,
    scrollHelpers,
    handleScrollRendered,
    onContentRendered: props.onContentRendered,
  })

  const { renderMarkdownContent } = createMarkdownContentRenderer({
    toolState: props.toolState,
    partId: props.toolCallIdentifier,
    partVersion: partVersionAccessor,
    instanceId: props.instanceId,
    sessionId: props.sessionId,
    isDark: props.isDark,
    scrollHelpers,
    handleScrollRendered,
    onContentRendered: props.onContentRendered,
  })

  const rendererContext: ToolRendererContext = {
    toolCall: props.toolCallMemo,
    toolState: props.toolState,
    toolName: props.toolName,
    instanceId: props.instanceId,
    sessionId: props.sessionId,
    t: props.t,
    messageVersion: messageVersionAccessor,
    partVersion: partVersionAccessor,
    renderMarkdown: renderMarkdownContent,
    renderAnsi: renderAnsiContent,
    renderDiff: renderDiffContent,
    renderToolCall: (options) => {
      if (!options?.toolCall) return null
      return (
        <ToolCall
          toolCall={options.toolCall}
          toolCallId={options.toolCall.id}
          messageId={options.messageId}
          messageVersion={options.messageVersion}
          partVersion={options.partVersion}
          instanceId={props.instanceId}
          sessionId={options.sessionId}
          forceCollapsed={options.forceCollapsed}
        />
      )
    },
    scrollHelpers,
    onContentRendered: props.onContentRendered,
  }

  let previousPartVersion: number | undefined
  createEffect(() => {
    const version = partVersionAccessor()
    if (version === undefined) {
      return
    }
    if (previousPartVersion !== undefined && version === previousPartVersion) {
      return
    }
    previousPartVersion = version
    followScroll.restoreAfterRender()
  })

  createEffect(() => {
    if (followScroll.autoScroll()) {
      followScroll.restoreAfterRender({ forceBottom: true })
    }
  })

  const renderToolBody = () => {
    return renderer().renderBody(rendererContext)
  }

  const renderError = () => {
    const state = props.toolState()
    if (state?.status === "error" && state.error) {
      return (
        <div class="tool-call-error-content">
          <strong>{props.t("toolCall.error.label")}</strong> {state.error}
        </div>
      )
    }
    return null
  }

  const renderPermissionBlock = () => (
    <PermissionToolBlock
      permission={permissionDetails}
      active={props.isPermissionActive}
      submitting={permissionSubmitting}
      error={permissionError}
      renderDiff={renderDiffContent}
      fallbackSessionId={() => props.sessionId}
      onRespond={(permission, sessionId, response) => void handlePermissionResponse(permission, response)}
    />
  )

  const renderQuestionBlock = () => (
    <QuestionToolBlock
      toolName={props.toolName}
      toolState={props.toolState}
      toolCallId={props.toolCallIdentifier}
      request={questionDetails}
      active={props.isQuestionActive}
      submitting={questionSubmitting}
      error={questionError}
      draftAnswers={questionDraftAnswers}
      setDraftAnswers={setQuestionDraftAnswers}
      onSubmit={() => void handleQuestionSubmit()}
      onDismiss={() => void handleQuestionDismiss()}
    />
  )
  return (
    <div class="tool-call-details">
      <Show
        when={props.isToolInputVisible() && props.hasToolInput()}
        fallback={
          <>
            {renderToolBody()}
            {renderError()}

            <Show when={status() === "pending" && !props.pendingPermission()}>
              <div class="tool-call-pending-message">
                <span class="spinner-small"></span>
                <span>{props.t("toolCall.pending.waitingToRun")}</span>
              </div>
            </Show>
          </>
        }
      >
        <div class="tool-call-io-sections">
          <div class="tool-call-io-section">
            <button type="button" class="tool-call-io-toggle" aria-expanded={props.inputSectionExpanded()} onClick={props.toggleInputSection}>
              <span class="tool-call-io-title">{props.t("toolCall.io.input")}</span>
            </button>

            <Show when={props.inputSectionExpanded()}>
              <div class="tool-call-io-body">
                {(() => {
                  const content = toolInputMarkdown()
                  if (!content) return null
                  return renderMarkdownContent({ content, cacheKey: "input" })
                })()}
              </div>
            </Show>
          </div>

          <div class="tool-call-io-section">
            <button type="button" class="tool-call-io-toggle" aria-expanded={props.outputSectionExpanded()} onClick={props.toggleOutputSection}>
              <span class="tool-call-io-title">{props.t("toolCall.io.output")}</span>
            </button>

            <Show when={props.outputSectionExpanded()}>
              <div class="tool-call-io-body">
                {renderToolBody()}
                {renderError()}

                <Show when={status() === "pending" && !props.pendingPermission()}>
                  <div class="tool-call-pending-message">
                    <span class="spinner-small"></span>
                    <span>{props.t("toolCall.pending.waitingToRun")}</span>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </Show>

      {renderPermissionBlock()}
      {renderQuestionBlock()}
    </div>
  )
}





export default function ToolCall(props: ToolCallProps) {
  const { preferences, setDiffViewMode } = useConfig()
  const { isDark } = useTheme()
  const { t } = useI18n()
  const toolCallMemo = createMemo(() => props.toolCall)
  const toolName = createMemo(() => toolCallMemo()?.tool || "")
  const toolCallIdentifier = createMemo(() => {
    const partId = toolCallMemo()?.id
    if (!partId) {
      throw new Error("Tool call requires a part id")
    }
    return partId
  })
  const toolState = createMemo(() => toolCallMemo()?.state)

  const store = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))
  const activeRequest = createMemo(() => activeInterruption().get(props.instanceId) ?? null)

  const permissionState = createMemo(() => store().getPermissionState(props.messageId, toolCallIdentifier()))
  const pendingPermission = createMemo(() => {
    const state = permissionState()
    if (state) {
      return { permission: state.entry.permission, active: state.active }
    }
    return toolCallMemo()?.pendingPermission
  })

  const questionState = createMemo(() => store().getQuestionState(props.messageId, toolCallIdentifier()))
  const pendingQuestion = createMemo(() => {
    const state = questionState()
    if (state) {
      return { request: state.entry.request as QuestionRequest, active: state.active }
    }
    return undefined
  })

  const toolOutputDefaultExpanded = createMemo(() => (preferences().toolOutputExpansion || "expanded") === "expanded")
  const diagnosticsDefaultExpanded = createMemo(() => (preferences().diagnosticsExpansion || "expanded") === "expanded")

  const defaultExpandedForTool = createMemo(() => {
    if (props.forceCollapsed) {
      return false
    }
    const prefExpanded = toolOutputDefaultExpanded()
    const toolName = toolCallMemo()?.tool || ""
    if (toolName === "read") {
      const state = toolState()
      if (state?.status === "error") {
        return true
      }
      return false
    }
    return prefExpanded
  })

  const [userExpanded, setUserExpanded] = createSignal<boolean | null>(null)
  const toolInputsVisibility = createMemo(() => preferences().toolInputsVisibility || "collapsed")
  const [toolInputVisibilityOverride, setToolInputVisibilityOverride] = createSignal<"hidden" | "expanded" | null>(null)
  const effectiveToolInputsVisibility = createMemo(() => toolInputVisibilityOverride() ?? toolInputsVisibility())
  const isToolInputVisible = createMemo(() => effectiveToolInputsVisibility() !== "hidden")
  const inputDefaultExpanded = createMemo(() => effectiveToolInputsVisibility() === "expanded")
  const [inputSectionOverride, setInputSectionOverride] = createSignal<boolean | null>(null)
  const [outputSectionOverride, setOutputSectionOverride] = createSignal<boolean | null>(null)
  const inputSectionExpanded = () => {
    const override = inputSectionOverride()
    if (override !== null) return override
    return inputDefaultExpanded()
  }
  const outputSectionExpanded = () => {
    const override = outputSectionOverride()
    if (override !== null) return override
    return true
  }

  const isPermissionActive = createMemo(() => {
    const pending = pendingPermission()
    if (!pending?.permission) return false
    const active = activeRequest()
    return active?.kind === "permission" && active.id === pending.permission.id
  })

  const isQuestionActive = createMemo(() => {
    const pending = pendingQuestion()
    if (!pending?.request) return false
    const active = activeRequest()
    return active?.kind === "question" && active.id === pending.request.id
  })

  const expanded = () => {
    if (isPermissionActive() || isQuestionActive()) return true
    const override = userExpanded()
    if (override !== null) return override
    return defaultExpandedForTool()
  }

  const toolInput = createMemo(() => {
    const state = toolState()
    return readToolStatePayload(state).input
  })

  const hasToolInput = createMemo(() => {
    const input = toolInput()
    return input && Object.keys(input).length > 0
  })

  const [toolCallRootEl, setToolCallRootEl] = createSignal<HTMLDivElement | undefined>()
  const [scrollTopSnapshot, setScrollTopSnapshot] = createSignal(0)
  const [diagnosticsOverride, setDiagnosticsOverride] = createSignal<boolean | undefined>(undefined)

  const diagnosticsExpanded = () => {
    if (isPermissionActive() || isQuestionActive()) return true
    const override = diagnosticsOverride()
    if (override !== undefined) return override
    return diagnosticsDefaultExpanded()
  }
  const diagnosticsEntries = createMemo(() => {
    const state = toolState()
    if (!state) return []
    return extractDiagnostics(state)
  })

  const toggleInputSection = () => {
    setInputSectionOverride((prev) => {
      const current = prev === null ? inputSectionExpanded() : prev
      return !current
    })
  }

  const toggleOutputSection = () => {
    setOutputSectionOverride((prev) => {
      const current = prev === null ? outputSectionExpanded() : prev
      return !current
    })
  }


  const statusClass = () => {
    const status = toolState()?.status || "pending"
    return `tool-call-status-${status}`
  }

  const combinedStatusClass = () => {
    const base = statusClass()
    return pendingPermission() || pendingQuestion() ? `${base} tool-call-awaiting-permission` : base
  }

  function toggle() {
    const permission = pendingPermission()
    if (permission?.active) {
      return
    }
    setUserExpanded((prev) => {
      const current = prev === null ? defaultExpandedForTool() : prev
      return !current
    })
  }

  createEffect(() => {
    // When global preference changes, reset per-tool-call overrides so palette changes apply.
    toolInputsVisibility()
    setToolInputVisibilityOverride(null)
    setInputSectionOverride(null)
    setOutputSectionOverride(null)
  })

  const handleToggleInputVisibility = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!expanded()) {
      toggle()
    }

    const currentlyVisible = isToolInputVisible()
    setToolInputVisibilityOverride(currentlyVisible ? "hidden" : "expanded")
  }

  const renderer = createMemo(() => resolveToolRenderer(toolName()))

  const renderMarkdownStub: ToolRendererContext["renderMarkdown"] = () => null
  const renderAnsiStub: ToolRendererContext["renderAnsi"] = () => null
  const renderDiffStub: ToolRendererContext["renderDiff"] = () => null
  const renderToolCallStub: NonNullable<ToolRendererContext["renderToolCall"]> = () => null
  const headerRendererContext: ToolRendererContext = {
    toolCall: toolCallMemo,
    toolState,
    toolName,
    instanceId: props.instanceId,
    sessionId: props.sessionId,
    t,
    messageVersion: () => props.messageVersion,
    partVersion: () => props.partVersion,
    renderMarkdown: renderMarkdownStub,
    renderAnsi: renderAnsiStub,
    renderDiff: renderDiffStub,
    renderToolCall: renderToolCallStub,
    scrollHelpers: undefined,
  }

  const getRendererAction = () => renderer().getAction?.(headerRendererContext) ?? getDefaultToolAction(toolName())


  const renderToolTitle = () => {
    const state = toolState()
    const currentTool = toolName()

    if (currentTool !== "task") {
      return resolveTitleForTool({ toolName: currentTool, state })
    }

    if (!state) return getRendererAction()
    if (state.status === "pending") return getRendererAction()

    const customTitle = renderer().getTitle?.(headerRendererContext)
    if (customTitle) return customTitle

    if (isToolStateRunning(state) && state.title) {
      return state.title
    }

    if (isToolStateCompleted(state) && state.title) {
      return state.title
    }

    return getToolName(currentTool)
  }

  const headerText = createMemo(() => {
    // Keep this as a memo so copy always matches what's rendered.
    return renderToolTitle()
  })

  const speechText = createMemo(() =>
    buildToolSpeechText({
      title: headerText(),
      state: toolState(),
      t,
    }),
  )

  const speech = useSpeech({
    id: () => `${props.instanceId}:${props.sessionId}:${props.messageId ?? "message"}:${toolCallIdentifier()}`,
    text: speechText,
  })

  const canSpeakToolCall = () => speechText().trim().length > 0 && speech.canUseSpeech()

  const handleCopyHeader = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const text = headerText()
    if (!text) return
    await copyToClipboard(text)
  }

  const status = () => toolState()?.status || ""

  return (
    <div

      ref={(element) => {
        setToolCallRootEl(element || undefined)
      }}
      class={`tool-call ${combinedStatusClass()}`}
      data-part-type="tool"
      data-tool-name={toolName()}
      data-instance-id={props.instanceId}
      data-session-id={props.sessionId}
      data-message-id={props.messageId}
      data-part-id={toolCallIdentifier()}
    >
      <div class="tool-call-header">
        <button
          type="button"
          class="tool-call-header-toggle"
          onClick={toggle}
          aria-expanded={expanded()}
        >
          <span class="tool-call-summary" data-tool-icon={getToolIcon(toolName())}>
            {headerText()}
          </span>
        </button>

        <Show when={hasToolInput()}>
          <button
            type="button"
            class="tool-call-header-input"
            onClick={handleToggleInputVisibility}
            aria-pressed={isToolInputVisible()}
            aria-label={
              isToolInputVisible()
                ? t("toolCall.header.hideInputAriaLabel")
                : t("toolCall.header.showInputAriaLabel")
            }
            title={isToolInputVisible() ? t("toolCall.header.hideInputTitle") : t("toolCall.header.showInputTitle")}
          >
            <ArrowRightSquare class="w-3.5 h-3.5" />
          </button>
        </Show>

        <button
          type="button"
          class="tool-call-header-copy"
          onClick={handleCopyHeader}
          aria-label={t("toolCall.header.copyAriaLabel")}
          title={t("toolCall.header.copyTitle")}
        >
          <Copy class="w-3.5 h-3.5" />
        </button>

        <Show when={canSpeakToolCall()}>
          <SpeechActionButton
            class="tool-call-header-copy"
            onClick={() => void speech.toggle()}
            title={speech.buttonTitle()}
            isLoading={speech.isLoading()}
            isPlaying={speech.isPlaying()}
          />
        </Show>

        <ToolStatusIndicator status={status} />
      </div>

      <Show when={expanded()}>
        <ToolCallDetails
          toolCallMemo={toolCallMemo}
          toolState={toolState}
          toolName={toolName}
          toolCallIdentifier={toolCallIdentifier}
          instanceId={props.instanceId}
          sessionId={props.sessionId}
          messageId={props.messageId}
          messageVersion={props.messageVersion}
          partVersion={props.partVersion}
          onContentRendered={props.onContentRendered}
          preferences={preferences}
          setDiffViewMode={setDiffViewMode}
          isDark={isDark}
          t={t}
          store={store}
          pendingPermission={pendingPermission}
          pendingQuestion={pendingQuestion}
          isPermissionActive={isPermissionActive}
          isQuestionActive={isQuestionActive}
          hasToolInput={hasToolInput}
          isToolInputVisible={isToolInputVisible}
          toolInput={toolInput}
          inputSectionExpanded={inputSectionExpanded}
          outputSectionExpanded={outputSectionExpanded}
          toggleInputSection={toggleInputSection}
          toggleOutputSection={toggleOutputSection}
          toolCallRootEl={toolCallRootEl}
          scrollTopSnapshot={scrollTopSnapshot}
          setScrollTopSnapshot={setScrollTopSnapshot}
        />
      </Show>
 
      <Show when={diagnosticsEntries().length}>

        {renderDiagnosticsSection(
          t,
          diagnosticsEntries(),
          diagnosticsExpanded(),
          () => setDiagnosticsOverride((prev) => {
            const current = prev === undefined ? diagnosticsDefaultExpanded() : prev
            return !current
          }),
          diagnosticFileName(diagnosticsEntries()),
        )}
      </Show>
    </div>
  )
}
