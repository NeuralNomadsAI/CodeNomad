import { createSignal, Show, createEffect, createMemo, onCleanup, type Accessor, type JSXElement } from "solid-js"
import { ArrowRightSquare, Check, Copy, Hourglass, Loader2, Volume2, WrapText, XCircle } from "lucide-solid"
import { stringify as stringifyYaml } from "yaml"
import { messageStoreBus } from "../stores/message-v2/bus"
import { useTheme } from "../lib/theme"
import { useGlobalCache } from "../lib/hooks/use-global-cache"
import { useConfig } from "../stores/preferences"
import { activeInterruption, sendPermissionResponse, sendQuestionReject, sendQuestionReply } from "../stores/instances"
import { copyToClipboard } from "../lib/clipboard"
import type { PermissionRequest } from "../types/permission"
import { getPermissionSessionId } from "../types/permission"
import type { QuestionRequest } from "../types/question"
import { useI18n } from "../lib/i18n"
import { resolveToolRenderer } from "./tool-call/renderers"
import { resolveToolExpansionDefault } from "./tool-call/tool-registry"
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
  ToolOutputChrome,
  ToolRendererContext,
  ToolScrollHelpers,
} from "./tool-call/types"
import {
  buildToolSpeechText,
  ensureMarkdownContent,
  getRelativePath,
  getToolName,
  isToolStateCompleted,
  isToolStateError,
  isToolStateRunning,
  getDefaultToolAction,
  readToolStatePayload,
} from "./tool-call/utils"
import { getLogger } from "../lib/logger"
import { useSpeech } from "../lib/hooks/use-speech"
import { createFollowScroll } from "../lib/follow-scroll"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import SpeechActionButton from "./speech-action-button"

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
  headerAction?: JSXElement
  headerMenuItems?: () => ActionOverflowMenuItem[]
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
  pendingPermission: () => { permission: PermissionRequest; active: boolean } | undefined
  pendingQuestion: () => { request: QuestionRequest; active: boolean } | undefined
  isPermissionActive: () => boolean
  isQuestionActive: () => boolean
  hasToolInput: () => boolean
  isToolInputVisible: () => boolean
  toolInput: () => Record<string, any> | undefined
  inputSectionExpanded: () => boolean
  outputSectionExpanded: () => boolean
  outputWrapEnabled: Accessor<boolean>
  toggleOutputWrap: () => void
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
    scrollHelpers.restoreAfterRender()
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

  async function handlePermissionResponse(permission: PermissionRequest, response: "once" | "always" | "reject", message?: string) {
    if (!permission) return
    setPermissionSubmitting(true)
    setPermissionError(null)
    try {
      const sessionId = getPermissionSessionId(permission)
      if (!sessionId) throw new Error("Permission request is missing sessionID")
      await sendPermissionResponse(props.instanceId, sessionId, permission.id, response, message)
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
      if (isTextInputFocused()) return
      const permission = permissionDetails()
      if (!permission || !props.isPermissionActive()) return
      if (event.key === "Enter") {
        event.preventDefault()
        void handlePermissionResponse(permission, "once")
      } else if (event.key === "a" || event.key === "A") {
        event.preventDefault()
        void handlePermissionResponse(permission, "always")
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
      await sendQuestionReply(props.instanceId, request.sessionID, request.id, normalized)
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
      await sendQuestionReject(props.instanceId, request.sessionID, request.id)
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

  const toolInputDisplay = createMemo((): { content: string; copyText: string; language: string } | null => {
    const input = props.toolInput()
    if (!input || Object.keys(input).length === 0) return null

    try {
      const yamlText = stringifyYaml(input)
      const content = ensureMarkdownContent(yamlText, "yaml", true)
      return content ? { content, copyText: yamlText, language: "yaml" } : null
    } catch (error) {
      log.error("Failed to convert tool call input to YAML", error)
      try {
        const jsonText = JSON.stringify(input, null, 2)
        const content = ensureMarkdownContent(jsonText, "json", true)
        return content ? { content, copyText: jsonText, language: "json" } : null
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

  const renderOutputMarkdownContent: ToolRendererContext["renderMarkdown"] = (options) =>
    renderMarkdownContent({ ...options, wrap: options.wrap ?? props.outputWrapEnabled() })

  const rendererContext: ToolRendererContext = {
    toolCall: props.toolCallMemo,
    toolState: props.toolState,
    toolName: props.toolName,
    instanceId: props.instanceId,
    sessionId: props.sessionId,
    t: props.t,
    messageVersion: messageVersionAccessor,
    partVersion: partVersionAccessor,
    renderMarkdown: renderOutputMarkdownContent,
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
          onContentRendered={props.onContentRendered}
          forceCollapsed={options.forceCollapsed}
        />
      )
    },
    outputWrapEnabled: props.outputWrapEnabled,
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
    scrollHelpers.restoreAfterRender()
  })

  createEffect(() => {
    if (followScroll.autoScroll()) {
      scrollHelpers.restoreAfterRender()
    }
  })

  const renderToolBody = () => {
    return renderer().renderBody(rendererContext)
  }

  const outputChrome = createMemo<ToolOutputChrome>(() => renderer().getOutputChrome?.(rendererContext) ?? {})

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
      onRespond={(permission, sessionId, response, message) => void handlePermissionResponse(permission, response, message)}
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

  const shouldShowPendingMessage = () => {
    const tool = props.toolName()
    return status() === "pending" && !props.pendingPermission() && tool !== "todowrite"
  }

  const copyIoText = async (event: MouseEvent, text?: string | null) => {
    event.preventDefault()
    event.stopPropagation()
    if (!text) return
    await copyToClipboard(text)
  }

  const outputWrapTitle = () =>
    props.outputWrapEnabled()
      ? props.t("toolCall.diff.disableWordWrap")
      : props.t("toolCall.diff.enableWordWrap")

  const renderIoHeader = (options: {
    title: () => string
    language?: () => string | null | undefined
    expanded: () => boolean
    onToggle: () => void
    copyText?: () => string | null | undefined
    copyTitle?: () => string
    copyAriaLabel?: () => string
    actions?: () => JSXElement
    wrapToggle?: () => boolean | undefined
  }) => (
    <div class="tool-call-io-header">
      <button type="button" class="tool-call-io-toggle" aria-expanded={options.expanded()} onClick={options.onToggle}>
        <span class="tool-call-io-disclosure" aria-hidden="true">{options.expanded() ? "▼" : "▶"}</span>
        <span class="tool-call-io-title">{options.title()}</span>
        <Show when={options.language?.()}>
          {(language) => <span class="tool-call-io-language">{language()}</span>}
        </Show>
      </button>

      <Show when={options.actions?.()}>
        {(actions) => <span class="tool-call-io-actions">{actions()}</span>}
      </Show>

      <Show when={options.copyText?.()}>
        {(copyText) => (
          <button
            type="button"
            class="tool-call-header-icon-button tool-call-header-copy tool-call-io-copy"
            onClick={(event) => void copyIoText(event, copyText())}
            aria-label={options.copyAriaLabel?.() ?? props.t("toolCall.io.copyOutputAriaLabel")}
            title={options.copyTitle?.() ?? props.t("toolCall.io.copyOutputTitle")}
          >
            <Copy class="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </Show>

      <Show when={options.wrapToggle?.()}>
        <button
          type="button"
          class={`tool-call-header-icon-button tool-call-header-copy tool-call-io-wrap${props.outputWrapEnabled() ? " active" : ""}`}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.toggleOutputWrap()
          }}
          aria-label={outputWrapTitle()}
          title={outputWrapTitle()}
        >
          <WrapText class="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </Show>
    </div>
  )

  const shouldUseToolHeaderOutputControls = () => Boolean(outputChrome().wrapToggle)

  const renderToolOutputBody = () => {
    const body = renderToolBody()
    const error = renderError()
    const showPending = shouldShowPendingMessage()
    const chrome = outputChrome()

    if (!body && !error && !showPending) {
      return null
    }

    if (chrome.wrapToggle) {
      return (
        <div class="tool-call-body">
          <div class="tool-call-io-body" data-suppress-inner-header={chrome.suppressInnerHeader === false ? undefined : "true"}>
            {body}
            {error}

            <Show when={showPending}>
              <div class="tool-call-pending-message">
                <span class="spinner-small"></span>
                <span>{props.t("toolCall.pending.waitingToRun")}</span>
              </div>
            </Show>
          </div>
        </div>
      )
    }

    return (
      <div class="tool-call-body">
        {body}
        {error}

        <Show when={showPending}>
          <div class="tool-call-pending-message">
            <span class="spinner-small"></span>
            <span>{props.t("toolCall.pending.waitingToRun")}</span>
          </div>
        </Show>
      </div>
    )
  }

  return (
    <div class="tool-call-details">
      <Show
        when={props.isToolInputVisible() && props.hasToolInput()}
        fallback={renderToolOutputBody()}
      >
        <div class="tool-call-body">
          <div class="tool-call-io-sections">
            <div class="tool-call-io-section">
              {(() => {
                return renderIoHeader({
                  title: () => props.t("toolCall.io.input"),
                  language: () => toolInputDisplay()?.language,
                  expanded: props.inputSectionExpanded,
                  onToggle: props.toggleInputSection,
                  copyText: () => toolInputDisplay()?.copyText,
                  copyTitle: () => props.t("toolCall.io.copyInputTitle"),
                  copyAriaLabel: () => props.t("toolCall.io.copyInputAriaLabel"),
                })
              })()}

              <Show when={props.inputSectionExpanded()}>
                <div class="tool-call-io-body" data-suppress-inner-header="true">
                  {(() => {
                    const input = toolInputDisplay()
                    if (!input) return null
                    return renderMarkdownContent({ content: input.content, cacheKey: "input" })
                  })()}
                </div>
              </Show>
            </div>

            <div class="tool-call-io-section">
              <Show when={!shouldUseToolHeaderOutputControls()}>
                {renderIoHeader({
                    title: () => outputChrome().title || props.t("toolCall.io.output"),
                    language: () => outputChrome().language,
                    expanded: props.outputSectionExpanded,
                    onToggle: props.toggleOutputSection,
                    copyText: () => outputChrome().copyText,
                    copyTitle: () => props.t("toolCall.io.copyOutputTitle"),
                    copyAriaLabel: () => props.t("toolCall.io.copyOutputAriaLabel"),
                    actions: () => outputChrome().actions,
                    wrapToggle: () => outputChrome().wrapToggle,
                  })}
              </Show>

              <Show when={shouldUseToolHeaderOutputControls() || props.outputSectionExpanded()}>
                <div>
                  <div
                    class="tool-call-io-body"
                    data-suppress-inner-header={outputChrome().suppressInnerHeader === false ? undefined : "true"}
                  >
                    {renderToolBody()}
                    {renderError()}

                    <Show when={shouldShowPendingMessage()}>
                      <div class="tool-call-pending-message">
                        <span class="spinner-small"></span>
                        <span>{props.t("toolCall.pending.waitingToRun")}</span>
                      </div>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>
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

  const diagnosticsDefaultExpanded = createMemo(() => (preferences().diagnosticsExpansion || "expanded") === "expanded")

  const defaultExpandedForTool = createMemo(() => {
    if (props.forceCollapsed) {
      return false
    }
    const state = toolState()
    if (state?.status === "error") {
      return true
    }
    return resolveToolExpansionDefault(preferences(), toolCallMemo()?.tool || "")
  })

  const [userExpanded, setUserExpanded] = createSignal<boolean | null>(null)
  const [outputWrapEnabled, setOutputWrapEnabled] = createSignal(true)
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
    if (pending.active) return true
    const active = activeRequest()
    return active?.kind === "permission" && active.id === pending.permission.id
  })

  const isQuestionActive = createMemo(() => {
    const pending = pendingQuestion()
    if (!pending?.request) return false
    if (pending.active) return true
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

  const toggleOutputWrap = () => setOutputWrapEnabled((enabled) => !enabled)

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
    outputWrapEnabled,
    scrollHelpers: undefined,
  }

  const getRendererAction = () => renderer().getAction?.(headerRendererContext) ?? getDefaultToolAction(toolName())
  const headerOutputChrome = createMemo(() => renderer().getOutputChrome?.(headerRendererContext) ?? {})


  const renderToolTitle = () => {
    const state = toolState()
    const currentTool = toolName()

    if (currentTool !== "task") {
      if (!state || state.status === "pending") return getRendererAction()

      const stateTitle = typeof (state as { title?: string }).title === "string" ? (state as { title?: string }).title : undefined
      if (stateTitle && stateTitle.length > 0) {
        return stateTitle
      }

      const customTitle = renderer().getTitle?.(headerRendererContext)
      if (customTitle) return customTitle

      return getToolName(currentTool)
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

  const toolTypeLabel = createMemo(() => toolName())

  const headerTitleDetail = createMemo(() => {
    const rawTitle = renderToolTitle().trim()
    const typeLabel = toolTypeLabel().trim()
    if (!rawTitle) return ""
    const labels = [typeLabel, getToolName(toolName()).trim()].filter(Boolean)
    for (const label of labels) {
      if (rawTitle === label) return ""
      if (rawTitle.startsWith(`${label} `)) return rawTitle.slice(label.length).trimStart()
      if (rawTitle.startsWith(`${label}[`)) return rawTitle.slice(label.length).trimStart()
      if (rawTitle.startsWith(`${label} · `)) return rawTitle.slice(label.length + 3).trimStart()
    }
    return rawTitle
  })

  const headerText = createMemo(() => {
    // Keep this as a memo so copy always matches what's rendered.
    const typeLabel = toolTypeLabel()
    const detail = headerTitleDetail()
    return [typeLabel, detail].filter(Boolean).join(" ")
  })

  const headerCopyText = createMemo(() => headerOutputChrome().copyText || "")
  const canCopyHeaderOutput = () => headerCopyText().length > 0
  const canToggleOutputWrap = () => Boolean(headerOutputChrome().wrapToggle)
  const outputWrapTitle = () =>
    outputWrapEnabled()
      ? t("toolCall.diff.disableWordWrap")
      : t("toolCall.diff.enableWordWrap")

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
    const text = headerCopyText()
    if (!text) return
    await copyToClipboard(text)
  }

  const actionMenuItems = (includePrimaryActions = false): ActionOverflowMenuItem[] => {
    const items: ActionOverflowMenuItem[] = []

    if (hasToolInput()) {
      items.push({
        key: "toggle-input",
        label: isToolInputVisible() ? t("toolCall.header.hideInputTitle") : t("toolCall.header.showInputTitle"),
        icon: <ArrowRightSquare class="w-3.5 h-3.5" aria-hidden="true" />,
        onSelect: () => {
          if (!expanded()) toggle()
          const currentlyVisible = isToolInputVisible()
          setToolInputVisibilityOverride(currentlyVisible ? "hidden" : "expanded")
        },
      })
    }

    if (includePrimaryActions) {
      if (canCopyHeaderOutput()) {
        items.push({
          key: "copy",
          label: t("toolCall.header.copyOutputTitle"),
          icon: <Copy class="w-3.5 h-3.5" aria-hidden="true" />,
          onSelect: async () => {
            const text = headerCopyText()
            if (!text) return
            await copyToClipboard(text)
          },
        })
      }

      if (canToggleOutputWrap()) {
        items.push({
          key: "toggle-output-wrap",
          label: outputWrapTitle(),
          icon: <WrapText class="w-3.5 h-3.5" aria-hidden="true" />,
          onSelect: () => {
            toggleOutputWrap()
          },
        })
      }

      if (canSpeakToolCall()) {
        items.push({
          key: "speak",
          label: speech.buttonTitle(),
          icon: <Volume2 class="w-3.5 h-3.5" aria-hidden="true" />,
          onSelect: () => void speech.toggle(),
        })
      }
    }

    items.push(...(props.headerMenuItems?.() ?? []))

    return items
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
      <div class="tool-call-header" data-action-overflow={actionMenuItems(true).length > 0 ? "true" : undefined}>
        <button
          type="button"
          class="tool-call-header-toggle"
          onClick={toggle}
          aria-expanded={expanded()}
        >
          <span class="tool-call-disclosure" aria-hidden="true">{expanded() ? "▼" : "▶"}</span>
          <span class="tool-call-summary">
            <span class="tool-call-summary-type">{toolTypeLabel()}</span>
            <Show when={headerTitleDetail()}>
              {(detail) => <span class="tool-call-summary-title">{detail()}</span>}
            </Show>
            <ToolStatusIndicator status={status} />
          </span>
        </button>

        <Show when={canCopyHeaderOutput()}>
          <button
            type="button"
            class="tool-call-header-icon-button tool-call-header-copy"
            onClick={handleCopyHeader}
            aria-label={t("toolCall.header.copyOutputAriaLabel")}
            title={t("toolCall.header.copyOutputTitle")}
          >
            <Copy class="w-3.5 h-3.5" />
          </button>
        </Show>

        <Show when={canToggleOutputWrap()}>
          <button
            type="button"
            class={`tool-call-header-icon-button tool-call-header-copy tool-call-header-wrap${outputWrapEnabled() ? " active" : ""}`}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              toggleOutputWrap()
            }}
            aria-label={outputWrapTitle()}
            title={outputWrapTitle()}
          >
            <WrapText class="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </Show>

        <Show when={canSpeakToolCall()}>
          <SpeechActionButton
            class="tool-call-header-icon-button tool-call-header-copy"
            onClick={() => void speech.toggle()}
            title={speech.buttonTitle()}
            isLoading={speech.isLoading()}
            isPlaying={speech.isPlaying()}
          />
        </Show>

        <Show when={props.headerAction}>
          {(action) => <span class="tool-call-header-action">{action()}</span>}
        </Show>

        <ActionOverflowMenu
          items={actionMenuItems()}
          label={t("messageItem.actions.more")}
          triggerClass="tool-call-header-icon-button tool-call-header-copy action-overflow-wide"
          minItems={1}
        />
        <ActionOverflowMenu
          items={actionMenuItems(true)}
          label={t("messageItem.actions.more")}
          triggerClass="tool-call-header-icon-button tool-call-header-copy action-overflow-narrow"
          minItems={1}
        />
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
          outputWrapEnabled={outputWrapEnabled}
          toggleOutputWrap={toggleOutputWrap}
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
