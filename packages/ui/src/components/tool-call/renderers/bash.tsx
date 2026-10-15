import { Show, createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import type { ToolState } from "../../../types/tool-state"
import type { ToolRenderer, ToolScrollHelpers } from "../types"
import { ensureMarkdownContent, formatUnknownForCopy, formatUnknownForRender, getToolName, isToolStateCompleted, isToolStateError, isToolStateRunning, limitToolOutputForRender, readToolStatePayload } from "../utils"
import { tGlobal } from "../../../lib/i18n"
import { createStableAnsiStreamUpdater } from "../ansi-render"
import { ansiToHtml, hasAnsi } from "../../../lib/ansi"
import { getBashToolSearchText } from "../search-text"

// Output changes need no transcript notification: its ResizeObserver handles
// any height change, and a frame-delayed notification always arrived after it.
function RunningBashOutput(props: {
  content: Accessor<string>
  scrollHelpers?: ToolScrollHelpers
}) {
  let preRef: HTMLPreElement | undefined
  const updater = createStableAnsiStreamUpdater()

  createEffect(() => {
    const element = preRef
    if (!element) return
    updater.update(element, props.content())
    props.scrollHelpers?.restoreAfterRender()
  })

  onCleanup(() => {
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
}) {
  createEffect(() => {
    props.html
    props.scrollHelpers?.restoreAfterRender()
  })

  return (
    <div class="message-text tool-call-markdown" ref={props.scrollHelpers?.registerContainer}>
      <pre class="tool-call-content tool-call-ansi" dir="auto" innerHTML={props.html} />
    </div>
  )
}

function getBashCopyText(state: ToolState | undefined): string {
  if (!state || state.status === "pending") return ""

  const { input, metadata } = readToolStatePayload(state)
  const command = typeof input.command === "string" && input.command.length > 0 ? `$ ${input.command}` : ""
  const outputResult = formatUnknownForCopy(
    isToolStateCompleted(state)
      ? state.output
      : (isToolStateRunning(state) || isToolStateError(state)) && metadata.output
        ? metadata.output
        : undefined,
  )
  return [command, outputResult?.text].filter(Boolean).join("\n")
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
    const command = typeof input.command === "string" && input.command.length > 0 ? limitToolOutputForRender(`$ ${input.command}`) : ""
    const outputResult = formatUnknownForRender(
      isToolStateCompleted(current)
        ? current.output
        : (isToolStateRunning(current) || isToolStateError(current)) && metadata.output
          ? metadata.output
          : undefined,
    )
    return [command, outputResult?.text].filter(Boolean).join("\n")
  })
  const renderedContent = createMemo(() => limitToolOutputForRender(joinedContent()))

  const finalMarkdown = createMemo(() => {
    const current = state()
    const content = renderedContent()
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
    const content = renderedContent()
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
              <FinalAnsiOutput html={html()} scrollHelpers={props.scrollHelpers} />
            )}
          </Show>
        }
      >
        <RunningBashOutput content={renderedContent} scrollHelpers={props.scrollHelpers} />
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
  getOutputChrome({ toolState }) {
    const state = toolState()
    if (!state || state.status === "pending") return undefined
    const { input, metadata } = readToolStatePayload(state)
    const output = isToolStateCompleted(state) ? state.output : (isToolStateRunning(state) || isToolStateError(state)) ? metadata.output : undefined
    const hasCopyText = (typeof input.command === "string" && input.command.length > 0)
      || (output !== undefined && output !== null && output !== "" && (!Array.isArray(output) || output.length > 0))
    if (!hasCopyText) return undefined
    return { language: "bash", getCopyText: () => getBashCopyText(state), hasCopyText: true, wrapToggle: true, suppressInnerHeader: true }
  },
  renderBody({ toolState, renderMarkdown, scrollHelpers }) {
    return <BashToolBody toolState={toolState} renderMarkdown={renderMarkdown as any} scrollHelpers={scrollHelpers} />
  },
}
