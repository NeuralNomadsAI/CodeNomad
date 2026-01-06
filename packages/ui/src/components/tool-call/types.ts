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
  messageVersion?: Accessor<number | undefined>
  partVersion?: Accessor<number | undefined>
  renderMarkdown(options: MarkdownRenderOptions): JSXElement | null
  renderAnsi(options: AnsiRenderOptions): JSXElement | null
  renderDiff(payload: DiffPayload, options?: DiffRenderOptions): JSXElement | null
  scrollHelpers?: ToolScrollHelpers
}

export interface ToolRenderer {
  tools: string[]
  getTitle?(context: ToolRendererContext): string | undefined
  getAction?(context: ToolRendererContext): string | undefined
  renderBody(context: ToolRendererContext): JSXElement | null
}

export type ToolRendererMap = Record<string, ToolRenderer>
