import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, extractDiffPayload, getRelativePath, getToolName, isToolStateCompleted, limitToolOutputForRender, readToolStatePayload } from "../utils"
import { tGlobal } from "../../../lib/i18n"
import { getDiffToolSearchText } from "../search-text"

export const patchRenderer: ToolRenderer = {
  tools: ["patch"],
  getSearchText: getDiffToolSearchText,
  getAction: () => tGlobal("toolCall.renderer.action.preparingPatch"),
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    const filePath = typeof input.filePath === "string" ? input.filePath : ""
    if (!filePath) return getToolName("patch")
    return `${getToolName("patch")} ${getRelativePath(filePath)}`
  },
  getOutputChrome({ toolState, toolName }) {
    const state = toolState()
    if (!state || state.status === "pending") return undefined

    const diffPayload = extractDiffPayload(toolName(), state)
    if (diffPayload) {
      return { language: "diff", getCopyText: () => diffPayload.diffText, suppressInnerHeader: false }
    }

    const { metadata } = readToolStatePayload(state)
    const diffText = typeof metadata.diff === "string" ? metadata.diff : null
    const fallback = isToolStateCompleted(state) && typeof state.output === "string" ? state.output : null
    const copyText = diffText || fallback
    if (!copyText) return undefined
    return { language: "diff", getCopyText: () => copyText, wrapToggle: true, suppressInnerHeader: true }
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
    const value = diffText || fallback
    const content = ensureMarkdownContent(value ? limitToolOutputForRender(value) : value, "diff", true)
    if (!content) return null

    return renderMarkdown({ content, size: "large", disableHighlight: state.status === "running" })
  },
}
