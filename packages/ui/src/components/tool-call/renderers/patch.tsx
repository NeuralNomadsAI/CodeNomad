import type { ToolState } from "../../../types/tool-state"
import type { ToolRenderer } from "../types"
import { extractDiffPayload, getRelativePath, getToolName, hasVisibleText, isToolStateCompleted, readToolStatePayload } from "../utils"
import { applyPatchRenderer } from "./apply-patch"
import { getApplyPatchFiles } from "./apply-patch-data"
import { getDiffToolSearchText } from "../search-text"

function hasMultiplePatchFiles(state: ToolState): boolean {
  return getApplyPatchFiles(readToolStatePayload(state).metadata).length > 1
}

export const patchRenderer: ToolRenderer = {
  tools: ["patch"],
  getSearchText: getDiffToolSearchText,
  getAction: applyPatchRenderer.getAction,
  getTitle(context) {
    const state = context.toolState()
    if (!state) return undefined
    if (hasMultiplePatchFiles(state)) return applyPatchRenderer.getTitle!(context)
    const { input } = readToolStatePayload(state)
    const filePath = typeof input.filePath === "string" ? input.filePath : ""
    if (!filePath) return getToolName("patch")
    return `${getToolName("patch")} ${getRelativePath(filePath)}`
  },
  getOutputChrome(context) {
    const state = context.toolState()
    if (!state || state.status === "pending") return undefined
    if (hasMultiplePatchFiles(state)) return applyPatchRenderer.getOutputChrome!(context)

    const diffPayload = extractDiffPayload(context.toolName(), state)
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
  renderBody(context) {
    const { toolState, toolName, renderDiff, renderMarkdown } = context
    const state = toolState()
    if (!state || state.status === "pending") return null
    if (hasMultiplePatchFiles(state)) return applyPatchRenderer.renderBody(context)

    const diffPayload = extractDiffPayload(toolName(), state)
    if (diffPayload) {
      return renderDiff(diffPayload)
    }

    const { metadata } = readToolStatePayload(state)
    const diffText = typeof metadata.diff === "string" ? metadata.diff : null
    const fallback = isToolStateCompleted(state) && typeof state.output === "string" ? state.output : null
    const value = diffText || fallback
    if (!hasVisibleText(value)) return null

    return renderMarkdown({ content: value, codeLanguage: "diff", size: "large", disableHighlight: state.status === "running" })
  },
}
