import type { Accessor, JSXElement } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk/v2"
import type { ClientPart } from "../../types/message"

export type ToolCallPart = Extract<ClientPart, { type: "tool" }>

export interface DiffPayload {
  diffText: string
  filePath?: string
}

export interface MarkdownRenderOptions {
  content: string
  size?: "default" | "large"
  disableHighlight?: boolean
  wrap?: boolean
  /**
   * Optional suffix to avoid render-cache collisions when a tool call renders
   * multiple markdown regions (e.g. task prompt vs task output).
   */
  cacheKey?: string
  /**
   * When true, do not register this markdown region with tool-call scroll
   * tracking (avoids nested scroll + autoscroll interactions).
   */
  disableScrollTracking?: boolean
}

export interface AnsiRenderOptions {
  content: string
  size?: "default" | "large"
  requireAnsi?: boolean
  variant?: "running" | "final"
}

export interface DiffRenderOptions {
  variant?: string
  disableScrollTracking?: boolean
  label?: string
  onFullDiffAccess?: () => void
  /**
   * Optional cache key suffix to avoid collisions when rendering multiple diffs
   * within the same tool call (e.g. apply_patch).
   */
  cacheKey?: string
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
  visibilitySessionId: string
  t: (key: string, params?: Record<string, unknown>) => string
  messageVersion?: Accessor<number | undefined>
  partVersion?: Accessor<number | undefined>
  renderMarkdown(options: MarkdownRenderOptions): JSXElement | null
  renderAnsi(options: AnsiRenderOptions): JSXElement | null
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
    visibilitySessionId?: string
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
  checkpoint?: () => Promise<void>
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
  getSearchText?(context: ToolSearchTextContext): AsyncIterable<string> | Promise<string[]> | string[]
  renderBody(context: ToolRendererContext): JSXElement | null
}

export interface ToolOutputChrome {
  title?: string
  language?: string
  copyText?: string | null
  getCopyText?: () => string | null
  actions?: JSXElement
  wrapToggle?: boolean
  suppressInnerHeader?: boolean
}

export type ToolRendererMap = Record<string, ToolRenderer>
