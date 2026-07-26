import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, formatUnknownForCopy, formatUnknownForRender, isToolStateCompleted, isToolStateError, isToolStateRunning, readToolStatePayload } from "../utils"
import { getDefaultToolSearchText } from "../search-text"

export const defaultRenderer: ToolRenderer = {
  tools: ["*"],
  getSearchText: getDefaultToolSearchText,
  getOutputChrome({ toolState }) {
    const state = toolState()
    if (!state || state.status === "pending") return undefined

    const { metadata, input } = readToolStatePayload(state)
    const primaryOutput = isToolStateCompleted(state)
      ? state.output
      : (isToolStateRunning(state) || isToolStateError(state)) && metadata.output
        ? metadata.output
        : metadata.diff ?? metadata.preview ?? input.content

    const result = formatUnknownForCopy(primaryOutput)
    if (!result) return undefined

    return {
      language: result.language ?? "text",
      copyText: result.text,
      wrapToggle: true,
      suppressInnerHeader: true,
    }
  },
  renderBody({ toolState, renderMarkdown, outputWrapEnabled }) {
    const state = toolState()
    if (!state || state.status === "pending") return null

    const { metadata, input } = readToolStatePayload(state)
    const primaryOutput = isToolStateCompleted(state)
      ? state.output
      : (isToolStateRunning(state) || isToolStateError(state)) && metadata.output
        ? metadata.output
        : metadata.diff ?? metadata.preview ?? input.content

    const result = formatUnknownForRender(primaryOutput)
    if (!result) return null

    const content = ensureMarkdownContent(result.text, result.language, true)
    if (!content) return null

    return renderMarkdown({ content, disableHighlight: state.status === "running", wrap: outputWrapEnabled?.() ?? true })
  },
}
