import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, formatUnknown, isToolStateCompleted, isToolStateError, isToolStateRunning, readToolStatePayload } from "../utils"
import { getDefaultToolSearchText } from "../search-text"

export const defaultRenderer: ToolRenderer = {
  tools: ["*"],
  getSearchText: getDefaultToolSearchText,
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
