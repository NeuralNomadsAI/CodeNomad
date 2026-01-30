import type { Accessor, JSXElement } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import type { TextPart } from "../../types/message"
import { Markdown } from "../markdown"
import type { MarkdownRenderOptions, ToolScrollHelpers } from "./types"

export function createMarkdownContentRenderer(params: {
  toolState: Accessor<ToolState | undefined>
  partId: Accessor<string>
  partVersion?: Accessor<number | undefined>
  instanceId: string
  sessionId: string
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
    if (!options.content) {
      return null
    }

    const size = options.size || "default"
    const disableHighlight = options.disableHighlight || false
    const messageClass = `message-text tool-call-markdown${size === "large" ? " tool-call-markdown-large" : ""}`
    const disableScrollTracking = options.disableScrollTracking || false
    const registerRef = disableScrollTracking ? registerUntracked : registerTracked

    const state = params.toolState()
    const shouldDeferMarkdown = Boolean(state && (state.status === "running" || state.status === "pending") && disableHighlight)
    if (shouldDeferMarkdown) {
      return (
        <div
          class={messageClass}
          ref={registerRef}
          onScroll={disableScrollTracking ? undefined : params.scrollHelpers.handleScroll}
        >
          <pre class="whitespace-pre-wrap break-words text-sm font-mono">{options.content}</pre>
          {params.scrollHelpers.renderSentinel({ disableTracking: disableScrollTracking })}
        </div>
      )
    }

    const cacheKey = typeof options.cacheKey === "string" && options.cacheKey.length > 0 ? options.cacheKey : undefined
    const markdownPart: TextPart = {
      id: cacheKey ? `${params.partId()}:${cacheKey}` : params.partId(),
      type: "text",
      text: options.content,
      version: params.partVersion?.(),
    }

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
          part={markdownPart}
          instanceId={params.instanceId}
          sessionId={params.sessionId}
          isDark={params.isDark()}
          disableHighlight={disableHighlight}
          onRendered={handleMarkdownRendered}
        />
        {params.scrollHelpers.renderSentinel({ disableTracking: disableScrollTracking })}
      </div>
    )
  }

  return { renderMarkdownContent }
}
