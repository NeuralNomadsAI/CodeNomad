import type { Accessor, JSXElement } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
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
}

export interface ToolRendererContext {
  toolCall: Accessor<ToolCallPart>
  toolState: Accessor<ToolState | undefined>
  toolName: Accessor<string>
  instanceId: string
  sessionId: string
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
    forceCollapsed?: boolean
  }) => JSXElement | null
  scrollHelpers?: ToolScrollHelpers
}

export interface ToolRenderer {
  tools: string[]
  getTitle?(context: ToolRendererContext): string | undefined
  getAction?(context: ToolRendererContext): string | undefined
  renderBody(context: ToolRendererContext): JSXElement | null
}

export type ToolRendererMap = Record<string, ToolRenderer>
