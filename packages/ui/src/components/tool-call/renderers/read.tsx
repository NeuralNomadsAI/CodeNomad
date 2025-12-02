import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, getRelativePath, getToolName, inferLanguageFromPath, readToolStatePayload } from "../utils"

export const readRenderer: ToolRenderer = {
  tools: ["read"],
  getAction: () => "Reading file...",
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    const filePath = typeof input.filePath === "string" ? input.filePath : ""
    if (!filePath) return getToolName("read")
    return `${getToolName("read")} ${getRelativePath(filePath)}`
  },
  renderBody({ toolState, renderMarkdown }) {
    const state = toolState()
    if (!state || state.status === "pending") return null
    const { metadata, input } = readToolStatePayload(state)
    const preview = typeof metadata.preview === "string" ? metadata.preview : null
    const language = inferLanguageFromPath(typeof input.filePath === "string" ? input.filePath : undefined)
    const content = ensureMarkdownContent(preview, language, true)
    if (!content) return null
    return renderMarkdown({ content, disableHighlight: state.status === "running" })
  },
}
