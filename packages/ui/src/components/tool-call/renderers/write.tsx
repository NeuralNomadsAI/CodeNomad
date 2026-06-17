import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, getRelativePath, getToolName, inferLanguageFromPath, readToolStatePayload } from "../utils"
import { tGlobal } from "../../../lib/i18n"
import { getWriteToolSearchText } from "../search-text"

export const writeRenderer: ToolRenderer = {
  tools: ["write"],
  getSearchText: getWriteToolSearchText,
  getAction: () => tGlobal("toolCall.renderer.action.preparingWrite"),
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    const filePath = typeof input.filePath === "string" ? input.filePath : ""
    if (!filePath) return getToolName("write")
    return `${getToolName("write")} ${getRelativePath(filePath)}`
  },
  getOutputChrome({ toolState }) {
    const state = toolState()
    if (!state || state.status === "pending") return undefined
    const { metadata, input } = readToolStatePayload(state)
    const contentValue = typeof input.content === "string" ? input.content : metadata.content
    if (typeof contentValue !== "string" || contentValue.length === 0) return undefined
    const filePath = typeof input.filePath === "string" ? input.filePath : undefined
    return {
      language: inferLanguageFromPath(filePath) ?? "text",
      copyText: contentValue,
      suppressInnerHeader: true,
    }
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
