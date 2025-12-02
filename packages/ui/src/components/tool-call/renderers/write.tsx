import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, getRelativePath, getToolName, inferLanguageFromPath, readToolStatePayload } from "../utils"

export const writeRenderer: ToolRenderer = {
  tools: ["write"],
  getAction: () => "Preparing write...",
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    const filePath = typeof input.filePath === "string" ? input.filePath : ""
    if (!filePath) return getToolName("write")
    return `${getToolName("write")} ${getRelativePath(filePath)}`
  },
  renderBody({ toolState, renderMarkdown }) {
    const state = toolState()
    if (!state || state.status === "pending") return null
    const { metadata, input } = readToolStatePayload(state)
    const contentValue = typeof input.content === "string" ? input.content : metadata.content
    const filePath = typeof input.filePath === "string" ? input.filePath : undefined
    const content = ensureMarkdownContent(contentValue ?? null, inferLanguageFromPath(filePath), true)
    if (!content) return null
    return renderMarkdown({ content, size: "large", disableHighlight: state.status === "running" })
  },
}
