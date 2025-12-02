import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, formatUnknown, getToolName, readToolStatePayload } from "../utils"

export const webfetchRenderer: ToolRenderer = {
  tools: ["webfetch"],
  getAction: () => "Fetching from the web...",
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    if (typeof input.url === "string" && input.url.length > 0) {
      return `${getToolName("webfetch")} ${input.url}`
    }
    return getToolName("webfetch")
  },
  renderBody({ toolState, renderMarkdown }) {
    const state = toolState()
    if (!state || state.status === "pending") return null

    const { metadata } = readToolStatePayload(state)
    const result = formatUnknown(
      state.status === "completed"
        ? state.output
        : metadata.output,
    )
    if (!result) return null

    const content = ensureMarkdownContent(result.text, result.language, true)
    if (!content) return null

    return renderMarkdown({ content, disableHighlight: state.status === "running" })
  },
}
