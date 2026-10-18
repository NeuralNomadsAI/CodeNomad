import type { Accessor, JSXElement } from "solid-js"
import type { ClientPart } from "../../types/message"
import type { ToolState } from "../../types/tool-state"
import type { RecordTextRevealTarget } from "../../stores/message-v2/record-display-cache"
import type { TextSource } from "../../lib/render-text-window"

export type ToolCallPart = Extract<ClientPart, { type: "tool" }>

export interface DiffPayload {
  diffText: string
  copyText?: string
  filePath?: string
}

export interface MarkdownRenderOptions {
  /**
   * Markdown source, or raw text when `codeLanguage` is set. The full text is
   * passed (as a `TextSource` when it is joined from parts): rendering shows a
   * bounded prefix with an in-place reveal of the rest.
   */
  content: string | TextSource
  /** Render the bounded content as a fenced code block in this language ("" for none). */
  codeLanguage?: string
  /** Characters rendered before the reveal; defaults to TOOL_OUTPUT_RENDER_CHARACTER_LIMIT. */
  renderLimit?: number
  size?: "default" | "large"
  disableHighlight?: boolean
  wrap?: boolean
  /**
   * Optional suffix to avoid render-cache collisions when a tool call renders
   * multiple markdown regions (e.g. task prompt vs task output). It also names
   * the region's reveal state.
   */
  cacheKey?: string
  /**
   * When true, do not register this markdown region with tool-call scroll
   * tracking (avoids nested scroll + autoscroll interactions).
   */
  disableScrollTracking?: boolean
}

export interface DiffRenderOptions {
  variant?: string
  disableScrollTracking?: boolean
  label?: string
  onFullDiffAccess?: (diffText: string) => void
  /**
   * Optional cache key suffix to avoid collisions when rendering multiple diffs
   * within the same tool call (e.g. apply_patch). It also names the diff's reveal state.
   */
  cacheKey?: string
  /** Diff characters rendered before the reveal; defaults to TOOL_OUTPUT_RENDER_CHARACTER_LIMIT. */
  renderLimit?: number
}

export interface ToolScrollHelpers {
  registerContainer(element: HTMLDivElement | null, options?: { disableTracking?: boolean }): void
  handleScroll(event: Event & { currentTarget: HTMLDivElement }): void
  renderSentinel(options?: { disableTracking?: boolean }): JSXElement | null
  restoreAfterRender(): void
}

export interface ToolRendererContext {
  toolCall: Accessor<ToolCallPart>
  toolState: Accessor<ToolState | undefined>
  toolName: Accessor<string>
  instanceId: string
  sessionId: string
  /** Activity of the owning conversation, inherited by nested child-session tools. */
  isActive?: Accessor<boolean>
  t: (key: string, params?: Record<string, unknown>) => string
  messageVersion?: Accessor<number | undefined>
  partVersion?: Accessor<number | undefined>
  /** Reveal state of one display-bounded text region of this tool call. */
  textRevealTarget(section: string): RecordTextRevealTarget
  renderMarkdown(options: MarkdownRenderOptions): JSXElement | null
  renderDiff(payload: DiffPayload, options?: DiffRenderOptions): JSXElement | null
  /**
   * Render another tool call inline. This is provided by the ToolCall shell
   * to avoid renderer-level imports that would create cyclic dependencies.
   */
  renderToolCall?: (options: {
    toolCall: ToolCallPart
    messageId?: string
    messageVersion?: number
    partVersion?: number
    sessionId: string
    forceCollapsed?: boolean
  }) => JSXElement | null
  outputWrapEnabled?: Accessor<boolean>
  scrollHelpers?: ToolScrollHelpers
  onContentRendered?: () => void
}

export interface ToolSearchTextContext {
  toolCall: ToolCallPart
  toolState: ToolState | undefined
  toolName: string
}

export interface ToolRenderer {
  tools: string[]
  getTitle?(context: ToolRendererContext): string | undefined
  getAction?(context: ToolRendererContext): string | undefined
  getOutputChrome?(context: ToolRendererContext): ToolOutputChrome | undefined
  /**
   * Text that is visible or directly revealable through this renderer. Keep this
   * in sync with custom renderBody output when adding specialized tool UIs.
   */
  getSearchText?(context: ToolSearchTextContext): string[]
  renderBody(context: ToolRendererContext): JSXElement | null
}

export interface ToolOutputChrome {
  title?: string
  language?: string
  copyText?: string | null
  getCopyText?: () => string | null
  hasCopyText?: boolean
  actions?: JSXElement
  wrapToggle?: boolean
  suppressInnerHeader?: boolean
}

export type ToolRendererMap = Record<string, ToolRenderer>
