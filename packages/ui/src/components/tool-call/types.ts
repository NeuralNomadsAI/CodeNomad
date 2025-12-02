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

export interface DiffRenderOptions {
  variant?: string
  disableScrollTracking?: boolean
  label?: string
}

export interface ToolRendererContext {
  toolCall: Accessor<ToolCallPart>
  toolState: Accessor<ToolState | undefined>
  toolName: Accessor<string>
  renderMarkdown(options: MarkdownRenderOptions): JSXElement | null
  renderDiff(payload: DiffPayload, options?: DiffRenderOptions): JSXElement | null
}

export interface ToolRenderer {
  tools: string[]
  getTitle?(context: ToolRendererContext): string | undefined
  getAction?(context: ToolRendererContext): string | undefined
  renderBody(context: ToolRendererContext): JSXElement | null
}

export type ToolRendererMap = Record<string, ToolRenderer>
