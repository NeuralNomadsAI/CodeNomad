import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, formatUnknown, isToolStateCompleted, isToolStateError, isToolStateRunning, readToolStatePayload } from "../utils"

export const defaultRenderer: ToolRenderer = {
  tools: ["*"],
  renderBody({ toolState, renderMarkdown }) {
    const state = toolState()
    if (!state || state.status === "pending") return null

    const { metadata, input } = readToolStatePayload(state)
    const primaryOutput = isToolStateCompleted(state)
      ? state.output
      : (isToolStateRunning(state) || isToolStateError(state)) && metadata.output
        ? metadata.output
        : metadata.diff ?? metadata.preview ?? input.content

    const result = formatUnknown(primaryOutput)
    if (!result) return null

    const content = ensureMarkdownContent(result.text, result.language, true)
    if (!content) return null

    return renderMarkdown({ content, disableHighlight: state.status === "running" })
  },
}
