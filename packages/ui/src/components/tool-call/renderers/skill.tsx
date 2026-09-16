import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, formatUnknownForCopy, formatUnknownForRender, getToolName } from "../utils"
import { getDefaultToolSearchText } from "../search-text"

export const skillRenderer: ToolRenderer = {
  tools: ["skill"],
  getSearchText: getDefaultToolSearchText,
  getTitle() {
    return getToolName("skill")
  },
  getOutputChrome({ toolState }) {
    const state = toolState()
    if (!state || state.status !== "completed") return undefined

    if (state.output === undefined || state.output === null || state.output === "" || (Array.isArray(state.output) && state.output.length === 0)) return undefined
    return { getCopyText: () => formatUnknownForCopy(state.output)?.text ?? null, hasCopyText: true, suppressInnerHeader: true }
  },
  renderBody({ toolState, renderMarkdown }) {
    const state = toolState()
    if (!state || state.status !== "completed") return null

    const output = formatUnknownForRender(state.output)?.text ?? null
    const content = ensureMarkdownContent(output, undefined, false)
    if (!content) return null
    return <div class="tool-call-skill-body">{renderMarkdown({ content })}</div>
  },
}
