import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, extractDiffPayload, getRelativePath, getToolName, isToolStateCompleted, readToolStatePayload } from "../utils"

export const editRenderer: ToolRenderer = {
  tools: ["edit"],
  getAction: () => "Preparing edit...",
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    const filePath = typeof input.filePath === "string" ? input.filePath : ""
    if (!filePath) return getToolName("edit")
    return `${getToolName("edit")} ${getRelativePath(filePath)}`
  },
  renderBody({ toolState, toolName, renderDiff, renderMarkdown }) {
    const state = toolState()
    if (!state || state.status === "pending") return null

    const diffPayload = extractDiffPayload(toolName(), state)
    if (diffPayload) {
      return renderDiff(diffPayload)
    }

    const { metadata } = readToolStatePayload(state)
    const diffText = typeof metadata.diff === "string" ? metadata.diff : null
    const fallback = isToolStateCompleted(state) && typeof state.output === "string" ? state.output : null
    const content = ensureMarkdownContent(diffText || fallback, "diff", true)
    if (!content) return null

    return renderMarkdown({ content, size: "large", disableHighlight: state.status === "running" })
  },
}
