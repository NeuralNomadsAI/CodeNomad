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

    const output = formatUnknownForCopy(state.output)?.text ?? null
    if (!output) return undefined
    return { copyText: output, suppressInnerHeader: true }
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
