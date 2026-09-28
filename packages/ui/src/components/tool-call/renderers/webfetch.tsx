import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, formatUnknownForCopy, formatUnknownForRender, getToolName, readToolStatePayload } from "../utils"
import { tGlobal } from "../../../lib/i18n"
import { getWebfetchToolSearchText } from "../search-text"

export const webfetchRenderer: ToolRenderer = {
  tools: ["webfetch"],
  getSearchText: getWebfetchToolSearchText,
  getAction: () => tGlobal("toolCall.renderer.action.fetchingFromWeb"),
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    if (typeof input.url === "string" && input.url.length > 0) {
      return `${getToolName("webfetch")} ${input.url}`
    }
    return getToolName("webfetch")
  },
  getOutputChrome({ toolState }) {
    const state = toolState()
    if (!state || state.status === "pending") return undefined

    const { metadata } = readToolStatePayload(state)
    const output = state.status === "completed" ? state.output : metadata.output
    if (output === undefined || output === null || output === "" || (Array.isArray(output) && output.length === 0)) return undefined
    const result = formatUnknownForRender(output)

    return {
      language: result?.language ?? "text",
      getCopyText: () => formatUnknownForCopy(output)?.text ?? null,
      hasCopyText: true,
      wrapToggle: true,
      suppressInnerHeader: true,
    }
  },
  renderBody({ toolState, renderMarkdown }) {
    const state = toolState()
    if (!state || state.status === "pending") return null

    const { metadata } = readToolStatePayload(state)
    const result = formatUnknownForRender(
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
