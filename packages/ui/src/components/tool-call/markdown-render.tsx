import type { Accessor, JSXElement } from "solid-js"
import type { ToolState } from "../../types/tool-state"
import type { TextPart } from "../../types/message"
import type { RecordTextRevealTarget } from "../../stores/message-v2/record-display-cache"
import { TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "../../lib/render-text-window"
import { Markdown } from "../markdown"
import { BoundedText } from "../hidden-text"
import { ensureMarkdownContent } from "./utils"
import type { MarkdownRenderOptions, ToolScrollHelpers } from "./types"

export function createMarkdownContentRenderer(params: {
  toolState: Accessor<ToolState | undefined>
  partId: Accessor<string>
  partVersion?: Accessor<number | undefined>
  instanceId: string
  sessionId: string
  textRevealTarget: (section: string) => RecordTextRevealTarget
  isDark: Accessor<boolean>
  scrollHelpers: ToolScrollHelpers
  handleScrollRendered: () => void
  onContentRendered?: () => void
}) {
  const registerTracked = (element: HTMLDivElement | null) => {
    params.scrollHelpers.registerContainer(element)
  }

  const registerUntracked = (element: HTMLDivElement | null) => {
    params.scrollHelpers.registerContainer(element, { disableTracking: true })
  }

  function renderMarkdownContent(options: MarkdownRenderOptions): JSXElement | null {
    const content = options.content
    if (content.length === 0) {
      return null
    }

    const size = options.size || "default"
    const disableHighlight = options.disableHighlight || false
    const wrapEnabled = options.wrap ?? true
    const messageClass = `message-text tool-call-markdown${size === "large" ? " tool-call-markdown-large" : ""}${wrapEnabled ? " tool-call-markdown-wrap" : ""}`
    const state = params.toolState()
    const disableScrollTracking = options.disableScrollTracking || (state?.status !== "running" && state?.status !== "pending")
    const registerRef = disableScrollTracking ? registerUntracked : registerTracked
    const shouldDeferMarkdown = Boolean(state && (state.status === "running" || state.status === "pending") && disableHighlight)
    const cacheKey = typeof options.cacheKey === "string" && options.cacheKey.length > 0 ? options.cacheKey : undefined
    const renderLimit = options.renderLimit ?? TOOL_OUTPUT_RENDER_CHARACTER_LIMIT
    const revealTarget = params.textRevealTarget(cacheKey ?? "output")
    if (shouldDeferMarkdown) {
      return (
        <div
          class={messageClass}
          ref={registerRef}
          onScroll={disableScrollTracking ? undefined : params.scrollHelpers.handleScroll}
        >
          <BoundedText source={content} limit={renderLimit} revealTarget={revealTarget}>
            {(text) => <pre class="whitespace-pre-wrap break-words text-sm font-mono" dir="auto">{text()}</pre>}
          </BoundedText>
          {params.scrollHelpers.renderSentinel({ disableTracking: disableScrollTracking })}
        </div>
      )
    }

    const codeLanguage = options.codeLanguage
    const formatText = codeLanguage === undefined
      ? undefined
      : (text: string) => ensureMarkdownContent(text, codeLanguage || undefined, true) ?? ""
    const markdownPart = (): TextPart => ({
      id: cacheKey ? `${params.partId()}:${cacheKey}` : params.partId(),
      type: "text",
      text: typeof content === "string" ? content : "",
      version: params.partVersion?.(),
    })

    const handleMarkdownRendered = () => {
      params.handleScrollRendered()
      params.onContentRendered?.()
    }

    return (
      <div
        class={messageClass}
        ref={registerRef}
        onScroll={disableScrollTracking ? undefined : params.scrollHelpers.handleScroll}
      >
        <Markdown
          part={markdownPart()}
          instanceId={params.instanceId}
          sessionId={params.sessionId}
          isDark={params.isDark()}
          disableHighlight={disableHighlight}
          defaultCodeBlockWrap={wrapEnabled}
          renderLimit={renderLimit}
          formatText={formatText}
          source={typeof content === "string" ? undefined : content}
          revealTarget={revealTarget}
          onRendered={handleMarkdownRendered}
        />
        {params.scrollHelpers.renderSentinel({ disableTracking: disableScrollTracking })}
      </div>
    )
  }

  return { renderMarkdownContent }
}
