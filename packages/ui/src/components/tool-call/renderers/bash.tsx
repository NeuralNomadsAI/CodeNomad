import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, formatUnknown, getToolName, isToolStateCompleted, isToolStateError, isToolStateRunning, readToolStatePayload } from "../utils"

export const bashRenderer: ToolRenderer = {
  tools: ["bash"],
  getAction: () => "Writing command...",
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    const name = getToolName("bash")
    if (typeof input.description === "string" && input.description.length > 0) {
      return `${name} ${input.description}`
    }
    return name
  },
  renderBody({ toolState, renderMarkdown }) {
    const state = toolState()
    if (!state || state.status === "pending") return null

    const { input, metadata } = readToolStatePayload(state)
    const command = typeof input.command === "string" && input.command.length > 0 ? `$ ${input.command}` : ""
    const outputResult = formatUnknown(
      isToolStateCompleted(state)
        ? state.output
        : (isToolStateRunning(state) || isToolStateError(state)) && metadata.output
          ? metadata.output
          : undefined,
    )
    const parts = [command, outputResult?.text].filter(Boolean)
    if (parts.length === 0) return null

    const content = ensureMarkdownContent(parts.join("\n"), "bash", true)
    if (!content) return null

    return renderMarkdown({ content, disableHighlight: state.status === "running" })
  },
}
