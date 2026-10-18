import { Show, createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import type { ToolState } from "../../../types/tool-state"
import type { MarkdownRenderOptions, ToolRenderer, ToolScrollHelpers } from "../types"
import { formatUnknownForCopy, formatUnknownForRender, getToolName, isToolStateCompleted, isToolStateError, isToolStateRunning, readToolStatePayload, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "../utils"
import { tGlobal } from "../../../lib/i18n"
import { createStableAnsiStreamUpdater } from "../ansi-render"
import { ansiToHtml, hasAnsi } from "../../../lib/ansi"
import { getBashToolSearchText } from "../search-text"
import type { RecordTextRevealTarget } from "../../../stores/message-v2/record-display-cache"
import { HiddenTextNotice, createTextWindow } from "../../hidden-text"
import { joinedTextSource } from "../../../lib/render-text-window"

type TextWindowHandle = ReturnType<typeof createTextWindow>

function OutputReveal(props: { output: TextWindowHandle }) {
  return (
    <Show when={props.output.window().hidden > 0}>
      <HiddenTextNotice window={props.output.window()} onReveal={props.output.reveal} />
    </Show>
  )
}

// Output changes need no transcript notification: its ResizeObserver handles
// any height change, and a frame-delayed notification always arrived after it.
// Past the display bound the streamed prefix stops changing; only the reveal line counts on.
function RunningBashOutput(props: {
  content: Accessor<string>
  output: TextWindowHandle
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
      <OutputReveal output={props.output} />
      {props.scrollHelpers?.renderSentinel?.()}
    </div>
  )
}

function FinalAnsiOutput(props: {
  html: string
  output: TextWindowHandle
  scrollHelpers?: ToolScrollHelpers
}) {
  createEffect(() => {
    props.html
    props.scrollHelpers?.restoreAfterRender()
  })

  return (
    <div class="message-text tool-call-markdown" ref={props.scrollHelpers?.registerContainer}>
      <pre class="tool-call-content tool-call-ansi" dir="auto" innerHTML={props.html} />
      <OutputReveal output={props.output} />
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
  renderMarkdown: (options: MarkdownRenderOptions) => ReturnType<ToolRenderer["renderBody"]>
  revealTarget: RecordTextRevealTarget
  scrollHelpers?: ToolScrollHelpers
}) {
  const state = createMemo(() => props.toolState())

  // "$ command\noutput" as parts of the native strings: windows copy only their
  // bounded prefix, so no full join of a large output stays alive between updates.
  const parts = createMemo((): string[] => {
    const current = state()
    if (!current || current.status === "pending") return []

    const { input, metadata } = readToolStatePayload(current)
    const command = typeof input.command === "string" ? input.command : ""
    const output = formatUnknownForRender(
      isToolStateCompleted(current)
        ? current.output
        : (isToolStateRunning(current) || isToolStateError(current)) && metadata.output
          ? metadata.output
          : undefined,
    )?.text ?? ""
    if (!command) return output ? [output] : []
    return output ? ["$ ", command, "\n", output] : ["$ ", command]
  })
  const source = createMemo(() => joinedTextSource(parts()))
  // The Markdown path bounds the same text with the same reveal state ("output").
  const output = createTextWindow({ source, limit: () => TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, target: () => props.revealTarget })
  const renderedContent = createMemo(() => output.window().text)

  const isFinal = createMemo(() => {
    const current = state()
    return Boolean(current && current.status !== "pending" && current.status !== "running" && source().length > 0)
  })
  // Detect ANSI across the whole output, so a reveal never switches renderers.
  const finalHasAnsi = createMemo(() => isFinal() && parts().some((part) => hasAnsi(part)))
  const finalAnsiHtml = createMemo(() => (finalHasAnsi() ? ansiToHtml(renderedContent()) : null))

  return (
    <Show when={state() && source().length > 0}>
      <Show
        when={state()?.status === "running"}
        fallback={
          <Show when={finalAnsiHtml()} fallback={isFinal() && !finalHasAnsi() ? props.renderMarkdown({ content: source(), codeLanguage: "bash" }) : null}>
            {(html) => (
              <FinalAnsiOutput html={html()} output={output} scrollHelpers={props.scrollHelpers} />
            )}
          </Show>
        }
      >
        <RunningBashOutput content={renderedContent} output={output} scrollHelpers={props.scrollHelpers} />
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
  renderBody({ toolState, renderMarkdown, scrollHelpers, textRevealTarget }) {
    return <BashToolBody toolState={toolState} renderMarkdown={renderMarkdown} revealTarget={textRevealTarget("output")} scrollHelpers={scrollHelpers} />
  },
}
