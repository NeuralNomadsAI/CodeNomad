import type { ToolRenderer } from "../types"
import { defaultRenderer } from "./default"
import { getToolName, readToolStatePayload } from "../utils"

export const invalidRenderer: ToolRenderer = {
  tools: ["invalid"],
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return getToolName("invalid")
    const { input } = readToolStatePayload(state)
    if (typeof input.tool === "string") {
      return getToolName(input.tool)
    }
    return getToolName("invalid")
  },
  renderBody(context) {
    return defaultRenderer.renderBody(context)
  },
}
