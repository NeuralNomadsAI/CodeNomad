import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, getRelativePath, getToolName, inferLanguageFromPath, readToolStatePayload } from "../utils"
import { tGlobal } from "../../../lib/i18n"

export const readRenderer: ToolRenderer = {
  tools: ["read"],
  getAction: () => tGlobal("toolCall.renderer.action.readingFile"),
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    const filePath = typeof input.filePath === "string" ? input.filePath : ""
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

    const baseTitle = relativePath ? `${getToolName("read")} ${relativePath}` : getToolName("read")
    if (!detailParts.length) {
      return baseTitle
    }

    return `${baseTitle} · ${detailParts.join(" · ")}`
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
