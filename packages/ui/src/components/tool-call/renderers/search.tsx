import type { ToolRenderer } from "../types"
import { getToolName, readToolStatePayload } from "../utils"
import { getDefaultToolSearchText } from "../search-text"
import { defaultRenderer } from "./default"

export const searchRenderer: ToolRenderer = {
  tools: ["glob", "grep"],
  getSearchText: getDefaultToolSearchText,
  getTitle({ toolName, toolState }) {
    const state = toolState()
    const name = getToolName(toolName())
    if (!state) return name

    const { input } = readToolStatePayload(state)
    const pattern = typeof input.pattern === "string" ? input.pattern.trim() : ""
    if (!pattern) return name

    return `${name} ${pattern}`
  },
  getOutputChrome(context) {
    return defaultRenderer.getOutputChrome?.(context)
  },
  renderBody(context) {
    return defaultRenderer.renderBody(context)
  },
}
