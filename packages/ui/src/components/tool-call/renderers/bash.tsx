import { Show, createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk/v2"
import type { ToolRenderer, ToolScrollHelpers } from "../types"
import { ensureMarkdownContent, formatUnknown, getToolName, isToolStateCompleted, isToolStateError, isToolStateRunning, readToolStatePayload } from "../utils"
import { tGlobal } from "../../../lib/i18n"
import { createStableAnsiStreamUpdater } from "../ansi-render"
import { ansiToHtml, hasAnsi } from "../../../lib/ansi"
import { getBashToolSearchText } from "../search-text"

function RunningBashOutput(props: {
  content: Accessor<string>
  scrollHelpers?: ToolScrollHelpers
  onContentRendered?: () => void
}) {
  let preRef: HTMLPreElement | undefined
  let pendingRenderNotificationFrame: number | null = null
  const updater = createStableAnsiStreamUpdater()

  const notifyContentRendered = () => {
    if (!props.onContentRendered || typeof requestAnimationFrame !== "function") return
    if (pendingRenderNotificationFrame !== null) {
      cancelAnimationFrame(pendingRenderNotificationFrame)
    }
    pendingRenderNotificationFrame = requestAnimationFrame(() => {
      pendingRenderNotificationFrame = null
      props.onContentRendered?.()
    })
  }

  createEffect(() => {
    const element = preRef
    if (!element) return
    updater.update(element, props.content())
    props.scrollHelpers?.restoreAfterRender()
    notifyContentRendered()
  })

  onCleanup(() => {
    if (pendingRenderNotificationFrame !== null) {
      cancelAnimationFrame(pendingRenderNotificationFrame)
      pendingRenderNotificationFrame = null
    }
    preRef = undefined
    updater.reset()
  })

  return (
    <div
      class="message-text tool-call-markdown"
      ref={props.scrollHelpers?.registerContainer}
      onScroll={props.scrollHelpers ? (event) => props.scrollHelpers!.handleScroll(event as Event & { currentTarget: HTMLDivElement }) : undefined}
    >
      <pre ref={preRef} class="tool-call-content tool-call-ansi" dir="auto" />
      {props.scrollHelpers?.renderSentinel?.()}
    </div>
  )
}

function FinalAnsiOutput(props: {
  html: string
  scrollHelpers?: ToolScrollHelpers
  onContentRendered?: () => void
}) {
  let pendingRenderNotificationFrame: number | null = null

  const notifyContentRendered = () => {
    if (!props.onContentRendered || typeof requestAnimationFrame !== "function") return
    if (pendingRenderNotificationFrame !== null) {
      cancelAnimationFrame(pendingRenderNotificationFrame)
    }
    pendingRenderNotificationFrame = requestAnimationFrame(() => {
      pendingRenderNotificationFrame = null
      props.onContentRendered?.()
    })
  }

  createEffect(() => {
    props.html
    props.scrollHelpers?.restoreAfterRender()
    notifyContentRendered()
  })

  onCleanup(() => {
    if (pendingRenderNotificationFrame !== null) {
      cancelAnimationFrame(pendingRenderNotificationFrame)
      pendingRenderNotificationFrame = null
    }
  })

  return (
    <div class="message-text tool-call-markdown" ref={props.scrollHelpers?.registerContainer}>
      <pre class="tool-call-content tool-call-ansi" dir="auto" innerHTML={props.html} />
    </div>
  )
}

function BashToolBody(props: {
  toolState: Accessor<ToolState | undefined>
  renderMarkdown: (options: { content: string }) => ReturnType<ToolRenderer["renderBody"]>
  scrollHelpers?: ToolScrollHelpers
  onContentRendered?: () => void
}) {
  const state = createMemo(() => props.toolState())

  const joinedContent = createMemo(() => {
    const current = state()
    if (!current || current.status === "pending") return ""

    const { input, metadata } = readToolStatePayload(current)
    const command = typeof input.command === "string" && input.command.length > 0 ? `$ ${input.command}` : ""
    const outputResult = formatUnknown(
      isToolStateCompleted(current)
        ? current.output
        : (isToolStateRunning(current) || isToolStateError(current)) && metadata.output
          ? metadata.output
          : undefined,
    )
    return [command, outputResult?.text].filter(Boolean).join("\n")
  })

  const finalMarkdown = createMemo(() => {
    const current = state()
    const content = joinedContent()
    if (!current || current.status === "pending" || current.status === "running" || content.length === 0) {
      return null
    }
    if (hasAnsi(content)) {
      return null
    }
    return ensureMarkdownContent(content, "bash", true)
  })

  const finalAnsiHtml = createMemo(() => {
    const current = state()
    const content = joinedContent()
    if (!current || current.status === "pending" || current.status === "running" || content.length === 0) {
      return null
    }
    if (!hasAnsi(content)) {
      return null
    }
    return ansiToHtml(content)
  })

  return (
    <Show when={state() && joinedContent().length > 0}>
      <Show
        when={state()?.status === "running"}
        fallback={
          <Show when={finalAnsiHtml()} fallback={finalMarkdown() ? props.renderMarkdown({ content: finalMarkdown()! as string }) : null}>
            {(html) => (
              <FinalAnsiOutput html={html()} scrollHelpers={props.scrollHelpers} onContentRendered={props.onContentRendered} />
            )}
          </Show>
        }
      >
        <RunningBashOutput content={joinedContent} scrollHelpers={props.scrollHelpers} onContentRendered={props.onContentRendered} />
      </Show>
    </Show>
  )
}

export const bashRenderer: ToolRenderer = {
  tools: ["bash"],
  getSearchText: getBashToolSearchText,
  getAction: () => tGlobal("toolCall.renderer.action.writingCommand"),
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    const name = getToolName("bash")
    const description = typeof input.description === "string" && input.description.length > 0 ? input.description : ""
    const timeout = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : undefined

    const baseTitle = description ? `${name} ${description}` : name
    if (!timeout) {
      return baseTitle
    }

    const timeoutLabel = `${timeout}ms`
    return `${baseTitle} · ${tGlobal("toolCall.renderer.bash.title.timeout", { timeout: timeoutLabel })}`
  },
  renderBody({ toolState, renderMarkdown, scrollHelpers, onContentRendered }) {
    return <BashToolBody toolState={toolState} renderMarkdown={renderMarkdown as any} scrollHelpers={scrollHelpers} onContentRendered={onContentRendered} />
  },
}
