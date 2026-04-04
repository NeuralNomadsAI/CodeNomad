import { Show, createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk/v2"
import type { ToolRenderer, ToolScrollHelpers } from "../types"
import { ensureMarkdownContent, formatUnknown, getToolName, isToolStateCompleted, isToolStateError, isToolStateRunning, readToolStatePayload } from "../utils"
import { tGlobal } from "../../../lib/i18n"
import { ansiToHtml, createAnsiStreamRenderer, hasAnsi } from "../../../lib/ansi"
import { escapeHtml } from "../../../lib/text-render-utils"

function RunningBashOutput(props: {
  content: Accessor<string>
  scrollHelpers?: ToolScrollHelpers
}) {
  let preRef: HTMLPreElement | undefined
  const streamRenderer = createAnsiStreamRenderer()
  let previousContent = ""
  let ansiActive = false

  createEffect(() => {
    const nextContent = props.content()
    const element = preRef
    if (!element) return

    const resetStreaming = !previousContent || !nextContent.startsWith(previousContent)

    if (resetStreaming) {
      ansiActive = hasAnsi(nextContent)
      if (ansiActive) {
        streamRenderer.reset()
        element.innerHTML = streamRenderer.render(nextContent)
      } else {
        streamRenderer.reset()
        element.innerHTML = escapeHtml(nextContent)
      }
      previousContent = nextContent
      return
    }

    const delta = nextContent.slice(previousContent.length)
    if (delta.length === 0) {
      return
    }

    if (!ansiActive && hasAnsi(delta)) {
      ansiActive = true
      streamRenderer.reset()
      element.innerHTML = streamRenderer.render(nextContent)
      previousContent = nextContent
      return
    }

    if (ansiActive) {
      const htmlChunk = streamRenderer.render(delta)
      if (htmlChunk.length > 0) {
        element.insertAdjacentHTML("beforeend", htmlChunk)
      }
    } else {
      const escapedDelta = escapeHtml(delta)
      if (escapedDelta.length > 0) {
        element.insertAdjacentHTML("beforeend", escapedDelta)
      }
    }

    previousContent = nextContent
  })

  onCleanup(() => {
    preRef = undefined
    previousContent = ""
    ansiActive = false
    streamRenderer.reset()
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

function BashToolBody(props: {
  toolState: Accessor<ToolState | undefined>
  renderMarkdown: (options: { content: string }) => ReturnType<ToolRenderer["renderBody"]>
  scrollHelpers?: ToolScrollHelpers
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
              <div class="message-text tool-call-markdown" ref={props.scrollHelpers?.registerContainer}>
                <pre class="tool-call-content tool-call-ansi" dir="auto" innerHTML={html()} />
              </div>
            )}
          </Show>
        }
      >
        <RunningBashOutput content={joinedContent} scrollHelpers={props.scrollHelpers} />
      </Show>
    </Show>
  )
}

export const bashRenderer: ToolRenderer = {
  tools: ["bash"],
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
  renderBody({ toolState, renderMarkdown, scrollHelpers }) {
    return <BashToolBody toolState={toolState} renderMarkdown={renderMarkdown as any} scrollHelpers={scrollHelpers} />
  },
}
