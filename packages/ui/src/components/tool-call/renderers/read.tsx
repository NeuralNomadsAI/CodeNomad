import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, getRelativePath, getToolName, inferLanguageFromPath, limitToolOutputForRender, readToolStatePayload } from "../utils"
import { tGlobal } from "../../../lib/i18n"
import { getReadToolSearchText } from "../search-text"

function getReadPath(input: Record<string, any>): string {
  const filePath = typeof input.filePath === "string" ? input.filePath : ""
  if (filePath) return filePath
  const path = typeof input.path === "string" ? input.path : ""
  if (path) return path
  return typeof input.name === "string" ? input.name : ""
}

export const readRenderer: ToolRenderer = {
  tools: ["read"],
  getSearchText: getReadToolSearchText,
  getAction: () => tGlobal("toolCall.renderer.action.readingFile"),
  getTitle({ toolName, toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    const filePath = getReadPath(input)
    const offset = typeof input.offset === "number" ? input.offset : undefined
    const limit = typeof input.limit === "number" ? input.limit : undefined
    const relativePath = filePath ? getRelativePath(filePath) : ""
    const detailParts: string[] = []

    if (typeof offset === "number") {
      detailParts.push(tGlobal("toolCall.renderer.read.detail.offset", { offset }))
    }

    if (typeof limit === "number") {
      detailParts.push(tGlobal("toolCall.renderer.read.detail.limit", { limit }))
    }

    const toolLabel = getToolName(toolName())
    const baseTitle = relativePath ? `${toolLabel} ${relativePath}` : toolLabel
    if (!detailParts.length) {
      return baseTitle
    }

    return `${baseTitle} · ${detailParts.join(" · ")}`
  },
  getOutputChrome({ toolState }) {
    const state = toolState()
    if (!state || state.status === "pending") return undefined
    const { metadata, input } = readToolStatePayload(state)
    const preview = typeof metadata.preview === "string" ? metadata.preview : null
    if (!preview) return undefined
    const language = inferLanguageFromPath(getReadPath(input)) ?? "text"
    return { language, getCopyText: () => preview, wrapToggle: true, suppressInnerHeader: true }
  },
  renderBody({ toolState, renderMarkdown }) {
    const state = toolState()
    if (!state || state.status === "pending") return null
    const { metadata, input } = readToolStatePayload(state)
    const preview = typeof metadata.preview === "string" ? metadata.preview : null
    const language = inferLanguageFromPath(getReadPath(input))
    const content = ensureMarkdownContent(preview ? limitToolOutputForRender(preview) : preview, language, true)
    if (!content) return null
    return renderMarkdown({ content, disableHighlight: state.status === "running" })
  },
}
